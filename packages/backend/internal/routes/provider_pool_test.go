package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// fakePool hands out its accounts in order, skipping excluded and limited
// ones, and records what the proxy reports back.
type fakePool struct {
	mu        sync.Mutex
	accounts  []services.ResolvedProviderConnection
	limited   map[string]time.Time
	rejected  []string
	refreshed []string
	refreshOK bool
	nextReset time.Time
	reconnect bool
	pooled    bool
	next      int
	onRefresh func()
}

func (p *fakePool) PickForModelCall(_ context.Context, _, _ int64, _ string, excluded []string) (services.ProviderPoolPick, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pick := services.ProviderPoolPick{Pooled: p.pooled, NextReset: p.nextReset, Reconnect: p.reconnect}
	for range p.accounts {
		account := p.accounts[p.next%len(p.accounts)]
		p.next++
		if _, limited := p.limited[account.ConnectionID]; limited || contains(excluded, account.ConnectionID) || contains(p.rejected, account.ConnectionID) {
			continue
		}
		pick.Connection = &account
		return pick, nil
	}
	return pick, nil
}
func (p *fakePool) MarkLimited(_ context.Context, id string, until time.Time) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.limited[id] = until
	return nil
}
func (p *fakePool) MarkRejected(_ context.Context, id string, _ int64, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rejected = append(p.rejected, id)
	return nil
}
func (p *fakePool) ForceRefresh(_ context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refreshed = append(p.refreshed, id)
	if p.onRefresh != nil {
		p.onRefresh()
	}
	if p.refreshOK {
		return nil
	}
	return assert.AnError
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

type fakeScopes struct{ ok bool }

func (s fakeScopes) Scope(_ context.Context, info *middleware.AuthInfo) (int64, int64, bool) {
	return 7, 42, s.ok && info != nil
}

type providerCall struct {
	auth, apiKey, beta, account, path string
	body                              map[string]any
}

// accountUpstream answers per bearer token: the status and body configured
// for that account, 200 SSE otherwise.
func accountUpstream(t *testing.T, calls *[]providerCall, answers map[string]func(w http.ResponseWriter)) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		call := providerCall{auth: r.Header.Get("Authorization"), apiKey: r.Header.Get("X-Api-Key"), beta: r.Header.Get("Anthropic-Beta"), account: r.Header.Get("Chatgpt-Account-Id"), path: r.URL.Path}
		_ = json.Unmarshal(raw, &call.body)
		mu.Lock()
		*calls = append(*calls, call)
		mu.Unlock()
		token := strings.TrimPrefix(call.auth, "Bearer ")
		if token == "" {
			token = call.apiKey
		}
		if answer, ok := answers[token]; ok {
			answer(w)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, anthropicStream)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func poolHandler(pool *fakePool, upstream string) *ProviderPoolHandler {
	return &ProviderPoolHandler{Pool: pool, Scopes: fakeScopes{ok: true}, Upstreams: map[string]string{"anthropic": upstream, "chatgpt": upstream}}
}

const anthropicStream = "event: message_start\n" +
	`data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}` + "\n\n" +
	"event: message_stop\n" +
	`data: {"type":"message_stop"}` + "\n\n"

func workspaceContext() context.Context {
	return middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, RawScopes: "read:workspace,repo:42,workspace:ws1"})
}

func proxyRequest(t *testing.T, h http.Handler, path, body string, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, strings.Replace(path, "/api/model/", "/provider-pool/", 1), strings.NewReader(body)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer smithers_pooltoken")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func claudeAccounts(ids ...string) []services.ResolvedProviderConnection {
	var out []services.ResolvedProviderConnection
	for _, id := range ids {
		out = append(out, services.ResolvedProviderConnection{ConnectionID: id, Provider: "claude", Kind: "setup_token", AccessToken: "sk-ant-oat01-" + id})
	}
	return out
}

const messagesBody = `{"model":"claude-sonnet-4-6","max_tokens":100,"stream":true,"system":[{"type":"text","text":"Be terse."}],"messages":[{"role":"user","content":"hi"}]}`

