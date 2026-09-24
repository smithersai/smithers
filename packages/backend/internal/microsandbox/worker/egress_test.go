package worker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	upstream "github.com/superradcompany/microsandbox/sdk/go"

	"github.com/smithersai/smithers/packages/backend/internal/ironproxy"
	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestCreateFailsClosedWhenEgressProxyIsRequestedButUnavailable(t *testing.T) {
	// The typed refusal must fire before any SDK connection: an image that
	// could never be pulled proves the runtime was never consulted.
	runtime := NewSDKRuntime()
	sentinel := "PLUE_SECRET_SENTINEL_egress_unavailable"
	_, err := runtime.Create(context.Background(), "msb_egress", 1, sandbox.CreateRequest{
		Image: "registry.invalid/never:pulled",
		EgressProxy: &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{
			Name: "ANTHROPIC_API_KEY", Value: sentinel, Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"x-api-key"},
		}}},
	})
	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
	assert.NotContains(t, err.Error(), sentinel)
}

func TestApplyEgressProxyMakesTheProxyTheOnlyEgressPath(t *testing.T) {
	t.Parallel()
	endpoint := EgressProxyEndpoint{
		Port: 41007, URL: ironproxy.GuestProxyURL(41007),
		Env: ironproxy.GuestEnv(ironproxy.GuestProxyURL(41007), sandbox.EgressProxyCAGuestPath),
	}
	request := applyEgressProxy(sandbox.CreateRequest{
		Internet: "public",
		Firewall: &sandbox.FirewallPolicy{EgressAllow: []sandbox.FirewallEgressRule{{Host: "*"}}},
		Files:    map[string]sandbox.SandboxFile{"/opt/x": {Content: "keep"}},
		Init: &sandbox.ServiceConfig{Enabled: true, Services: []sandbox.ServiceSpec{{
			Name: "agent", Env: map[string]string{"HOME": "/root", "HTTPS_PROXY": "http://evil:1"},
		}}},
	}, endpoint, []byte("-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n"))

	require.NotNil(t, request.Firewall)
	assert.Equal(t, "deny", request.Firewall.DefaultEgressAction)
	assert.Empty(t, request.Internet)
	policy := networkPolicy(request)
	assert.Equal(t, upstream.PolicyActionDeny, policy.DefaultEgress)
	var proxyRule bool
	for _, rule := range policy.Rules {
		assert.Equal(t, "host", rule.Destination, "every allow targets the sandbox host, never the internet")
		if rule.Port == "41007" && rule.Protocol == upstream.PolicyProtocolTCP {
			proxyRule = true
		}
	}
	assert.True(t, proxyRule, "the proxy port on the host is the one allowed TCP destination")

	assert.Equal(t, "keep", request.Files["/opt/x"].Content)
	assert.Contains(t, request.Files[sandbox.EgressProxyCAGuestPath].Content, "BEGIN CERTIFICATE")
	profile := request.Files[sandbox.EgressProxyEnvGuestPath].Content
	for name, value := range endpoint.Env {
		assert.Contains(t, profile, "export "+name+"="+shellQuote(value), "terminal profile must match the service environment")
	}
	assert.NotContains(t, profile, "ANTHROPIC_API_KEY")
	loader := request.Files[sandbox.EgressProxyProfileGuestPath].Content
	assert.Contains(t, loader, sandbox.EgressProxyEnvGuestPath)
	assert.Contains(t, loader, "/etc/smithers/workspace-git.env")

	env := request.Init.Services[0].Env
	assert.Equal(t, "/root", env["HOME"])
	assert.Equal(t, endpoint.URL, env["HTTPS_PROXY"], "a service-supplied proxy override cannot bypass the boundary")
	assert.Equal(t, sandbox.EgressProxyCAGuestPath, env["SSL_CERT_FILE"])
	assert.Equal(t, sandbox.EgressProxyCAGuestPath, env["NODE_EXTRA_CA_CERTS"])
}

