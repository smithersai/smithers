package control

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestPGStoreInspectionPreservesDegradedCheckpointAndRecoveryReasons(t *testing.T) {
	for _, reason := range []string{"", "secrets_required", "planned_drain"} {
		t.Run("reason="+reason, func(t *testing.T) {
			pool := openMicrosandboxTestDatabase(t)
			ctx := context.Background()
			store := NewPGStore(pool)
			_, err := store.Heartbeat(ctx, heartbeatForTest("old-worker", "https://old-worker.invalid"))
			require.NoError(t, err)
			create := sandbox.CreateRequest{Image: "image@sha256:one", Persistence: &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}}
			_, err = store.Allocate(ctx, "msb_retained", create, msb.SanitizeCreateRequest(create), ResourceOwner{Kind: "workspace", ID: "retained-workspace"})
			require.NoError(t, err)
			_, err = store.CreateSnapshot(ctx, "msbs_retained", "msb_retained", "local-snapshot", true)
			require.NoError(t, err)
			size := int64(1024)
			require.NoError(t, store.SetSnapshotState(ctx, "msbs_retained", "exported", "gs://test/retained.tar", "retained-digest", &size))
			_, err = store.SetRecoverySnapshot(ctx, "msb_retained", 1, "msbs_retained")
			require.NoError(t, err)
			// A failed newer checkpoint can leave a historical exported snapshot
			// behind. Empty recovery intent must not authorize restoring it.
			require.NoError(t, store.SetState(ctx, "msb_retained", 1, "stopped", "degraded", "new checkpoint export failed"))
			_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET recovery_reason=$1 WHERE id='msb_retained'`, reason)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state='stale',lease_expires_at=now()-interval '1 day' WHERE id='old-worker'`)
			require.NoError(t, err)

			result, err := store.Reconcile(ctx, time.Now())
			require.NoError(t, err)
			var actualReason string
			require.NoError(t, pool.QueryRow(ctx, `SELECT recovery_reason FROM sandbox_instances WHERE id='msb_retained'`).Scan(&actualReason))
			retained, err := store.GetPlacement(ctx, "msb_retained")
			require.NoError(t, err)
			assert.True(t, retained.WorkerUnavailable)
			assert.Equal(t, "stopped", retained.DesiredState)
			assert.Equal(t, "msbs_retained", retained.RecoverySnapshotID)
			assert.Equal(t, "retained-digest", retained.RecoverySnapshotDigest)
			assert.Equal(t, reason, actualReason, "inspection and reconciliation must preserve recovery intent")
			assert.Zero(t, result.DegradedPersistent)
			assert.EqualValues(t, 1, retained.Generation)
			if reason == "" {
				_, err = store.ClaimRecovery(ctx, "test-controller", time.Minute)
				assert.ErrorIs(t, err, ErrNotFound, "an exported historical snapshot does not authorize automatic rollback")
			}

		})
	}
}

func TestPGStoreProjectsExpiredAndFencedWorkerAvailability(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)
	_, err := store.Heartbeat(ctx, heartbeatForTest("worker", "https://worker.invalid"))
	require.NoError(t, err)
	_, err = store.Allocate(ctx, "msb_availability", sandbox.CreateRequest{}, nil, ResourceOwner{Kind: "workspace", ID: "availability-workspace"})
	require.NoError(t, err)
	for _, tc := range []struct {
		state                string
		expired, unavailable bool
	}{
		{"ready", false, false}, {"draining", false, false}, {"ready", true, true}, {"fenced", false, true},
	} {
		_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state=$1,lease_expires_at=now()+CASE WHEN $2 THEN interval '-1 hour' ELSE interval '1 hour' END WHERE id='worker'`, tc.state, tc.expired)
		require.NoError(t, err)
		placement, err := store.GetPlacement(ctx, "msb_availability")
		require.NoError(t, err)
		assert.Equal(t, tc.unavailable, placement.WorkerUnavailable, "%s expired=%v", tc.state, tc.expired)
	}
}

func TestControllerInspectRefusesUnavailableWorkerWithoutDialingIt(t *testing.T) {
	var calls atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(w, http.StatusOK, sandbox.Sandbox{ID: "local-runtime", State: sandbox.StateStopped})
	}))
	defer worker.Close()
	store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{SandboxID: "msb_retained", WorkerUnavailable: true}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodGet, "/v1/sandboxes/msb_retained", "", "")
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.Contains(t, response.Body.String(), "host_lease_lost")
	assert.Contains(t, response.Body.String(), "Use another workspace, or retry when this worker is available.")
	assert.Zero(t, calls.Load(), "a known unavailable worker must not delay the HTTP response")
	store.placement.WorkerUnavailable = false
	response = controllerRequest(t, controller, http.MethodGet, "/v1/sandboxes/msb_retained", "", "")
	assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.EqualValues(t, 1, calls.Load())
	assert.Contains(t, response.Body.String(), "msb_retained")
}
