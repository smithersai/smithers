package control

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type staticDiskGCProtection struct {
	images    []string
	snapshots []string
}

func (s staticDiskGCProtection) ListReadySandboxEnvironmentImageReferences(context.Context) ([]string, error) {
	return append([]string(nil), s.images...), nil
}

func (s staticDiskGCProtection) ListProtectedWorkerSnapshotLocalIDs(_ context.Context, workerID string) ([]string, error) {
	if workerID != "worker-gc" {
		return nil, nil
	}
	return append([]string(nil), s.snapshots...), nil
}

func TestPGStoreHeartbeatReturnsControllerDiskGCProtection(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	store := NewPGStore(pool, WithDiskGCProtectionQuerier(staticDiskGCProtection{
		images: []string{"registry/base@sha256:ready"}, snapshots: []string{"golden-local"},
	}))

	response, err := store.Heartbeat(context.Background(), heartbeatForTest("worker-gc", "https://worker-gc.internal"))
	require.NoError(t, err)
	assert.Equal(t, []string{"registry/base@sha256:ready"}, response.DiskGCProtection.Images)
	assert.Equal(t, []string{"golden-local"}, response.DiskGCProtection.Snapshots)
}

func TestPGStorePlacementAccessIdempotencyAndRecovery(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	workerA := heartbeatForTest("worker-a", "https://worker-a.internal")
	authorization, err := store.Heartbeat(ctx, workerA)
	require.NoError(t, err)
	assert.True(t, authorization.Authorized)
	assert.True(t, authorization.AdmitNew)

	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	create := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	placement, err := store.Allocate(ctx, "msb_persistent", create, msb.SanitizeCreateRequest(create), ResourceOwner{Kind: "workspace", ID: "workspace-1"})
	require.NoError(t, err)
	require.NoError(t, store.RecordService(ctx, "msb_persistent", 1,
		msb.SanitizeServiceSpec(sandbox.ServiceSpec{Name: "workspace-agent", Exec: []string{"/opt/workspace-agent"}})))
	assert.Equal(t, "worker-a", placement.WorkerID)
	assert.True(t, placement.Persistent)

	loaded, err := store.GetPlacement(ctx, "msb_persistent")
	require.NoError(t, err)
	assert.Equal(t, int64(1), loaded.Generation)
	assert.True(t, loaded.Persistent)
	assert.Equal(t, int64(1000), loaded.Requested.CPUMillis)
	assert.JSONEq(t, string(msb.SanitizeCreateRequest(create)), string(loaded.RequestSpec))
	assert.Equal(t, []sandbox.ServiceSpec{{Name: "workspace-agent", Exec: []string{"/opt/workspace-agent"}}}, loaded.RecoveryServices)
	var resourceKind, resourceID string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT COALESCE(resource_kind,''),COALESCE(resource_id,'')
		FROM sandbox_instances WHERE id='msb_persistent'`).Scan(&resourceKind, &resourceID))
	assert.Equal(t, "workspace", resourceKind)
	assert.Equal(t, "workspace-1", resourceID)

	identityExpiry := time.Now().Add(time.Hour)
	require.NoError(t, store.CreateIdentity(ctx, "msbi_test", identityExpiry))
	_, err = store.GrantPermission(ctx, "msbp_test", "msbi_test", "msb_persistent", []string{"root"})
	require.NoError(t, err)
	token := "single-use-secret"
	require.NoError(t, store.CreateAccessGrant(ctx, "msbg_test", "msbi_test", HashAccessToken(token), time.Now().Add(time.Minute)))
	access, err := store.ValidateAccess(ctx, msb.AccessValidationRequest{
		SandboxID: "msb_persistent", Token: token, User: "root", Protocol: "ssh",
	}, HashAccessToken(token))
	require.NoError(t, err)
	assert.True(t, access.Allowed)
	require.NoError(t, store.RevokeAccessGrant(ctx, "msbg_test"))
	_, err = store.ValidateAccess(ctx, msb.AccessValidationRequest{
		SandboxID: "msb_persistent", User: "root", Protocol: "ssh",
	}, HashAccessToken(token))
	assert.ErrorIs(t, err, ErrDenied)

	bulkIdentityExpiry := time.Now().Add(time.Hour)
	require.NoError(t, store.CreateIdentity(ctx, "msbi_bulk", bulkIdentityExpiry))
	_, err = store.GrantPermission(ctx, "msbp_bulk", "msbi_bulk", "msb_persistent", []string{"root"})
	require.NoError(t, err)
	bulkToken := "bulk-revoked-secret"
	require.NoError(t, store.CreateAccessGrant(ctx, "msbg_bulk", "msbi_bulk", HashAccessToken(bulkToken), time.Now().Add(time.Minute)))
	require.NoError(t, store.RevokeSandboxAccessGrants(ctx, "msb_persistent"))
	_, err = store.ValidateAccess(ctx, msb.AccessValidationRequest{
		SandboxID: "msb_persistent", Token: bulkToken, User: "root", Protocol: "ssh",
	}, HashAccessToken(bulkToken))
	assert.ErrorIs(t, err, ErrDenied)

	_, acquired, err := store.BeginOperation(ctx, "operation-one", "POST /v1/sandboxes", "digest-one")
	require.NoError(t, err)
	assert.True(t, acquired)
	response := OperationResponse{StatusCode: httpStatusCreated, ContentType: "application/json", Body: []byte(`{"id":"msb_persistent"}`), Replayable: true}
	require.NoError(t, store.CompleteOperation(ctx, "operation-one", response))
	replay, acquired, err := store.BeginOperation(ctx, "operation-one", "POST /v1/sandboxes", "digest-one")
	require.NoError(t, err)
	assert.False(t, acquired)
	assert.Equal(t, response, replay)
	_, _, err = store.BeginOperation(ctx, "operation-one", "POST /v1/sandboxes", "different")
	assert.ErrorIs(t, err, ErrIdempotencyConflict)
	_, acquired, err = store.BeginOperation(ctx, "operation-crashed", "DELETE /v1/sandboxes/msb_x", "digest-delete")
	require.NoError(t, err)
	assert.True(t, acquired)
	_, acquired, err = store.BeginOperation(ctx, "operation-crashed", "DELETE /v1/sandboxes/msb_x", "digest-delete")
	assert.ErrorIs(t, err, ErrOperationInProgress)
	assert.False(t, acquired)
	_, err = pool.Exec(ctx, `UPDATE sandbox_operations SET lease_expires_at=now()-interval '1 second' WHERE idempotency_key='operation-crashed'`)
	require.NoError(t, err)
	_, acquired, err = store.BeginOperation(ctx, "operation-crashed", "DELETE /v1/sandboxes/msb_x", "digest-delete")
	require.NoError(t, err)
	assert.True(t, acquired, "a controller crash must not wedge an operation until its 24-hour replay expiry")

	snapshot, err := store.CreateSnapshot(ctx, "msbs_recovery", "msb_persistent", "msbs_recovery", true)
	require.NoError(t, err)
	assert.Equal(t, "worker-a", snapshot.WorkerID)
	size := int64(1024)
	require.NoError(t, store.SetSnapshotState(ctx, "msbs_recovery", "exported", "gs://bucket/recovery.tar", "digest-recovery", &size))
	previous, err := store.SetRecoverySnapshot(ctx, "msb_persistent", 1, "msbs_recovery")
	require.NoError(t, err)
	assert.Empty(t, previous)

	_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state='stale' WHERE id='worker-a'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_instances SET desired_state='stopped',observed_state='degraded',
			recovery_reason='worker_lost' WHERE id='msb_persistent'`)
	require.NoError(t, err)
	_, err = store.Heartbeat(ctx, heartbeatForTest("worker-b", "https://worker-b.internal"))
	require.NoError(t, err)

	claim, err := store.ClaimRecovery(ctx, "controller-test", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "worker-b", claim.Placement.WorkerID)
	assert.Equal(t, int64(2), claim.Placement.Generation)
	assert.NotEqual(t, "msb_persistent", claim.Placement.LocalID)
	assert.Regexp(t, `^msb_[0-9a-f-]+$`, claim.Placement.LocalID)
	assert.Equal(t, "msbs_recovery", claim.Placement.RecoverySnapshotID)
	assert.Equal(t, "stopped", claim.DesiredState)
	require.Equal(t, []sandbox.ServiceSpec{{Name: "workspace-agent", Exec: []string{"/opt/workspace-agent"}}}, claim.Placement.RecoveryServices)
	require.NoError(t, store.CompleteRecovery(ctx, claim.Placement.SandboxID, claim.Placement.Generation, "stopped"))

	recovered, err := store.GetPlacement(ctx, "msb_persistent")
	require.NoError(t, err)
	assert.Equal(t, "worker-b", recovered.WorkerID)
	assert.Equal(t, int64(2), recovered.Generation)
	assert.Equal(t, "stopped", recovered.ObservedState)

	oldInventory := workerA
	oldInventory.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_persistent", Generation: 1}}
	responseAuth, err := store.Heartbeat(ctx, oldInventory)
	require.NoError(t, err)
	assert.Empty(t, responseAuth.DeleteOrphans, "orphans are quarantined before destructive cleanup")
	_, err = pool.Exec(ctx, `UPDATE sandbox_orphans SET delete_after=now()-interval '1 second'`)
	require.NoError(t, err)
	responseAuth, err = store.Heartbeat(ctx, oldInventory)
	require.NoError(t, err)
	require.Len(t, responseAuth.DeleteOrphans, 1)
	assert.Equal(t, "msb_persistent", responseAuth.DeleteOrphans[0].SandboxID)
	assert.Equal(t, int64(1), responseAuth.DeleteOrphans[0].Generation)

	_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state='draining' WHERE id='worker-b'`)
	require.NoError(t, err)
	draining, err := store.Heartbeat(ctx, heartbeatForTest("worker-b", "https://worker-b.internal"))
	require.NoError(t, err)
	assert.Equal(t, "draining", draining.State)
	assert.True(t, draining.Authorized)
	assert.False(t, draining.AdmitNew)
	metricsRegistry := prometheus.NewRegistry()
	require.NoError(t, store.UpdateMetrics(ctx, msb.NewMetrics(metricsRegistry)))
	metricFamilies, err := metricsRegistry.Gather()
	require.NoError(t, err)
	assert.NotEmpty(t, metricFamilies)
}

func TestPGStoreBlocksSecretBearingServiceRecoveryUntilReprovision(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-secret-a", "https://worker-secret-a.internal"))
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_secret_recovery", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_secret_recovery", 1, "running", "running", ""))
	const secretSentinel = "must-never-reach-postgres"
	require.NoError(t, store.RecordService(ctx, "msb_secret_recovery", 1, msb.SanitizeServiceSpec(sandbox.ServiceSpec{
		Name: "gateway", Exec: []string{"/opt/gateway"}, Env: map[string]string{"TOKEN": secretSentinel},
	})))
	var durableServices string
	require.NoError(t, pool.QueryRow(ctx, `SELECT recovery_services::text FROM sandbox_instances WHERE id='msb_secret_recovery'`).Scan(&durableServices))
	assert.NotContains(t, durableServices, secretSentinel)
	assert.Contains(t, durableServices, "[redacted]")

	snapshot, err := store.CreateSnapshot(ctx, "msbs_secret_recovery", "msb_secret_recovery", "msbs_secret_recovery", true)
	require.NoError(t, err)
	size := int64(1024)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "gs://bucket/secret.tar", "secret-digest", &size))
	_, err = store.SetRecoverySnapshot(ctx, "msb_secret_recovery", 1, snapshot.SnapshotID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state='stale' WHERE id='worker-secret-a'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET observed_state='degraded',recovery_reason='worker_lost' WHERE id='msb_secret_recovery'`)
	require.NoError(t, err)
	_, err = store.Heartbeat(ctx, heartbeatForTest("worker-secret-b", "https://worker-secret-b.internal"))
	require.NoError(t, err)

	claim, err := store.ClaimRecovery(ctx, "controller-secret", time.Minute)
	require.NoError(t, err)
	require.Len(t, claim.Placement.RecoveryServices, 1)
	assert.Equal(t, "[redacted]", claim.Placement.RecoveryServices[0].Env["TOKEN"])
	require.NoError(t, store.BlockRecovery(ctx, claim.Placement.SandboxID, claim.Placement.Generation,
		"sandbox recovery requires secret reinjection for service gateway"))
	var observed, reason string
	require.NoError(t, pool.QueryRow(ctx, `SELECT observed_state,recovery_reason FROM sandbox_instances WHERE id='msb_secret_recovery'`).Scan(&observed, &reason))
	assert.Equal(t, "degraded", observed)
	assert.Equal(t, "secrets_required", reason)
	_, err = store.ClaimRecovery(ctx, "controller-secret-retry", time.Minute)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestPGStoreExpiredSnapshotBuildEnqueuesBoundTemporarySandbox(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-snapshot-build", "https://worker-snapshot-build.internal"))
	require.NoError(t, err)
	const operation = "POST /v1/sandboxes/snapshots"
	_, acquired, err := store.BeginOperation(ctx, "snapshot-build-crash", operation, "digest")
	require.NoError(t, err)
	require.True(t, acquired)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_snapshot_build_temp", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.BindOperation(ctx, "snapshot-build-crash", "msb_snapshot_build_temp"))
	require.NoError(t, store.SetState(ctx, "msb_snapshot_build_temp", 1, "running", "running", ""))
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_operations SET lease_expires_at=now()-interval '1 second'
		WHERE idempotency_key='snapshot-build-crash'`)
	require.NoError(t, err)

	_, acquired, err = store.BeginOperation(ctx, "snapshot-build-crash", operation, "digest")
	require.NoError(t, err)
	assert.True(t, acquired)
	var cleanupPending bool
	var desired, observed string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT cleanup_pending,desired_state,observed_state FROM sandbox_instances
		WHERE id='msb_snapshot_build_temp'`).Scan(&cleanupPending, &desired, &observed))
	assert.True(t, cleanupPending)
	assert.Equal(t, "deleted", desired)
	assert.Equal(t, "deleting", observed)
	var boundID *string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT sandbox_id FROM sandbox_operations WHERE idempotency_key='snapshot-build-crash'`).Scan(&boundID))
	assert.Nil(t, boundID)
	cleanup, err := store.ClaimCleanup(ctx, "controller-cleanup", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "msb_snapshot_build_temp", cleanup.SandboxID)
}

func TestPGStoreExpiredSnapshotBuildReplaysCompletedSnapshotAndCleansTemporarySandbox(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-snapshot-replay", "https://worker-snapshot-replay.internal"))
	require.NoError(t, err)
	const operation = "POST /v1/sandboxes/snapshots"
	_, acquired, err := store.BeginOperation(ctx, "snapshot-build-replay", operation, "digest")
	require.NoError(t, err)
	require.True(t, acquired)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_snapshot_replay_temp", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.BindOperation(ctx, "snapshot-build-replay", "msb_snapshot_replay_temp"))
	require.NoError(t, store.SetState(ctx, "msb_snapshot_replay_temp", 1, "running", "running", ""))
	snapshot, err := store.CreateSnapshot(ctx, "msbs_completed_before_crash", "msb_snapshot_replay_temp", "msbs_completed_before_crash", false)
	require.NoError(t, err)
	size := int64(128)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "gs://bucket/completed.tar", "sha256:completed", &size))
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_operations SET lease_expires_at=now()-interval '1 second'
		WHERE idempotency_key='snapshot-build-replay'`)
	require.NoError(t, err)

	replay, acquired, err := store.BeginOperation(ctx, "snapshot-build-replay", operation, "digest")
	require.NoError(t, err)
	assert.False(t, acquired)
	assert.Equal(t, operationHTTPStatusCreated, replay.StatusCode)
	var response sandbox.CreateSnapshotResponse
	require.NoError(t, json.Unmarshal(replay.Body, &response))
	assert.Equal(t, snapshot.SnapshotID, response.SnapshotID)
	var cleanupPending bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT cleanup_pending FROM sandbox_instances WHERE id='msb_snapshot_replay_temp'`).Scan(&cleanupPending))
	assert.True(t, cleanupPending)
}

func TestPGStoreConcurrentAllocationCannotOversubscribeHost(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-one", "https://worker-one.internal")
	heartbeat.Capacity.VMs = 1
	heartbeat.Capacity.CPUMillis = 1000
	heartbeat.Capacity.MemoryBytes = 512 * 1024 * 1024
	heartbeat.Capacity.DiskBytes = 10 * 1024 * 1024 * 1024
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	start := make(chan struct{})
	errorsByRequest := make([]error, 2)
	var wait sync.WaitGroup
	for index := range errorsByRequest {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			_, errorsByRequest[index] = store.Allocate(ctx, "msb_concurrent_"+string(rune('a'+index)), request, msb.SanitizeCreateRequest(request), ResourceOwner{})
		}(index)
	}
	close(start)
	wait.Wait()

	var succeeded, exhausted int
	for _, allocationErr := range errorsByRequest {
		switch {
		case allocationErr == nil:
			succeeded++
		case errors.Is(allocationErr, ErrNoCapacity):
			exhausted++
		default:
			require.NoError(t, allocationErr)
		}
	}
	assert.Equal(t, 1, succeeded)
	assert.Equal(t, 1, exhausted)
	var allocated int
	require.NoError(t, pool.QueryRow(ctx, `SELECT allocated_vms FROM sandbox_hosts WHERE id='worker-one'`).Scan(&allocated))
	assert.Equal(t, 1, allocated)
}

func TestPGStoreHeartbeatCannotEraseControllerCapacityReservation(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-reserved", "https://worker-reserved.internal")
	heartbeat.Capacity = msb.WorkerCapacity{
		CPUMillis: 1000, MemoryBytes: 512 * 1024 * 1024,
		DiskBytes: 10 * 1024 * 1024 * 1024, VMs: 1,
	}
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_reserved", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)

	// The worker has not registered the placement yet (for example, a large
	// snapshot import is still running), so its observed allocation is zero.
	// That report must not erase the controller's committed reservation.
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	_, err = store.Allocate(ctx, "msb_must_wait", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	assert.ErrorIs(t, err, ErrNoCapacity)

	var reserved, observed int
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT allocated_vms,observed_allocated_vms FROM sandbox_hosts
		WHERE id='worker-reserved'`).Scan(&reserved, &observed))
	assert.Equal(t, 1, reserved)
	assert.Equal(t, 0, observed)
}

