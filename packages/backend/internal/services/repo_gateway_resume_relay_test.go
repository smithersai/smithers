package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/previewgateway"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// The wave-11 wedge in one place: a gateway VM idle-suspends, the control plane
// never observes it (the row still says 'running'), so the relay keeps
// authorizing traffic into a VM that is powered off and every call 502s. The
// tests below drive the whole product loop against a guest model that behaves
// the way the real one does — a resumed VM comes back with NO gateway process,
// because the worker launches services as detached guest processes rather than
// systemd units — so a resume only ends in a serving gateway if the service is
// re-declared with real secrets afterwards.

// fakeGatewayGuest models the guest side of one gateway VM: whether the VM is
// powered on, and whether a gateway process is actually listening. Only the
// modeled VM id is tracked; any replacement VM a test provisions behaves like
// the default provider fake.
type fakeGatewayGuest struct {
	vmID    string
	mu      sync.Mutex
	powered bool
	serving bool
	deleted bool
}

func (g *fakeGatewayGuest) powerOn() {
	g.mu.Lock()
	defer g.mu.Unlock()
	// A resumed VM boots powered but empty: nothing re-launches the gateway.
	g.powered = true
	g.serving = false
}

// declare mirrors the worker's service declaration. A declaration carrying the
// durable "[redacted]" env (or none at all) starts a process that cannot serve
// — the exact shape recovery replay would have produced — so the guest refuses
// it rather than pretending the gateway came back.
func (g *fakeGatewayGuest) declare(spec sandbox.ServiceSpec) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.powered {
		return errors.New("cannot declare a service on a stopped sandbox")
	}
	token := spec.Env["SMITHERS_API_KEY"]
	if strings.TrimSpace(token) == "" || token == "[redacted]" {
		return errors.New("gateway service declared without usable credentials")
	}
	g.serving = true
	return nil
}

func (g *fakeGatewayGuest) state() (powered, serving bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.powered, g.serving
}

func (g *fakeGatewayGuest) destroy() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.deleted, g.powered, g.serving = true, false, false
}

// vmClient returns the provider fake wired to this guest.
func (g *fakeGatewayGuest) vmClient() *fakeRepoGatewayVMClient {
	return &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			if vmID != g.vmID {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			}
			powered, _ := g.state()
			state := sandbox.StateStopped
			if powered {
				state = sandbox.StateRunning
			}
			return sandbox.Sandbox{ID: vmID, State: state}, nil
		},
		startVMFn: func(_ context.Context, vmID string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
			if vmID == g.vmID {
				g.powerOn()
			}
			return sandbox.StartResult{ID: vmID}, nil
		},
		createSystemdServiceFn: func(_ context.Context, vmID string, spec sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			if vmID == g.vmID {
				if err := g.declare(spec); err != nil {
					return sandbox.CreateServiceResult{}, err
				}
			}
			return sandbox.CreateServiceResult{Success: true, ServiceName: spec.Name}, nil
		},
		deleteVMFn: func(_ context.Context, vmID string) error {
			if vmID == g.vmID {
				g.destroy()
			}
			return nil
		},
	}
}

