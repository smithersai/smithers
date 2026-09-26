package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// fastRepoGatewaySleep keeps probe-retry tests off wall-clock time.
func fastRepoGatewaySleep(svc *RepoGatewayService) {
	svc.sleep = func(ctx context.Context, _ time.Duration) error { return nil }
}

var testGatewayModelSeats = []modelproxy.Seat{modelproxy.Seats[2], modelproxy.Seats[4]}

// assertGatewayModelSeat checks that a gateway reaches its platform seats
// through the metered model proxy as egress-proxy placeholders. The minted
// model credential lives only in the gateway's egress proxy, swapped in on
// requests to the Smithers API host, so code the repository runs in the VM
// cannot read it from /proc/*/environ and spend the owner's credit from
// elsewhere. The platform key never enters at all.
func assertGatewayModelSeat(t *testing.T, env map[string]string, egress *sandbox.EgressProxyPolicy) {
	t.Helper()
	require.NotNil(t, egress, "the VM (re)start must bind the seats at its egress proxy")
	require.True(t, egress.Enabled)
	require.NoError(t, egress.Validate())
	bound := map[string]sandbox.EgressProxySecret{}
	for _, secret := range egress.Secrets {
		bound[secret.Name] = secret
	}
	credential := bound["CEREBRAS_API_KEY"].Value
	assert.True(t, strings.HasPrefix(credential, "smithers_"), "the seat is bound to a Smithers model credential")
	for _, name := range []string{"CEREBRAS_API_KEY", "AI_GATEWAY_API_KEY"} {
		assert.Equal(t, sandbox.EgressProxyPlaceholder(name), env[name], "the guest holds only the placeholder")
		assert.Equal(t, credential, bound[name].Value, name)
		assert.Equal(t, []string{"jjhub.example"}, bound[name].Hosts, "the credential is swapped only toward the Smithers API host")
		assert.ElementsMatch(t, []string{"authorization", "x-api-key"}, bound[name].MatchHeaders)
	}
	for name, value := range env {
		assert.NotEqual(t, credential, value, "%s must not carry the model credential", name)
	}
	assert.Equal(t, "https://jjhub.example/model-proxy", env[modelproxy.URLEnv])
	assert.Equal(t, "cerebras,vercel", env[modelproxy.ProvidersEnv])
	assert.Equal(t, "https://jjhub.example/model-proxy/vercel/v4/ai/evaluation-model", env["SMITHERS_EVALUATOR_BASE_URL"])
}

func TestRepoGatewayProvision_PlatformSeatsUseTheMeteredModelProxy(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayModelSeats(testGatewayModelSeats))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "running", info.Status)

	for _, req := range vm.execAwaitReqs {
		assert.NotContains(t, req.Command, "smithers init --global")
		assert.NotContains(t, req.Command, "SMITHERS_GATEWAY_ENGINE_PATCH")
	}
	require.Len(t, vm.systemdSpecs, 1)
	require.Len(t, vm.createVMReqs, 1)
	assertGatewayModelSeat(t, vm.systemdSpecs[0].Env, vm.createVMReqs[0].EgressProxy)
	var minted []string
	for _, token := range q.accessTokens {
		if strings.HasPrefix(token.Name, "model-proxy-gateway-") {
			minted = append(minted, token.Scopes)
		}
	}
	require.Len(t, minted, 1)
	assert.Contains(t, minted[0], "workspace:gateway-", "the credential is confined off the /api surface")
	assert.Contains(t, minted[0], "repo:200")
}

func TestRepoGatewayProvision_NoSeatStillInstallsProductHost(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)

	for _, req := range vm.execAwaitReqs {
		assert.NotContains(t, req.Command, "agents.ts", "no seat configured: stock generated pack must be untouched")
	}
	require.Len(t, vm.systemdSpecs, 1)
	_, hasKey := vm.systemdSpecs[0].Env["CEREBRAS_API_KEY"]
	assert.False(t, hasKey)
}

func TestRepoGatewayProvision_NoSeatSkipsEnginePatch(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	for _, req := range vm.execAwaitReqs {
		assert.NotContains(t, req.Command, "SMITHERS_GATEWAY_ENGINE_PATCH")
	}
}