func TestPGStoreReconcileProtectsBoundedSnapshotImport(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-import", "https://worker-import.internal"))
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_importing", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_hosts SET lease_expires_at=now()+interval '1 hour'
		WHERE id='worker-import';
		UPDATE sandbox_instances SET last_heartbeat_at=now()-interval '2 minutes'
		WHERE id='msb_importing'`)
	require.NoError(t, err)

	result, err := store.Reconcile(ctx, time.Now())
	require.NoError(t, err)
	assert.Zero(t, result.MissingRuntime)
	placement, err := store.GetPlacement(ctx, "msb_importing")
	require.NoError(t, err)
	assert.Equal(t, "starting", placement.ObservedState)

	_, err = pool.Exec(ctx, `UPDATE sandbox_instances
		SET updated_at=now()-interval '41 minutes' WHERE id='msb_importing'`)
	require.NoError(t, err)
	result, err = store.Reconcile(ctx, time.Now())
	require.NoError(t, err)
	assert.EqualValues(t, 1, result.MissingRuntime)
	var observed, recoveryReason string
	var cleanupPending bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT observed_state,cleanup_pending,recovery_reason
		FROM sandbox_instances WHERE id='msb_importing'`).Scan(
		&observed, &cleanupPending, &recoveryReason,
	))
	assert.Equal(t, "failed", observed)
	assert.True(t, cleanupPending)
	assert.Empty(t, recoveryReason, "an unmaterialized create has no state that can be recovered")
}