func TestEgressTrustStoreHookIsPOSIXAndGuardedByPresence(t *testing.T) {
	t.Parallel()
	hook := egressTrustStoreHook("/etc/smithers/egress-ca.pem")
	assert.True(t, strings.HasPrefix(hook, "if command -v update-ca-certificates"), "only runs where a Debian-style trust store exists")
	assert.NotContains(t, hook, "bash", "the guest may not ship bash (NixOS images)")
	assert.Contains(t, hook, "|| true", "a missing trust store never fails bootstrap")
}

func TestRedactCredentialShapesInRelayedProxyLogs(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "authorization: Bearer [redacted] ok", redactCredentialShapes("authorization: Bearer sk-ant-123 ok"))
	assert.Equal(t, `{"host":"api.anthropic.com"}`, redactCredentialShapes(`{"host":"api.anthropic.com"}`))
}

func TestParseEgressAuditRecordProjectsOnlySafeBoundedFields(t *testing.T) {
	t.Parallel()
	line := `{"time":"2026-09-02T15:00:00.123Z","msg":"request","audit":{"host":"API.CEREBRAS.AI","method":"post","path":"/v1/chat?api_key=must-not-survive","status":201,"allowed":true,"request_transforms":{"secrets":{"annotations":{"swapped":[{"secret":"CEREBRAS_API_KEY","locations":["header:authorization"]}]}}}}}`
	record, err := parseEgressAuditRecord("msb_audit", []byte(line))
	require.NoError(t, err)
	assert.Equal(t, "msb_audit", record.SandboxID)
	assert.Equal(t, "api.cerebras.ai", record.Host)
	assert.Equal(t, "POST", record.Method)
	assert.Equal(t, "/v1/chat", record.Path)
	assert.Equal(t, int32(201), record.Status)
	assert.True(t, record.Allowed)
	assert.Equal(t, []string{"CEREBRAS_API_KEY"}, record.SwappedSecretNames)
	assert.NotContains(t, string(record.TransformSummary), "authorization")
	assert.NotContains(t, string(record.TransformSummary), "must-not-survive")
}

func TestParseEgressAuditRecordSupportsArrayTransformTraceAndAction(t *testing.T) {
	t.Parallel()
	line := `{"time":1788361200,"msg":"request","audit":{"host":"api.openai.com","method":"POST","path":"/v1/responses","action":"deny","status_code":403,"request_transforms":[{"name":"allowlist","action":"continue"},{"name":"secrets","action":"continue","annotations":{"swapped":[{"secret":"OPENAI_API_KEY","locations":["header:Authorization"]}],"unrelated":{"secret":"MUST_NOT_BE_COLLECTED"}}}]}}`
	record, err := parseEgressAuditRecord("msb_array", []byte(line))
	require.NoError(t, err)
	assert.False(t, record.Allowed)
	assert.Equal(t, int32(403), record.Status)
	assert.Equal(t, []string{"OPENAI_API_KEY"}, record.SwappedSecretNames)
	assert.JSONEq(t, `{"request_transform_count":2,"response_transform_count":0,"swapped_secret_count":1}`, string(record.TransformSummary))
}

func TestParseEgressAuditRecordRedactsAPathThatReceivedASecretValue(t *testing.T) {
	t.Parallel()
	line := `{"time":"2026-09-02T15:00:00Z","msg":"request","audit":{"host":"example.com","method":"GET","path":"/account/arbitrary-secret-value","status_code":200,"request_transforms":[{"name":"secrets","annotations":{"swapped":[{"secret":"ACCOUNT_TOKEN","locations":["path"]}]}}]}}`
	record, err := parseEgressAuditRecord("msb_path", []byte(line))
	require.NoError(t, err)
	assert.Equal(t, "/[redacted]", record.Path)
	assert.NotContains(t, record.Path, "arbitrary-secret-value")
}