func TestRepoGatewayReuse_LegacyGatewayReprovisions(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-old", VmID: "vm-old", Status: "running",
			BaseUrl: "https://old.example", AuthTokenCiphertext: "tok",
			LastActivityAt: time.Now(),
		},
	}
	one := int32(1)
	vm := &fakeRepoGatewayVMClient{
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			if vmID == "vm-old" && strings.Contains(req.Command, repoGatewayProductHostMarker) {
				// Stock pack: marker absent.
				return sandbox.ExecResult{StatusCode: &one}, nil
			}
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayModelSeats(testGatewayModelSeats))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.NotEqual(t, "gw-old", info.GatewayID, "pre-seat gateway must be discarded and reprovisioned")
	assert.Contains(t, vm.deletedVMIDs, "vm-old")
	assert.Contains(t, q.getSoftDeleted(), "gw-old")
	// The replacement carries the seat.
	require.NotEmpty(t, vm.systemdSpecs)
	require.NotEmpty(t, vm.createVMReqs)
	assertGatewayModelSeat(t, vm.systemdSpecs[len(vm.systemdSpecs)-1].Env, vm.createVMReqs[len(vm.createVMReqs)-1].EgressProxy)
}

func TestRepoGatewayReuse_HostCheckTransportErrorDoesNotDiscard(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-old", VmID: "vm-old", Status: "running",
			BaseUrl: "https://old.example", AuthTokenCiphertext: "tok",
			LastActivityAt: time.Now(),
		},
	}
	vm := &fakeRepoGatewayVMClient{
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return sandbox.ExecResult{}, errors.New("sandbox provider transport blip")
		},
	}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayModelSeats(testGatewayModelSeats))

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "check product gateway host")
	assert.NotContains(t, vm.deletedVMIDs, "vm-old", "a provider blip must never destroy a healthy gateway")
	assert.NotContains(t, q.getSoftDeleted(), "gw-old")
}

func TestRepoGatewayReuse_HealthProbeFailureReprovisions(t *testing.T) {
	t.Parallel()

	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "vm-wedged") {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer probe.Close()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-wedged", VmID: "vm-wedged", Status: "running",
			BaseUrl: "https://wedged.example", AuthTokenCiphertext: "tok",
			LastActivityAt: time.Now(),
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm,
		WithRepoGatewayHealthProbe(probe.URL, probe.Client()))
	fastRepoGatewaySleep(svc)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.NotEqual(t, "gw-wedged", info.GatewayID, "a gateway that never answers /health must be reprovisioned")
	assert.Contains(t, vm.deletedVMIDs, "vm-wedged")
	assert.Contains(t, q.getSoftDeleted(), "gw-wedged")
}

func TestRepoGatewayReuse_UnreachableIngressKeepsGateway(t *testing.T) {
	t.Parallel()

	// The preview ingress itself is down (Service gone, DNS dead, netpol
	// drop): the probe never reaches the component that knows whether the VM
	// answers, so it learned nothing about THIS gateway. Discarding here would
	// turn one ingress outage into a fleet-wide teardown — every reuse in the
	// pool fails identically and deletes a healthy VM plus its persistent
	// workspace on the way out.
	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	unreachable := probe.URL
	probe.Close()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-live", VmID: "vm-live", Status: "running",
			BaseUrl: "https://live.example", AuthTokenCiphertext: "tok",
			LastActivityAt: time.Now(),
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayHealthProbe(unreachable, nil))
	fastRepoGatewaySleep(svc)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "probe gateway health")
	assert.NotContains(t, vm.deletedVMIDs, "vm-live", "an ingress outage must never destroy a healthy gateway")
	assert.NotContains(t, q.getSoftDeleted(), "gw-live")
	assert.Empty(t, vm.createVMReqs, "an indeterminate probe must not reprovision")
}

func TestRepoGatewayReuse_HealthyGatewayAnswersRunning(t *testing.T) {
	t.Parallel()

	var probed atomic.Int32
	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probed.Add(1)
		assert.True(t, strings.HasPrefix(r.URL.Path, "/__preview/smithers-gw-"), "probe must ride the preview path: %s", r.URL.Path)
		assert.True(t, strings.HasSuffix(r.URL.Path, "/health"))
		w.WriteHeader(http.StatusOK)
	}))
	defer probe.Close()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-live", VmID: "vm-live", Status: "running",
			BaseUrl: "https://live.example", AuthTokenCiphertext: "tok",
			LastActivityAt: time.Now(),
		},
	}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm,
		WithRepoGatewayHealthProbe(probe.URL, probe.Client()))
	fastRepoGatewaySleep(svc)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "gw-live", info.GatewayID)
	assert.Equal(t, "running", info.Status)
	assert.Equal(t, int32(1), probed.Load(), "a healthy gateway answers on the first probe")
	assert.Empty(t, vm.deletedVMIDs)
	assert.Empty(t, q.getSoftDeleted())
}

func TestRepoGatewayReuse_ProbeRetriesWhileUnitBinds(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer probe.Close()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-slow", VmID: "vm-slow", Status: "suspended",
			BaseUrl: "https://slow.example", AuthTokenCiphertext: "tok",
			LastActivityAt: time.Now(),
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm,
		WithRepoGatewayHealthProbe(probe.URL, probe.Client()))
	fastRepoGatewaySleep(svc)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "gw-slow", info.GatewayID, "a resumed VM whose unit takes seconds to bind is healthy, not wedged")
	assert.Equal(t, "running", info.Status)
	assert.Equal(t, int32(3), calls.Load())
	assert.Contains(t, vm.startedVMIDs, "vm-slow")
	assert.Empty(t, vm.deletedVMIDs)
}