func TestPGStoreRuntimeStateDrivesRestartLease(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-restart", "https://worker-restart.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_restart", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_restart", 1, "running", "running", ""))
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_restart", Generation: 1, State: "restart_pending"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	claim, err := store.ClaimRestart(ctx, "controller-restart", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "msb_restart", claim.SandboxID)
	assert.Equal(t, int64(1), claim.Generation)
	require.NoError(t, store.CompleteRecovery(ctx, claim.SandboxID, claim.Generation, "running"))
	restarted, err := store.GetPlacement(ctx, "msb_restart")
	require.NoError(t, err)
	assert.Equal(t, "running", restarted.ObservedState)
}

func TestPGStoreExpiredRestartLeaseIsReclaimedAfterControllerCrash(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-restart-reclaim", "https://worker-restart-reclaim.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_restart_reclaim", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_restart_reclaim", 1, "running", "running", ""))
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_restart_reclaim", Generation: 1, State: "restart_pending"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	first, err := store.ClaimRestart(ctx, "controller-before-crash", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "restart_pending", first.ObservedState)
	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET lease_expires_at=now()-interval '1 second' WHERE id='msb_restart_reclaim'`)
	require.NoError(t, err)
	second, err := store.ClaimRestart(ctx, "controller-after-crash", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "recovering", second.ObservedState)
	assert.Equal(t, first.WorkerID, second.WorkerID)
	assert.Equal(t, first.Generation, second.Generation)
	require.NoError(t, store.CompleteRecovery(ctx, second.SandboxID, second.Generation, "running"))
}

func TestPGStoreExpiredDrainLeaseIsReclaimedBeforeNodeTermination(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-drain-reclaim", "https://worker-drain-reclaim.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_drain_reclaim", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_drain_reclaim", 1, "running", "running", ""))
	heartbeat.State = "draining"
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_drain_reclaim", Generation: 1, State: "running"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	_, err = store.ClaimDrain(ctx, "controller-before-crash", time.Minute)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET lease_expires_at=now()-interval '1 second' WHERE id='msb_drain_reclaim'`)
	require.NoError(t, err)
	heartbeat.Inventory[0].State = "stopped"
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	reclaimed, err := store.ClaimDrain(ctx, "controller-after-crash", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "running", reclaimed.PreviousObserved, "the replacement controller must finish the original stop-and-checkpoint intent")

	snapshot, err := store.CreateSnapshot(ctx, "msbs_drain_reclaim", "msb_drain_reclaim", "msbs_drain_reclaim", true)
	require.NoError(t, err)
	size := int64(1024)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "gs://bucket/drain-reclaim.tar", "drain-reclaim-digest", &size))
	_, err = store.SetRecoverySnapshot(ctx, "msb_drain_reclaim", 1, snapshot.SnapshotID)
	require.NoError(t, err)
	require.NoError(t, store.CompleteDrainCheckpoint(ctx, "msb_drain_reclaim", 1))
}