func TestProviderPool_RotatesPastALimitedAccountBeforeAnyByteReachesTheCaller(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"sk-ant-oat01-a": func(w http.ResponseWriter) {
			w.Header().Set("Retry-After", "3600")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"rate_limit_error","message":"usage limit"}}`)
		},
	})
	pool := &fakePool{pooled: true, accounts: claudeAccounts("a", "b"), limited: map[string]time.Time{}}
	h := poolHandler(pool, upstream.URL)

	rec := proxyRequest(t, h, "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, anthropicStream, rec.Body.String())
	require.Len(t, calls, 2)
	assert.WithinDuration(t, time.Now().Add(time.Hour), pool.limited["a"], time.Minute, "the limited account is parked until its reset")
	second := calls[1]
	assert.Equal(t, "/v1/messages", second.path)
	assert.Equal(t, "Bearer sk-ant-oat01-b", second.auth)
	assert.Empty(t, second.apiKey, "no platform key and no Smithers token reach the provider")
	assert.Contains(t, second.beta, "oauth-2025-04-20")
	system := second.body["system"].([]any)
	assert.Equal(t, "You are Claude Code, Anthropic's official CLI for Claude.", system[0].(map[string]any)["text"])
	assert.Equal(t, "Be terse.", system[1].(map[string]any)["text"])
	assert.NotContains(t, rec.Body.String()+strings.Join(rec.Header().Values("Authorization"), ""), "sk-ant-oat01")
	assert.NotContains(t, second.auth+second.apiKey, "smithers_pooltoken", "the pool credential never reaches the provider")
}

func TestProviderPool_AllLimitedAnswersRateLimitUntilTheEarliestReset(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, nil)
	pool := &fakePool{pooled: true, accounts: claudeAccounts("a"), limited: map[string]time.Time{"a": time.Now().Add(time.Hour)}, nextReset: time.Now().Add(20 * time.Minute)}

	rec := proxyRequest(t, poolHandler(pool, upstream.URL), "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.InDelta(t, 1200, atoi(rec.Header().Get("Retry-After")), 5)
	assert.Contains(t, rec.Body.String(), `"rate_limit_error"`)
	assert.Empty(t, calls, "no provider call and no platform fallback")
}

func TestProviderPool_ReconnectAndRefusedCredentials(t *testing.T) {
	var calls []providerCall
	unauthorized := func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) }
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){"sk-ant-oat01-a": unauthorized, "oauth-token": unauthorized})
	accounts := append(claudeAccounts("a"), services.ResolvedProviderConnection{ConnectionID: "o", Provider: "claude", Kind: "oauth", AccessToken: "oauth-token", HasRefreshToken: true})
	pool := &fakePool{pooled: true, accounts: accounts, limited: map[string]time.Time{}, refreshOK: true}

	rec := proxyRequest(t, poolHandler(pool, upstream.URL), "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())

	assert.Equal(t, []string{"a", "o"}, pool.rejected, "a refused setup token, and an OAuth token refused again after its refresh, need a reconnect")
	assert.Equal(t, []string{"o"}, pool.refreshed, "a refused OAuth token is refreshed once and retried")
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "every account was tried for this call")

	// A refresh that fixes the token serves the same request.
	calls = nil
	fixed := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){"oauth-token": unauthorized})
	single := &fakePool{pooled: true, limited: map[string]time.Time{}, refreshOK: true, accounts: []services.ResolvedProviderConnection{{ConnectionID: "o", Provider: "claude", Kind: "oauth", AccessToken: "oauth-token", HasRefreshToken: true}}}
	h := poolHandler(single, fixed.URL)
	single.onRefresh = func() { single.accounts[0].AccessToken = "fresh-token" }
	rec = proxyRequest(t, h, "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, single.rejected)

	pool = &fakePool{pooled: true, reconnect: true, limited: map[string]time.Time{}}
	rec = proxyRequest(t, poolHandler(pool, upstream.URL), "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Body.String(), "authentication_error")
}

func TestProviderPool_ChatGPTAccountsAndPaths(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"codex-a": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"type":"usage_limit_reached","resets_in_seconds":7200}}`)
		},
	})
	pool := &fakePool{pooled: true, limited: map[string]time.Time{}, accounts: []services.ResolvedProviderConnection{
		{ConnectionID: "a", Provider: "codex", Kind: "oauth", AccessToken: "codex-a", AccountID: "acct-a"},
		{ConnectionID: "b", Provider: "codex", Kind: "oauth", AccessToken: "codex-b", AccountID: "acct-b"},
	}}
	h := poolHandler(pool, upstream.URL)

	rec := proxyRequest(t, h, "/api/model/chatgpt/codex/responses", `{"model":"gpt-6-luna","stream":true,"input":[]}`, workspaceContext())

	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, calls, 2)
	assert.Equal(t, "/codex/responses", calls[1].path)
	assert.Equal(t, "Bearer codex-b", calls[1].auth)
	assert.Equal(t, "acct-b", calls[1].account)
	assert.WithinDuration(t, time.Now().Add(2*time.Hour), pool.limited["a"], time.Minute)

	calls = nil
	rec = proxyRequest(t, h, "/api/model/chatgpt/backend-api/accounts", `{"model":"x"}`, workspaceContext())
	assert.Equal(t, http.StatusNotFound, rec.Code, "only the inference path is served with an account")
	assert.Empty(t, calls)
}