func TestRelayLogsDropsAuditWithoutBlockingOnBackpressure(t *testing.T) {
	t.Parallel()
	dropped := make(chan string, 1)
	manager := &EgressProxyManager{
		config: EgressProxyConfig{
			Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
			AuditDropped: func(reason string) { dropped <- reason },
		},
		audit: make(chan msb.SandboxEgressAuditRecord, 1),
	}
	line := `{"time":"2026-09-02T15:00:00Z","msg":"request","audit":{"host":"example.com","method":"GET","path":"/","status":200,"allowed":true}}`
	manager.relayLogs(manager.config.Logger, "msb_backpressure", strings.NewReader(line+"\n"+line+"\n"))
	assert.Len(t, manager.audit, 1)
	assert.Equal(t, "backpressure", <-dropped)
}

func TestEgressProxyManagerRefusesMissingBinary(t *testing.T) {
	t.Parallel()
	ca, err := ironproxy.GenerateCA("test", time.Hour)
	require.NoError(t, err)
	_, err = NewEgressProxyManager(EgressProxyConfig{Binary: filepath.Join(t.TempDir(), "missing"), Dir: t.TempDir(), CA: ca})
	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
}

func TestEgressProxyManagerStartFailsClosedWhenTheProcessNeverListens(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	binary := filepath.Join(dir, "fake-iron-proxy")
	// A "proxy" that exits immediately without listening. The manager must
	// report the typed error and never leak the sandbox's credential value.
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexit 3\n"), 0o755))
	ca, err := ironproxy.GenerateCA("test", time.Hour)
	require.NoError(t, err)
	manager, err := NewEgressProxyManager(EgressProxyConfig{Binary: binary, Dir: dir, CA: ca, StartTimeout: 2 * time.Second})
	require.NoError(t, err)
	sentinel := "PLUE_SECRET_SENTINEL_never_listens"
	_, err = manager.Start(context.Background(), "msb_dead", &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{
		Name: "TOKEN", Value: sentinel, Hosts: []string{"example.test"}, MatchHeaders: []string{"authorization"},
	}}})
	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
	assert.NotContains(t, err.Error(), sentinel)
	assert.False(t, manager.Required("msb_dead"), "a failed start leaves no marker behind")
	_, live := manager.Endpoint("msb_dead")
	assert.False(t, live)
	entries, _ := os.ReadDir(filepath.Join(dir, "sandboxes"))
	assert.Empty(t, entries, "config dir is removed on failure")
}

// A guest that exits on its own is removed by the runtime without any Delete
// reaching the worker; the periodic reap must stop its proxy (and the
// credentials in that process's environment) and suspend proxies of guests
// that are merely stopped.
func TestEgressProxyManagerReapsProxiesWhoseGuestIsGone(t *testing.T) {
	binary := ironProxyBinary(t)
	dir := t.TempDir()
	ca, err := ironproxy.GenerateCA("reap", time.Hour)
	require.NoError(t, err)
	manager, err := NewEgressProxyManager(EgressProxyConfig{Binary: binary, Dir: dir, CA: ca, StartTimeout: 15 * time.Second, PortMin: 42100, PortMax: 42199})
	require.NoError(t, err)
	t.Cleanup(manager.StopAll)
	policy := func() *sandbox.EgressProxyPolicy {
		return &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{
			Name: "K", Value: "v", Hosts: []string{"example.test"}, MatchHeaders: []string{"authorization"},
		}}}
	}
	for _, id := range []string{"msb_gone", "msb_stopped", "msb_live", "msb_unknown", "msb_creating"} {
		_, err := manager.Start(context.Background(), id, policy())
		require.NoError(t, err, id)
	}
	// msb_gone vanished long ago; msb_creating started just now and the runtime
	// does not know it yet because Create registers the guest after the proxy.
	manager.mu.Lock()
	for _, id := range []string{"msb_gone", "msb_stopped", "msb_live", "msb_unknown"} {
		manager.procs[id].startedAt = time.Now().Add(-egressProxyReapGrace - time.Minute)
	}
	manager.mu.Unlock()
	lookup := func(_ context.Context, id string) (sandbox.Sandbox, error) {
		switch id {
		case "msb_gone", "msb_creating":
			return sandbox.Sandbox{}, errors.New("sandbox " + id + " not found")
		case "msb_stopped":
			return sandbox.Sandbox{ID: id, State: sandbox.StateStopped}, nil
		case "msb_unknown":
			return sandbox.Sandbox{}, errors.New("runtime unavailable")
		}
		return sandbox.Sandbox{ID: id, State: sandbox.StateRunning}, nil
	}
	stopped, suspended := manager.ReapOrphans(context.Background(), lookup)
	assert.Equal(t, 1, stopped)
	assert.Equal(t, 1, suspended)
	_, goneLive := manager.Endpoint("msb_gone")
	assert.False(t, goneLive)
	assert.False(t, manager.Required("msb_gone"), "a vanished guest's binding is forgotten")
	_, stoppedLive := manager.Endpoint("msb_stopped")
	assert.False(t, stoppedLive)
	assert.True(t, manager.Required("msb_stopped"), "a stopped guest stays proxy-backed so Start fails closed")
	_, live := manager.Endpoint("msb_live")
	assert.True(t, live, "a running guest keeps its proxy")
	_, unknownLive := manager.Endpoint("msb_unknown")
	assert.True(t, unknownLive, "a runtime error is not evidence the guest is gone")
	_, creatingLive := manager.Endpoint("msb_creating")
	assert.True(t, creatingLive, "a proxy younger than the reap grace is a create in flight, not an orphan")
}

