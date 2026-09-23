package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type sseTicketReplicaPrincipal struct {
	userID   int64
	rawToken string
}

func seedSSETicketReplicaPAT(t *testing.T, dsn string) sseTicketReplicaPrincipal {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	require.NoError(t, err)
	defer conn.Close(ctx)

	unique := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	username := "sse_replica_" + unique
	var userID int64
	require.NoError(t, conn.QueryRow(ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name, is_active)
		 VALUES ($1, $1, $2, $2, $1, true) RETURNING id`,
		username, username+"@example.com").Scan(&userID))

	rawToken := "smithers_" + strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")[:40]
	sum := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(sum[:])
	_, err = conn.Exec(ctx,
		`INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)
		 VALUES ($1, 'replica-ticket', $2, $3, 'read:user')`,
		userID, tokenHash, tokenHash[len(tokenHash)-8:])
	require.NoError(t, err)

	return sseTicketReplicaPrincipal{userID: userID, rawToken: rawToken}
}

type sseTicketReplicaResponse struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expires_at"`
}

func mintSSETicketOnReplica(t *testing.T, replica *runHarness, path, rawToken string) sseTicketReplicaResponse {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "http://"+replica.addr()+path, nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "token "+rawToken)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode, "%s: %s", path, body)

	var payload sseTicketReplicaResponse
	require.NoError(t, json.Unmarshal(body, &payload), "%s: %s", path, body)
	require.NotEmpty(t, payload.Ticket, "%s: %s", path, body)
	return payload
}

// redeemSSETicketOnReplica opens the notification stream with the ticket and
// returns the status code. A 200 is confirmed by the first SSE frame before
// the request is cancelled so the replica can drain on shutdown.
func redeemSSETicketOnReplica(t *testing.T, replica *runHarness, ticket string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://"+replica.addr()+"/api/notifications?ticket="+url.QueryEscape(ticket), nil)
	require.NoError(t, err)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultTransport.RoundTrip(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Logf("redeem on %s -> %d: %s", replica.addr(), resp.StatusCode, body)
		return resp.StatusCode
	}
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	require.NoError(t, err)
	require.Contains(t, line, ": connected", "stream should open with the connected comment")
	return resp.StatusCode
}

func assertSSETicketNotHS256JWT(t *testing.T, path, ticket string) {
	t.Helper()
	assert.False(t, strings.HasPrefix(ticket, "eyJ"), "%s issued an HS256 JWT ticket: %s", path, ticket)
	assert.NotEqual(t, 3, len(strings.Split(ticket, ".")), "%s issued a three-segment JWT ticket: %s", path, ticket)
}

// sseTicketRouterQueries opens the production-configured pool for the router
// response-shape guard, sharing the run harness's disposable schema setup.
func sseTicketRouterQueries(t *testing.T) (*db.Queries, sseTicketReplicaPrincipal) {
	t.Helper()
	dsn := testDatabaseURL(t)
	pool, err := database.NewPool(context.Background(), config.DatabaseConfig{URL: dsn, MaxConns: 4, MaxConnLifetime: 3600, MaxConnIdleTime: 1800})
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return db.New(pool), seedSSETicketReplicaPAT(t, dsn)
}