// newFakePreviewIngress serves the gateway's preview route — the single
// upstream both the resume-time liveness probe and the API relay ride — and
// answers only what the guest can actually serve.
func newFakePreviewIngress(domain string, guest *fakeGatewayGuest, replacements ...*fakeGatewayGuest) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, replacement := range replacements {
			if strings.HasPrefix(r.URL.Path, previewgateway.RoutePrefix+repoGatewayDomain(replacement.vmID)+"/") {
				if _, serving := replacement.state(); !serving {
					w.WriteHeader(http.StatusBadGateway)
					return
				}
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		if !strings.HasPrefix(r.URL.Path, previewgateway.RoutePrefix+domain+"/") {
			http.NotFound(w, r)
			return
		}
		if _, serving := guest.state(); !serving {
			// Nothing is listening on the VM's port: the ingress answers, the
			// gateway does not.
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
}

// relayRepoGatewayQuerier adds the relay's row lookup to the shared gateway
// fake so one test can drive resolve -> resume -> relay. Tombstoned rows
// disappear exactly as GetRepoGatewayByID's `deleted_at IS NULL` makes them.
type relayRepoGatewayQuerier struct {
	*fakeRepoGatewayQuerier
}

func (q *relayRepoGatewayQuerier) GetRepoGatewayByID(ctx context.Context, id string) (runtimeports.RepoGateway, error) {
	for _, tombstoned := range q.getSoftDeleted() {
		if tombstoned == id {
			return runtimeports.RepoGateway{}, pgx.ErrNoRows
		}
	}
	if q.active != nil && q.active.ID == id {
		return *q.active, nil
	}
	return runtimeports.RepoGateway{}, pgx.ErrNoRows
}

func repoGatewayTokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

// relayThroughIngress performs the product's relay hop: authorize the operator
// token, then rewrite the request onto the preview gateway's path route exactly
// as RepoGatewayHandler.Relay does.
func relayThroughIngress(t *testing.T, svc *RepoGatewayService, ingress *httptest.Server, gatewayID, token, path string) (int, error) {
	t.Helper()
	target, err := svc.AuthorizeRelay(context.Background(), gatewayID, token)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(http.MethodGet, ingress.URL+previewgateway.RoutePrefix+target.Domain+path, nil)
	require.NoError(t, err)
	resp, err := ingress.Client().Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// idleSuspendedGatewayRow is the wave-11 shape: a live row that still says
// 'running' because an idle suspend is invisible to the control plane.
func idleSuspendedGatewayRow(gatewayID, vmID, token string) *runtimeports.RepoGateway {
	return &runtimeports.RepoGateway{
		ID:                  gatewayID,
		RepositoryID:        200,
		UserID:              1,
		VmID:                vmID,
		BaseUrl:             "https://" + repoGatewayDomain(vmID),
		AuthTokenHash:       repoGatewayTokenHash(token),
		AuthTokenCiphertext: token,
		Status:              "running",
		LastActivityAt:      time.Now(),
	}
}

// The wave-11 defect end to end: an idle-suspended VM whose row still answers
// 'running' 502s through the relay, and resolving it must resume the SAME VM
// into a serving gateway — not hand back the dead one, and not throw away the
// persistent workspace. Without the resume-time re-declare the resumed VM has
// no gateway process at all, the probe never goes green, and the caller
// discards a perfectly good VM with every run parked on it.
func TestRepoGatewayService_IdleSuspendResumeRelay_ServesTheSameVMAgain(t *testing.T) {
	t.Parallel()

	const (
		gatewayID = "gw-idle"
		vmID      = "vm-idle"
		token     = "smithers_gateway_wave11"
	)
	guest := &fakeGatewayGuest{vmID: vmID} // idle-suspended: powered off, nothing listening
	ingress := newFakePreviewIngress(repoGatewayDomain(vmID), guest)
	defer ingress.Close()

	q := &relayRepoGatewayQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
		active: idleSuspendedGatewayRow(gatewayID, vmID, token),
	}}
	vm := guest.vmClient()
	svc := newTestRepoGatewayService(q, vm,
		WithRepoGatewayModelSeats(testGatewayModelSeats),
		WithRepoGatewayHealthProbe(ingress.URL, ingress.Client()))
	fastRepoGatewaySleep(svc)

	// The wedge itself: the row says running, so the relay authorizes and routes
	// straight into a VM that is powered off.
	status, err := relayThroughIngress(t, svc, ingress, gatewayID, token, "/rpc")
	require.NoError(t, err, "the relay authorizes against the row, which still says 'running'")
	assert.Equal(t, http.StatusBadGateway, status, "an idle-suspended gateway 502s before the resume")

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, gatewayID, info.GatewayID, "a resumable gateway must be resumed, not replaced")
	assert.Equal(t, vmID, info.VMID)
	assert.Equal(t, "running", info.Status)
	assert.Equal(t, []string{vmID}, vm.startedVMIDs)
	assert.Empty(t, vm.createVMReqs, "resuming must not provision a replacement VM")
	assert.Empty(t, vm.deletedVMIDs, "the persistent workspace must survive an idle suspend")
	assert.Empty(t, q.getSoftDeleted())

	require.Len(t, vm.systemdSpecs, 1, "a resumed VM boots with no gateway process; resume must re-declare it")
	assert.Equal(t, token, vm.systemdSpecs[0].Env["SMITHERS_API_KEY"],
		"the re-declare carries the real operator token, not the durable '[redacted]' shape")
	require.NotEmpty(t, vm.startReqs)
	assertGatewayModelSeat(t, vm.systemdSpecs[0].Env, vm.startReqs[len(vm.startReqs)-1].EgressProxy)

	powered, serving := guest.state()
	assert.True(t, powered)
	assert.True(t, serving, "the resumed VM must end up with a gateway process listening")

	status, err = relayThroughIngress(t, svc, ingress, gatewayID, token, "/rpc")
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, status, "after the resume the relay reaches a live gateway")
}

