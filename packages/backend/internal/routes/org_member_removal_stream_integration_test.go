//go:build integration
// +build integration

package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestOrgMemberRemoval_EndsPrivateRepositoryStream exercises the whole
// revocation path for an organization member removal on a real database: the
// member holds read access to a private organization repository through a
// team, opens the agent-session SSE route (LoadRepoContext, AuthLoader, the
// real broker, the real revocation bus), the organization owner removes the
// member through OrgService.RemoveOrgMember, and the established stream must
// end with a "revoked" event within the documented five-second bound.
func TestOrgMemberRemoval_EndsPrivateRepositoryStream(t *testing.T) {
	pool, err := resetRoutesIntegrationDatabase(routesIntegrationDatabaseURL())
	require.NoError(t, err)
	// Use the same type registration as database.NewPool: generated repository
	// search vectors are strings, while pgx otherwise reads binary tsvectors.
	poolConfig := pool.Config()
	pool.Close()
	poolConfig.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err = pgxpool.NewWithConfig(ctx, poolConfig)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	queries := db.New(pool)

	owner := routesIntegrationCreateUser(t, pool, "org_owner")
	member := routesIntegrationCreateUser(t, pool, "org_member")
	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	org, err := queries.CreateOrganization(ctx, db.CreateOrganizationParams{
		Name:       "acme_" + unique,
		LowerName:  "acme_" + unique,
		Visibility: "private",
	})
	require.NoError(t, err)
	_, err = queries.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: owner.ID, Role: "owner"})
	require.NoError(t, err)
	_, err = queries.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: member.ID, Role: "member"})
	require.NoError(t, err)

	repo := routesIntegrationCreateOrgRepo(t, pool, org, "org_private_repo")
	team, err := queries.CreateTeam(ctx, db.CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "readers",
		LowerName:      "readers",
		Permission:     "read",
	})
	require.NoError(t, err)
	_, err = queries.AddTeamMember(ctx, db.AddTeamMemberParams{TeamID: team.ID, UserID: member.ID})
	require.NoError(t, err)
	_, err = queries.AddTeamRepo(ctx, db.AddTeamRepoParams{TeamID: team.ID, RepositoryID: repo.ID})
	require.NoError(t, err)

	session, err := queries.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		ID:           uuid.NewString(),
		RepositoryID: repo.ID,
		UserID:       member.ID,
		Title:        "Org member removal integration",
		Status:       "active",
	})
	require.NoError(t, err)

	// Production wiring from cmd/server: one bus per process listens on the
	// pool, the publisher records the row and applies it to the local bus,
	// and the routes package watches that bus.
	busCtx, stopBus := context.WithCancel(ctx)
	bus := revocation.NewBus(pool, queries)
	require.NoError(t, bus.Start(busCtx))
	t.Cleanup(func() {
		stopBus()
		select {
		case <-bus.Done():
		case <-time.After(5 * time.Second):
			t.Error("revocation bus did not stop")
		}
	})
	require.Eventually(t, bus.Positioned, 5*time.Second, 10*time.Millisecond)
	previous := currentRevocationSource()
	SetRevocationSource(bus)
	t.Cleanup(func() { SetRevocationSource(previous) })

	agentService := services.NewAgentServiceWithPool(queries, pool, services.WithAgentDispatchQuerier(deploymentdb.New(pool)))
	server, _ := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		agentSessionStreamService: agentService,
		agentSessionStreamPool:    pool,
	})
	client := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, member))
	streamPath := fmt.Sprintf("/api/repos/%s/%s/agent/sessions/%s/stream", repo.Owner, repo.Name, session.ID)

	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()
	req, err := http.NewRequestWithContext(streamCtx, http.MethodGet, server.URL+streamPath, nil)
	require.NoError(t, err)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		t.Fatalf("the team grant must admit the member before removal: status %d: %s", resp.StatusCode, body)
	}
	reader := bufio.NewReader(resp.Body)

	// Prove the subscription is live before removing the member.
	liveMessage, err := agentService.AppendMessage(ctx, session.ID, "assistant", []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`{"text":"before-removal"}`)},
	})
	require.NoError(t, err)
	liveFrame := readAgentSSEFrameFromReader(t, reader, resp.Body, 3*time.Second)
	require.Equal(t, fmt.Sprint(liveMessage.ID), liveFrame["id"])

	orgService := services.NewOrgServiceWithPool(queries, pool)
	orgService.SetRevocationPublisher(revocation.NewDBPublisher(queries, bus))
	removedAt := time.Now()
	require.NoError(t, orgService.RemoveOrgMember(ctx, &db.User{ID: owner.ID, Username: owner.Username, LowerUsername: owner.Username}, org.Name, member.Username))

	deadline := removedAt.Add(5 * time.Second)
	frame, err := readOrgRemovalSSEFrameWithin(reader, resp.Body, time.Until(deadline))
	require.NoError(t, err, "the removed member's established stream must end with a revoked event within 5s after RemoveOrgMember")
	require.Equal(t, "revoked", frame["event"], "frame after removal: %v", frame)
	var event revocation.Event
	require.NoError(t, json.Unmarshal([]byte(frame["data"]), &event))
	require.Equal(t, revocation.KindOrgMemberRemoved, event.Kind)
	require.Equal(t, member.ID, event.UserID)
	require.Equal(t, org.ID, event.OrganizationID)
	require.Less(t, time.Since(removedAt), 5*time.Second)

	// The handler returns after the revoked event, so the body reaches EOF.
	_, err = readOrgRemovalSSEFrameWithin(reader, resp.Body, time.Until(deadline))
	require.ErrorIs(t, err, io.EOF, "stream must reach EOF within 5s of removal, after the revoked event")
	t.Logf("org_member_removed reached the real SSE client and EOF in %s", time.Since(removedAt))

	// A fresh request is refused: the team grant no longer counts for a
	// non-member, so the private repository is invisible.
	freshReq, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+streamPath, nil)
	require.NoError(t, err)
	freshResp, err := client.Do(freshReq)
	require.NoError(t, err)
	defer freshResp.Body.Close()
	require.Equal(t, http.StatusNotFound, freshResp.StatusCode)
}

// readOrgRemovalSSEFrameWithin distinguishes stream EOF from a deadline and
// closes the body on timeout to release the reader goroutine.
func readOrgRemovalSSEFrameWithin(reader *bufio.Reader, closer io.Closer, timeout time.Duration) (map[string]string, error) {
	type result struct {
		frame map[string]string
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		frame, err := readAgentSSEFrameBlocking(reader)
		ch <- result{frame: frame, err: err}
	}()
	select {
	case got := <-ch:
		return got.frame, got.err
	case <-time.After(timeout):
		_ = closer.Close()
		return nil, context.DeadlineExceeded
	}
}

// routesIntegrationCreateOrgRepo inserts a private repository owned by the
// organization; LoadRepoContext resolves it through owner_namespaces by the
// organization's name.
func routesIntegrationCreateOrgRepo(t *testing.T, pool *pgxpool.Pool, org db.Organization, prefix string) routesIntegrationRepo {
	t.Helper()

	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	name := fmt.Sprintf("%s_%s", strings.ToLower(prefix), unique)

	var repoID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (
			 org_id, name, lower_name, description, is_public,
			 default_bookmark, next_issue_number, next_landing_number
		 )
		 VALUES ($1, $2, $3, '', FALSE, 'main', 1, 1)
		 RETURNING id`,
		org.ID,
		name,
		name,
	).Scan(&repoID)
	require.NoError(t, err)

	return routesIntegrationRepo{
		ID:    repoID,
		Owner: org.Name,
		Name:  name,
	}
}