func TestRepoGatewaySweepWidowed(t *testing.T) {
	t.Parallel()

	now := time.Now()
	newRow := func(id, vmID string, idle time.Duration) runtimeports.RepoGateway {
		return runtimeports.RepoGateway{
			ID: id, VmID: vmID, Status: "running",
			AuthTokenCiphertext: "tok",
			LastActivityAt:      now.Add(-idle),
		}
	}
	goneErr := &sandbox.StatusError{StatusCode: 404, Message: "sandbox not found"}
	staleErr := &sandbox.StatusError{StatusCode: 409, Code: "stale_generation", Message: "placement changed"}

	q := &fakeRepoGatewayQuerier{
		activeRows: []runtimeports.RepoGateway{
			newRow("gw-gone", "vm-gone", time.Hour),
			newRow("gw-stale-gen", "vm-stale-gen", time.Hour),
			newRow("gw-stale-stopped", "vm-stale", 48*time.Hour),
			newRow("gw-fresh-stopped", "vm-fresh", time.Hour),
			newRow("gw-running", "vm-running", 48*time.Hour),
			newRow("gw-blip", "vm-blip", 48*time.Hour),
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			switch vmID {
			case "vm-gone":
				return sandbox.Sandbox{}, goneErr
			case "vm-stale-gen":
				return sandbox.Sandbox{}, staleErr
			case "vm-stale":
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			case "vm-fresh":
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			case "vm-running":
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			default:
				return sandbox.Sandbox{}, errors.New("provider transport blip")
			}
		},
	}
	svc := newTestRepoGatewayService(q, vm)
	svc.sweepWidowedGateways(context.Background())

	softDeleted := q.getSoftDeleted()
	assert.Contains(t, softDeleted, "gw-gone", "VM gone at the provider: the row must not answer running forever")
	assert.Contains(t, softDeleted, "gw-stale-gen", "a stale-fenced placement can never be operated again: discard")
	assert.Contains(t, softDeleted, "gw-stale-stopped", "stopped past the idle contract: reprovision fresh on next resolve")
	assert.NotContains(t, softDeleted, "gw-fresh-stopped", "recently idle-suspended is the normal contract: keep")
	assert.NotContains(t, softDeleted, "gw-running", "a running VM is never widowed")
	assert.NotContains(t, softDeleted, "gw-blip", "a provider blip is not evidence: keep and retry next tick")
	assert.Contains(t, vm.deletedVMIDs, "vm-gone")
	assert.Contains(t, vm.deletedVMIDs, "vm-stale-gen")
	assert.Contains(t, vm.deletedVMIDs, "vm-stale", "deleting the stale stopped VM releases its retained disk")
	assert.NotContains(t, vm.deletedVMIDs, "vm-fresh")
}

func TestRepoGatewayReuse_StaleFencedVMReprovisions(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{
		active: &runtimeports.RepoGateway{
			ID: "gw-fenced", VmID: "vm-fenced", Status: "running",
			BaseUrl: "https://fenced.example", AuthTokenCiphertext: "tok",
			LastActivityAt: time.Now(),
		},
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 409, ErrorCode: "stale_generation", Message: "placement changed"}
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.NotEqual(t, "gw-fenced", info.GatewayID, "a stale-fenced VM must be discarded and reprovisioned, not 500 forever")
	assert.Contains(t, vm.deletedVMIDs, "vm-fenced")
	assert.Contains(t, q.getSoftDeleted(), "gw-fenced")
}

func TestRepoGatewayVMRequest_MemSize(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm, WithRepoGatewayModelSeats(testGatewayModelSeats))

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	require.NotEmpty(t, vm.createVMReqs)
	require.NotNil(t, vm.createVMReqs[0].MemSizeMB, "the 512MiB default OOM-killed the gateway under the stock verify step")
	assert.Equal(t, int32(2048), *vm.createVMReqs[0].MemSizeMB)
}

// Every gateway VM gets its own egress proxy; with no seats it binds nothing.
func TestRepoGatewayProvision_NoSeatStillOwnsAnEgressProxy(t *testing.T) {
	t.Parallel()

	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, vm)
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	require.Len(t, vm.createVMReqs, 1)
	require.NotNil(t, vm.createVMReqs[0].EgressProxy)
	assert.True(t, vm.createVMReqs[0].EgressProxy.Enabled)
	assert.Empty(t, vm.createVMReqs[0].EgressProxy.Secrets)
}