// A resume that cannot be recovered must tombstone the defect row, not leave it
// answering 'running': while the row lives, the relay keeps routing traffic to
// the dead VM and the next resolve hands back the very same one.
func TestRepoGatewayService_FailedResume_TombstonesRowAndStopsRelaying(t *testing.T) {
	t.Parallel()

	const (
		gatewayID = "gw-wedged"
		vmID      = "vm-wedged"
		token     = "smithers_gateway_wedged"
	)
	guest := &fakeGatewayGuest{vmID: vmID}
	replacement := &fakeGatewayGuest{vmID: "vm-gw-1"}
	ingress := newFakePreviewIngress(repoGatewayDomain(vmID), guest, replacement)
	defer ingress.Close()

	q := &relayRepoGatewayQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
		active: idleSuspendedGatewayRow(gatewayID, vmID, token),
	}}
	vm := guest.vmClient()
	vm.createVMFn = func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
		replacement.powerOn()
		return sandbox.CreateResult{ID: replacement.vmID}, nil
	}
	originalDeclare := vm.createSystemdServiceFn
	vm.createSystemdServiceFn = func(ctx context.Context, id string, spec sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
		if id == replacement.vmID {
			if err := replacement.declare(spec); err != nil {
				return sandbox.CreateServiceResult{}, err
			}
			return sandbox.CreateServiceResult{Success: true, ServiceName: spec.Name}, nil
		}
		return originalDeclare(ctx, id, spec)
	}
	vm.startVMFn = func(_ context.Context, _ string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
		return sandbox.StartResult{}, &sandbox.StatusError{
			StatusCode: 500,
			Message:    "Failed to spawn UFFD handler 'uffd:vm-wedged'",
		}
	}
	svc := newTestRepoGatewayService(q, vm,
		WithRepoGatewayHealthProbe(ingress.URL, ingress.Client()))
	fastRepoGatewaySleep(svc)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err, "an unresumable gateway must self-heal, not 500 forever")
	assert.NotEqual(t, vmID, info.VMID, "the caller gets a fresh VM")
	assert.Contains(t, q.getSoftDeleted(), gatewayID, "the failed resume must tombstone its defect row")
	assert.Contains(t, vm.deletedVMIDs, vmID)
	assert.Contains(t, vm.unmappedDomains, repoGatewayDomain(vmID))
	require.Len(t, vm.createVMReqs, 1)

	_, relayErr := relayThroughIngress(t, svc, ingress, gatewayID, token, "/rpc")
	require.Error(t, relayErr, "a tombstoned gateway must stop routing relay traffic")
	assert.Equal(t, 401, apiStatus(t, relayErr))
}

// Same defect row, reached through the provision race: the loser of the
// active-slot race reuses the winner, and when that winner is itself wedged the
// row has to be cleaned up here too. Leaking the internal sentinel instead 500s
// opaquely AND leaves the dead row holding the active slot, so every later
// resolve hands out the same dead VM — the wave-11 loop, restarted.
func TestRepoGatewayService_ProvisionRace_UnrecoverableWinner_IsDiscarded(t *testing.T) {
	t.Parallel()

	winner := runtimeports.RepoGateway{
		ID: "gw-winner-dead", VmID: "vm-winner-dead", BaseUrl: "https://winner",
		Status: "running", AuthTokenCiphertext: "smithers_gateway_winner",
	}
	q := &repoGatewayHActiveSequenceQuerier{
		fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
			executionInfoErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_repo_gateways_active"},
		},
		winner: winner,
	}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, _ string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}
		},
	}
	svc := newTestRepoGatewayService(q, vm)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)
	assert.NotErrorIs(t, err, errRepoGatewayUnrecoverable, "the internal sentinel must never reach the caller")
	assert.Equal(t, 409, apiStatus(t, err), "the caller is told to retry into a clean provision")
	assert.Contains(t, q.getSoftDeleted(), "gw-winner-dead", "the dead winner must not keep the active slot")
	assert.Contains(t, vm.deletedVMIDs, "vm-winner-dead")
}