func TestPGStoreDrainCheckpointRelocatesPersistentPlacement(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	workerA := heartbeatForTest("worker-drain-a", "https://worker-drain-a.internal")
	_, err := store.Heartbeat(ctx, workerA)
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_drain", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_drain", 1, "running", "running", ""))
	workerA.State = "draining"
	workerA.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_drain", Generation: 1, State: "running"}}
	authorization, err := store.Heartbeat(ctx, workerA)
	require.NoError(t, err)
	assert.False(t, authorization.AdmitNew)

	drain, err := store.ClaimDrain(ctx, "controller-drain", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "running", drain.PreviousObserved)
	snapshot, err := store.CreateSnapshot(ctx, "msbs_drain", "msb_drain", "msbs_drain", true)
	require.NoError(t, err)
	size := int64(1024)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "gs://bucket/drain.tar", "drain-digest", &size))
	_, err = store.SetRecoverySnapshot(ctx, "msb_drain", 1, snapshot.SnapshotID)
	require.NoError(t, err)
	require.NoError(t, store.CompleteDrainCheckpoint(ctx, "msb_drain", 1))
	workerA.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_drain", Generation: 1, State: "stopped"}}
	_, err = store.Heartbeat(ctx, workerA)
	require.NoError(t, err)
	var observed, recoveryReason string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT observed_state,recovery_reason FROM sandbox_instances
		WHERE id='msb_drain'`).Scan(&observed, &recoveryReason))
	assert.Equal(t, "degraded", observed)
	assert.Equal(t, "planned_drain", recoveryReason)
	_, err = store.ClaimDrain(ctx, "controller-second-drain", time.Minute)
	assert.ErrorIs(t, err, ErrNotFound, "a completed drain checkpoint must not loop back into another checkpoint")
	_, err = store.Heartbeat(ctx, heartbeatForTest("worker-drain-b", "https://worker-drain-b.internal"))
	require.NoError(t, err)

	recovery, err := store.ClaimRecovery(ctx, "controller-recovery", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "worker-drain-b", recovery.Placement.WorkerID)
	assert.Equal(t, int64(2), recovery.Placement.Generation)
	assert.NotEqual(t, "msb_drain", recovery.Placement.LocalID)
	require.NotNil(t, recovery.PreviousPlacement)
	assert.Equal(t, "worker-drain-a", recovery.PreviousPlacement.WorkerID)
	assert.Equal(t, int64(1), recovery.PreviousPlacement.Generation)
	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET lease_expires_at=now()-interval '1 second' WHERE id='msb_drain'`)
	require.NoError(t, err)
	reclaimed, err := store.ClaimRecovery(ctx, "controller-recovery-after-crash", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, recovery.Placement.WorkerID, reclaimed.Placement.WorkerID)
	assert.Equal(t, recovery.Placement.Generation, reclaimed.Placement.Generation)
	assert.Equal(t, recovery.Placement.LocalID, reclaimed.Placement.LocalID)
	assert.Nil(t, reclaimed.PreviousPlacement, "an expired claim on the already selected ready host must not reserve another worker")
	require.NoError(t, store.FailRecovery(ctx, reclaimed.Placement.SandboxID, reclaimed.Placement.Generation, "transient import timeout"))
	_, err = store.ClaimRecovery(ctx, "controller-recovery-before-backoff", time.Minute)
	assert.ErrorIs(t, err, ErrNotFound, "a failed recovery must not be reclaimed in the same reconciliation pass")
	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET lease_expires_at=now()-interval '1 second' WHERE id='msb_drain'`)
	require.NoError(t, err)
	retried, err := store.ClaimRecovery(ctx, "controller-recovery-after-failure", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, reclaimed.Placement.WorkerID, retried.Placement.WorkerID)
	assert.Equal(t, reclaimed.Placement.Generation, retried.Placement.Generation)
	assert.Equal(t, reclaimed.Placement.LocalID, retried.Placement.LocalID)
	assert.Nil(t, retried.PreviousPlacement, "a transient failure on the selected host must retry without reserving another worker")
	require.NoError(t, store.CompleteRecovery(ctx, retried.Placement.SandboxID, retried.Placement.Generation, "running"))
}

func TestPGStoreDrainCheckpointRecoversOnNewBootOfSameWorker(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-drain-reboot", "https://worker-drain-reboot.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_drain_reboot", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_drain_reboot", 1, "running", "running", ""))
	heartbeat.State = "draining"
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_drain_reboot", Generation: 1, State: "running"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	_, err = store.ClaimDrain(ctx, "controller-drain-reboot", time.Minute)
	require.NoError(t, err)
	snapshot, err := store.CreateSnapshot(ctx, "msbs_drain_reboot", "msb_drain_reboot", "msbs_drain_reboot", true)
	require.NoError(t, err)
	size := int64(1024)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "gs://bucket/drain-reboot.tar", "drain-reboot-digest", &size))
	_, err = store.SetRecoverySnapshot(ctx, "msb_drain_reboot", 1, snapshot.SnapshotID)
	require.NoError(t, err)
	require.NoError(t, store.CompleteDrainCheckpoint(ctx, "msb_drain_reboot", 1))

	heartbeat.State = "ready"
	heartbeat.BootID = "worker-drain-reboot-boot-b"
	heartbeat.Inventory[0].State = "stopped"
	authorization, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	assert.True(t, authorization.AdmitNew)

	recovery, err := store.ClaimRecovery(ctx, "controller-recovery-reboot", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "worker-drain-reboot", recovery.Placement.WorkerID)
	assert.Equal(t, int64(2), recovery.Placement.Generation)
	assert.Equal(t, "msb_drain_reboot", recovery.Placement.LocalID)
	assert.True(t, recovery.ReuseStoppedDisk)
	require.NotNil(t, recovery.PreviousPlacement)
	assert.Equal(t, "msb_drain_reboot", recovery.PreviousPlacement.LocalID)
	require.NoError(t, store.FailRecovery(ctx, recovery.Placement.SandboxID, recovery.Placement.Generation, "transient runtime error"))
	_, err = store.ClaimRecovery(ctx, "controller-recovery-reboot-before-backoff", time.Minute)
	assert.ErrorIs(t, err, ErrNotFound, "a failed retained-disk promotion must honor retry backoff")
	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET lease_expires_at=now()-interval '1 second' WHERE id='msb_drain_reboot'`)
	require.NoError(t, err)
	retried, err := store.ClaimRecovery(ctx, "controller-recovery-reboot-retry", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, recovery.Placement.Generation, retried.Placement.Generation)
	assert.Equal(t, recovery.Placement.LocalID, retried.Placement.LocalID)
	assert.True(t, retried.ReuseStoppedDisk)
	assert.Nil(t, retried.PreviousPlacement)
	require.NoError(t, store.CompleteRecovery(ctx, retried.Placement.SandboxID, retried.Placement.Generation, "running"))
}