func ironProxyBinary(t *testing.T) string {
	t.Helper()
	if path := strings.TrimSpace(os.Getenv("SMITHERS_TEST_IRON_PROXY_BIN")); path != "" {
		return path
	}
	path, err := exec.LookPath("iron-proxy")
	if err != nil {
		t.Skip("iron-proxy binary not on PATH; set SMITHERS_TEST_IRON_PROXY_BIN to run the integration test")
	}
	return path
}

// TestEgressProxyIntegrationSubstitutesBoundSecretAndDeniesUnboundHosts
// drives the real iron-proxy binary: the client sends the NAME placeholder,
// the upstream receives the real value, and a host outside the allowlist is
// rejected before any upstream connection. The proxy's own environment is the
// only place the value exists; the rendered config on disk never contains it.
func TestEgressProxyIntegrationSubstitutesBoundSecretAndDeniesUnboundHosts(t *testing.T) {
	binary := ironProxyBinary(t)
	sentinel := "PLUE_SECRET_SENTINEL_real_value_" + t.Name()
	var seenHeader string
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		seenHeader = request.Header.Get("x-api-key")
		_, _ = io.WriteString(writer, "upstream-ok")
	}))
	defer upstreamServer.Close()
	upstreamURL, err := url.Parse(upstreamServer.URL)
	require.NoError(t, err)

	dir := t.TempDir()
	ca, err := ironproxy.GenerateCA("integration", time.Hour)
	require.NoError(t, err)
	manager, err := NewEgressProxyManager(EgressProxyConfig{
		Binary: binary, Dir: dir, CA: ca, StartTimeout: 15 * time.Second,
		PortMin: 42000, PortMax: 42099,
		allowCIDRs: []string{"127.0.0.0/8"}, upstreamDenyCIDRs: []string{},
	})
	require.NoError(t, err)
	t.Cleanup(manager.StopAll)

	endpoint, err := manager.Start(context.Background(), "msb_integration", &sandbox.EgressProxyPolicy{
		Enabled: true,
		Secrets: []sandbox.EgressProxySecret{{
			Name: "TEST_API_KEY", Value: sentinel, Hosts: []string{"127.0.0.0/8"}, MatchHeaders: []string{"x-api-key"},
		}},
	})
	require.NoError(t, err)
	assert.True(t, manager.Required("msb_integration"))

	configBytes, err := os.ReadFile(filepath.Join(dir, "sandboxes", "msb_integration", "proxy.yaml"))
	require.NoError(t, err)
	assert.NotContains(t, string(configBytes), sentinel, "the rendered config names the env var, never the value")

	proxyURL, err := url.Parse("http://127.0.0.1:" + itoa(endpoint.Port))
	require.NoError(t, err)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 10 * time.Second}

	request, err := http.NewRequest(http.MethodGet, "http://"+upstreamURL.Host+"/v1/messages", nil)
	require.NoError(t, err)
	request.Header.Set("x-api-key", sandbox.EgressProxyPlaceholder("TEST_API_KEY"))
	response, err := client.Do(request)
	require.NoError(t, err)
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode, string(body))
	assert.Equal(t, sentinel, seenHeader, "the upstream received the real value")

	denied, err := http.NewRequest(http.MethodGet, "http://unbound.invalid/", nil)
	require.NoError(t, err)
	deniedResponse, err := client.Do(denied)
	require.NoError(t, err)
	_ = deniedResponse.Body.Close()
	assert.Equal(t, http.StatusForbidden, deniedResponse.StatusCode, "hosts outside the allowlist are rejected by the proxy")

	// A second sandbox on the same host must get its own four listener ports
	// and come up beside the first: the production failure this guards was
	// iron-proxy's default metrics listener colliding on :9090.
	second, err := manager.Start(context.Background(), "msb_integration_2", &sandbox.EgressProxyPolicy{
		Enabled: true,
		Secrets: []sandbox.EgressProxySecret{{Name: "OTHER_KEY", Value: "other", Hosts: []string{"127.0.0.0/8"}, MatchHeaders: []string{"authorization"}}},
	})
	require.NoError(t, err, "two proxies must coexist on one worker")
	assert.NotEqual(t, endpoint.Port, second.Port)
	_, firstLive := manager.Endpoint("msb_integration")
	_, secondLive := manager.Endpoint("msb_integration_2")
	assert.True(t, firstLive && secondLive)
	manager.Stop("msb_integration_2")

	manager.Suspend("msb_integration")
	_, live := manager.Endpoint("msb_integration")
	assert.False(t, live)
	assert.True(t, manager.Required("msb_integration"), "a suspended sandbox stays proxy-backed")
	// Resume must reuse the retained firewall port and replace the old token.
	resumed, err := manager.Resume(context.Background(), "msb_integration", &sandbox.EgressProxyPolicy{
		Enabled: true, Secrets: []sandbox.EgressProxySecret{{Name: "TEST_API_KEY", Value: "refreshed-token", Hosts: []string{"127.0.0.0/8"}, MatchHeaders: []string{"x-api-key"}}},
	})
	require.NoError(t, err)
	assert.Equal(t, endpoint.Port, resumed.Port)
	client.CloseIdleConnections()
	response, err = client.Do(request)
	require.NoError(t, err)
	_ = response.Body.Close()
	assert.Equal(t, "refreshed-token", seenHeader)
	manager.Stop("msb_integration")
	assert.False(t, manager.Required("msb_integration"))
}

func itoa(value int) string { return strconv.Itoa(value) }

// Tenant-chosen secret names must never become iron-proxy config variables or
// upstream proxy overrides. Those would redirect DNS resolution to a proxy.
func TestEgressProxySecretsCannotConfigureProxy(t *testing.T) {
	for _, name := range []string{"HTTPS_PROXY", "ALL_PROXY", "IRON_PROXY_UPSTREAM_DENY_CIDRS", "PATH", "HOME"} {
		t.Run(name, func(t *testing.T) {
			bindings, env := egressProxySecretBindings([]sandbox.EgressProxySecret{{Name: name, Value: "tenant-value", Hosts: []string{"api.example.com"}}})
			require.Len(t, bindings, 1)
			assert.Equal(t, "SMITHERS_EGRESS_SECRET_0", bindings[0].EnvVar)
			assert.Equal(t, sandbox.EgressProxyPlaceholder(name), bindings[0].ProxyValue)
			assert.Equal(t, []string{"SMITHERS_EGRESS_SECRET_0=tenant-value"}, env)
		})
	}
}