// With no liveness probe configured (local dev) nothing downstream can catch a
// resumed VM whose gateway process was never re-declared, so "the probe
// decides" decides nothing: the resolve would answer status:'running' for a VM
// with nothing listening, permanently — the resume block only runs while the VM
// is stopped, so no later resolve ever retries the declaration. Tombstone the
// row instead.
func TestRepoGatewayService_FailedRedeclareWithoutProbe_TombstonesRow(t *testing.T) {
	t.Parallel()

	const (
		gatewayID = "gw-nodeclare"
		vmID      = "vm-nodeclare"
		token     = "smithers_gateway_nodeclare"
	)
	q := &relayRepoGatewayQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
		active: idleSuspendedGatewayRow(gatewayID, vmID, token),
	}}
	guest := &fakeGatewayGuest{vmID: vmID}
	vm := guest.vmClient()
	declares := 0
	vm.createSystemdServiceFn = func(_ context.Context, id string, spec sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
		if id == vmID {
			declares++
			return sandbox.CreateServiceResult{}, errors.New("worker transport failed")
		}
		return sandbox.CreateServiceResult{Success: true, ServiceName: spec.Name}, nil
	}
	svc := newTestRepoGatewayService(q, vm)
	fastRepoGatewaySleep(svc)

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err, "the defect row is replaced rather than returned")
	assert.NotEqual(t, vmID, info.VMID)
	assert.Equal(t, 2, declares, "the re-declare keeps its one retry before the row is given up")
	assert.Contains(t, q.getSoftDeleted(), gatewayID,
		"a gateway that came back with no process must not answer 'running'")
	assert.Contains(t, vm.deletedVMIDs, vmID)
}

// A client can disconnect after StartSandbox has succeeded but before the
// resumed VM's gateway service is re-declared. That cancellation must not
// bypass the failed-redeclare tombstone path: otherwise the row remains
// 'running' while the resumed VM has no serving process, and every later
// resolve reuses the same dead gateway forever.
func TestRepoGatewayService_CanceledAfterResumeFailure_TombstonesRow(t *testing.T) {
	t.Parallel()

	const (
		gatewayID = "gw-canceled-redeclare"
		vmID      = "vm-canceled-redeclare"
		token     = "smithers_gateway_canceled_redeclare"
	)
	q := &relayRepoGatewayQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
		active: idleSuspendedGatewayRow(gatewayID, vmID, token),
	}}
	var declareCtxErrs []error
	var declareMu sync.Mutex
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(_ context.Context, id string) (sandbox.Sandbox, error) {
			if id == vmID {
				return sandbox.Sandbox{ID: id, State: sandbox.StateStopped}, nil
			}
			return sandbox.Sandbox{ID: id, State: sandbox.StateRunning}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, id string, spec sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			declareMu.Lock()
			declareCtxErrs = append(declareCtxErrs, ctx.Err())
			declareMu.Unlock()
			if id == vmID {
				return sandbox.CreateServiceResult{}, errors.New("re-declare transport failed")
			}
			return sandbox.CreateServiceResult{Success: true, ServiceName: spec.Name}, nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	vm.startVMFn = func(_ context.Context, id string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
		cancel() // StartSandbox succeeded; the request ends before re-declaration.
		return sandbox.StartResult{ID: id}, nil
	}

	// No health probe is configured, matching local deployments: failed
	// re-declaration itself must decide that the row is unrecoverable.
	svc := newTestRepoGatewayService(q, vm)
	_, _ = svc.GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())

	// The resolve is detached from the caller's context and bounded by the
	// response budget (see resolveExistingGateway), so the answer can arrive
	// before the tombstone is written. What must hold is that the cancellation
	// does not STOP the tombstone — so wait for the detached half to land
	// rather than reading the row the instant the caller is answered.
	require.Eventually(t, func() bool {
		return slices.Contains(q.getSoftDeleted(), gatewayID)
	}, 5*time.Second, 5*time.Millisecond,
		"caller cancellation after resume must not leave the stale row active")
	assert.Contains(t, vm.deletedVMIDs, vmID,
		"the resumed VM must be cleaned up when its service cannot be re-declared")
	declareMu.Lock()
	observedDeclareErrors := append([]error(nil), declareCtxErrs...)
	declareMu.Unlock()
	require.GreaterOrEqual(t, len(observedDeclareErrors), 2)
	assert.Equal(t, []error{nil, nil}, observedDeclareErrors[:2],
		"post-resume service re-declaration must outlive caller cancellation")
	_, err := svc.AuthorizeRelay(context.Background(), gatewayID, token)
	require.Error(t, err, "a tombstoned gateway must not remain reusable by the relay")
	assert.Equal(t, 401, apiStatus(t, err))
}