func TestPGStoreIdleStopIsNotClaimedAsWorkerRestart(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-idle", "https://worker-idle.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_idle", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_idle", 1, "running", "running", ""))
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_idle", Generation: 1, State: "stopped"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	_, err = store.ClaimRestart(ctx, "controller-restart", time.Minute)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestPGStoreTransientIdempotencyOutcomeCanRetrySameLogicalOperation(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, acquired, err := store.BeginOperation(ctx, "retryable-operation", "POST /v1/sandboxes", "same-digest")
	require.NoError(t, err)
	assert.True(t, acquired)
	require.NoError(t, store.CompleteOperation(ctx, "retryable-operation", OperationResponse{
		StatusCode: 503, ContentType: "application/json", Body: []byte(`{"error":"no capacity"}`), Replayable: true,
	}))

	_, acquired, err = store.BeginOperation(ctx, "retryable-operation", "POST /v1/sandboxes", "same-digest")
	require.NoError(t, err)
	assert.True(t, acquired, "a transient response must release the logical operation for retry")
	success := OperationResponse{StatusCode: httpStatusCreated, ContentType: "application/json", Body: []byte(`{"id":"msb_retry"}`), Replayable: true}
	require.NoError(t, store.CompleteOperation(ctx, "retryable-operation", success))
	replay, acquired, err := store.BeginOperation(ctx, "retryable-operation", "POST /v1/sandboxes", "same-digest")
	require.NoError(t, err)
	assert.False(t, acquired)
	assert.Equal(t, success, replay)
}

func TestPGStoreBoundCreateReplaysMaterializedIdentityAfterControllerFailure(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-create-recovery", "https://worker-create-recovery.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}

	tests := []struct {
		name          string
		key           string
		sandboxID     string
		operation     string
		forkSourceID  string
		failOperation bool
	}{
		{name: "controller process disappeared", key: "create-crashed", sandboxID: "msb_create_crashed", operation: "POST /v1/sandboxes"},
		{name: "database finalization failed", key: "create-finalize-failed", sandboxID: "msb_create_finalize_failed", operation: "POST /v1/sandboxes", failOperation: true},
		{name: "fork response envelope is preserved", key: "fork-crashed", sandboxID: "msb_fork_crashed", operation: "POST /v1/sandboxes/msb_parent/fork", forkSourceID: "msb_parent"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, acquired, err := store.BeginOperation(ctx, test.key, test.operation, "create-digest")
			require.NoError(t, err)
			require.True(t, acquired)
			_, err = store.Allocate(ctx, test.sandboxID, request, msb.SanitizeCreateRequest(request), ResourceOwner{})
			require.NoError(t, err)
			require.NoError(t, store.BindOperation(ctx, test.key, test.sandboxID))
			if test.failOperation {
				require.NoError(t, store.CompleteOperation(ctx, test.key, OperationResponse{
					StatusCode: 500, ContentType: "application/json", Body: []byte(`{"error":"finalization failed"}`), Replayable: true,
				}))
			}

			heartbeat.Inventory = append(heartbeat.Inventory, msb.WorkerInventoryItem{
				SandboxID: test.sandboxID, Generation: 1, State: "running",
			})
			_, err = store.Heartbeat(ctx, heartbeat)
			require.NoError(t, err)
			if !test.failOperation {
				_, acquired, err = store.BeginOperation(ctx, test.key, test.operation, "create-digest")
				assert.ErrorIs(t, err, ErrOperationInProgress)
				assert.False(t, acquired, "a concurrent duplicate must not steal completion from the original caller")
				_, err = pool.Exec(ctx, `
					UPDATE sandbox_operations SET lease_expires_at=now()-interval '1 second'
					WHERE idempotency_key=$1`, test.key)
				require.NoError(t, err)
			}

			replay, acquired, err := store.BeginOperation(ctx, test.key, test.operation, "create-digest")
			require.NoError(t, err)
			assert.False(t, acquired)
			assert.Equal(t, http.StatusCreated, replay.StatusCode)
			var createResponse sandbox.CreateResult
			require.NoError(t, json.Unmarshal(replay.Body, &createResponse))
			assert.Equal(t, test.sandboxID, createResponse.ID)
			var status, boundID string
			require.NoError(t, pool.QueryRow(ctx, `
				SELECT status,COALESCE(sandbox_id,'') FROM sandbox_operations
				WHERE idempotency_key=$1`, test.key).Scan(&status, &boundID))
			assert.Equal(t, "succeeded", status)
			assert.Equal(t, test.sandboxID, boundID)
		})
	}
}