func TestProviderPool_RefusesWithoutAWorkspaceCredentialOrAPool(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, nil)
	pool := &fakePool{pooled: true, accounts: claudeAccounts("a"), limited: map[string]time.Time{}}
	h := poolHandler(pool, upstream.URL)
	h.Scopes = fakeScopes{ok: false}
	rec := proxyRequest(t, h, "/provider-pool/anthropic/v1/messages", messagesBody, workspaceContext())
	assert.Equal(t, http.StatusForbidden, rec.Code, "a credential not bound to a workspace never spends an account")

	h = poolHandler(&fakePool{limited: map[string]time.Time{}}, upstream.URL)
	rec = proxyRequest(t, h, "/provider-pool/anthropic/v1/messages", messagesBody, workspaceContext())
	assert.Equal(t, http.StatusNotFound, rec.Code, "no connected accounts: nothing to serve, no platform fallback")
	assert.Empty(t, calls)

	rec = httptest.NewRecorder()
	ProviderPoolAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer key-from-sdk", r.Header.Get("Authorization"), "an Anthropic SDK key header is the bearer")
		assert.Empty(t, r.Header.Get("Cookie"))
	})).ServeHTTP(rec, func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/provider-pool/anthropic/v1/messages", nil)
		req.Header.Set("X-Api-Key", "key-from-sdk")
		req.Header.Set("Cookie", "session=abc")
		return req
	}())
	rec = httptest.NewRecorder()
	ProviderPoolAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("a cookie alone never authenticates") })).
		ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/provider-pool/anthropic/v1/messages", nil))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestProviderPool_StreamedLimitParksTheAccount(t *testing.T) {
	var calls []providerCall
	stream := "event: error\n" + `data: {"type":"error","error":{"type":"rate_limit_error","message":"limit"}}` + "\n\n"
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"sk-ant-oat01-a": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, stream)
		},
	})
	pool := &fakePool{pooled: true, accounts: claudeAccounts("a"), limited: map[string]time.Time{}}

	rec := proxyRequest(t, poolHandler(pool, upstream.URL), "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())

	assert.Equal(t, stream, rec.Body.String(), "output already sent is never retried")
	assert.Contains(t, pool.limited, "a")
}

func TestProviderPool_NeverFollowsARedirectWithAnAccountCredential(t *testing.T) {
	var leaked string
	elsewhere := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { leaked = r.Header.Get("Authorization") }))
	t.Cleanup(elsewhere.Close)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)
	pool := &fakePool{pooled: true, accounts: claudeAccounts("a"), limited: map[string]time.Time{}}

	proxyRequest(t, poolHandler(pool, redirect.URL), "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())
	assert.Empty(t, leaked)
}

func TestModelPoolLimitReset(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	h := http.Header{}
	assert.Equal(t, now.Add(5*time.Minute), modelPoolLimitReset(h, nil, now), "unknown: a short default")
	h.Set("Retry-After", "90")
	assert.Equal(t, now.Add(90*time.Second), modelPoolLimitReset(h, nil, now))
	assert.Equal(t, time.Unix(1_800_003_600, 0), modelPoolLimitReset(h, []byte(`{"error":{"resets_at":1800003600}}`), now), "the body's reset wins")
	assert.Equal(t, now.Add(30*time.Second), modelPoolLimitReset(http.Header{"Retry-After": {"1"}}, nil, now), "clamped up")
	assert.Equal(t, now.Add(7*24*time.Hour), modelPoolLimitReset(nil, []byte(`{"error":{"resets_in_seconds":99999999}}`), now), "clamped down")
	unified := http.Header{}
	unified.Set("Anthropic-Ratelimit-Unified-Reset", "1800007200")
	assert.Equal(t, time.Unix(1_800_007_200, 0), modelPoolLimitReset(unified, nil, now))
}

