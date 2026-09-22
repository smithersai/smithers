package compose

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// Release review R009: the Linear dispatcher wrapper must be the dispatcher the
// issue/comment services actually hold, so a real issue or comment mutation
// through the API enqueues a Linear sync operation. These tests drive run()
// end to end against the test database; the seeded integration row carries an
// undecryptable access token, so the sync attempt is recorded as a failed
// linear_sync_ops row without any outbound Linear call.

type linearWiringFixture struct {
	pool          *pgxpool.Pool
	owner         string
	repo          string
	repoID        int64
	token         string
	integrationID int64
}

func linearWiringEnv(t *testing.T) map[string]string {
	t.Helper()
	env := baseRunEnv(t)
	env["SMITHERS_FEATURE_FLAGS_ISSUES"] = "true"
	env["SMITHERS_AUTH_LINEAR_CLIENT_ID"] = "lin-id"
	env["SMITHERS_AUTH_LINEAR_CLIENT_SECRET"] = "lin-secret"
	return env
}

func seedLinearWiringFixture(t *testing.T, dsn string) *linearWiringFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	var suffixBytes [4]byte
	_, err = rand.Read(suffixBytes[:])
	require.NoError(t, err)
	suffix := hex.EncodeToString(suffixBytes[:])
	owner := "linearwiring" + suffix
	repo := "repo" + suffix

	var userID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $1, $2, $2, $1) RETURNING id`,
		owner, owner+"@example.com",
	).Scan(&userID))
	_, err = pool.Exec(ctx,
		`INSERT INTO self_host_owners (singleton, user_id) VALUES (TRUE, $1)`, userID)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM self_host_owners WHERE user_id = $1`, userID)
	})

	var rawBytes [20]byte
	_, err = rand.Read(rawBytes[:])
	require.NoError(t, err)
	rawToken := "smithers_" + hex.EncodeToString(rawBytes[:])
	sum := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(sum[:])
	_, err = pool.Exec(ctx,
		`INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)
		 VALUES ($1, 'lane-e', $2, $3, 'read:repository,write:repository')`,
		userID, tokenHash, rawToken[len(rawToken)-8:],
	)
	require.NoError(t, err)

	var repoID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number)
		 VALUES ($1, $2, $2, '', TRUE, 'main', 1) RETURNING id`,
		userID, repo,
	).Scan(&repoID))

	// The access token is deliberately not a valid ciphertext: the sync path
	// must still record the attempt as a failed operation row.
	var integrationID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO linear_integrations (user_id, linear_team_id, linear_team_name, access_token_encrypted, webhook_secret, jjhub_repo_id, jjhub_repo_owner, jjhub_repo_name)
		 VALUES ($1, 'team-lane-e', 'Lane E', $2, '', $3, $4, $5) RETURNING id`,
		userID, []byte("not-a-ciphertext"), repoID, owner, repo,
	).Scan(&integrationID))

	return &linearWiringFixture{pool: pool, owner: owner, repo: repo, repoID: repoID, token: rawToken, integrationID: integrationID}
}

func (f *linearWiringFixture) postJSON(t *testing.T, h *runHarness, path string, body any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(body)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, "http://"+h.addr()+path, bytes.NewReader(encoded))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+f.token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var decoded map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&decoded))
	require.Equalf(t, http.StatusCreated, resp.StatusCode, "POST %s: %v\nlogs:\n%s", path, decoded, h.logs.String())
	return decoded
}