func TestPGStoreCheckpointFailureDoesNotRestoreStaleRecoveryPoint(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-checkpoint-failure", "https://worker-checkpoint-failure.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_checkpoint_failure", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_checkpoint_failure", 1, "stopped", "stopped", ""))
	snapshot, err := store.CreateSnapshot(ctx, "msbs_old_recovery", "msb_checkpoint_failure", "msbs_old_recovery", true)
	require.NoError(t, err)
	size := int64(1024)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "gs://bucket/old.tar", "old-digest", &size))
	_, err = store.SetRecoverySnapshot(ctx, "msb_checkpoint_failure", 1, snapshot.SnapshotID)
	require.NoError(t, err)

	// This is the state left by a failed new checkpoint. The old snapshot is
	// still a valid historical artifact, but must not be treated as current.
	require.NoError(t, store.SetState(ctx, "msb_checkpoint_failure", 1, "stopped", "degraded", "new checkpoint export failed"))
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_checkpoint_failure", Generation: 1, State: "stopped"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	placement, err := store.GetPlacement(ctx, "msb_checkpoint_failure")
	require.NoError(t, err)
	assert.Equal(t, "degraded", placement.ObservedState, "worker inventory must not erase a checkpoint failure")
	_, err = store.ClaimRecovery(ctx, "controller-recovery", time.Minute)
	assert.ErrorIs(t, err, ErrNotFound)
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_hosts SET state='stale',lease_expires_at=now()-interval '1 second'
		WHERE id='worker-checkpoint-failure'`)
	require.NoError(t, err)
	_, err = store.Reconcile(ctx, time.Now())
	require.NoError(t, err)
	_, err = store.ClaimRecovery(ctx, "controller-recovery", time.Minute)
	assert.ErrorIs(t, err, ErrNotFound, "worker loss must not make a stale checkpoint eligible after a failed newer checkpoint")
}

func TestPGStoreNewWorkerBootClearsStickyDrain(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-rolling", "https://worker-rolling.internal")
	heartbeat.State = "draining"
	authorization, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	assert.Equal(t, "draining", authorization.State)
	assert.False(t, authorization.AdmitNew)

	heartbeat.State = "ready"
	authorization, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	assert.Equal(t, "draining", authorization.State, "the same process cannot cancel its own drain")

	heartbeat.BootID = "worker-rolling-boot-b"
	authorization, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	assert.Equal(t, "ready", authorization.State)
	assert.True(t, authorization.AdmitNew, "a replacement worker process must explicitly re-admit its host")
}

func TestPGStoreRejectsWorkerIdentityTakeover(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	heartbeat := heartbeatForTest("worker-protected", "https://worker-original.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	newer := heartbeat
	newer.BaseURL = "https://worker-current.internal"
	newer.BootID = "worker-current-boot"
	newer.IdentitySignedAt = heartbeat.IdentitySignedAt.Add(time.Second)
	_, err = store.Heartbeat(ctx, newer)
	require.NoError(t, err)
	_, err = store.Heartbeat(ctx, heartbeat)
	assert.ErrorIs(t, err, ErrDenied, "an older signed routing declaration must not overwrite newer worker state")

	attacker := newer
	attacker.BaseURL = "https://worker-attacker.internal"
	attacker.BootID = "attacker-boot"
	attacker.IdentitySignedAt = newer.IdentitySignedAt.Add(time.Second)
	attackerKey := sha256.Sum256([]byte("attacker-identity"))
	attacker.IdentityPublicKey = attackerKey[:]
	_, err = store.Heartbeat(ctx, attacker)
	assert.ErrorIs(t, err, ErrDenied)

	var baseURL, bootID string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT base_url,boot_id FROM sandbox_hosts WHERE id='worker-protected'`).Scan(&baseURL, &bootID))
	assert.Equal(t, newer.BaseURL, baseURL)
	assert.Equal(t, newer.BootID, bootID)
}

func TestPGStoreHealsRelocatedWorkerIdentityAfterLeaseExpiry(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	original := heartbeatForTest("worker-relocated", "https://worker-old-node.internal")
	_, err := store.Heartbeat(ctx, original)
	require.NoError(t, err)

	relocatedKey := sha256.Sum256([]byte("worker-relocated:new-node-identity"))
	relocated := heartbeatForTest("worker-relocated", "https://worker-new-node.internal")
	relocated.BootID = "worker-relocated-boot-b"
	relocated.IdentityPublicKey = relocatedKey[:]

	// While the incumbent lease is live the new key must stay locked out, and
	// the denial must say why instead of being a bare 0-rows refusal.
	_, err = store.Heartbeat(ctx, relocated)
	require.ErrorIs(t, err, ErrDenied)
	var denial *HeartbeatDenial
	require.ErrorAs(t, err, &denial)
	assert.Equal(t, "worker_identity_conflict", denial.Code)

	// Node relocation: the old pod is gone and its lease has been expired
	// beyond the takeover grace. Re-registration must heal the stale row and
	// authorize — never wedge until an operator clears the row by hand.
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_hosts SET lease_expires_at=now()-interval '3 minutes'
		WHERE id='worker-relocated'`)
	require.NoError(t, err)
	relocated.IdentitySignedAt = time.Now().UTC()
	response, err := store.Heartbeat(ctx, relocated)
	require.NoError(t, err)
	assert.True(t, response.Accepted)
	assert.True(t, response.Authorized)
	assert.True(t, response.AdmitNew)
	assert.True(t, response.IdentityRotated)

	var storedKey []byte
	var healedURL, healedState string
	var generation int64
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT identity_public_key,base_url,state,placement_generation
		FROM sandbox_hosts WHERE id='worker-relocated'`).
		Scan(&storedKey, &healedURL, &healedState, &generation))
	assert.Equal(t, relocatedKey[:], storedKey)
	assert.Equal(t, "https://worker-new-node.internal", healedURL)
	assert.Equal(t, "ready", healedState)
	assert.Equal(t, int64(2), generation,
		"identity takeover is a new boot; placements addressed to the old boot must be fenced by generation")

	// Subsequent heartbeats from the healed identity are ordinary renewals.
	relocated.IdentitySignedAt = time.Now().UTC()
	response, err = store.Heartbeat(ctx, relocated)
	require.NoError(t, err)
	assert.True(t, response.Authorized)
	assert.False(t, response.IdentityRotated)

	// The displaced original key is now the stranger: it must not swing the
	// row back while the healed incumbent is live.
	original.IdentitySignedAt = time.Now().UTC()
	_, err = store.Heartbeat(ctx, original)
	assert.ErrorIs(t, err, ErrDenied)
}

