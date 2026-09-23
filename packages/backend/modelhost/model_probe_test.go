package modelhost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type fixtureTester func(context.Context, int64, json.RawMessage) (json.RawMessage, error)

func (f fixtureTester) RunModelTest(ctx context.Context, owner int64, body json.RawMessage) (json.RawMessage, error) {
	return f(ctx, owner, body)
}

func TestOwnerModelTestRequestAndResult(t *testing.T) {
	const requestBody = `{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY","baseUrl":"http://127.0.0.1:3000"},"input":{"kind":"generation","system":"","prompt":"Hello","maxTokens":64}}`
	wanted := json.RawMessage(`{"ok":true,"latencyMs":12,"sample":"pong","output":{"kind":"generation","text":"pong"}}`)
	called := false
	models := OwnerModels{Tester: fixtureTester(func(_ context.Context, owner int64, body json.RawMessage) (json.RawMessage, error) {
		called = true
		require.EqualValues(t, 42, owner)
		require.JSONEq(t, requestBody, string(body))
		return wanted, nil
	})}
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(requestBody))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
	response := httptest.NewRecorder()
	models.Test(response, request)
	require.True(t, called)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, string(wanted), response.Body.String())

	for _, body := range []string{`{}`, `{"model":null}`, `{"model":{},"secret":"key"}`} {
		response := httptest.NewRecorder()
		models.Test(response, httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(body)).WithContext(request.Context()))
		require.Equal(t, http.StatusBadRequest, response.Code)
	}
	response = httptest.NewRecorder()
	models.Test(response, httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(requestBody)))
	require.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestOwnerModelTestRejectsMalformedModelBeforeTester(t *testing.T) {
	calls := 0
	models := OwnerModels{Tester: fixtureTester(func(context.Context, int64, json.RawMessage) (json.RawMessage, error) {
		calls++
		return nil, nil
	})}
	for _, model := range []string{
		`{}`,
		`{"id":"writer","protocol":"unknown","modelId":"fixture","credential":"TEST_KEY"}`,
		`{"id":"default","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"bad id","credential":"TEST_KEY"}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"bad_key"}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY","baseUrl":null}`,
		`{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY","secret":"key"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(`{"model":`+model+`}`))
		request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
		response := httptest.NewRecorder()
		models.Test(response, request)
		require.Equal(t, http.StatusBadRequest, response.Code, model)
		require.JSONEq(t, `{"code":"request_invalid"}`, response.Body.String())
	}
	require.Zero(t, calls)
}

func TestOwnerModelTestMissingCredentialIsTyped(t *testing.T) {
	models := OwnerModels{Tester: fixtureTester(func(context.Context, int64, json.RawMessage) (json.RawMessage, error) {
		return nil, ports.ErrModelCredentialMissing
	})}
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(`{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"MISSING_KEY"}}`))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
	response := httptest.NewRecorder()
	models.Test(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"ok":false,"latencyMs":0,"failure":{"code":"credential_missing","credential":"MISSING_KEY"},"fault":"user"}`, response.Body.String())
}

func TestPrivateModelProbeForwardsOnlyAuthenticatedOwnerRequest(t *testing.T) {
	const body = `{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}}`
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/model/test", r.URL.Path)
		require.Equal(t, "Bearer private-token", r.Header.Get("Authorization"))
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		_, _ = w.Write([]byte(`{"ok":false,"latencyMs":9,"failure":{"code":"refused","status":429},"fault":"wait"}`))
	}))
	defer private.Close()
	lease := &testLease{origin: private.URL}
	host, err := New(ResolverFunc(func(_ context.Context, owner, repository int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 42, owner)
		require.Zero(t, repository)
		require.JSONEq(t, body, string(request))
		return Binding{Model: json.RawMessage(`{"protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}`), CredentialName: "TEST_KEY", CredentialValue: "private-key"}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	result, err := host.RunModelTest(context.Background(), 42, json.RawMessage(body))
	require.NoError(t, err)
	require.JSONEq(t, `{"ok":false,"latencyMs":9,"failure":{"code":"refused","status":429},"fault":"wait"}`, string(result))
	require.True(t, lease.closed)
}

func TestOwnerModelTestComposesThroughPrivateHost(t *testing.T) {
	const body = `{"model":{"id":"writer","protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"},"input":{"kind":"generation","system":"","prompt":"ping","maxTokens":64}}`
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer private-token", r.Header.Get("Authorization"))
		require.Equal(t, "/v1/model/test", r.URL.Path)
		var request json.RawMessage
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		require.JSONEq(t, body, string(request))
		_, _ = w.Write([]byte(`{"ok":true,"latencyMs":7,"sample":"pong","output":{"kind":"generation","text":"pong"}}`))
	}))
	defer private.Close()
	lease := &testLease{origin: private.URL}
	host, err := New(ResolverFunc(func(_ context.Context, owner, repository int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 42, owner)
		require.Zero(t, repository)
		require.JSONEq(t, body, string(request))
		return Binding{Model: json.RawMessage(`{"protocol":"openai-chat","modelId":"fixture","credential":"TEST_KEY"}`), CredentialName: "TEST_KEY", CredentialValue: "secret"}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	models := OwnerModels{Tester: host}
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(body))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 42}}))
	response := httptest.NewRecorder()
	models.Test(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"ok":true,"latencyMs":7,"sample":"pong","output":{"kind":"generation","text":"pong"}}`, response.Body.String())
	require.True(t, lease.closed)
}

func TestPrivateModelProbeCancelsAndCleansLease(t *testing.T) {
	arrived := make(chan struct{})
	release := make(chan struct{})
	private := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(arrived)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer private.Close()
	defer close(release)
	lease := &testLease{origin: private.URL}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := host.RunModelTest(ctx, 42, json.RawMessage(`{"model":{}}`)); done <- err }()
	select {
	case <-arrived:
	case <-time.After(time.Second):
		t.Fatal("private host was not called")
	}
	cancel()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("cancelled probe did not stop")
	}
	require.True(t, lease.closed)
}