func (f *linearWiringFixture) countSyncOps(t *testing.T, entity string) int64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var count int64
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM linear_sync_ops WHERE integration_id = $1 AND entity = $2 AND source = 'jjhub' AND target = 'linear'`,
		f.integrationID, entity,
	).Scan(&count))
	return count
}

func (f *linearWiringFixture) waitForSyncOp(t *testing.T, h *runHarness, entity string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if f.countSyncOps(t, entity) > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no linear_sync_ops row for entity %q within 10s: the %s mutation never reached the Linear sync subscriber\nlogs:\n%s", entity, entity, h.logs.String())
}

func (f *linearWiringFixture) issuesPath() string {
	return fmt.Sprintf("/api/repos/%s/%s/issues", f.owner, f.repo)
}

func TestRun_IssueCreateReachesLinearSync(t *testing.T) {
	preserveSlog(t)
	env := linearWiringEnv(t)
	fx := seedLinearWiringFixture(t, env["SMITHERS_DATABASE_URL"])
	h := startRun(t, env)
	defer h.shutdownAndWaitNil()

	fx.postJSON(t, h, fx.issuesPath(), map[string]any{"title": "Lane E issue", "body": "created through the API"})
	fx.waitForSyncOp(t, h, "issue")
}

func TestRun_IssueCommentReachesLinearSync(t *testing.T) {
	preserveSlog(t)
	env := linearWiringEnv(t)
	fx := seedLinearWiringFixture(t, env["SMITHERS_DATABASE_URL"])
	h := startRun(t, env)
	defer h.shutdownAndWaitNil()

	issue := fx.postJSON(t, h, fx.issuesPath(), map[string]any{"title": "Lane E comment target", "body": ""})
	issueID := int64(issue["id"].(float64))
	issueNumber := int64(issue["number"].(float64))

	// Comments only sync for issues already mapped to a Linear issue.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := fx.pool.Exec(ctx,
		`INSERT INTO linear_issue_map (integration_id, jjhub_issue_id, jjhub_issue_number, linear_issue_id, linear_identifier)
		 VALUES ($1, $2, $3, $4, 'LANE-1')`,
		fx.integrationID, issueID, issueNumber, fmt.Sprintf("linear-issue-%d", issueID),
	)
	require.NoError(t, err)

	fx.postJSON(t, h, fmt.Sprintf("%s/%d/comments", fx.issuesPath(), issueNumber), map[string]any{"body": "a comment through the API"})
	fx.waitForSyncOp(t, h, "comment")
}

// Control: without Linear credentials the plain dispatcher stays in place and
// no sync operation is recorded, so the positive tests above are observing the
// wrapper and not some other writer.
func TestRun_IssueCreateWithoutLinearRecordsNoSync(t *testing.T) {
	preserveSlog(t)
	env := linearWiringEnv(t)
	env["SMITHERS_AUTH_LINEAR_CLIENT_ID"] = ""
	env["SMITHERS_AUTH_LINEAR_CLIENT_SECRET"] = ""
	fx := seedLinearWiringFixture(t, env["SMITHERS_DATABASE_URL"])
	h := startRun(t, env)
	defer h.shutdownAndWaitNil()

	fx.postJSON(t, h, fx.issuesPath(), map[string]any{"title": "Lane E control issue", "body": ""})
	time.Sleep(1500 * time.Millisecond)
	require.Zero(t, fx.countSyncOps(t, "issue"), "no Linear sync row expected without Linear credentials")
}

// The shared dispatcher also serves non-issue mutations. With or without
// Linear, commit statuses must still enqueue their ordinary webhook payload.
func TestRun_NonIssueWebhookWithLinear(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("linear_enabled=%t", enabled), func(t *testing.T) {
			preserveSlog(t)
			env := linearWiringEnv(t)
			if !enabled {
				env["SMITHERS_AUTH_LINEAR_CLIENT_ID"] = ""
				env["SMITHERS_AUTH_LINEAR_CLIENT_SECRET"] = ""
			}
			fx := seedLinearWiringFixture(t, env["SMITHERS_DATABASE_URL"])
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var hookID int64
			// Invalid ciphertext prevents the background delivery worker from
			// making an outbound request; the durable enqueue is the boundary.
			require.NoError(t, fx.pool.QueryRow(ctx,
				`INSERT INTO webhooks (repository_id, url, secret, events)
				 VALUES ($1, 'https://hooks.invalid/lane-e', 'not-ciphertext', ARRAY['status']) RETURNING id`,
				fx.repoID,
			).Scan(&hookID))
			h := startRun(t, env)
			defer h.shutdownAndWaitNil()

			status := fx.postJSON(t, h, fmt.Sprintf("/api/repos/%s/%s/statuses/abc123", fx.owner, fx.repo),
				map[string]any{"context": "lane-e", "status": "success", "description": "webhook control"})
			queryCtx, queryCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer queryCancel()
			var count int64
			require.NoError(t, fx.pool.QueryRow(queryCtx,
				`SELECT COUNT(*) FROM webhook_deliveries
				 WHERE webhook_id = $1 AND event_type = 'status'
				 AND payload->'commit_status'->>'id' = $2
				 AND payload->'commit_status'->>'sha' = 'abc123'
				 AND payload->'commit_status'->>'context' = 'lane-e'
				 AND payload->'commit_status'->>'status' = 'success'
				 AND payload->'commit_status'->>'description' = 'webhook control'
				 AND payload->'repository'->>'id' = $3
				 AND payload->'sender'->>'login' = $4`,
				hookID, fmt.Sprint(status["id"]), fmt.Sprint(fx.repoID), fx.owner,
			).Scan(&count))
			require.EqualValues(t, 1, count, "ordinary status webhook was not enqueued with its original payload")
			require.Never(t, func() bool {
				return fx.countSyncOps(t, "issue") > 0 || fx.countSyncOps(t, "comment") > 0
			}, 500*time.Millisecond, 50*time.Millisecond, "non-issue event must not create Linear operations")
		})
	}
}