func TestWithClaudeCodeIdentity(t *testing.T) {
	system := func(body []byte) any {
		var doc map[string]any
		require.NoError(t, json.Unmarshal(body, &doc))
		return doc["system"]
	}
	identity := map[string]any{"type": "text", "text": claudeCodeIdentity}
	assert.Equal(t, []any{identity}, system(withClaudeCodeIdentity([]byte(`{"model":"m"}`))))
	assert.Equal(t, []any{identity, map[string]any{"type": "text", "text": "x"}}, system(withClaudeCodeIdentity([]byte(`{"system":"x"}`))))
	led := []byte(`{"system":[{"type":"text","text":"` + claudeCodeIdentity + ` more"}]}`)
	assert.Equal(t, led, withClaudeCodeIdentity(led))
	assert.Equal(t, []byte("not json"), withClaudeCodeIdentity([]byte("not json")))
}

func atoi(value string) int {
	n := 0
	for _, c := range value {
		n = n*10 + int(c-'0')
	}
	return n
}

type fakePoolUses struct {
	mu   sync.Mutex
	uses []string
}

func (u *fakePoolUses) RecordWorkspaceProviderUse(_ context.Context, workspaceID, connectionID, model string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.uses = append(u.uses, workspaceID+"|"+connectionID+"|"+model)
	return nil
}

func TestProviderPool_RecordsTheAccountThatTookTheCall(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"sk-ant-oat01-a": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"rate_limit_error","message":"usage limit"}}`)
		},
	})
	pool := &fakePool{pooled: true, accounts: claudeAccounts("a", "b"), limited: map[string]time.Time{}}
	uses := &fakePoolUses{}
	h := poolHandler(pool, upstream.URL)
	h.Uses = uses

	rec := proxyRequest(t, h, "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())
	require.Equal(t, http.StatusOK, rec.Code)
	h.recorded.Wait()
	assert.Equal(t, []string{"ws1|b|claude-sonnet-4-6"}, uses.uses, "only the account that answered is recorded, with the model the call named")

	// A model field that is not a model id is not recorded as one.
	rec = proxyRequest(t, h, "/api/model/anthropic/v1/messages", `{"model":"sk-ant-oat01 secret\n","messages":[]}`, workspaceContext())
	require.Equal(t, http.StatusOK, rec.Code)
	h.recorded.Wait()
	require.Len(t, uses.uses, 2)
	assert.Equal(t, "ws1|b|", uses.uses[1])

	// Nothing is recorded when no account takes the call.
	pool.limited["b"] = time.Now().Add(time.Hour)
	pool.nextReset = time.Now().Add(time.Hour)
	rec = proxyRequest(t, h, "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	h.recorded.Wait()
	assert.Len(t, uses.uses, 2)
}

func TestProviderPool_ARefusedCallIsNotCountedAndARecordNeverHoldsTheCall(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"sk-ant-oat01-a": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"invalid_request_error","message":"unknown model"}}`)
		},
	})
	release := make(chan struct{})
	uses := &blockingPoolUses{release: release}
	h := poolHandler(&fakePool{pooled: true, accounts: claudeAccounts("a"), limited: map[string]time.Time{}}, upstream.URL)
	h.Uses = uses
	rec := proxyRequest(t, h, "/api/model/anthropic/v1/messages", `{"model":"made-up-model","messages":[]}`, workspaceContext())
	require.Equal(t, http.StatusBadRequest, rec.Code, "the provider's refusal reaches the caller")
	h.recorded.Wait()
	assert.Zero(t, uses.count(), "a refused call is not a call the account ran")

	h = poolHandler(&fakePool{pooled: true, accounts: claudeAccounts("b"), limited: map[string]time.Time{}}, upstream.URL)
	h.Uses = uses
	rec = proxyRequest(t, h, "/api/model/anthropic/v1/messages", messagesBody, workspaceContext())
	require.Equal(t, http.StatusOK, rec.Code, "the answer is relayed while its record is still waiting")
	assert.Equal(t, anthropicStream, rec.Body.String())
	close(release)
	h.recorded.Wait()
	assert.Equal(t, 1, uses.count())
}

type blockingPoolUses struct {
	release chan struct{}
	mu      sync.Mutex
	n       int
}

func (u *blockingPoolUses) RecordWorkspaceProviderUse(context.Context, string, string, string) error {
	<-u.release
	u.mu.Lock()
	defer u.mu.Unlock()
	u.n++
	return nil
}

func (u *blockingPoolUses) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.n
}
