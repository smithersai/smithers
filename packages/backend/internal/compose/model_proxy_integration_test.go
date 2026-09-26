package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// The mounted proxy, its auth and its payer resolution over product SQL: a
// run's agent token and a managed host charge the repository's owner; a
// workspace or gateway model credential and a user's own token charge the
// user; every other credential is refused before any credit moves.
func TestModelProxyChargesTheRightPayerPostgres(t *testing.T) {
	raw := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("PostgreSQL required")
		}
		t.Skip("PostgreSQL not configured")
	}
	pool, _ := postgresfixture.NewProductDatabase(t, raw)
	ctx := context.Background()
	q := db.New(pool)
	alice, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: "acme", LowerName: "acme", Visibility: "private"})
	require.NoError(t, err)
	orgRepo, err := q.CreateOrgRepo(ctx, db.CreateOrgRepoParams{OrgID: pgtype.Int8{Int64: org.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id) VALUES ($1, $2) RETURNING id::text`, orgRepo.ID, alice.ID).Scan(&workspaceID))

	token := func(name, scopes string, system bool) string {
		sum := sha256.Sum256([]byte(name))
		plaintext := "smithers_" + hex.EncodeToString(sum[:])[:40]
		hash := sha256.Sum256([]byte(plaintext))
		hashString := hex.EncodeToString(hash[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: alice.ID, Name: name, TokenHash: hashString, TokenLastEight: hashString[56:],
			Scopes: scopes, SystemIssued: system, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return plaintext
	}
	restricted := func(holder string) string {
		return "read:workspace,repo:" + strconv.FormatInt(orgRepo.ID, 10) + ",workspace:" + holder
	}
	workspaceCredential := token("model-proxy-workspace-"+workspaceID, restricted(workspaceID), true)
	gatewayCredential := token("model-proxy-gateway-gw1", restricted("gateway-gw1"), true)
	userToken := token("cli", "read:user", false)
	poolToken := token("provider-pool-workspace-"+workspaceID, restricted(workspaceID), true)
	forgedName := token("model-proxy-workspace-"+workspaceID+"-user", restricted(workspaceID), false)
	scopeless := token("no-read-user", "read:repository", false)

	var definitionID, runID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_definitions (repository_id, name, path, config) VALUES ($1, 'agent', '.smithers/agent.ts', '{}') RETURNING id`, orgRepo.ID).Scan(&definitionID))
	agentToken := "smithers_agent_" + strings.Repeat("a", 40)
	agentHash := sha256.Sum256([]byte(agentToken))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_runs (repository_id, workflow_definition_id, status, trigger_event, agent_token_hash, agent_token_expires_at)
		VALUES ($1, $2, 'running', 'agent', $3, now() + interval '1 hour') RETURNING id`, orgRepo.ID, definitionID, hex.EncodeToString(agentHash[:])).Scan(&runID))

	bindingID := uuid.NewString()
	control := "flow-host-control-credential"
	controlHash := sha256.Sum256([]byte(control))
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings (id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation, credential_ciphertext, credential_hash, state)
		VALUES ($1, 'repository:1', 'user:1', 'agent-session', 's-1', $2, $3, $4, 'coding', 'smithers-coding-host', $5, $6, 1, 'cipher', $7, 'running')`,
		bindingID, orgRepo.ID, alice.ID, workspaceID, strings.Repeat("a", 64), strings.Repeat("b", 40), controlHash[:])
	require.NoError(t, err)
	hostCredential := flowhost.ModelCredential(bindingID, control)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"input_tokens":3,"output_tokens":4}}`))
	}))
	defer upstream.Close()
	ledger := credits.Ledger{DB: pool}
	for _, owner := range []struct {
		kind string
		id   int64
	}{{"user", alice.ID}, {"org", org.ID}} {
		account, err := ledger.EnsureAccount(ctx, owner.kind, owner.id)
		require.NoError(t, err)
		require.NoError(t, ledger.Grant(ctx, account, "test", 1_000_000_000, nil))
	}
	handler := &modelproxy.Handler{Meter: modelproxy.Meter{Ledger: ledger}, Keys: modelproxy.StaticKeys{modelproxy.ProviderAnthropic: "sk-platform"},
		Callers: services.NewModelProxyCallers(q, pool), Upstreams: map[string]string{modelproxy.ProviderAnthropic: upstream.URL}}
	router := chi.NewRouter()
	mountModelProxy(router, q, testConfigAllFlagsOn(), handler)
	router.Route("/api", func(r chi.Router) {
		r.Get("/model/credential/receipt", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	})

	call := func(path, credential, header string) int {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"model":"claude-haiku-4-5","max_tokens":10,"messages":[]}`))
		request.Header.Set(header, map[bool]string{true: "Bearer ", false: ""}[header == "Authorization"]+credential)
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "cookie-never-spends"})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	const proxied = "/model-proxy/anthropic/v1/messages"
	require.Equal(t, http.StatusOK, call(proxied, agentToken, "X-Api-Key"))
	require.Equal(t, http.StatusOK, call(proxied, hostCredential, "Authorization"))
	require.Equal(t, http.StatusOK, call(proxied, workspaceCredential, "X-Api-Key"))
	require.Equal(t, http.StatusOK, call(proxied, gatewayCredential, "Authorization"))
	require.Equal(t, http.StatusOK, call("/api/model/anthropic/v1/messages", userToken, "Authorization"))
	for name, refused := range map[string]string{"pool": poolToken, "forged": forgedName, "scopeless": scopeless,
		"host with a rotated credential": flowhost.ModelCredential(bindingID, "rotated"), "none": ""} {
		code := call(proxied, refused, "Authorization")
		require.Contains(t, []int{http.StatusUnauthorized, http.StatusForbidden}, code, name)
	}
	receipt := httptest.NewRecorder()
	router.ServeHTTP(receipt, httptest.NewRequest(http.MethodGet, "/api/model/credential/receipt", nil))
	require.Equal(t, http.StatusTeapot, receipt.Code, "the /api/model routes beside the proxy still resolve")

	rows, err := pool.Query(ctx, `SELECT source, owner_type, owner_id, COALESCE(workflow_run_id, 0), COALESCE(workspace_id, ''), reference FROM model_usage ORDER BY id`)
	require.NoError(t, err)
	defer rows.Close()
	type row struct {
		source, ownerType string
		ownerID, runID    int64
		workspace, ref    string
	}
	var got []row
	for rows.Next() {
		var r row
		require.NoError(t, rows.Scan(&r.source, &r.ownerType, &r.ownerID, &r.runID, &r.workspace, &r.ref))
		got = append(got, r)
	}
	require.Equal(t, []row{
		{"agent_run", "org", org.ID, runID, "", ""},
		{"flow_host", "org", org.ID, 0, workspaceID, bindingID},
		{"workspace", "user", alice.ID, 0, workspaceID, ""},
		{"repo_gateway", "user", alice.ID, 0, "", "gw1"},
		{"app", "user", alice.ID, 0, "", ""},
	}, got)
}