func TestPGStoreFencedWorkerIdentityNeverHealsWithoutOperator(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-fenced", "https://worker-fenced.internal"))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_hosts SET state='fenced',lease_expires_at=now()-interval '1 hour'
		WHERE id='worker-fenced'`)
	require.NoError(t, err)

	replacementKey := sha256.Sum256([]byte("worker-fenced:replacement-identity"))
	replacement := heartbeatForTest("worker-fenced", "https://worker-fenced-new.internal")
	replacement.BootID = "worker-fenced-boot-b"
	replacement.IdentityPublicKey = replacementKey[:]
	_, err = store.Heartbeat(ctx, replacement)
	require.ErrorIs(t, err, ErrDenied)
	var denial *HeartbeatDenial
	require.ErrorAs(t, err, &denial)
	assert.Equal(t, "worker_fenced", denial.Code, "an operator fenced this host; relocation reconciliation must not unfence it")
}

func TestControllerReapsStaleSnapshotArtifactsWithoutDeletingLiveRecoveryPoint(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	var workerDeletes []string
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete || !strings.HasPrefix(request.URL.Path, "/internal/v1/snapshots/") {
			http.NotFound(writer, request)
			return
		}
		workerDeletes = append(workerDeletes, request.URL.Path)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer worker.Close()

	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-snapshot-cleanup", worker.URL))
	require.NoError(t, err)
	persistence := &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	request := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: persistence}
	_, err = store.Allocate(ctx, "msb_snapshot_owner", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_snapshot_owner", 1, "running", "running", ""))

	orphan, err := store.CreateSnapshot(ctx, "msbs_orphan", "msb_snapshot_owner", "msbs_orphan", true)
	require.NoError(t, err)
	orphanSize := int64(128)
	require.NoError(t, store.SetSnapshotState(ctx, orphan.SnapshotID, "failed", "memory://orphan", "orphan-digest", &orphanSize))

	recovery, err := store.CreateSnapshot(ctx, "msbs_live_recovery", "msb_snapshot_owner", "msbs_live_recovery", true)
	require.NoError(t, err)
	recoverySize := int64(256)
	require.NoError(t, store.SetSnapshotState(ctx, recovery.SnapshotID, "exported", "memory://live", "live-digest", &recoverySize))
	_, err = store.SetRecoverySnapshot(ctx, "msb_snapshot_owner", 1, recovery.SnapshotID)
	require.NoError(t, err)
	require.NoError(t, store.SetSnapshotState(ctx, recovery.SnapshotID, "failed", "", "", nil))
	collectible, err := store.CreateSnapshot(ctx, "msbs_collectible_export", "msb_snapshot_owner", "msbs_collectible_export", true)
	require.NoError(t, err)
	collectibleSize := int64(384)
	require.NoError(t, store.SetSnapshotState(ctx, collectible.SnapshotID, "exported", "memory://collectible", "collectible-digest", &collectibleSize))
	userSnapshot, err := store.CreateSnapshot(ctx, "msbs_user_export", "msb_snapshot_owner", "msbs_user_export", false)
	require.NoError(t, err)
	userSize := int64(512)
	require.NoError(t, store.SetSnapshotState(ctx, userSnapshot.SnapshotID, "exported", "memory://user", "user-digest", &userSize))
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_snapshots SET updated_at=now()-interval '31 minutes'
		WHERE id IN ('msbs_orphan','msbs_live_recovery','msbs_collectible_export','msbs_user_export')`)
	require.NoError(t, err)

	objects := &durableMemorySnapshotStore{objects: map[string][]byte{
		"memory://orphan":      []byte("orphan"),
		"memory://live":        []byte("live"),
		"memory://collectible": []byte("collectible"),
		"memory://user":        []byte("user"),
	}}
	controller := New(store, Config{SnapshotStore: objects, HTTPClient: &http.Client{Timeout: time.Second}, AllowInsecureDev: true})
	assert.ErrorIs(t, controller.deleteSnapshot(ctx, recovery.SnapshotID), ErrSnapshotInUse)

	result, err := controller.Reconcile(ctx, time.Now())
	require.NoError(t, err)
	assert.EqualValues(t, 2, result.SnapshotAttempted)
	assert.EqualValues(t, 2, result.SnapshotSucceeded)
	assert.Zero(t, result.SnapshotDeferred)
	_, err = store.GetSnapshot(ctx, orphan.SnapshotID)
	assert.ErrorIs(t, err, ErrNotFound)
	retained, err := store.GetSnapshot(ctx, recovery.SnapshotID)
	require.NoError(t, err)
	assert.Equal(t, "failed", retained.State)
	_, err = store.GetSnapshot(ctx, collectible.SnapshotID)
	assert.ErrorIs(t, err, ErrNotFound)
	retainedUser, err := store.GetSnapshot(ctx, userSnapshot.SnapshotID)
	require.NoError(t, err)
	assert.Equal(t, "exported", retainedUser.State)
	assert.ElementsMatch(t, []string{
		"/internal/v1/snapshots/msbs_orphan",
		"/internal/v1/snapshots/msbs_collectible_export",
	}, workerDeletes)
	objects.mu.Lock()
	defer objects.mu.Unlock()
	assert.NotContains(t, objects.objects, "memory://orphan")
	assert.NotContains(t, objects.objects, "memory://collectible")
	assert.Contains(t, objects.objects, "memory://live")
	assert.Contains(t, objects.objects, "memory://user")
}

