package modelhost_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

const ownerModelsSecretKey = "owner-models-test-key"

type ownerModelsFixture struct {
	pool     *pgxpool.Pool
	url      string
	owner    int64
	repo     int64
	handlers modelhost.OwnerModels
}

func newOwnerModelsFixture(t *testing.T) ownerModelsFixture {
	t.Helper()
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_PRODUCT_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_PRODUCT_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	pool, url := postgresfixture.NewProductDatabase(t, raw)
	ctx := context.Background()
	var owner, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username,lower_username) VALUES ('modelowner','modelowner') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (user_id,name,lower_name) VALUES ($1,'modelrepo','modelrepo') RETURNING id`, owner).Scan(&repo))
	codec, err := webhook.NewSecretCodec(ownerModelsSecretKey)
	require.NoError(t, err)
	return ownerModelsFixture{pool: pool, url: url, owner: owner, repo: repo, handlers: modelhost.OwnerModels{Pool: pool, Codec: codec}}
}

func (f ownerModelsFixture) call(t *testing.T, handler http.HandlerFunc, method string, body any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(body)
	require.NoError(t, err)
	request := httptest.NewRequest(method, "/api/model", bytes.NewReader(encoded))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: f.owner, Username: "modelowner"}}))
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	var result map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &result), recorder.Body.String())
	return result
}

func (f ownerModelsFixture) credential(t *testing.T, action, requestID, name, origin, value string) map[string]any {
	t.Helper()
	return f.call(t, f.handlers.Credential, http.MethodPost, map[string]string{"action": action, "requestId": requestID, "name": name, "origin": origin, "value": value})
}

func failureCode(result map[string]any) string {
	failure, _ := result["failure"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

func TestOwnerModelCredentialLifecycle(t *testing.T) {
	f := newOwnerModelsFixture(t)
	openai := "https://api.openai.com"

	require.Equal(t, true, f.credential(t, "enroll", "enroll-0001", "OPENAI_API_KEY", openai, "first")["ok"])
	require.Equal(t, "exists", failureCode(f.credential(t, "enroll", "enroll-0002", "OPENAI_API_KEY", openai, "again")))

	removed := f.credential(t, "remove", "remove-0001", "OPENAI_API_KEY", "", "")
	require.Equal(t, true, removed["ok"])
	require.Equal(t, false, removed["credential"].(map[string]any)["present"])

	reenrolled := f.credential(t, "enroll", "enroll-0003", "OPENAI_API_KEY", openai, "second")
	require.Equal(t, true, reenrolled["ok"], reenrolled)
	require.Equal(t, true, reenrolled["credential"].(map[string]any)["present"])

	rotated := f.credential(t, "rotate", "rotate-0001", "OPENAI_API_KEY", "", "third")
	require.Equal(t, true, rotated["ok"], rotated)

	// A retried request ID returns the first committed result.
	replayed := f.credential(t, "enroll", "enroll-0001", "OPENAI_API_KEY", openai, "ignored")
	require.Equal(t, true, replayed["ok"])

	require.Equal(t, "unknown", failureCode(f.credential(t, "remove", "remove-0002", "NEVER_ENROLLED", "", "")))
	require.Equal(t, "unknown", failureCode(f.credential(t, "rotate", "rotate-0002", "NEVER_ENROLLED", "", "value")))
	require.Equal(t, "origin", f.credential(t, "enroll", "enroll-0004", "ANTHROPIC_API_KEY", "https://evil.example", "value")["failure"].(map[string]any)["field"])
	require.Equal(t, "origin", f.credential(t, "enroll", "enroll-0005", "CUSTOM_KEY", "http://example.com", "value")["failure"].(map[string]any)["field"])

	catalog := f.call(t, f.handlers.Catalog, http.MethodGet, nil)
	var openaiRow map[string]any
	for _, entry := range catalog["credentials"].([]any) {
		row := entry.(map[string]any)
		if row["name"] == "OPENAI_API_KEY" {
			openaiRow = row
		}
	}
	require.Equal(t, true, openaiRow["present"])
	require.Equal(t, true, openaiRow["managed"])
}

func TestResolveChatModelCredentialSources(t *testing.T) {
	f := newOwnerModelsFixture(t)
	ctx := context.Background()
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return ownerModelsSecretKey })
	require.NoError(t, err)
	t.Cleanup(resolver.Close)
	request := func(credential string) json.RawMessage {
		encoded, err := json.Marshal(map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "m", "credential": credential}})
		require.NoError(t, err)
		return encoded
	}

	_, err = resolver.ResolveChatModel(ctx, f.owner, 0, json.RawMessage(`{}`))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing, "no default model")

	_, err = resolver.ResolveChatModel(ctx, f.owner, 0, request("OPENAI_API_KEY"))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)

	require.Equal(t, true, f.credential(t, "enroll", "enroll-1001", "OPENAI_API_KEY", "https://api.openai.com", "owner-key")["ok"])
	binding, err := resolver.ResolveChatModel(ctx, f.owner, 0, request("OPENAI_API_KEY"))
	require.NoError(t, err)
	require.Equal(t, "owner-key", binding.CredentialValue)
	require.Empty(t, binding.CredentialOrigin)

	_, err = resolver.ResolveChatModel(ctx, f.owner+1, 0, request("OPENAI_API_KEY"))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing, "another owner's credential")

	// A repository secret takes precedence over the owner credential.
	codec, err := webhook.NewSecretCodec(ownerModelsSecretKey)
	require.NoError(t, err)
	sealed, err := codec.EncryptString("repository-key")
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_secrets (repository_id,name,value_encrypted) VALUES ($1,'OPENAI_API_KEY',$2)`, f.repo, []byte(sealed))
	require.NoError(t, err)
	binding, err = resolver.ResolveChatModel(ctx, f.owner, f.repo, request("OPENAI_API_KEY"))
	require.NoError(t, err)
	require.Equal(t, "repository-key", binding.CredentialValue)

	// A custom credential is pinned to its enrolled origin.
	require.Equal(t, true, f.credential(t, "enroll", "enroll-1002", "CUSTOM_KEY", "https://models.example", "custom-key")["ok"])
	binding, err = resolver.ResolveChatModel(ctx, f.owner, 0, request("CUSTOM_KEY"))
	require.NoError(t, err)
	require.Equal(t, "https://models.example", binding.CredentialOrigin)

	// A removed credential reads as missing, not as an empty key.
	require.Equal(t, true, f.credential(t, "remove", "remove-1001", "CUSTOM_KEY", "", "")["ok"])
	_, err = resolver.ResolveChatModel(ctx, f.owner, 0, request("CUSTOM_KEY"))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)

	// The owner default model answers a turn with no model field.
	require.Equal(t, true, f.call(t, f.handlers.SetDefault, http.MethodPut, map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "m", "credential": "OPENAI_API_KEY"}})["ok"])
	binding, err = resolver.ResolveChatModel(ctx, f.owner, 0, json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Equal(t, "owner-key", binding.CredentialValue)
	defaults := f.call(t, f.handlers.Default, http.MethodGet, nil)
	require.Equal(t, "OPENAI_API_KEY", defaults["model"].(map[string]any)["credential"])
}
