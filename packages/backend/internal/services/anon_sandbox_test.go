package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const testAnonSandboxID = "7a1b9c2d-3e4f-4a5b-8c6d-9e0f1a2b3c4d"

type fakeAnonSandboxStore struct {
	mu   sync.Mutex
	rows map[string]db.AnonSandbox

	countErr error
}

func newFakeAnonSandboxStore() *fakeAnonSandboxStore {
	return &fakeAnonSandboxStore{rows: map[string]db.AnonSandbox{}}
}

func (f *fakeAnonSandboxStore) CreateAnonSandbox(_ context.Context, arg db.CreateAnonSandboxParams) (db.AnonSandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row := db.AnonSandbox{
		ID:           testAnonSandboxID,
		RepoFullName: arg.RepoFullName,
		Branch:       arg.Branch,
		Status:       "pending",
		TokenHash:    arg.TokenHash,
		ClientIp:     arg.ClientIp,
		ExpiresAt:    arg.ExpiresAt,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	f.rows[row.ID] = row
	return row, nil
}

func (f *fakeAnonSandboxStore) GetAnonSandbox(_ context.Context, id string) (db.AnonSandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok || row.DeletedAt.Valid {
		return db.AnonSandbox{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeAnonSandboxStore) UpdateAnonSandboxStatusCAS(_ context.Context, arg db.UpdateAnonSandboxStatusCASParams) (db.AnonSandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[arg.ID]
	if !ok || row.DeletedAt.Valid || row.Status != arg.ExpectedStatus {
		return db.AnonSandbox{}, pgx.ErrNoRows
	}
	row.Status = arg.NewStatus
	row.ProvisioningStage = arg.ProvisioningStage
	if arg.VmID != "" {
		row.VmID = arg.VmID
	}
	row.UpdatedAt = time.Now().UTC()
	f.rows[arg.ID] = row
	return row, nil
}

func (f *fakeAnonSandboxStore) CountActiveAnonSandboxes(_ context.Context) (int64, error) {
	if f.countErr != nil {
		return 0, f.countErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var n int64
	for _, row := range f.rows {
		if !row.DeletedAt.Valid && (row.Status == "pending" || row.Status == "starting" || row.Status == "running") {
			n++
		}
	}
	return n, nil
}

func (f *fakeAnonSandboxStore) CountActiveAnonSandboxesForIP(_ context.Context, clientIP string) (int64, error) {
	if f.countErr != nil {
		return 0, f.countErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var n int64
	for _, row := range f.rows {
		if row.ClientIp == clientIP && !row.DeletedAt.Valid && (row.Status == "pending" || row.Status == "starting" || row.Status == "running") {
			n++
		}
	}
	return n, nil
}

func (f *fakeAnonSandboxStore) ListReapableAnonSandboxes(_ context.Context, limit int32) ([]db.AnonSandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	var out []db.AnonSandbox
	for _, row := range f.rows {
		if row.DeletedAt.Valid {
			continue
		}
		if row.ExpiresAt.Before(now) || row.Status == "failed" {
			out = append(out, row)
		}
		if len(out) >= int(limit) {
			break
		}
	}
	return out, nil
}

func (f *fakeAnonSandboxStore) SoftDeleteAnonSandbox(_ context.Context, id string) (db.AnonSandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok || row.DeletedAt.Valid {
		return db.AnonSandbox{}, pgx.ErrNoRows
	}
	row.Status = "deleted"
	row.DeletedAt.Valid = true
	row.DeletedAt.Time = time.Now().UTC()
	f.rows[id] = row
	return row, nil
}

type fakeAnonVMClient struct {
	mu         sync.Mutex
	created    []sandbox.CreateRequest
	deleted    []string
	execs      []sandbox.ExecRequest
	createErr  error
	execStatus int32
	deleteErr  error
}

func (f *fakeAnonVMClient) CreateSandbox(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, req)
	if f.createErr != nil && strings.TrimSpace(req.SnapshotID) != "" {
		return sandbox.CreateResult{}, f.createErr
	}
	return sandbox.CreateResult{ID: "vm-anon-1"}, nil
}

func (f *fakeAnonVMClient) DeleteSandbox(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, id)
	return f.deleteErr
}

func (f *fakeAnonVMClient) Execute(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.execs = append(f.execs, req)
	status := f.execStatus
	return sandbox.ExecResult{StatusCode: &status}, nil
}

type fakeAnonGolden struct {
	current string
	badIDs  []string
}

func (f *fakeAnonGolden) Current(context.Context) string       { return f.current }
func (f *fakeAnonGolden) MarkBad(_ context.Context, id string) { f.badIDs = append(f.badIDs, id) }

func testAnonConfig() AnonSandboxConfig {
	return AnonSandboxConfig{
		Enabled:       true,
		RepoAllowlist: []string{"smithersai/smithers"},
		TTL:           30 * time.Minute,
		MaxConcurrent: 2,
		MaxPerIP:      1,
		MemSizeMB:     4096,
		VCPUCount:     2,
		RootfsSizeMB:  10240,
	}
}

func testAnonBaseVMRequest() sandbox.CreateRequest {
	return sandbox.CreateRequest{
		Packages: []string{"ca-certificates", "git"},
		Persistence: &sandbox.PersistencePolicy{
			Type: sandbox.PersistencePersistent,
		},
	}
}

func newTestAnonService(store *fakeAnonSandboxStore, vm *fakeAnonVMClient, golden *fakeAnonGolden, cfg AnonSandboxConfig) *AnonSandboxService {
	var g anonGoldenSnapshots
	if golden != nil {
		g = golden
	}
	var client AnonSandboxVMClient
	if vm != nil {
		client = vm
	}
	return NewAnonSandboxService(store, client, g, testAnonBaseVMRequest, cfg)
}

func wantStatusErr(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want APIError, got %v", err)
	}
	if apiErr.Status != status {
		t.Fatalf("want status %d, got %d (%s)", status, apiErr.Status, apiErr.Message)
	}
}

func TestAnonSandboxCreate_RejectsUnlistedRepo(t *testing.T) {
	s := newTestAnonService(newFakeAnonSandboxStore(), &fakeAnonVMClient{}, nil, testAnonConfig())
	_, err := s.Create(context.Background(), "smithersai/other", "", "1.2.3.4")
	wantStatusErr(t, err, http.StatusForbidden)

	_, err = s.Create(context.Background(), "not-a-full-name", "", "1.2.3.4")
	wantStatusErr(t, err, http.StatusBadRequest)
}

func TestAnonSandboxCreate_Disabled(t *testing.T) {
	cfg := testAnonConfig()
	cfg.Enabled = false
	s := newTestAnonService(newFakeAnonSandboxStore(), &fakeAnonVMClient{}, nil, cfg)
	_, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	wantStatusErr(t, err, http.StatusNotFound)
}

func TestAnonSandboxCreate_RejectsBadBranch(t *testing.T) {
	s := newTestAnonService(newFakeAnonSandboxStore(), &fakeAnonVMClient{}, nil, testAnonConfig())
	for _, branch := range []string{"-flag", "has space", "semi;colon", strings.Repeat("x", 200)} {
		if _, err := s.Create(context.Background(), "smithersai/smithers", branch, "1.2.3.4"); err == nil {
			t.Fatalf("branch %q accepted", branch)
		}
	}
}

func TestAnonSandboxCreate_CapsFailClosed(t *testing.T) {
	store := newFakeAnonSandboxStore()
	store.countErr = errors.New("db down")
	s := newTestAnonService(store, &fakeAnonVMClient{}, nil, testAnonConfig())
	if _, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4"); err == nil {
		t.Fatal("count error must refuse creation")
	}
}

func TestAnonSandboxCreate_PerIPCap(t *testing.T) {
	store := newFakeAnonSandboxStore()
	store.rows["existing"] = db.AnonSandbox{ID: "existing", Status: "running", ClientIp: "1.2.3.4", ExpiresAt: time.Now().Add(time.Hour)}
	s := newTestAnonService(store, &fakeAnonVMClient{}, nil, testAnonConfig())
	_, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	wantStatusErr(t, err, http.StatusTooManyRequests)

	// A different IP is still admitted (global cap is 2).
	if _, err := s.Create(context.Background(), "smithersai/smithers", "", "5.6.7.8"); err != nil {
		t.Fatalf("different ip refused: %v", err)
	}
}

func TestAnonSandboxCreate_GlobalCap(t *testing.T) {
	store := newFakeAnonSandboxStore()
	store.rows["a"] = db.AnonSandbox{ID: "a", Status: "running", ClientIp: "9.9.9.9", ExpiresAt: time.Now().Add(time.Hour)}
	store.rows["b"] = db.AnonSandbox{ID: "b", Status: "starting", ClientIp: "8.8.8.8", ExpiresAt: time.Now().Add(time.Hour)}
	s := newTestAnonService(store, &fakeAnonVMClient{}, nil, testAnonConfig())
	_, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	wantStatusErr(t, err, http.StatusTooManyRequests)
}

func waitForStatus(t *testing.T, store *fakeAnonSandboxStore, id string, want string) db.AnonSandbox {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		row := store.rows[id]
		store.mu.Unlock()
		if row.Status == want {
			return row
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("row %s never reached status %q", id, want)
	return db.AnonSandbox{}
}

func TestAnonSandboxCreate_ProvisionsToRunning(t *testing.T) {
	store := newFakeAnonSandboxStore()
	vm := &fakeAnonVMClient{}
	golden := &fakeAnonGolden{current: "snap-golden-1"}
	s := newTestAnonService(store, vm, golden, testAnonConfig())

	created, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Token == "" || len(created.Token) != 64 {
		t.Fatalf("want 64-hex token, got %q", created.Token)
	}
	sum := sha256.Sum256([]byte(created.Token))
	if hex.EncodeToString(sum[:]) != created.Sandbox.TokenHash {
		t.Fatal("token hash mismatch")
	}
	if created.Sandbox.Status != "pending" {
		t.Fatalf("want pending, got %s", created.Sandbox.Status)
	}

	row := waitForStatus(t, store, created.Sandbox.ID, "running")
	if row.VmID != "vm-anon-1" {
		t.Fatalf("vm id not persisted: %+v", row)
	}
	if row.ProvisioningStage != anonStageReady {
		t.Fatalf("want ready stage, got %s", row.ProvisioningStage)
	}

	vm.mu.Lock()
	defer vm.mu.Unlock()
	if len(vm.created) != 1 {
		t.Fatalf("want 1 create, got %d", len(vm.created))
	}
	req := vm.created[0]
	if req.SnapshotID != "snap-golden-1" {
		t.Fatalf("golden snapshot not used: %+v", req)
	}
	if req.Packages != nil {
		t.Fatal("packages must be stripped on snapshot boot")
	}
	if req.Persistence == nil || req.Persistence.Type != sandbox.PersistenceEphemeral {
		t.Fatalf("want ephemeral persistence, got %+v", req.Persistence)
	}
	if req.MemSizeMB == nil || *req.MemSizeMB != 4096 || req.VCPUCount == nil || *req.VCPUCount != 2 {
		t.Fatalf("sizing caps not applied: %+v", req)
	}
	if req.IdleTimeoutSeconds == nil || *req.IdleTimeoutSeconds != int64(30*60) {
		t.Fatalf("idle timeout must equal TTL: %+v", req.IdleTimeoutSeconds)
	}
	if len(vm.execs) != 1 {
		t.Fatalf("want 1 clone exec, got %d", len(vm.execs))
	}
	cmd := vm.execs[0].Command
	if !strings.Contains(cmd, "https://github.com/smithersai/smithers") {
		t.Fatalf("clone must target the public GitHub URL: %s", cmd)
	}
	if strings.Contains(cmd, "GIT_CONFIG") || strings.Contains(cmd, "Authorization") {
		t.Fatalf("anonymous clone must carry no credentials: %s", cmd)
	}
}

func TestAnonSandboxCreate_GoldenFallbackMarksBad(t *testing.T) {
	store := newFakeAnonSandboxStore()
	vm := &fakeAnonVMClient{createErr: &sandbox.StatusError{StatusCode: 404, Message: "snapshot not found"}}
	golden := &fakeAnonGolden{current: "snap-bad"}
	s := newTestAnonService(store, vm, golden, testAnonConfig())

	created, err := s.Create(context.Background(), "smithersai/smithers", "main", "1.2.3.4")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	waitForStatus(t, store, created.Sandbox.ID, "running")

	vm.mu.Lock()
	creates := len(vm.created)
	vm.mu.Unlock()
	if creates != 2 {
		t.Fatalf("want snapshot attempt + bare fallback, got %d creates", creates)
	}
	if len(golden.badIDs) != 1 || golden.badIDs[0] != "snap-bad" {
		t.Fatalf("snapshot must be invalidated: %v", golden.badIDs)
	}
}

func TestAnonSandboxCloneFailure_DeletesVMAndFails(t *testing.T) {
	store := newFakeAnonSandboxStore()
	vm := &fakeAnonVMClient{execStatus: 128}
	s := newTestAnonService(store, vm, nil, testAnonConfig())

	created, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	row := waitForStatus(t, store, created.Sandbox.ID, "failed")
	if row.ProvisioningStage != anonStageCloneFailed {
		t.Fatalf("want clone_failed, got %s", row.ProvisioningStage)
	}
	vm.mu.Lock()
	defer vm.mu.Unlock()
	if len(vm.deleted) != 1 || vm.deleted[0] != "vm-anon-1" {
		t.Fatalf("clone failure must delete the VM: %v", vm.deleted)
	}
}

func TestAnonSandboxGet_TokenCapability(t *testing.T) {
	store := newFakeAnonSandboxStore()
	vm := &fakeAnonVMClient{}
	s := newTestAnonService(store, vm, nil, testAnonConfig())
	created, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := s.Get(context.Background(), created.Sandbox.ID, created.Token); err != nil {
		t.Fatalf("get with valid token: %v", err)
	}

	_, err = s.Get(context.Background(), created.Sandbox.ID, "wrong-token")
	wantStatusErr(t, err, http.StatusNotFound)

	_, err = s.Get(context.Background(), "e2b9c1d0-0000-4000-8000-000000000000", created.Token)
	wantStatusErr(t, err, http.StatusNotFound)
}

func TestAnonSandboxDelete_TearsDownVM(t *testing.T) {
	store := newFakeAnonSandboxStore()
	vm := &fakeAnonVMClient{}
	s := newTestAnonService(store, vm, nil, testAnonConfig())
	created, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	waitForStatus(t, store, created.Sandbox.ID, "running")

	if err := s.Delete(context.Background(), created.Sandbox.ID, created.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	store.mu.Lock()
	row := store.rows[created.Sandbox.ID]
	store.mu.Unlock()
	if !row.DeletedAt.Valid || row.Status != "deleted" {
		t.Fatalf("row not tombstoned: %+v", row)
	}
	vm.mu.Lock()
	defer vm.mu.Unlock()
	if len(vm.deleted) == 0 {
		t.Fatal("delete must tear down the VM")
	}
}

// A failed (non-404) provider delete must NOT tombstone the row: the reaper
// only sweeps live rows, so tombstoning here would orphan the disk forever.
func TestAnonSandboxDelete_VMDeleteFailureKeepsRowLive(t *testing.T) {
	store := newFakeAnonSandboxStore()
	vm := &fakeAnonVMClient{}
	s := newTestAnonService(store, vm, nil, testAnonConfig())
	created, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	waitForStatus(t, store, created.Sandbox.ID, "running")

	vm.mu.Lock()
	vm.deleteErr = errors.New("provider unavailable")
	vm.mu.Unlock()
	if err := s.Delete(context.Background(), created.Sandbox.ID, created.Token); err == nil {
		t.Fatal("delete must surface the failed VM teardown")
	}
	store.mu.Lock()
	row := store.rows[created.Sandbox.ID]
	store.mu.Unlock()
	if row.DeletedAt.Valid || row.Status == "deleted" {
		t.Fatalf("row must stay live for the reaper after a failed VM delete: %+v", row)
	}

	// Once the provider recovers, delete succeeds and tombstones the row.
	vm.mu.Lock()
	vm.deleteErr = nil
	vm.mu.Unlock()
	if err := s.Delete(context.Background(), created.Sandbox.ID, created.Token); err != nil {
		t.Fatalf("delete after recovery: %v", err)
	}
	store.mu.Lock()
	row = store.rows[created.Sandbox.ID]
	store.mu.Unlock()
	if !row.DeletedAt.Valid {
		t.Fatalf("row not tombstoned after recovered delete: %+v", row)
	}
}

func TestAnonSandboxReap_DeletesVMThenRow(t *testing.T) {
	store := newFakeAnonSandboxStore()
	store.rows["expired"] = db.AnonSandbox{
		ID: "expired", Status: "running", VmID: "vm-old",
		ExpiresAt: time.Now().Add(-time.Minute),
	}
	vm := &fakeAnonVMClient{}
	s := newTestAnonService(store, vm, nil, testAnonConfig())

	if err := s.reap(context.Background()); err != nil {
		t.Fatalf("reap: %v", err)
	}
	vm.mu.Lock()
	deleted := append([]string(nil), vm.deleted...)
	vm.mu.Unlock()
	if len(deleted) != 1 || deleted[0] != "vm-old" {
		t.Fatalf("want vm-old deleted, got %v", deleted)
	}
	store.mu.Lock()
	row := store.rows["expired"]
	store.mu.Unlock()
	if !row.DeletedAt.Valid {
		t.Fatal("expired row must be tombstoned")
	}
}

func TestAnonSandboxReap_KeepsRowWhenVMDeleteFails(t *testing.T) {
	store := newFakeAnonSandboxStore()
	store.rows["expired"] = db.AnonSandbox{
		ID: "expired", Status: "running", VmID: "vm-stuck",
		ExpiresAt: time.Now().Add(-time.Minute),
	}
	vm := &fakeAnonVMClient{deleteErr: errors.New("provider down")}
	s := newTestAnonService(store, vm, nil, testAnonConfig())

	if err := s.reap(context.Background()); err != nil {
		t.Fatalf("reap: %v", err)
	}
	store.mu.Lock()
	row := store.rows["expired"]
	store.mu.Unlock()
	if row.DeletedAt.Valid {
		t.Fatal("row must survive a failed VM delete so the disk is retried, never orphaned")
	}
}

func TestAnonSandboxReap_ToleratesVMAlreadyGone(t *testing.T) {
	store := newFakeAnonSandboxStore()
	store.rows["expired"] = db.AnonSandbox{
		ID: "expired", Status: "failed", VmID: "vm-gone",
		ExpiresAt: time.Now().Add(-time.Minute),
	}
	vm := &fakeAnonVMClient{deleteErr: &sandbox.StatusError{StatusCode: 404}}
	s := newTestAnonService(store, vm, nil, testAnonConfig())

	if err := s.reap(context.Background()); err != nil {
		t.Fatalf("reap: %v", err)
	}
	store.mu.Lock()
	row := store.rows["expired"]
	store.mu.Unlock()
	if !row.DeletedAt.Valid {
		t.Fatal("404 from the provider means the VM is gone; the row must be tombstoned")
	}
}

func TestAnonSandboxCreate_NoProviderDegradesHonestly(t *testing.T) {
	s := newTestAnonService(newFakeAnonSandboxStore(), nil, nil, testAnonConfig())
	_, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	wantStatusErr(t, err, http.StatusConflict)
}