func TestPGStoreRetainsLayeredForkSnapshotForRunningEphemeralChild(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-fork-parent", "https://worker-fork-parent.internal"))
	require.NoError(t, err)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_fork_parent", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_fork_parent", 1, "running", "running", ""))
	snapshot, err := store.CreateSnapshot(ctx, "msbs_fork_parent", "msb_fork_parent", "msbs_fork_parent", true)
	require.NoError(t, err)
	size := int64(128)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "gs://bucket/fork.tar", "fork-digest", &size))

	childRequest := sandbox.CreateRequest{SnapshotID: snapshot.SnapshotID}
	child, err := store.Allocate(ctx, "msb_fork_child", childRequest, msb.SanitizeCreateRequest(childRequest), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, child.SandboxID, child.Generation, "running", "running", ""))
	ready, err := store.CreateSnapshot(ctx, "msbs_ready_for_adoption", "msb_fork_parent", "msbs_ready_for_adoption", false)
	require.NoError(t, err)
	require.NoError(t, store.SetSnapshotState(ctx, ready.SnapshotID, "ready", "", "", nil))
	require.NoError(t, store.AdoptSnapshot(ctx, ready.SnapshotID, child.SandboxID))
	adopted, err := store.GetSnapshot(ctx, ready.SnapshotID)
	require.NoError(t, err)
	assert.Equal(t, child.SandboxID, adopted.SourceID)

	failed, err := store.CreateSnapshot(ctx, "msbs_failed_after_fork", "msb_fork_parent", "msbs_failed_after_fork", true)
	require.NoError(t, err)
	require.NoError(t, store.SetSnapshotState(ctx, failed.SnapshotID, "failed", "", "", nil))
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_snapshots
		SET updated_at=CASE id
			WHEN 'msbs_fork_parent' THEN now()-interval '2 hours'
			ELSE now()-interval '1 hour'
		END
		WHERE id IN ('msbs_fork_parent','msbs_failed_after_fork')`)
	require.NoError(t, err)

	// Exclude live layered snapshots in the candidate query itself. Selecting
	// the oldest retained fork and rejecting it later would starve every newer
	// cleanup candidate on each reconciliation pass.
	claimed, err := store.ClaimSnapshotCleanup(ctx, "controller", time.Minute, 30*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, failed.SnapshotID, claimed.SnapshotID)
	require.NoError(t, store.CompleteSnapshotCleanup(ctx, failed.SnapshotID, "controller"))

	_, err = store.BeginSnapshotCleanup(ctx, snapshot.SnapshotID, "controller", time.Minute)
	assert.ErrorIs(t, err, ErrSnapshotInUse)

	require.NoError(t, store.Release(ctx, child.SandboxID, child.Generation))
	cleanup, err := store.BeginSnapshotCleanup(ctx, snapshot.SnapshotID, "controller", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, snapshot.SnapshotID, cleanup.SnapshotID)
}

func TestControllerCompletesSnapshotCleanupAfterWorkerIsPermanentlyLost(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-snapshot-lost", "https://worker-snapshot-lost.internal"))
	require.NoError(t, err)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_snapshot_lost_owner", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_snapshot_lost_owner", 1, "running", "running", ""))
	snapshot, err := store.CreateSnapshot(ctx, "msbs_lost_worker", "msb_snapshot_lost_owner", "msbs_lost_worker", true)
	require.NoError(t, err)
	size := int64(64)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exported", "memory://lost-worker", "lost-worker-digest", &size))
	require.NoError(t, store.Release(ctx, "msb_snapshot_lost_owner", 1))
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_hosts SET state='stale',lease_expires_at=now()-interval '16 minutes'
		WHERE id='worker-snapshot-lost';
		UPDATE sandbox_snapshots SET updated_at=now()-interval '31 minutes'
		WHERE id='msbs_lost_worker'`)
	require.NoError(t, err)

	objects := &durableMemorySnapshotStore{objects: map[string][]byte{"memory://lost-worker": []byte("archive")}}
	controller := New(store, Config{SnapshotStore: objects, AllowInsecureDev: true})
	result, err := controller.Reconcile(ctx, time.Now())
	require.NoError(t, err)
	assert.EqualValues(t, 1, result.SnapshotSucceeded)
	_, err = store.GetSnapshot(ctx, snapshot.SnapshotID)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestPGStoreDoesNotCollectSnapshotDuringLiveExportLease(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-exporting", "https://worker-exporting.internal"))
	require.NoError(t, err)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_exporting", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_exporting", 1, "running", "running", ""))
	snapshot, err := store.CreateSnapshot(ctx, "msbs_exporting", "msb_exporting", "msbs_exporting", true)
	require.NoError(t, err)
	require.NoError(t, store.SetSnapshotState(ctx, snapshot.SnapshotID, "exporting", "", "", nil))
	_, err = pool.Exec(ctx, `
		UPDATE sandbox_snapshots SET updated_at=now()-interval '31 minutes'
		WHERE id='msbs_exporting'`)
	require.NoError(t, err)
	_, err = store.ClaimSnapshotCleanup(ctx, "controller-cleanup", time.Minute, 30*time.Minute)
	assert.ErrorIs(t, err, ErrNotFound)

	_, err = pool.Exec(ctx, `
		UPDATE sandbox_snapshots SET cleanup_lease_expires_at=now()-interval '1 second'
		WHERE id='msbs_exporting'`)
	require.NoError(t, err)
	claimed, err := store.ClaimSnapshotCleanup(ctx, "controller-cleanup", time.Minute, 30*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, snapshot.SnapshotID, claimed.SnapshotID)
}

func TestControllerDeleteOnLostWorkerConvergesCleanupAndCapacity(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	deadWorker := httptest.NewServer(http.NotFoundHandler())
	workerURL := deadWorker.URL
	deadWorker.Close()
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-lost", workerURL))
	require.NoError(t, err)
	request := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_delete_lost", request, msb.SanitizeCreateRequest(request), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_delete_lost", 1, "running", "running", ""))

	controller := New(store, Config{APIKey: "api-key", HTTPClient: &http.Client{Timeout: time.Second}, AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodDelete, "/v1/sandboxes/msb_delete_lost", "delete-lost", "")
	assert.Equal(t, http.StatusAccepted, response.Code)
	assert.Equal(t, "true", response.Header().Get("X-Plue-Cleanup-Pending"))
	var pending bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT cleanup_pending FROM sandbox_instances WHERE id='msb_delete_lost'`).Scan(&pending))
	assert.True(t, pending)

	_, err = pool.Exec(ctx, `
		UPDATE sandbox_hosts SET state='stale',lease_expires_at=now()-interval '1 second' WHERE id='worker-lost';
		UPDATE sandbox_instances SET lease_expires_at=now()-interval '1 second' WHERE id='msb_delete_lost'`)
	require.NoError(t, err)
	result, err := controller.Reconcile(ctx, time.Now())
	require.NoError(t, err)
	assert.EqualValues(t, 1, result.CleanupSucceeded)
	_, err = store.GetPlacement(ctx, "msb_delete_lost")
	assert.ErrorIs(t, err, ErrNotFound)
	var reserved int
	require.NoError(t, pool.QueryRow(ctx, `SELECT allocated_vms FROM sandbox_hosts WHERE id='worker-lost'`).Scan(&reserved))
	assert.Zero(t, reserved)
}

const httpStatusCreated = 201

func heartbeatForTest(id, baseURL string) msb.WorkerHeartbeat {
	identity := sha256.Sum256([]byte("worker-identity:" + id))
	return msb.WorkerHeartbeat{
		WorkerID: id, BootID: id + "-boot-a", BaseURL: baseURL, State: "ready", LeaseTTLSeconds: 30,
		IdentityPublicKey: identity[:], IdentitySignedAt: time.Now().UTC(),
		Capacity: msb.WorkerCapacity{
			CPUMillis: 8000, MemoryBytes: 32 * 1024 * 1024 * 1024,
			DiskBytes: 300 * 1024 * 1024 * 1024, VMs: 24,
		},
	}
}

func openMicrosandboxTestDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("requires PostgreSQL; covered by DB Integration")
	}
	dsn := strings.TrimSpace(os.Getenv("SMITHERS_TEST_DATABASE_URL"))
	if dsn == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_TEST_DATABASE_URL is required")
		}
		t.Skip("SMITHERS_TEST_DATABASE_URL is required for Microsandbox store integration tests")
	}
	schema, err := os.ReadFile(filepath.Join("..", "..", "..", "db", "schema.sql"))
	require.NoError(t, err)
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	adminConfig := config.Copy()
	adminConfig.ConnConfig.Database = "postgres"
	admin, err := pgxpool.NewWithConfig(ctx, adminConfig)
	require.NoError(t, err)
	require.NoError(t, admin.Ping(ctx))

	// The generated hosted schema names public explicitly. Use a fresh database
	// for each test so applying it cannot touch the configured PostgreSQL DB.
	database := "smithers_microsandbox_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{database}.Sanitize())
	require.NoError(t, err)
	var pool *pgxpool.Pool
	t.Cleanup(func() {
		if pool != nil {
			pool.Close()
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, dropErr := admin.Exec(cleanupCtx, `DROP DATABASE `+pgx.Identifier{database}.Sanitize()+` WITH (FORCE)`)
		admin.Close()
		require.NoError(t, dropErr)
	})

	config.ConnConfig.Database = database
	pool, err = pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	require.NoError(t, pool.Ping(ctx))
	_, err = pool.Exec(ctx, string(schema))
	require.NoError(t, err)
	return pool
}
