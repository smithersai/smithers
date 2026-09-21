package control

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

var (
	ErrNoCapacity = errors.New("no healthy Microsandbox worker has sufficient capacity")
	ErrNotFound   = errors.New("sandbox placement not found")
	// ErrSnapshotNotFound distinguishes "the snapshot this create referenced is
	// gone" from every other not-found. It WRAPS ErrNotFound so existing
	// errors.Is(err, ErrNotFound) callers keep their behavior, while the HTTP
	// layer can emit a machine-readable `snapshot_not_found` code. Callers must
	// never re-derive this from the error prose: a client that substring-matched
	// "snapshot" against the generic "sandbox resource was not found" message
	// silently failed to retire a dangling golden-snapshot pointer for 8 days.
	ErrSnapshotNotFound        = fmt.Errorf("sandbox snapshot not found: %w", ErrNotFound)
	ErrStale                   = errors.New("sandbox placement generation is stale")
	ErrDenied                  = errors.New("sandbox access grant denied")
	ErrSnapshotInUse           = errors.New("snapshot is still required by a live sandbox")
	ErrIdempotencyConflict     = errors.New("idempotency key was reused for a different request")
	ErrOperationInProgress     = errors.New("idempotent operation is already in progress")
	ErrRecoverySecretsRequired = errors.New("sandbox recovery requires secret reinjection")
)

// identityTakeoverGrace is how long a worker's authorization lease must have
// been expired before a heartbeat presenting a NEW identity key may reclaim
// the same durable worker ID. The per-node identity key lives on the worker's
// hostPath, so a node relocation reschedules the same durable worker with a
// key the host row has never seen. A live worker renews its 30-second lease
// every 10 seconds; a lease dead for four full windows means the incumbent
// workload is gone and its placements are already degraded for durable
// recovery, so handing the ID to the replacement key is reconciliation, not
// hijack. Live workers stay protected: their lease never ages into this
// window.
const identityTakeoverGrace = 2 * time.Minute

// HeartbeatDenial explains why a worker heartbeat was refused. It wraps
// ErrDenied so existing errors.Is(err, ErrDenied) callers keep their
// behavior, while the controller can log and return a machine-readable
// reason. Before this existed a denial was a bare 0-rows upsert: a relocated
// worker wedged unauthorized indefinitely with no diagnosable cause on either
// side of the connection.
type HeartbeatDenial struct {
	Code    string
	Message string
}

func (d *HeartbeatDenial) Error() string { return d.Message }
func (d *HeartbeatDenial) Unwrap() error { return ErrDenied }

type ReconcileResult struct {
	StaleHosts         int64
	FailedEphemeral    int64
	DegradedPersistent int64
	MissingRuntime     int64
	RecoveryAttempted  int64
	RecoverySucceeded  int64
	RecoveryFailed     int64
	RestartAttempted   int64
	RestartSucceeded   int64
	RestartFailed      int64
	CleanupAttempted   int64
	CleanupSucceeded   int64
	CleanupDeferred    int64
	DrainAttempted     int64
	DrainCheckpointed  int64
	DrainDeferred      int64
	SnapshotAttempted  int64
	SnapshotSucceeded  int64
	SnapshotDeferred   int64
}

type OperationResponse struct {
	StatusCode  int                 `json:"status_code"`
	ContentType string              `json:"content_type,omitempty"`
	Body        []byte              `json:"body,omitempty"`
	Replayable  bool                `json:"replayable"`
	Headers     map[string][]string `json:"headers,omitempty"`
}

type Placement struct {
	SandboxID string
	LocalID   string
	WorkerID  string
	WorkerURL string
	// WorkerUnavailable is read with the placement so inspection never dials a
	// worker whose ownership lease is already known to be lost.
	WorkerUnavailable         bool
	Generation                int64
	DesiredState              string
	ObservedState             string
	Requested                 msb.WorkerCapacity
	SnapshotLocalID           string
	SnapshotWorkerID          string
	SnapshotObjectURI         string
	SnapshotDigest            string
	Persistent                bool
	RecoverySnapshotID        string
	RecoverySnapshotLocalID   string
	RecoverySnapshotObjectURI string
	RecoverySnapshotDigest    string
	RequestSpec               json.RawMessage
	RecoveryServices          []sandbox.ServiceSpec
}

type RecoveryClaim struct {
	Placement         Placement
	PreviousPlacement *Placement
	DesiredState      string
	ReuseStoppedDisk  bool
}

type DrainClaim struct {
	Placement        Placement
	PreviousObserved string
}

type ResourceOwner struct {
	Kind string
	ID   string
}

type SnapshotPlacement struct {
	SnapshotID string
	LocalID    string
	WorkerID   string
	WorkerURL  string
	Generation int64
	SourceID   string
	ObjectURI  string
	Digest     string
	SizeBytes  *int64
	State      string
}

type Store interface {
	Heartbeat(context.Context, msb.WorkerHeartbeat) (msb.WorkerHeartbeatResponse, error)
	Allocate(context.Context, string, sandbox.CreateRequest, json.RawMessage, ResourceOwner) (Placement, error)
	GetPlacement(context.Context, string) (Placement, error)
	SetState(context.Context, string, int64, string, string, string) error
	// QueueFailedCreateCleanup parks a failed create as pending cleanup so the
	// reconcile loop owns the worker delete and tombstone with retries.
	QueueFailedCreateCleanup(context.Context, string, int64, string) error
	RecordService(context.Context, string, int64, json.RawMessage) error
	BeginDelete(context.Context, string, int64) error
	Release(context.Context, string, int64) error
	// ReleaseReservation/AcquireReservation move a live placement's worker
	// reservation without deleting it, so an idle-suspended guest stops holding
	// pool capacity and a resume re-charges it (or fails with ErrNoCapacity).
	ReleaseReservation(context.Context, string, int64) error
	AcquireReservation(context.Context, string, int64) (bool, error)
	CreateSnapshot(context.Context, string, string, string, bool) (SnapshotPlacement, error)
	GetSnapshot(context.Context, string) (SnapshotPlacement, error)
	SetSnapshotState(context.Context, string, string, string, string, *int64) error
	SetRecoverySnapshot(context.Context, string, int64, string) (string, error)
	AdoptSnapshot(context.Context, string, string) error
	BeginSnapshotCleanup(context.Context, string, string, time.Duration) (SnapshotPlacement, error)
	ClaimSnapshotCleanup(context.Context, string, time.Duration, time.Duration) (SnapshotPlacement, error)
	CompleteSnapshotCleanup(context.Context, string, string) error
	FailSnapshotCleanup(context.Context, string, string, string) error
	CreateIdentity(context.Context, string, time.Time) error
	GrantPermission(context.Context, string, string, string, []string) (int64, error)
	CreateAccessGrant(context.Context, string, string, []byte, time.Time) error
	RevokeAccessGrant(context.Context, string) error
	RevokeSandboxAccessGrants(context.Context, string) error
	ValidateAccess(context.Context, msb.AccessValidationRequest, []byte) (msb.AccessValidationResponse, error)
	PublishIngress(context.Context, string, string, int32) (sandbox.IngressRoute, error)
	RevokeIngress(context.Context, string) error
	ResolveDomainMapping(context.Context, string) (msb.PreviewTarget, error)
	Reconcile(context.Context, time.Time) (ReconcileResult, error)
	ClaimCleanup(context.Context, string, time.Duration) (Placement, error)
	FailCleanup(context.Context, string, int64, string) error
	ClaimDrain(context.Context, string, time.Duration) (DrainClaim, error)
	CompleteDrainCheckpoint(context.Context, string, int64) error
	FailDrain(context.Context, string, int64, string, string) error
	ClaimRestart(context.Context, string, time.Duration) (Placement, error)
	FailRestart(context.Context, string, int64, string) error
	ClaimRecovery(context.Context, string, time.Duration) (RecoveryClaim, error)
	CompleteRecovery(context.Context, string, int64, string) error
	FailRecovery(context.Context, string, int64, string) error
	BlockRecovery(context.Context, string, int64, string) error
	BeginOperation(context.Context, string, string, string) (OperationResponse, bool, error)
	BindOperation(context.Context, string, string) error
	CompleteOperation(context.Context, string, OperationResponse) error
	InsertEgressAuditBatch(context.Context, string, []msb.SandboxEgressAuditRecord) (int64, error)
}

type PGStore struct {
	pool       *pgxpool.Pool
	diskGCRefs DiskGCProtectionQuerier
}

// DiskGCProtectionQuerier supplies product-owned image and snapshot references
// without coupling the standalone controller's core schema tests to those
// higher-level tables.
type DiskGCProtectionQuerier interface {
	ListReadySandboxEnvironmentImageReferences(context.Context) ([]string, error)
	ListProtectedWorkerSnapshotLocalIDs(context.Context, string) ([]string, error)
}

type PGStoreOption func(*PGStore)

func WithDiskGCProtectionQuerier(querier DiskGCProtectionQuerier) PGStoreOption {
	return func(store *PGStore) { store.diskGCRefs = querier }
}

func NewPGStore(pool *pgxpool.Pool, options ...PGStoreOption) *PGStore {
	store := &PGStore{pool: pool}
	for _, option := range options {
		if option != nil {
			option(store)
		}
	}
	return store
}

func (s *PGStore) InsertEgressAuditBatch(ctx context.Context, workerID string, records []msb.SandboxEgressAuditRecord) (int64, error) {
	if s == nil || s.pool == nil {
		return 0, errors.New("sandbox control store is unavailable")
	}
	payload, err := json.Marshal(records)
	if err != nil {
		return 0, err
	}
	return db.New(s.pool).InsertSandboxEgressAuditBatch(ctx, db.InsertSandboxEgressAuditBatchParams{
		WorkerID: workerID,
		Records:  payload,
	})
}

func (s *PGStore) Heartbeat(ctx context.Context, heartbeat msb.WorkerHeartbeat) (msb.WorkerHeartbeatResponse, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		response, err := s.heartbeatOnce(ctx, heartbeat)
		if err == nil || !retryableTransactionError(err) {
			return response, err
		}
		lastErr = err
		timer := time.NewTimer(time.Duration(attempt+1) * 10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return msb.WorkerHeartbeatResponse{}, ctx.Err()
		case <-timer.C:
		}
	}
	return msb.WorkerHeartbeatResponse{}, lastErr
}

func retryableTransactionError(err error) bool {
	var sqlState interface{ SQLState() string }
	return errors.As(err, &sqlState) && (sqlState.SQLState() == "40P01" || sqlState.SQLState() == "40001")
}

func (s *PGStore) heartbeatOnce(ctx context.Context, heartbeat msb.WorkerHeartbeat) (msb.WorkerHeartbeatResponse, error) {
	if s == nil || s.pool == nil {
		return msb.WorkerHeartbeatResponse{}, errors.New("sandbox control store is unavailable")
	}
	leaseTTL := heartbeat.LeaseTTL
	if leaseTTL <= 0 && heartbeat.LeaseTTLSeconds > 0 {
		leaseTTL = time.Duration(heartbeat.LeaseTTLSeconds) * time.Second
	}
	if leaseTTL <= 0 {
		leaseTTL = 30 * time.Second
	}
	state := strings.ToLower(strings.TrimSpace(heartbeat.State))
	if state == "" {
		state = "ready"
	}
	if len(heartbeat.Inventory) > 10_000 {
		return msb.WorkerHeartbeatResponse{}, errors.New("worker inventory exceeds controller limit")
	}
	if len(heartbeat.IdentityPublicKey) != 32 {
		return msb.WorkerHeartbeatResponse{}, &HeartbeatDenial{
			Code: "worker_identity_invalid", Message: "worker heartbeat identity key is malformed",
		}
	}
	protection := msb.WorkerDiskGCProtection{}
	if s.diskGCRefs != nil {
		var err error
		protection.Images, err = s.diskGCRefs.ListReadySandboxEnvironmentImageReferences(ctx)
		if err != nil {
			return msb.WorkerHeartbeatResponse{}, fmt.Errorf("list disk GC protected images: %w", err)
		}
		protection.Snapshots, err = s.diskGCRefs.ListProtectedWorkerSnapshotLocalIDs(ctx, heartbeat.WorkerID)
		if err != nil {
			return msb.WorkerHeartbeatResponse{}, fmt.Errorf("list disk GC protected snapshots: %w", err)
		}
	}
	inventoryIDs := make([]string, 0, len(heartbeat.Inventory))
	inventoryGenerations := make([]int64, 0, len(heartbeat.Inventory))
	inventoryStates := make([]string, 0, len(heartbeat.Inventory))
	seenInventory := make(map[string]struct{}, len(heartbeat.Inventory))
	for _, item := range heartbeat.Inventory {
		id := strings.TrimSpace(item.SandboxID)
		if id == "" || item.Generation <= 0 {
			return msb.WorkerHeartbeatResponse{}, errors.New("worker inventory contains an invalid placement")
		}
		if _, duplicate := seenInventory[id]; duplicate {
			return msb.WorkerHeartbeatResponse{}, errors.New("worker inventory contains a duplicate sandbox")
		}
		seenInventory[id] = struct{}{}
		observedState := strings.ToLower(strings.TrimSpace(item.State))
		switch observedState {
		case "running", "stopped", "restart_pending":
		default:
			observedState = ""
		}
		inventoryIDs = append(inventoryIDs, id)
		inventoryGenerations = append(inventoryGenerations, item.Generation)
		inventoryStates = append(inventoryStates, observedState)
	}
	capabilities, _ := json.Marshal(heartbeat.Capabilities)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var effectiveState string
	err = tx.QueryRow(ctx, `
		INSERT INTO sandbox_hosts (
			id, identity_public_key, identity_signed_at, base_url, state, boot_id, capacity_cpu_millis, capacity_memory_bytes,
			capacity_disk_bytes, capacity_vms, allocated_cpu_millis,
			allocated_memory_bytes, allocated_disk_bytes, allocated_vms,
			observed_allocated_cpu_millis, observed_allocated_memory_bytes,
			observed_allocated_disk_bytes, observed_allocated_vms,
			capabilities, runtime_version, worker_image, heartbeat_at,
			lease_expires_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,0,0,$11,$12,$13,$14,$15,$16,$17,now(),now()+$18::interval,now())
		ON CONFLICT (id) DO UPDATE SET
			base_url=EXCLUDED.base_url,
			state=CASE
				WHEN sandbox_hosts.state='fenced' THEN sandbox_hosts.state
				WHEN sandbox_hosts.state='draining' AND sandbox_hosts.boot_id=EXCLUDED.boot_id
				THEN sandbox_hosts.state
				ELSE EXCLUDED.state
			END,
			boot_id=EXCLUDED.boot_id,
			placement_generation=CASE
				WHEN sandbox_hosts.boot_id<>EXCLUDED.boot_id THEN sandbox_hosts.placement_generation+1
				ELSE sandbox_hosts.placement_generation
			END,
			capacity_cpu_millis=EXCLUDED.capacity_cpu_millis,
			capacity_memory_bytes=EXCLUDED.capacity_memory_bytes,
			capacity_disk_bytes=EXCLUDED.capacity_disk_bytes,
			capacity_vms=EXCLUDED.capacity_vms,
			observed_allocated_cpu_millis=EXCLUDED.observed_allocated_cpu_millis,
			observed_allocated_memory_bytes=EXCLUDED.observed_allocated_memory_bytes,
			observed_allocated_disk_bytes=EXCLUDED.observed_allocated_disk_bytes,
			observed_allocated_vms=EXCLUDED.observed_allocated_vms,
			capabilities=EXCLUDED.capabilities,
			runtime_version=EXCLUDED.runtime_version,
			worker_image=EXCLUDED.worker_image,
			identity_signed_at=EXCLUDED.identity_signed_at,
			heartbeat_at=now(),
			lease_expires_at=EXCLUDED.lease_expires_at,
			updated_at=now()
		WHERE sandbox_hosts.identity_public_key=EXCLUDED.identity_public_key
		  AND EXCLUDED.identity_signed_at >= sandbox_hosts.identity_signed_at
		RETURNING state`,
		heartbeat.WorkerID, heartbeat.IdentityPublicKey, heartbeat.IdentitySignedAt,
		heartbeat.BaseURL, state, heartbeat.BootID,
		heartbeat.Capacity.CPUMillis, heartbeat.Capacity.MemoryBytes,
		heartbeat.Capacity.DiskBytes, heartbeat.Capacity.VMs,
		heartbeat.Allocated.CPUMillis, heartbeat.Allocated.MemoryBytes,
		heartbeat.Allocated.DiskBytes, heartbeat.Allocated.VMs,
		capabilities, heartbeat.RuntimeVersion, heartbeat.WorkerImage,
		fmt.Sprintf("%f seconds", leaseTTL.Seconds()),
	).Scan(&effectiveState)
	identityRotated := false
	if errors.Is(err, pgx.ErrNoRows) {
		effectiveState, err = takeOverRelocatedWorkerIdentity(ctx, tx, heartbeat, state, capabilities, leaseTTL)
		identityRotated = err == nil
	}
	if err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}

	if _, err := tx.Exec(ctx, `
		WITH inventory AS (
			SELECT * FROM unnest($2::text[],$3::bigint[],$4::text[])
				AS v(provider_local_id,generation,state)
		)
		UPDATE sandbox_instances i SET last_heartbeat_at=now(),
			compute_observed_at=CASE
				WHEN NOT $5::boolean OR v.state<>'stopped' THEN now()
				ELSE NULL END,
			observed_state=CASE
				WHEN i.observed_state='starting' AND v.state='running' THEN 'running'
				WHEN i.observed_state IN ('starting','stopping','recovering','deleting','degraded','failed') THEN i.observed_state
				WHEN v.state='' THEN i.observed_state ELSE v.state END,
			updated_at=CASE
				WHEN i.observed_state='starting' AND v.state='running' THEN now()
				WHEN i.observed_state NOT IN ('starting','stopping','recovering','deleting','degraded','failed')
				  AND v.state<>'' AND i.observed_state<>v.state THEN now()
				ELSE i.updated_at END
		FROM inventory v
		WHERE i.provider_local_id=v.provider_local_id AND i.worker_id=$1
		  AND i.placement_generation=v.generation AND i.deleted_at IS NULL`,
		heartbeat.WorkerID, inventoryIDs, inventoryGenerations, inventoryStates,
		heartbeat.Capabilities[msb.WorkerCapabilityAllocationExcludesStoppedCompute]); err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	// Hand back the compute reservation of every guest this worker is no longer
	// running. Retained disk remains charged until delete.
	// Microsandbox suspends a guest on ITS OWN idle timer (repo gateways and
	// workspaces both ship a 30-minute one), so the controller never sees a
	// stop/suspend call for the common case — the only signal is the guest
	// turning up 'stopped' in the heartbeat inventory. Without this, an idle
	// pool stays 100% reserved and every new provision 503s, which is exactly
	// how the single production worker wedged at 7000/7000 on 2026-08-07.
	//
	// The updated_at guard is what makes it safe against an in-flight resume:
	// AcquireReservation and every observed-state transition stamp updated_at,
	// so a guest that has only just been recharged or has only just gone down is
	// left alone until it has been settled for a full minute (six heartbeats).
	if _, err := tx.Exec(ctx, `
		WITH released AS (
			UPDATE sandbox_instances i SET reservation_held=false, updated_at=now()
			WHERE i.worker_id=$1 AND i.deleted_at IS NULL AND i.reservation_held
			  AND i.observed_state='stopped'
			  AND i.updated_at < now()-interval '60 seconds'
			RETURNING i.requested_cpu_millis AS cpu, i.requested_memory_bytes AS memory
		), totals AS (
			SELECT COALESCE(SUM(cpu),0) AS cpu, COALESCE(SUM(memory),0) AS memory,
			       count(*) AS vms FROM released
		)
		UPDATE sandbox_hosts h SET
			allocated_cpu_millis=GREATEST(0,h.allocated_cpu_millis-t.cpu),
			allocated_memory_bytes=GREATEST(0,h.allocated_memory_bytes-t.memory),
			allocated_vms=GREATEST(0,h.allocated_vms-t.vms), updated_at=now()
		FROM totals t WHERE h.id=$1 AND t.vms > 0`, heartbeat.WorkerID); err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	if _, err := tx.Exec(ctx, `
		WITH inventory AS (
			SELECT * FROM unnest($2::text[],$3::bigint[])
				AS v(provider_local_id,generation)
		)
		DELETE FROM sandbox_orphans o USING inventory v,sandbox_instances i
		WHERE o.worker_id=$1 AND o.provider_local_id=v.provider_local_id
		  AND o.placement_generation=v.generation
		  AND i.provider_local_id=v.provider_local_id AND i.worker_id=$1
		  AND i.placement_generation=v.generation AND i.deleted_at IS NULL`,
		heartbeat.WorkerID, inventoryIDs, inventoryGenerations); err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	if _, err := tx.Exec(ctx, `
		WITH inventory AS (
			SELECT * FROM unnest($2::text[],$3::bigint[])
				AS v(provider_local_id,generation)
		)
		INSERT INTO sandbox_orphans (
			worker_id,provider_local_id,placement_generation,first_seen_at,last_seen_at,delete_after
		)
		SELECT $1,v.provider_local_id,v.generation,now(),now(),now()+interval '15 minutes'
		FROM inventory v
		WHERE NOT EXISTS (
			SELECT 1 FROM sandbox_instances i
			WHERE i.provider_local_id=v.provider_local_id AND i.worker_id=$1
			  AND i.placement_generation=v.generation AND i.deleted_at IS NULL
		)
		ON CONFLICT (worker_id,provider_local_id,placement_generation) DO UPDATE SET
			last_seen_at=now()`, heartbeat.WorkerID, inventoryIDs, inventoryGenerations); err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	// Inventory entries that disappeared after quarantine no longer need a
	// tombstone. Entries still reported refresh last_seen_at above.
	if _, err := tx.Exec(ctx, `
		DELETE FROM sandbox_orphans
		WHERE worker_id=$1 AND last_seen_at < now()-$2::interval`,
		heartbeat.WorkerID, fmt.Sprintf("%f seconds", 2*leaseTTL.Seconds())); err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT o.provider_local_id,o.placement_generation
		FROM sandbox_orphans o
		WHERE o.worker_id=$1 AND o.delete_after <= now()
		  AND NOT EXISTS (
			SELECT 1 FROM sandbox_instances i
			WHERE i.provider_local_id=o.provider_local_id AND i.worker_id=o.worker_id
			  AND i.placement_generation=o.placement_generation AND i.deleted_at IS NULL
		  )
		ORDER BY o.delete_after LIMIT 100`, heartbeat.WorkerID)
	if err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	deletions := make([]msb.WorkerInventoryItem, 0)
	for rows.Next() {
		var item msb.WorkerInventoryItem
		if err := rows.Scan(&item.SandboxID, &item.Generation); err != nil {
			rows.Close()
			return msb.WorkerHeartbeatResponse{}, err
		}
		deletions = append(deletions, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return msb.WorkerHeartbeatResponse{}, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return msb.WorkerHeartbeatResponse{}, err
	}
	return msb.WorkerHeartbeatResponse{
		Accepted: true, State: effectiveState,
		Authorized:       effectiveState == "ready" || effectiveState == "draining",
		AdmitNew:         effectiveState == "ready",
		DeleteOrphans:    deletions,
		DiskGCProtection: protection,
		IdentityRotated:  identityRotated,
	}, nil
}

// takeOverRelocatedWorkerIdentity heals the durable host row after a node
// relocation. The identity-pinned upsert above correctly refuses a known
// worker ID arriving with an unknown key — but when the incumbent's lease has
// been expired for identityTakeoverGrace, that refusal is no longer
// protecting a live worker; it is wedging the relocated one. Re-bind the row
// to the new key so re-registration converges without operator surgery.
// Placement generation advances on the boot change, so anything addressed to
// the previous boot stays fenced, and the takeover UPDATE's WHERE clause
// makes concurrent controller replicas serialize on the row: the loser
// re-evaluates against the healed row and reports a plain denial. Fenced rows
// never heal here — an operator fenced them deliberately.
func takeOverRelocatedWorkerIdentity(ctx context.Context, tx pgx.Tx, heartbeat msb.WorkerHeartbeat, state string, capabilities []byte, leaseTTL time.Duration) (string, error) {
	var effectiveState string
	err := tx.QueryRow(ctx, `
		UPDATE sandbox_hosts SET
			identity_public_key=$2, identity_signed_at=$3, base_url=$4, state=$5,
			boot_id=$6,
			placement_generation=CASE
				WHEN sandbox_hosts.boot_id<>$6 THEN sandbox_hosts.placement_generation+1
				ELSE sandbox_hosts.placement_generation
			END,
			capacity_cpu_millis=$7, capacity_memory_bytes=$8,
			capacity_disk_bytes=$9, capacity_vms=$10,
			observed_allocated_cpu_millis=$11, observed_allocated_memory_bytes=$12,
			observed_allocated_disk_bytes=$13, observed_allocated_vms=$14,
			capabilities=$15, runtime_version=$16, worker_image=$17,
			heartbeat_at=now(), lease_expires_at=now()+$18::interval, updated_at=now()
		WHERE sandbox_hosts.id=$1
		  AND sandbox_hosts.identity_public_key <> $2
		  AND sandbox_hosts.state <> 'fenced'
		  AND sandbox_hosts.lease_expires_at <= now() - $19::interval
		RETURNING state`,
		heartbeat.WorkerID, heartbeat.IdentityPublicKey, heartbeat.IdentitySignedAt,
		heartbeat.BaseURL, state, heartbeat.BootID,
		heartbeat.Capacity.CPUMillis, heartbeat.Capacity.MemoryBytes,
		heartbeat.Capacity.DiskBytes, heartbeat.Capacity.VMs,
		heartbeat.Allocated.CPUMillis, heartbeat.Allocated.MemoryBytes,
		heartbeat.Allocated.DiskBytes, heartbeat.Allocated.VMs,
		capabilities, heartbeat.RuntimeVersion, heartbeat.WorkerImage,
		fmt.Sprintf("%f seconds", leaseTTL.Seconds()),
		fmt.Sprintf("%f seconds", identityTakeoverGrace.Seconds()),
	).Scan(&effectiveState)
	if err == nil {
		return effectiveState, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	return "", heartbeatDenialReason(ctx, tx, heartbeat)
}

// heartbeatDenialReason turns a silent 0-rows heartbeat upsert into a
// machine-readable cause, read under the same transaction so the explanation
// matches the exact row state that refused the heartbeat.
func heartbeatDenialReason(ctx context.Context, tx pgx.Tx, heartbeat msb.WorkerHeartbeat) error {
	var storedKey []byte
	var storedSignedAt, leaseExpiresAt time.Time
	var storedState string
	err := tx.QueryRow(ctx, `
		SELECT identity_public_key, identity_signed_at, state, lease_expires_at
		FROM sandbox_hosts WHERE id=$1`, heartbeat.WorkerID).
		Scan(&storedKey, &storedSignedAt, &storedState, &leaseExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return &HeartbeatDenial{Code: "worker_registration_conflict",
			Message: "worker host row changed during heartbeat; retry"}
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(storedKey, heartbeat.IdentityPublicKey) {
		if storedState == "fenced" {
			return &HeartbeatDenial{Code: "worker_fenced",
				Message: "worker id is fenced; operator action is required before a replacement identity may register"}
		}
		return &HeartbeatDenial{Code: "worker_identity_conflict",
			Message: fmt.Sprintf(
				"worker id is bound to a different identity key (lease expires %s); a replacement identity may re-register %s after lease expiry",
				leaseExpiresAt.UTC().Format(time.RFC3339), identityTakeoverGrace)}
	}
	return &HeartbeatDenial{Code: "worker_identity_stale",
		Message: fmt.Sprintf(
			"heartbeat identity proof signed at %s does not supersede the stored proof from %s",
			heartbeat.IdentitySignedAt.UTC().Format(time.RFC3339), storedSignedAt.UTC().Format(time.RFC3339))}
}

func requestedCapacity(request sandbox.CreateRequest) msb.WorkerCapacity {
	cpus := int64(1)
	if request.VCPUCount != nil && *request.VCPUCount > 0 {
		cpus = int64(*request.VCPUCount)
	}
	memoryMiB := int64(512)
	if request.MemSizeMB != nil && *request.MemSizeMB > 0 {
		memoryMiB = int64(*request.MemSizeMB)
	}
	diskMiB := msb.DefaultRootfsSizeMB(request.Kind)
	if request.RootfsSizeMB != nil && *request.RootfsSizeMB > 0 {
		diskMiB = *request.RootfsSizeMB
	}
	return msb.WorkerCapacity{
		CPUMillis:   cpus * 1000,
		MemoryBytes: memoryMiB * 1024 * 1024,
		DiskBytes:   diskMiB * 1024 * 1024,
		VMs:         1,
	}
}

// observedReservationsJoin attributes the worker's latest aggregate back to
// controller-owned placements. last_heartbeat_at marks every placement in the
// latest inventory (disk is retained and always observed); compute_observed_at
// marks only entries included by that worker version's compute aggregate.
// Anything left in observed after subtracting this known overlap is an unknown
// guest and must be added to, not compared with, controller reservations.
const observedReservationsJoin = `
		LEFT JOIN LATERAL (
			SELECT COALESCE(SUM(i.requested_cpu_millis)
			         FILTER (WHERE i.compute_observed_at=h.heartbeat_at),0) AS cpu_millis,
			       COALESCE(SUM(i.requested_memory_bytes)
			         FILTER (WHERE i.compute_observed_at=h.heartbeat_at),0) AS memory_bytes,
			       COALESCE(SUM(i.requested_disk_bytes)
			         FILTER (WHERE i.last_heartbeat_at=h.heartbeat_at),0) AS disk_bytes,
			       count(*) FILTER (WHERE i.compute_observed_at=h.heartbeat_at) AS vms
			FROM sandbox_instances i
			WHERE i.worker_id=h.id AND i.deleted_at IS NULL
		) known_observed ON true`

// effectiveAllocated is the per-resource occupancy the admission rule compares
// against capacity: controller reservations plus the part of the worker's
// observation that cannot be attributed to those reservations. This is the set
// union the historical GREATEST approximation could not express when an
// unknown guest coexisted with a newly allocated or released known placement.
func effectiveAllocated(resource string) string {
	return "(h.allocated_" + resource + "+GREATEST(0,h.observed_allocated_" + resource +
		"-known_observed." + resource + "))"
}

func persistentRequest(request sandbox.CreateRequest) bool {
	if request.Persistence == nil {
		return false
	}
	return request.Persistence.Type == sandbox.PersistencePersistent
}

func (s *PGStore) Allocate(ctx context.Context, sandboxID string, request sandbox.CreateRequest, sanitized json.RawMessage, owner ResourceOwner) (Placement, error) {
	if s == nil || s.pool == nil {
		return Placement{}, errors.New("sandbox control store is unavailable")
	}
	requested := requestedCapacity(request)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var placement Placement
	placement.SandboxID = sandboxID
	placement.LocalID = sandboxID
	placement.Generation = 1
	placement.DesiredState = "running"
	placement.ObservedState = "starting"
	placement.Requested = requested
	placement.Persistent = persistentRequest(request)

	var snapshotID any
	if strings.TrimSpace(request.SnapshotID) != "" {
		snapshotID = request.SnapshotID
		err = tx.QueryRow(ctx, `
				SELECT provider_local_id, COALESCE(worker_id,''), COALESCE(object_uri,''), COALESCE(digest,'')
				FROM sandbox_snapshots
				WHERE id=$1 AND state IN ('ready','exported') AND deleted_at IS NULL
				FOR SHARE`, request.SnapshotID).
			Scan(&placement.SnapshotLocalID, &placement.SnapshotWorkerID, &placement.SnapshotObjectURI, &placement.SnapshotDigest)
		if errors.Is(err, pgx.ErrNoRows) {
			// The snapshot id is the only pre-existing resource a create can
			// reference, so this miss is unambiguously snapshot-scoped: report it
			// as such instead of as a generic placement miss.
			return Placement{}, ErrSnapshotNotFound
		}
		if err != nil {
			return Placement{}, err
		}
		if placement.Persistent && placement.SnapshotObjectURI != "" {
			placement.RecoverySnapshotID = request.SnapshotID
			placement.RecoverySnapshotLocalID = placement.SnapshotLocalID
			placement.RecoverySnapshotObjectURI = placement.SnapshotObjectURI
			placement.RecoverySnapshotDigest = placement.SnapshotDigest
		}
	}
	err = tx.QueryRow(ctx, `
		SELECT h.id, h.base_url
		FROM sandbox_hosts h`+observedReservationsJoin+`
		WHERE h.state='ready' AND h.lease_expires_at > now()
		  AND h.capacity_cpu_millis-`+effectiveAllocated("cpu_millis")+` >= $1
		  AND h.capacity_memory_bytes-`+effectiveAllocated("memory_bytes")+` >= $2
		  AND h.capacity_disk_bytes-`+effectiveAllocated("disk_bytes")+` >= $3
		  AND h.capacity_vms-`+effectiveAllocated("vms")+` >= 1
		ORDER BY (h.id=$4) DESC,
		         (`+effectiveAllocated("vms")+`::double precision / GREATEST(h.capacity_vms,1)) ASC,
		         h.heartbeat_at DESC
		FOR UPDATE OF h SKIP LOCKED LIMIT 1`, requested.CPUMillis, requested.MemoryBytes, requested.DiskBytes, placement.SnapshotWorkerID).
		Scan(&placement.WorkerID, &placement.WorkerURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return Placement{}, ErrNoCapacity
	}
	if err != nil {
		return Placement{}, err
	}

	if _, err = tx.Exec(ctx, `
		UPDATE sandbox_hosts SET
			allocated_cpu_millis=allocated_cpu_millis+$2,
			allocated_memory_bytes=allocated_memory_bytes+$3,
			allocated_disk_bytes=allocated_disk_bytes+$4,
			allocated_vms=allocated_vms+1,
			updated_at=now()
		WHERE id=$1`, placement.WorkerID, requested.CPUMillis, requested.MemoryBytes, requested.DiskBytes); err != nil {
		return Placement{}, err
	}

	if len(sanitized) == 0 {
		sanitized = []byte(`{}`)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO sandbox_instances (
			id, provider, provider_local_id, worker_id, placement_generation,
			desired_state, observed_state, image_ref, snapshot_id,
			recovery_snapshot_id, recovery_point_at, request_spec,
			resource_kind, resource_id, requested_cpu_millis, requested_memory_bytes, requested_disk_bytes,
			last_heartbeat_at
		) VALUES ($1,'microsandbox',$2,$3,1,'running','starting',$4,$5,$6::text,
			CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,$7,$8,$9,$10,$11,$12,now())`,
		sandboxID, sandboxID, placement.WorkerID, request.Image, snapshotID,
		nullIfEmpty(placement.RecoverySnapshotID), sanitized,
		nullIfEmpty(owner.Kind), nullIfEmpty(owner.ID),
		requested.CPUMillis, requested.MemoryBytes, requested.DiskBytes)
	if err != nil {
		return Placement{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Placement{}, err
	}
	return placement, nil
}

func (s *PGStore) GetPlacement(ctx context.Context, sandboxID string) (Placement, error) {
	var placement Placement
	var allocatedVMs int32
	var recoveryServices json.RawMessage
	err := s.pool.QueryRow(ctx, `
		SELECT i.id, i.provider_local_id, COALESCE(i.worker_id,''), COALESCE(h.base_url,''),
		       i.placement_generation, i.desired_state, i.observed_state,
		       i.requested_cpu_millis, i.requested_memory_bytes,
		       i.requested_disk_bytes, 1,
		       COALESCE(i.request_spec #>> '{persistence,type}','') = 'persistent',
		       COALESCE(i.recovery_snapshot_id,''), COALESCE(rs.provider_local_id,''),
		       COALESCE(rs.object_uri,''), COALESCE(rs.digest,''),
		       COALESCE(i.request_spec,'{}'::jsonb), COALESCE(i.recovery_services,'[]'::jsonb),
		       (h.id IS NULL OR h.state IN ('stale','fenced') OR h.lease_expires_at <= now())
		FROM sandbox_instances i
		LEFT JOIN sandbox_hosts h ON h.id=i.worker_id
		LEFT JOIN sandbox_snapshots rs ON rs.id=i.recovery_snapshot_id
			AND rs.state='exported' AND rs.deleted_at IS NULL
		WHERE i.id=$1 AND i.deleted_at IS NULL`, sandboxID).Scan(
		&placement.SandboxID, &placement.LocalID, &placement.WorkerID,
		&placement.WorkerURL, &placement.Generation, &placement.DesiredState,
		&placement.ObservedState, &placement.Requested.CPUMillis,
		&placement.Requested.MemoryBytes, &placement.Requested.DiskBytes, &allocatedVMs,
		&placement.Persistent, &placement.RecoverySnapshotID,
		&placement.RecoverySnapshotLocalID, &placement.RecoverySnapshotObjectURI,
		&placement.RecoverySnapshotDigest, &placement.RequestSpec, &recoveryServices,
		&placement.WorkerUnavailable,
	)
	placement.Requested.VMs = allocatedVMs
	if errors.Is(err, pgx.ErrNoRows) {
		return Placement{}, ErrNotFound
	}
	if err != nil {
		return Placement{}, err
	}
	if err := json.Unmarshal(recoveryServices, &placement.RecoveryServices); err != nil {
		return Placement{}, fmt.Errorf("decode durable service declarations: %w", err)
	}
	return placement, nil
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func (s *PGStore) SetState(ctx context.Context, sandboxID string, generation int64, desired, observed, lastError string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET
			desired_state=COALESCE(NULLIF($3,''),desired_state),
			observed_state=COALESCE(NULLIF($4,''),observed_state),
			last_error=$5,
			last_heartbeat_at=now(), updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL`,
		sandboxID, generation, desired, observed, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) RecordService(ctx context.Context, sandboxID string, generation int64, sanitized json.RawMessage) error {
	var service sandbox.ServiceSpec
	if err := json.Unmarshal(sanitized, &service); err != nil {
		return fmt.Errorf("decode durable service declaration: %w", err)
	}
	if strings.TrimSpace(service.Name) == "" {
		return errors.New("durable service declaration requires a name")
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET recovery_services=
			COALESCE((
				SELECT jsonb_agg(item) FROM jsonb_array_elements(recovery_services) item
				WHERE item->>'name'<>$4
			),'[]'::jsonb) || jsonb_build_array($3::jsonb),
			updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL`,
		sandboxID, generation, string(sanitized), service.Name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) BeginDelete(ctx context.Context, sandboxID string, generation int64) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET desired_state='deleted',observed_state='deleting',
			cleanup_pending=true,last_error='',updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL`, sandboxID, generation)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

// QueueFailedCreateCleanup marks a sandbox whose create failed as pending
// cleanup so the reconcile loop retries the worker delete and tombstones the
// row. The create path cannot call Release directly and give up when that
// transaction fails: reconcilers skip observed_state='failed' and the cleanup
// claim requires cleanup_pending, so a best-effort Release can park the
// placement in 'failed' until manual intervention while the VM's existence on
// the worker stays ambiguous (production hit this on 2026-08-10: two rows
// parked for nine days with the degraded-state alert firing).
func (s *PGStore) QueueFailedCreateCleanup(ctx context.Context, sandboxID string, generation int64, lastError string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET desired_state='deleted',observed_state='failed',
			cleanup_pending=true,lease_owner=NULL,lease_expires_at=NULL,
			last_error=$3,last_heartbeat_at=now(),updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL`,
		sandboxID, generation, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) Release(ctx context.Context, sandboxID string, generation int64) error {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		err := s.releaseOnce(ctx, sandboxID, generation)
		if err == nil || !retryableTransactionError(err) {
			return err
		}
		lastErr = err
		timer := time.NewTimer(time.Duration(attempt+1) * 10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return lastErr
}

func (s *PGStore) releaseOnce(ctx context.Context, sandboxID string, generation int64) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workerID string
	var held bool
	var requested msb.WorkerCapacity
	// Read the reservation flag BEFORE the delete update: a suspended instance
	// already handed its compute share back through ReleaseReservation. Disk is
	// always decremented here because the retained root filesystem existed until
	// this delete; compute is decremented only when it was still held.
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(worker_id,''), requested_cpu_millis, requested_memory_bytes,
		       requested_disk_bytes, reservation_held
		FROM sandbox_instances
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL
		FOR UPDATE`, sandboxID, generation).Scan(
		&workerID, &requested.CPUMillis, &requested.MemoryBytes, &requested.DiskBytes, &held,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
		UPDATE sandbox_instances SET desired_state='deleted', observed_state='deleted',
			cleanup_pending=false,lease_owner=NULL,lease_expires_at=NULL,
			reservation_held=false,
			deleted_at=now(), updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL`,
		sandboxID, generation); err != nil {
		return err
	}
	if workerID == "" {
		return tx.Commit(ctx)
	}
	_, err = tx.Exec(ctx, `
		UPDATE sandbox_hosts SET
			allocated_cpu_millis=GREATEST(0,allocated_cpu_millis-CASE WHEN $5 THEN $2 ELSE 0::bigint END),
			allocated_memory_bytes=GREATEST(0,allocated_memory_bytes-CASE WHEN $5 THEN $3 ELSE 0::bigint END),
			allocated_disk_bytes=GREATEST(0,allocated_disk_bytes-$4),
			allocated_vms=GREATEST(0,allocated_vms-CASE WHEN $5 THEN 1 ELSE 0 END), updated_at=now()
		WHERE id=$1`, workerID, requested.CPUMillis, requested.MemoryBytes, requested.DiskBytes, held)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReleaseReservation hands a stopped/suspended guest's compute reservation back
// to its worker without deleting the placement. A microVM that is powered off
// consumes no CPU and no guest memory, but its retained root disk stays charged
// until delete. Before this existed the compute reservation
// was only ever returned by Release (which tombstones the row), so the
// 30-minute idle timeout turned every gateway/workspace VM into a permanent
// capacity debit: seven lifetime VMs exhausted a 7000-millis worker with every
// guest asleep.
//
// Idempotent: releasing an already-released (or already-deleted) instance is a
// no-op, so a retried suspend can never double-credit the pool. Callers pair it
// with AcquireReservation on the resume path.
func (s *PGStore) ReleaseReservation(ctx context.Context, sandboxID string, generation int64) error {
	return s.retryReservation(ctx, sandboxID, generation, s.releaseReservationOnce)
}

// AcquireReservation re-charges a resumed guest's compute capacity against the
// worker it is still placed on, using the same CPU, memory, and VM-slot
// admission rule as Allocate. Disk needs no second charge because the retained
// root filesystem remained reserved while the guest was stopped. This prevents
// a resume from overcommitting a worker that filled up while the guest slept. When the pool is
// full it returns ErrNoCapacity and changes nothing: the instance stays
// suspended with its reservation released and is resumable later.
//
// Idempotent: an instance that still holds its reservation (never suspended, or
// a retried resume) is accepted without touching the host counters, and reports
// acquired=false so a failed start does not release a reservation it never took.
func (s *PGStore) AcquireReservation(ctx context.Context, sandboxID string, generation int64) (bool, error) {
	acquired := false
	err := s.retryReservation(ctx, sandboxID, generation, func(ctx context.Context, id string, gen int64) error {
		var once error
		acquired, once = s.acquireReservationOnce(ctx, id, gen)
		return once
	})
	return acquired, err
}

// retryReservation gives the serializable reservation transactions the same
// bounded retry loop Release uses: suspend, resume and delete all touch the
// same sandbox_hosts row, so serialization failures are expected under
// concurrency and must not surface as errors to the caller.
func (s *PGStore) retryReservation(ctx context.Context, sandboxID string, generation int64,
	once func(context.Context, string, int64) error) error {
	if s == nil || s.pool == nil {
		return errors.New("sandbox control store is unavailable")
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		err := once(ctx, sandboxID, generation)
		if err == nil || !retryableTransactionError(err) {
			return err
		}
		lastErr = err
		timer := time.NewTimer(time.Duration(attempt+1) * 10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return lastErr
}

func (s *PGStore) releaseReservationOnce(ctx context.Context, sandboxID string, generation int64) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workerID string
	var requested msb.WorkerCapacity
	err = tx.QueryRow(ctx, `
		UPDATE sandbox_instances SET reservation_held=false, updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL
		  AND reservation_held
		RETURNING COALESCE(worker_id,''), requested_cpu_millis, requested_memory_bytes`,
		sandboxID, generation).Scan(&workerID, &requested.CPUMillis, &requested.MemoryBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		// Already released, already deleted, or a stale generation: nothing is
		// owed to the host either way.
		return nil
	}
	if err != nil {
		return err
	}
	if workerID == "" {
		return tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `
		UPDATE sandbox_hosts SET
			allocated_cpu_millis=GREATEST(0,allocated_cpu_millis-$2),
			allocated_memory_bytes=GREATEST(0,allocated_memory_bytes-$3),
			allocated_vms=GREATEST(0,allocated_vms-1), updated_at=now()
		WHERE id=$1`, workerID, requested.CPUMillis, requested.MemoryBytes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PGStore) acquireReservationOnce(ctx context.Context, sandboxID string, generation int64) (bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workerID string
	var held bool
	var requested msb.WorkerCapacity
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(worker_id,''), requested_cpu_millis, requested_memory_bytes,
		       reservation_held
		FROM sandbox_instances
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL
		FOR UPDATE`, sandboxID, generation).Scan(
		&workerID, &requested.CPUMillis, &requested.MemoryBytes, &held)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	if held {
		// A worker may report a guest stopped before the heartbeat-side release
		// has settled for 60 seconds. Starting it during that window is still a
		// real resume: mark the placement in flight even though no counters need
		// to move. Otherwise the next heartbeat can see the old stopped state,
		// release the held reservation, and let another allocation take the slot
		// while this guest is booting.
		if _, err = tx.Exec(ctx, `
			UPDATE sandbox_instances SET desired_state='running',
				observed_state='starting', updated_at=now()
			WHERE id=$1 AND placement_generation=$2`, sandboxID, generation); err != nil {
			return false, err
		}
		return false, tx.Commit(ctx)
	}
	if workerID == "" {
		// The host lease is gone; this placement is owned by durable recovery,
		// which re-Allocates on a healthy worker instead of re-charging a
		// worker row that no longer exists.
		return false, ErrNoCapacity
	}
	// This stopped instance is absent from current compute reservations. Old
	// workers may still report it, but observed overlap attribution removes that
	// known contribution before the same admission check a fresh compute slot
	// would face.
	tag, err := tx.Exec(ctx, `
		UPDATE sandbox_hosts AS target SET
			allocated_cpu_millis=target.allocated_cpu_millis+$2,
			allocated_memory_bytes=target.allocated_memory_bytes+$3,
			allocated_vms=target.allocated_vms+1, updated_at=now()
		FROM sandbox_hosts h`+observedReservationsJoin+`
		WHERE h.id=target.id AND target.id=$1
		  AND h.state='ready' AND h.lease_expires_at > now()
		  AND h.capacity_cpu_millis-`+effectiveAllocated("cpu_millis")+` >= $2
		  AND h.capacity_memory_bytes-`+effectiveAllocated("memory_bytes")+` >= $3
		  AND h.capacity_vms-`+effectiveAllocated("vms")+` >= 1`,
		workerID, requested.CPUMillis, requested.MemoryBytes)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, ErrNoCapacity
	}
	if _, err = tx.Exec(ctx, `
		UPDATE sandbox_instances SET reservation_held=true,
			desired_state='running', observed_state='starting', updated_at=now()
		WHERE id=$1 AND placement_generation=$2`, sandboxID, generation); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (s *PGStore) CreateSnapshot(ctx context.Context, snapshotID, sourceSandboxID, localID string, garbageCollectible bool) (SnapshotPlacement, error) {
	placement, err := s.GetPlacement(ctx, sourceSandboxID)
	if err != nil {
		return SnapshotPlacement{}, err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO sandbox_snapshots (
			id, provider, provider_local_id, source_sandbox_id, worker_id,
			placement_generation, state, garbage_collectible, cleanup_lease_expires_at
		) VALUES ($1,'microsandbox',$2,$3,$4,$5,'creating',$6,now()+interval '40 minutes')`,
		snapshotID, localID, sourceSandboxID, placement.WorkerID, placement.Generation, garbageCollectible)
	if err != nil {
		return SnapshotPlacement{}, err
	}
	return SnapshotPlacement{
		SnapshotID: snapshotID, LocalID: localID, WorkerID: placement.WorkerID,
		WorkerURL: placement.WorkerURL, Generation: placement.Generation,
		SourceID: sourceSandboxID,
	}, nil
}

func (s *PGStore) GetSnapshot(ctx context.Context, snapshotID string) (SnapshotPlacement, error) {
	var placement SnapshotPlacement
	err := s.pool.QueryRow(ctx, `
		SELECT ss.id, ss.provider_local_id, COALESCE(ss.worker_id,''), COALESCE(h.base_url,''),
		       ss.placement_generation, COALESCE(ss.source_sandbox_id,''),
		       COALESCE(ss.object_uri,''), COALESCE(ss.digest,''), ss.size_bytes,ss.state
		FROM sandbox_snapshots ss LEFT JOIN sandbox_hosts h ON h.id=ss.worker_id
		WHERE ss.id=$1 AND ss.deleted_at IS NULL`, snapshotID).Scan(
		&placement.SnapshotID, &placement.LocalID, &placement.WorkerID,
		&placement.WorkerURL, &placement.Generation, &placement.SourceID,
		&placement.ObjectURI, &placement.Digest, &placement.SizeBytes, &placement.State,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SnapshotPlacement{}, ErrNotFound
	}
	return placement, err
}

func (s *PGStore) SetSnapshotState(ctx context.Context, snapshotID, state, objectURI, digest string, size *int64) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_snapshots SET state=$2, object_uri=COALESCE(NULLIF($3,''),object_uri),
			digest=COALESCE(NULLIF($4,''),digest), size_bytes=COALESCE($5,size_bytes),
			cleanup_lease_expires_at=CASE WHEN $2 IN ('creating','exporting')
				THEN now()+interval '40 minutes' ELSE NULL END, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, snapshotID, state, objectURI, digest, size)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) SetRecoverySnapshot(ctx context.Context, sandboxID string, generation int64, snapshotID string) (string, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var previous string
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(recovery_snapshot_id,'') FROM sandbox_instances
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL
		FOR UPDATE`, sandboxID, generation).Scan(&previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrStale
	}
	if err != nil {
		return "", err
	}
	var lockedSnapshotID string
	err = tx.QueryRow(ctx, `
		SELECT id FROM sandbox_snapshots
		WHERE id=$1 AND state='exported' AND object_uri IS NOT NULL
		  AND digest IS NOT NULL AND deleted_at IS NULL
		FOR SHARE`, snapshotID).Scan(&lockedSnapshotID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errors.New("recovery snapshot is not durably exported")
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sandbox_instances SET recovery_snapshot_id=$3,recovery_point_at=now(),
			updated_at=now(),last_error=''
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL`,
		sandboxID, generation, snapshotID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return previous, nil
}

func (s *PGStore) AdoptSnapshot(ctx context.Context, snapshotID, sandboxID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_snapshots SET source_sandbox_id=$2,updated_at=now()
		WHERE id=$1 AND state IN ('ready','exported') AND deleted_at IS NULL
		  AND EXISTS (SELECT 1 FROM sandbox_instances WHERE id=$2 AND deleted_at IS NULL)`,
		snapshotID, sandboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) BeginSnapshotCleanup(ctx context.Context, snapshotID, owner string, leaseTTL time.Duration) (SnapshotPlacement, error) {
	if strings.TrimSpace(owner) == "" {
		return SnapshotPlacement{}, errors.New("snapshot cleanup owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 5 * time.Minute
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return SnapshotPlacement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var placement SnapshotPlacement
	var cleanupLeaseActive bool
	err = tx.QueryRow(ctx, `
		SELECT ss.id,ss.provider_local_id,COALESCE(ss.worker_id,''),
		       CASE WHEN h.state IN ('ready','draining') AND h.lease_expires_at > now()
		                 OR h.state='stale' AND h.lease_expires_at > now()-interval '15 minutes'
		            THEN h.base_url ELSE '' END,
		       ss.placement_generation,COALESCE(ss.source_sandbox_id,''),
		       COALESCE(ss.object_uri,''),COALESCE(ss.digest,''),ss.size_bytes,ss.state,
		       COALESCE(ss.cleanup_lease_expires_at > now(),false)
		FROM sandbox_snapshots ss
		LEFT JOIN sandbox_hosts h ON h.id=ss.worker_id
		WHERE ss.id=$1 AND ss.deleted_at IS NULL
		FOR UPDATE OF ss`, snapshotID).Scan(
		&placement.SnapshotID, &placement.LocalID, &placement.WorkerID,
		&placement.WorkerURL, &placement.Generation, &placement.SourceID,
		&placement.ObjectURI, &placement.Digest, &placement.SizeBytes, &placement.State,
		&cleanupLeaseActive,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SnapshotPlacement{}, ErrNotFound
	}
	if err != nil {
		return SnapshotPlacement{}, err
	}
	if cleanupLeaseActive && (placement.State == "creating" || placement.State == "exporting" || placement.State == "deleting") {
		return SnapshotPlacement{}, ErrOperationInProgress
	}
	var inUse bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM sandbox_instances i
			WHERE i.deleted_at IS NULL AND
				(i.recovery_snapshot_id=$1 OR i.snapshot_id=$1)
		)`, snapshotID).Scan(&inUse); err != nil {
		return SnapshotPlacement{}, err
	}
	if inUse {
		return SnapshotPlacement{}, ErrSnapshotInUse
	}
	tag, err := tx.Exec(ctx, `
		UPDATE sandbox_snapshots SET state='deleting',cleanup_owner=$2,
			cleanup_lease_expires_at=now()+$3::interval,last_error='',updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, snapshotID, owner,
		fmt.Sprintf("%f seconds", leaseTTL.Seconds()))
	if err != nil {
		return SnapshotPlacement{}, err
	}
	if tag.RowsAffected() != 1 {
		return SnapshotPlacement{}, ErrStale
	}
	if err := tx.Commit(ctx); err != nil {
		return SnapshotPlacement{}, err
	}
	return placement, nil
}

func (s *PGStore) ClaimSnapshotCleanup(ctx context.Context, owner string, leaseTTL, staleAfter time.Duration) (SnapshotPlacement, error) {
	if strings.TrimSpace(owner) == "" {
		return SnapshotPlacement{}, errors.New("snapshot cleanup owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 5 * time.Minute
	}
	if staleAfter <= 0 {
		staleAfter = 30 * time.Minute
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return SnapshotPlacement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var placement SnapshotPlacement
	err = tx.QueryRow(ctx, `
		SELECT ss.id,ss.provider_local_id,COALESCE(ss.worker_id,''),
		       CASE WHEN h.state IN ('ready','draining') AND h.lease_expires_at > now()
		                 OR h.state='stale' AND h.lease_expires_at > now()-interval '15 minutes'
		            THEN h.base_url ELSE '' END,
		       ss.placement_generation,COALESCE(ss.source_sandbox_id,''),
		       COALESCE(ss.object_uri,''),COALESCE(ss.digest,''),ss.size_bytes,ss.state
		FROM sandbox_snapshots ss
		LEFT JOIN sandbox_hosts h ON h.id=ss.worker_id
		WHERE ss.deleted_at IS NULL
		  AND (
			(ss.state IN ('creating','exporting','failed') AND ss.updated_at <= now()-$1::interval
			 AND (ss.cleanup_lease_expires_at IS NULL OR ss.cleanup_lease_expires_at <= now()))
			OR (ss.state='exported' AND ss.garbage_collectible=true AND ss.updated_at <= now()-$1::interval)
			OR (ss.state='deleting' AND (ss.cleanup_lease_expires_at IS NULL OR ss.cleanup_lease_expires_at <= now()))
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM sandbox_instances i
			WHERE i.deleted_at IS NULL
			  AND (i.recovery_snapshot_id=ss.id OR i.snapshot_id=ss.id)
		  )
		ORDER BY ss.updated_at,ss.id
		FOR UPDATE OF ss SKIP LOCKED LIMIT 1`,
		fmt.Sprintf("%f seconds", staleAfter.Seconds())).Scan(
		&placement.SnapshotID, &placement.LocalID, &placement.WorkerID,
		&placement.WorkerURL, &placement.Generation, &placement.SourceID,
		&placement.ObjectURI, &placement.Digest, &placement.SizeBytes, &placement.State,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SnapshotPlacement{}, ErrNotFound
	}
	if err != nil {
		return SnapshotPlacement{}, err
	}
	var inUse bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM sandbox_instances i
			WHERE i.deleted_at IS NULL AND
				(i.recovery_snapshot_id=$1 OR i.snapshot_id=$1)
		)`, placement.SnapshotID).Scan(&inUse); err != nil {
		return SnapshotPlacement{}, err
	}
	if inUse {
		return SnapshotPlacement{}, ErrNotFound
	}
	tag, err := tx.Exec(ctx, `
		UPDATE sandbox_snapshots SET state='deleting',cleanup_owner=$2,
			cleanup_lease_expires_at=now()+$3::interval,updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, placement.SnapshotID, owner,
		fmt.Sprintf("%f seconds", leaseTTL.Seconds()))
	if err != nil {
		return SnapshotPlacement{}, err
	}
	if tag.RowsAffected() != 1 {
		return SnapshotPlacement{}, ErrStale
	}
	if err := tx.Commit(ctx); err != nil {
		return SnapshotPlacement{}, err
	}
	return placement, nil
}

func (s *PGStore) CompleteSnapshotCleanup(ctx context.Context, snapshotID, owner string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_snapshots SET state='deleted',cleanup_owner=NULL,
			cleanup_lease_expires_at=NULL,last_error='',deleted_at=now(),updated_at=now()
		WHERE id=$1 AND state='deleting' AND cleanup_owner=$2 AND deleted_at IS NULL`, snapshotID, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) FailSnapshotCleanup(ctx context.Context, snapshotID, owner, lastError string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_snapshots SET cleanup_owner=NULL,
			cleanup_lease_expires_at=now()+interval '5 minutes',last_error=$3,updated_at=now()
		WHERE id=$1 AND state='deleting' AND cleanup_owner=$2 AND deleted_at IS NULL`,
		snapshotID, owner, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) CreateIdentity(ctx context.Context, identityID string, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO sandbox_access_identities (id,expires_at) VALUES ($1,$2)`, identityID, expiresAt)
	return err
}

func (s *PGStore) GrantPermission(ctx context.Context, permissionID, identityID, sandboxID string, allowedUsers []string) (int64, error) {
	var generation int64
	err := s.pool.QueryRow(ctx, `
		WITH target AS (
			SELECT placement_generation FROM sandbox_instances
			WHERE id=$3 AND deleted_at IS NULL
		), inserted AS (
			INSERT INTO sandbox_access_permissions (
				id, identity_id, sandbox_id, allowed_users, placement_generation
			) SELECT $1,$2,$3,$4,placement_generation FROM target
			ON CONFLICT (identity_id,sandbox_id) DO UPDATE SET
				allowed_users=EXCLUDED.allowed_users,
				placement_generation=EXCLUDED.placement_generation
			RETURNING placement_generation
		) SELECT placement_generation FROM inserted`,
		permissionID, identityID, sandboxID, allowedUsers).Scan(&generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return generation, err
}

func (s *PGStore) CreateAccessGrant(ctx context.Context, grantID, identityID string, tokenHash []byte, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sandbox_access_grants (id,identity_id,token_hash,protocol,expires_at)
		VALUES ($1,$2,$3,'ssh',$4)`, grantID, identityID, tokenHash, expiresAt)
	return err
}

func (s *PGStore) RevokeAccessGrant(ctx context.Context, grantID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_access_grants SET revoked_at=COALESCE(revoked_at,now())
		WHERE id=$1`, grantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RevokeSandboxAccessGrants invalidates every SSH grant whose identity can
// access sandboxID. It is idempotent when the sandbox exists but currently has
// no grants.
func (s *PGStore) RevokeSandboxAccessGrants(ctx context.Context, sandboxID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_access_grants SET revoked_at=COALESCE(revoked_at,now())
		WHERE identity_id IN (
		    SELECT identity_id
		    FROM sandbox_access_permissions
		    WHERE sandbox_id=$1
		)`, sandboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM sandbox_instances WHERE id=$1 AND deleted_at IS NULL
	)`, sandboxID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) ValidateAccess(ctx context.Context, request msb.AccessValidationRequest, tokenHash []byte) (msb.AccessValidationResponse, error) {
	var response msb.AccessValidationResponse
	var allowedUsers []string
	err := s.pool.QueryRow(ctx, `
		SELECT i.id, i.provider_local_id, i.worker_id, h.base_url,
		       i.placement_generation, g.expires_at, p.allowed_users
		FROM sandbox_access_grants g
		JOIN sandbox_access_identities a ON a.id=g.identity_id
		JOIN sandbox_access_permissions p ON p.identity_id=g.identity_id
		JOIN sandbox_instances i ON i.id=p.sandbox_id
		JOIN sandbox_hosts h ON h.id=i.worker_id
		WHERE g.token_hash=$1 AND g.revoked_at IS NULL AND g.expires_at > now()
		  AND a.expires_at > now()
		  AND g.protocol=$2 AND i.id=$3 AND i.deleted_at IS NULL
		  AND i.placement_generation=p.placement_generation
		  AND h.state IN ('ready','draining') AND h.lease_expires_at > now()`,
		tokenHash, request.Protocol, request.SandboxID).Scan(
		&response.SandboxID, &response.LocalID, &response.WorkerID,
		&response.WorkerURL, &response.Generation, &response.ExpiresAt, &allowedUsers,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return msb.AccessValidationResponse{}, ErrDenied
	}
	if err != nil {
		return msb.AccessValidationResponse{}, err
	}
	if len(allowedUsers) == 0 {
		return msb.AccessValidationResponse{}, ErrDenied
	}
	allowed := false
	for _, user := range allowedUsers {
		if user == request.User {
			allowed = true
			break
		}
	}
	if !allowed {
		return msb.AccessValidationResponse{}, ErrDenied
	}
	response.Allowed = true
	return response, nil
}

func (s *PGStore) PublishIngress(ctx context.Context, domain, sandboxID string, port int32) (sandbox.IngressRoute, error) {
	domain = strings.ToLower(strings.TrimSpace(domain))
	var generation int64
	err := s.pool.QueryRow(ctx, `SELECT placement_generation FROM sandbox_instances WHERE id=$1 AND deleted_at IS NULL`, sandboxID).Scan(&generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return sandbox.IngressRoute{}, ErrNotFound
	}
	if err != nil {
		return sandbox.IngressRoute{}, err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO sandbox_domain_mappings (domain,sandbox_id,guest_port,placement_generation)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (domain) DO UPDATE SET sandbox_id=EXCLUDED.sandbox_id,
			guest_port=EXCLUDED.guest_port,
			placement_generation=EXCLUDED.placement_generation,updated_at=now()`,
		domain, sandboxID, port, generation)
	if err != nil {
		return sandbox.IngressRoute{}, err
	}
	return sandbox.IngressRoute{ID: domain, Hostname: domain, SandboxID: sandboxID, Port: port}, nil
}

func (s *PGStore) RevokeIngress(ctx context.Context, domain string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sandbox_domain_mappings WHERE domain=$1`, strings.ToLower(strings.TrimSpace(domain)))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) ResolveDomainMapping(ctx context.Context, domain string) (msb.PreviewTarget, error) {
	var target msb.PreviewTarget
	err := s.pool.QueryRow(ctx, `
		SELECT d.domain, i.id, i.worker_id, h.base_url, i.provider_local_id,
		       i.placement_generation, d.guest_port, i.observed_state
		FROM sandbox_domain_mappings d
		JOIN sandbox_instances i ON i.id=d.sandbox_id
		JOIN sandbox_hosts h ON h.id=i.worker_id
		WHERE d.domain=$1 AND d.placement_generation=i.placement_generation
		  AND i.deleted_at IS NULL AND h.state IN ('ready','draining')
		  AND h.lease_expires_at > now()`, strings.ToLower(strings.TrimSpace(domain))).Scan(
		&target.Domain, &target.SandboxID, &target.WorkerID, &target.WorkerURL,
		&target.LocalID, &target.Generation, &target.GuestPort, &target.State,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return msb.PreviewTarget{}, ErrNotFound
	}
	return target, err
}

func HashAccessToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// UpdateMetrics publishes aggregate controller state without exposing worker,
// sandbox, user, or repository identifiers as labels.
func (s *PGStore) UpdateMetrics(ctx context.Context, metrics *msb.Metrics) error {
	if metrics == nil {
		return nil
	}
	hostStates := map[string]float64{}
	rows, err := s.pool.Query(ctx, `SELECT state,count(*) FROM sandbox_hosts GROUP BY state`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var state string
		var count float64
		if err := rows.Scan(&state, &count); err != nil {
			rows.Close()
			return err
		}
		hostStates[state] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	metrics.SetHostStates(hostStates)

	// `effective` must use the SAME expression the admission rule uses, or the
	// gauge an operator reads to answer "will the next provision 503?" stops
	// matching the answer placement actually gives.
	var cpu, memory, disk, vms [4]float64
	err = s.pool.QueryRow(ctx, `
		SELECT
			COALESCE(SUM(h.capacity_cpu_millis),0),
			COALESCE(SUM(h.allocated_cpu_millis),0),
			COALESCE(SUM(h.observed_allocated_cpu_millis),0),
			COALESCE(SUM(`+effectiveAllocated("cpu_millis")+`),0),
			COALESCE(SUM(h.capacity_memory_bytes),0),
			COALESCE(SUM(h.allocated_memory_bytes),0),
			COALESCE(SUM(h.observed_allocated_memory_bytes),0),
			COALESCE(SUM(`+effectiveAllocated("memory_bytes")+`),0),
			COALESCE(SUM(h.capacity_disk_bytes),0),
			COALESCE(SUM(h.allocated_disk_bytes),0),
			COALESCE(SUM(h.observed_allocated_disk_bytes),0),
			COALESCE(SUM(`+effectiveAllocated("disk_bytes")+`),0),
			COALESCE(SUM(h.capacity_vms),0),
			COALESCE(SUM(h.allocated_vms),0),
			COALESCE(SUM(h.observed_allocated_vms),0),
			COALESCE(SUM(`+effectiveAllocated("vms")+`),0)
		FROM sandbox_hosts h`+observedReservationsJoin+`
		WHERE h.state IN ('ready','draining') AND h.lease_expires_at > now()`).Scan(
		&cpu[0], &cpu[1], &cpu[2], &cpu[3],
		&memory[0], &memory[1], &memory[2], &memory[3],
		&disk[0], &disk[1], &disk[2], &disk[3],
		&vms[0], &vms[1], &vms[2], &vms[3],
	)
	if err != nil {
		return err
	}
	for resource, values := range map[string][4]float64{
		"cpu_millis": cpu, "memory_bytes": memory, "disk_bytes": disk, "vms": vms,
	} {
		for index, kind := range []string{"total", "reserved", "observed", "effective"} {
			metrics.SetCapacity(resource, kind, values[index])
		}
	}

	instanceStates := map[string]float64{}
	rows, err = s.pool.Query(ctx, `
		SELECT observed_state,count(*) FROM sandbox_instances
		WHERE deleted_at IS NULL GROUP BY observed_state`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var state string
		var count float64
		if err := rows.Scan(&state, &count); err != nil {
			rows.Close()
			return err
		}
		instanceStates[state] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	metrics.SetInstanceStates(instanceStates)

	var orphans, cleanup float64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM sandbox_orphans`).Scan(&orphans); err != nil {
		return err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM sandbox_instances
		WHERE cleanup_pending AND deleted_at IS NULL`).Scan(&cleanup); err != nil {
		return err
	}
	metrics.SetOrphans(orphans)
	metrics.SetCleanupPending(cleanup)
	return nil
}

func (s *PGStore) Reconcile(ctx context.Context, now time.Time) (ReconcileResult, error) {
	if s == nil || s.pool == nil {
		return ReconcileResult{}, errors.New("sandbox control store is unavailable")
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ReconcileResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	stale, err := tx.Exec(ctx, `
		UPDATE sandbox_hosts SET state='stale',updated_at=$1
		WHERE state IN ('ready','draining') AND lease_expires_at <= $1`, now)
	if err != nil {
		return ReconcileResult{}, err
	}
	missing, err := tx.Exec(ctx, `
		UPDATE sandbox_instances i SET
			observed_state=CASE
				WHEN i.observed_state='starting' THEN 'failed'
				WHEN COALESCE(i.request_spec #>> '{persistence,type}','ephemeral') = 'persistent'
				THEN 'degraded' ELSE 'failed' END,
			cleanup_pending=CASE
				WHEN i.observed_state='starting' THEN true
				WHEN COALESCE(i.request_spec #>> '{persistence,type}','ephemeral') = 'persistent'
				THEN i.cleanup_pending ELSE true END,
			recovery_reason=CASE
				WHEN i.observed_state='starting' THEN ''
				WHEN COALESCE(i.request_spec #>> '{persistence,type}','ephemeral') = 'persistent'
				THEN 'worker_lost' ELSE '' END,
			last_error='worker inventory no longer contains placement',updated_at=$1
		FROM sandbox_hosts h
		WHERE i.worker_id=h.id AND h.state IN ('ready','draining')
		  AND h.lease_expires_at > $1 AND i.deleted_at IS NULL
		  AND i.cleanup_pending=false
		  AND i.last_heartbeat_at < $1-interval '90 seconds'
		  AND (i.observed_state <> 'starting' OR i.updated_at < $1-interval '40 minutes')
		  AND i.observed_state NOT IN ('degraded','recovering','failed','deleted')`, now)
	if err != nil {
		return ReconcileResult{}, err
	}
	persistent, err := tx.Exec(ctx, `
		UPDATE sandbox_instances i SET observed_state='degraded',recovery_reason='worker_lost',
			last_error='worker lease expired; durable recovery required',updated_at=$1
		FROM sandbox_hosts h
		WHERE i.worker_id=h.id AND h.state='stale' AND i.deleted_at IS NULL
		  AND i.cleanup_pending=false
		  AND i.observed_state NOT IN ('degraded','deleted')
		  AND COALESCE(i.request_spec #>> '{persistence,type}','') = 'persistent'`, now)
	if err != nil {
		return ReconcileResult{}, err
	}
	ephemeral, err := tx.Exec(ctx, `
		UPDATE sandbox_instances i SET observed_state='failed',cleanup_pending=true,recovery_reason='',
			last_error='worker lease expired',updated_at=$1
		FROM sandbox_hosts h
		WHERE i.worker_id=h.id AND h.state='stale' AND i.deleted_at IS NULL
		  AND i.cleanup_pending=false
		  AND i.observed_state NOT IN ('failed','deleted','degraded')
		  AND COALESCE(i.request_spec #>> '{persistence,type}','ephemeral') <> 'persistent'`, now)
	if err != nil {
		return ReconcileResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReconcileResult{}, err
	}
	return ReconcileResult{
		StaleHosts: stale.RowsAffected(), FailedEphemeral: ephemeral.RowsAffected(),
		DegradedPersistent: persistent.RowsAffected(), MissingRuntime: missing.RowsAffected(),
	}, nil
}

// ClaimCleanup leases one pending provider deletion. A blank WorkerURL means
// the host lease is gone; the controller can then release its reservation and
// let a future returning inventory entry converge through orphan quarantine.
func (s *PGStore) ClaimCleanup(ctx context.Context, owner string, leaseTTL time.Duration) (Placement, error) {
	if strings.TrimSpace(owner) == "" {
		return Placement{}, errors.New("cleanup lease owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 2 * time.Minute
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var placement Placement
	err = tx.QueryRow(ctx, `
		SELECT i.id,i.provider_local_id,COALESCE(i.worker_id,''),
		       CASE WHEN h.state IN ('ready','draining') AND h.lease_expires_at > now()
		            THEN h.base_url ELSE '' END,
		       i.placement_generation,i.desired_state,i.observed_state
		FROM sandbox_instances i
		LEFT JOIN sandbox_hosts h ON h.id=i.worker_id
		WHERE i.deleted_at IS NULL AND i.cleanup_pending=true
		  AND (i.lease_expires_at IS NULL OR i.lease_expires_at <= now())
		ORDER BY i.updated_at,i.id
		FOR UPDATE OF i SKIP LOCKED LIMIT 1`).Scan(
		&placement.SandboxID, &placement.LocalID, &placement.WorkerID,
		&placement.WorkerURL, &placement.Generation,
		&placement.DesiredState, &placement.ObservedState,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Placement{}, ErrNotFound
	}
	if err != nil {
		return Placement{}, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE sandbox_instances SET desired_state='deleted',observed_state='deleting',
			lease_owner=$3,lease_expires_at=now()+$4::interval,updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND cleanup_pending=true
		  AND deleted_at IS NULL`, placement.SandboxID, placement.Generation, owner,
		fmt.Sprintf("%f seconds", leaseTTL.Seconds()))
	if err != nil {
		return Placement{}, err
	}
	if tag.RowsAffected() != 1 {
		return Placement{}, ErrStale
	}
	if err := tx.Commit(ctx); err != nil {
		return Placement{}, err
	}
	return placement, nil
}

func (s *PGStore) FailCleanup(ctx context.Context, sandboxID string, generation int64, lastError string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET lease_owner=NULL,
			lease_expires_at=now()+interval '30 seconds',last_error=$3,updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND cleanup_pending=true
		  AND deleted_at IS NULL`, sandboxID, generation, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

// ClaimDrain leases one durable placement from a controller-draining host.
// Ephemeral work is allowed to finish naturally; it is never silently moved.
func (s *PGStore) ClaimDrain(ctx context.Context, owner string, leaseTTL time.Duration) (DrainClaim, error) {
	if strings.TrimSpace(owner) == "" {
		return DrainClaim{}, errors.New("drain lease owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 10 * time.Minute
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return DrainClaim{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claim DrainClaim
	err = tx.QueryRow(ctx, `
		SELECT i.id,i.provider_local_id,i.worker_id,h.base_url,
		       i.placement_generation,i.desired_state,
		       CASE WHEN i.observed_state='stopping' THEN i.desired_state ELSE i.observed_state END,
		       i.requested_cpu_millis,i.requested_memory_bytes,i.requested_disk_bytes
		FROM sandbox_instances i
		JOIN sandbox_hosts h ON h.id=i.worker_id
		WHERE i.deleted_at IS NULL AND i.cleanup_pending=false
		  AND h.state='draining' AND h.lease_expires_at > now()
		  AND i.desired_state IN ('running','stopped')
		  AND i.observed_state IN ('running','stopped','restart_pending','stopping')
		  AND COALESCE(i.request_spec #>> '{persistence,type}','') = 'persistent'
		  AND (i.lease_expires_at IS NULL OR i.lease_expires_at <= now())
		ORDER BY i.updated_at,i.id
		FOR UPDATE OF i SKIP LOCKED LIMIT 1`).Scan(
		&claim.Placement.SandboxID, &claim.Placement.LocalID,
		&claim.Placement.WorkerID, &claim.Placement.WorkerURL,
		&claim.Placement.Generation, &claim.Placement.DesiredState,
		&claim.PreviousObserved, &claim.Placement.Requested.CPUMillis,
		&claim.Placement.Requested.MemoryBytes, &claim.Placement.Requested.DiskBytes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return DrainClaim{}, ErrNotFound
	}
	if err != nil {
		return DrainClaim{}, err
	}
	claim.Placement.ObservedState = claim.PreviousObserved
	claim.Placement.Persistent = true
	claim.Placement.Requested.VMs = 1
	tag, err := tx.Exec(ctx, `
		UPDATE sandbox_instances SET observed_state='stopping',lease_owner=$3,
			lease_expires_at=now()+$4::interval,updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND deleted_at IS NULL
		  AND observed_state IN ($5,'stopping')`, claim.Placement.SandboxID, claim.Placement.Generation,
		owner, fmt.Sprintf("%f seconds", leaseTTL.Seconds()), claim.PreviousObserved)
	if err != nil {
		return DrainClaim{}, err
	}
	if tag.RowsAffected() != 1 {
		return DrainClaim{}, ErrStale
	}
	if err := tx.Commit(ctx); err != nil {
		return DrainClaim{}, err
	}
	return claim, nil
}

func (s *PGStore) CompleteDrainCheckpoint(ctx context.Context, sandboxID string, generation int64) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances i SET observed_state='degraded',recovery_reason='planned_drain',lease_owner=NULL,
			lease_expires_at=NULL,last_error='worker drain relocation required',updated_at=now()
		FROM sandbox_snapshots rs
		WHERE i.id=$1 AND i.placement_generation=$2 AND i.observed_state='stopping'
		  AND i.recovery_snapshot_id=rs.id AND rs.state='exported'
		  AND rs.object_uri IS NOT NULL AND rs.digest IS NOT NULL
		  AND rs.deleted_at IS NULL AND i.deleted_at IS NULL`, sandboxID, generation)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("draining sandbox has no verified recovery checkpoint")
	}
	return nil
}

func (s *PGStore) FailDrain(ctx context.Context, sandboxID string, generation int64, observed, lastError string) error {
	switch observed {
	case "running", "stopped", "restart_pending":
	default:
		observed = "degraded"
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET observed_state=$3,lease_owner=NULL,
			lease_expires_at=now()+interval '30 seconds',last_error=$4,updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND observed_state='stopping'
		  AND deleted_at IS NULL`, sandboxID, generation, observed, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

// ClaimRestart leases a healthy local placement whose runtime stopped during
// a worker/pod restart. It is deliberately separate from snapshot recovery:
// the generation and worker remain unchanged while the durable local disk is
// still present.
func (s *PGStore) ClaimRestart(ctx context.Context, owner string, leaseTTL time.Duration) (Placement, error) {
	if strings.TrimSpace(owner) == "" {
		return Placement{}, errors.New("restart lease owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 10 * time.Minute
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var placement Placement
	var persistence string
	err = tx.QueryRow(ctx, `
		SELECT i.id,i.provider_local_id,i.worker_id,h.base_url,
		       i.placement_generation,i.desired_state,i.observed_state,
		       i.requested_cpu_millis,i.requested_memory_bytes,i.requested_disk_bytes,
		       COALESCE(i.request_spec #>> '{persistence,type}','ephemeral')
		FROM sandbox_instances i
		JOIN sandbox_hosts h ON h.id=i.worker_id
		WHERE i.deleted_at IS NULL AND i.desired_state='running'
		  AND (i.observed_state='restart_pending' OR
		       (i.observed_state='recovering' AND i.recovery_reason=''))
		  AND h.state='ready' AND h.lease_expires_at > now()
		  AND (i.lease_expires_at IS NULL OR i.lease_expires_at <= now())
		ORDER BY i.updated_at,i.id
		FOR UPDATE OF i SKIP LOCKED LIMIT 1`).Scan(
		&placement.SandboxID, &placement.LocalID, &placement.WorkerID,
		&placement.WorkerURL, &placement.Generation, &placement.DesiredState,
		&placement.ObservedState, &placement.Requested.CPUMillis,
		&placement.Requested.MemoryBytes, &placement.Requested.DiskBytes,
		&persistence,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Placement{}, ErrNotFound
	}
	if err != nil {
		return Placement{}, err
	}
	placement.Requested.VMs = 1
	placement.Persistent = persistence == string(sandbox.PersistencePersistent)
	tag, err := tx.Exec(ctx, `
		UPDATE sandbox_instances SET observed_state='recovering',lease_owner=$3,
			lease_expires_at=now()+$4::interval,updated_at=now()
		WHERE id=$1 AND placement_generation=$2
		  AND (observed_state='restart_pending' OR
		       (observed_state='recovering' AND recovery_reason=''))
		  AND deleted_at IS NULL`, placement.SandboxID, placement.Generation, owner,
		fmt.Sprintf("%f seconds", leaseTTL.Seconds()))
	if err != nil {
		return Placement{}, err
	}
	if tag.RowsAffected() != 1 {
		return Placement{}, ErrStale
	}
	if err := tx.Commit(ctx); err != nil {
		return Placement{}, err
	}
	return placement, nil
}

func (s *PGStore) FailRestart(ctx context.Context, sandboxID string, generation int64, lastError string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET observed_state='restart_pending',
			lease_owner=NULL,lease_expires_at=now()+interval '30 seconds',last_error=$3,updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND observed_state='recovering'
		  AND deleted_at IS NULL`, sandboxID, generation, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) ClaimRecovery(ctx context.Context, owner string, leaseTTL time.Duration) (RecoveryClaim, error) {
	if strings.TrimSpace(owner) == "" {
		return RecoveryClaim{}, errors.New("recovery lease owner is required")
	}
	if leaseTTL <= 0 {
		leaseTTL = 10 * time.Minute
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return RecoveryClaim{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var claim RecoveryClaim
	var recoveryServices json.RawMessage
	var currentHostState string
	var recoveryReason string
	var reservationHeld bool
	err = tx.QueryRow(ctx, `
		SELECT i.id,i.provider_local_id,COALESCE(i.worker_id,''),COALESCE(h.base_url,''),
		       i.placement_generation,i.desired_state,i.observed_state,
		       i.requested_cpu_millis,i.requested_memory_bytes,i.requested_disk_bytes,
		       COALESCE(h.state,''),rs.id,rs.provider_local_id,rs.object_uri,rs.digest,
		       i.request_spec,i.recovery_services,i.recovery_reason,i.reservation_held
		FROM sandbox_instances i
		JOIN sandbox_snapshots rs ON rs.id=i.recovery_snapshot_id
			AND rs.state='exported' AND rs.object_uri IS NOT NULL
			AND rs.digest IS NOT NULL AND rs.deleted_at IS NULL
		LEFT JOIN sandbox_hosts h ON h.id=i.worker_id
		WHERE i.deleted_at IS NULL AND i.desired_state IN ('running','stopped')
		  AND i.observed_state IN ('degraded','recovering')
		  AND i.recovery_reason IN ('worker_lost','planned_drain')
		  AND (i.observed_state='recovering' OR i.recovery_reason='worker_lost' OR
		       h.state IN ('draining','stale') OR h.id IS NULL OR
		       (i.recovery_reason='planned_drain' AND h.state='ready'))
		  AND COALESCE(i.request_spec #>> '{persistence,type}','') = 'persistent'
		  AND (i.lease_expires_at IS NULL OR i.lease_expires_at <= now())
		ORDER BY i.updated_at,i.id
		FOR UPDATE OF i SKIP LOCKED LIMIT 1`).Scan(
		&claim.Placement.SandboxID, &claim.Placement.LocalID,
		&claim.Placement.WorkerID, &claim.Placement.WorkerURL,
		&claim.Placement.Generation, &claim.DesiredState,
		&claim.Placement.ObservedState, &claim.Placement.Requested.CPUMillis,
		&claim.Placement.Requested.MemoryBytes, &claim.Placement.Requested.DiskBytes,
		&currentHostState, &claim.Placement.RecoverySnapshotID,
		&claim.Placement.RecoverySnapshotLocalID,
		&claim.Placement.RecoverySnapshotObjectURI,
		&claim.Placement.RecoverySnapshotDigest,
		&claim.Placement.RequestSpec, &recoveryServices, &recoveryReason, &reservationHeld,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecoveryClaim{}, ErrNotFound
	}
	if err != nil {
		return RecoveryClaim{}, err
	}
	if err := json.Unmarshal(recoveryServices, &claim.Placement.RecoveryServices); err != nil {
		return RecoveryClaim{}, fmt.Errorf("decode durable recovery services: %w", err)
	}
	claim.Placement.Persistent = true
	claim.Placement.DesiredState = claim.DesiredState
	claim.Placement.Requested.VMs = 1
	claim.Placement.SnapshotLocalID = claim.Placement.RecoverySnapshotLocalID
	claim.Placement.SnapshotObjectURI = claim.Placement.RecoverySnapshotObjectURI
	claim.Placement.SnapshotDigest = claim.Placement.RecoverySnapshotDigest

	if currentHostState != "ready" || claim.Placement.WorkerURL == "" {
		previousPlacement := claim.Placement
		claim.PreviousPlacement = &previousPlacement
		oldWorkerID := claim.Placement.WorkerID
		var newWorkerID, newWorkerURL string
		err = tx.QueryRow(ctx, `
			SELECT h.id,h.base_url FROM sandbox_hosts h`+observedReservationsJoin+`
			WHERE h.state='ready' AND h.lease_expires_at > now() AND h.id<>$1
			  AND h.capacity_cpu_millis-`+effectiveAllocated("cpu_millis")+` >= $2
			  AND h.capacity_memory_bytes-`+effectiveAllocated("memory_bytes")+` >= $3
			  AND h.capacity_disk_bytes-`+effectiveAllocated("disk_bytes")+` >= $4
			  AND h.capacity_vms-`+effectiveAllocated("vms")+` >= 1
			ORDER BY (`+effectiveAllocated("vms")+`::double precision/GREATEST(h.capacity_vms,1)),h.heartbeat_at DESC
			FOR UPDATE OF h SKIP LOCKED LIMIT 1`, oldWorkerID,
			claim.Placement.Requested.CPUMillis, claim.Placement.Requested.MemoryBytes,
			claim.Placement.Requested.DiskBytes).Scan(&newWorkerID, &newWorkerURL)
		if errors.Is(err, pgx.ErrNoRows) {
			return RecoveryClaim{}, ErrNoCapacity
		}
		if err != nil {
			return RecoveryClaim{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sandbox_hosts SET allocated_cpu_millis=allocated_cpu_millis+$2,
				allocated_memory_bytes=allocated_memory_bytes+$3,
				allocated_disk_bytes=allocated_disk_bytes+$4,
				allocated_vms=allocated_vms+1,updated_at=now() WHERE id=$1`,
			newWorkerID, claim.Placement.Requested.CPUMillis,
			claim.Placement.Requested.MemoryBytes, claim.Placement.Requested.DiskBytes); err != nil {
			return RecoveryClaim{}, err
		}
		if oldWorkerID != "" {
			if _, err := tx.Exec(ctx, `
				UPDATE sandbox_hosts SET
					allocated_cpu_millis=GREATEST(0,allocated_cpu_millis-CASE WHEN $5 THEN $2 ELSE 0::bigint END),
					allocated_memory_bytes=GREATEST(0,allocated_memory_bytes-CASE WHEN $5 THEN $3 ELSE 0::bigint END),
					allocated_disk_bytes=GREATEST(0,allocated_disk_bytes-$4),
					allocated_vms=GREATEST(0,allocated_vms-CASE WHEN $5 THEN 1 ELSE 0 END),updated_at=now()
				WHERE id=$1`, oldWorkerID, claim.Placement.Requested.CPUMillis,
				claim.Placement.Requested.MemoryBytes, claim.Placement.Requested.DiskBytes,
				reservationHeld); err != nil {
				return RecoveryClaim{}, err
			}
		}
		claim.Placement.WorkerID = newWorkerID
		claim.Placement.WorkerURL = newWorkerURL
		claim.Placement.Generation++
	} else if claim.Placement.ObservedState == "degraded" {
		if !reservationHeld {
			// A stopped placement may have released compute before a planned
			// drain. Reusing its retained disk still requires re-admitting CPU,
			// memory, and the active-VM slot before the recovery boot.
			tag, rechargeErr := tx.Exec(ctx, `
				UPDATE sandbox_hosts AS target SET
					allocated_cpu_millis=target.allocated_cpu_millis+$2,
					allocated_memory_bytes=target.allocated_memory_bytes+$3,
					allocated_vms=target.allocated_vms+1,updated_at=now()
				FROM sandbox_hosts h`+observedReservationsJoin+`
				WHERE h.id=target.id AND target.id=$1
				  AND h.state='ready' AND h.lease_expires_at > now()
				  AND h.capacity_cpu_millis-`+effectiveAllocated("cpu_millis")+` >= $2
				  AND h.capacity_memory_bytes-`+effectiveAllocated("memory_bytes")+` >= $3
				  AND h.capacity_vms-`+effectiveAllocated("vms")+` >= 1`,
				claim.Placement.WorkerID, claim.Placement.Requested.CPUMillis,
				claim.Placement.Requested.MemoryBytes)
			if rechargeErr != nil {
				return RecoveryClaim{}, rechargeErr
			}
			if tag.RowsAffected() == 0 {
				return RecoveryClaim{}, ErrNoCapacity
			}
		}
		// A drain is sticky for one worker boot. If the same durable worker ID
		// returns ready, Heartbeat has already proven that it is a new boot
		// epoch. Promote the verified stopped local disk under a new placement
		// generation so every command from the prior boot is fenced. A different
		// worker still restores the exported checkpoint under a fresh local ID.
		previousPlacement := claim.Placement
		claim.PreviousPlacement = &previousPlacement
		claim.Placement.Generation++
	}
	claim.ReuseStoppedDisk = recoveryReason == "planned_drain" && currentHostState == "ready"
	if claim.PreviousPlacement != nil && !claim.ReuseStoppedDisk {
		// A snapshot may retain its source sandbox name. Reusing that name for
		// the recovered runtime makes Microsandbox replace the stopped source
		// while it is also opening the source snapshot. Use a new provider-local
		// name for every actual relocation while the logical sandbox ID remains
		// stable for API callers and product rows.
		claim.Placement.LocalID = "msb_" + uuid.NewString()
	}

	tag, err := tx.Exec(ctx, `
		UPDATE sandbox_instances SET worker_id=$2,provider_local_id=$3,placement_generation=$4,
			observed_state='recovering',reservation_held=true,lease_owner=$5,
			lease_expires_at=now()+$6::interval,updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, claim.Placement.SandboxID,
		claim.Placement.WorkerID, claim.Placement.LocalID, claim.Placement.Generation, owner,
		fmt.Sprintf("%f seconds", leaseTTL.Seconds()))
	if err != nil {
		return RecoveryClaim{}, err
	}
	if tag.RowsAffected() != 1 {
		return RecoveryClaim{}, ErrStale
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sandbox_domain_mappings SET placement_generation=$2,updated_at=now()
		WHERE sandbox_id=$1`, claim.Placement.SandboxID, claim.Placement.Generation); err != nil {
		return RecoveryClaim{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecoveryClaim{}, err
	}
	return claim, nil
}

func (s *PGStore) CompleteRecovery(ctx context.Context, sandboxID string, generation int64, observed string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET observed_state=$3,recovery_reason='',lease_owner=NULL,
			lease_expires_at=NULL,last_error='',last_heartbeat_at=now(),updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND observed_state='recovering'
		  AND deleted_at IS NULL`, sandboxID, generation, observed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) FailRecovery(ctx context.Context, sandboxID string, generation int64, lastError string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET observed_state='recovering',lease_owner=NULL,
			lease_expires_at=now()+interval '30 seconds',last_error=$3,updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND observed_state='recovering'
		  AND deleted_at IS NULL`, sandboxID, generation, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) BlockRecovery(ctx context.Context, sandboxID string, generation int64, lastError string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_instances SET observed_state='degraded',recovery_reason='secrets_required',
			lease_owner=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now()
		WHERE id=$1 AND placement_generation=$2 AND observed_state='recovering'
		  AND deleted_at IS NULL`, sandboxID, generation, lastError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

func (s *PGStore) BindOperation(ctx context.Context, key, sandboxID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_operations SET sandbox_id=$2,updated_at=now()
		WHERE idempotency_key=$1 AND status='pending'
		  AND (sandbox_id IS NULL OR sandbox_id=$2)`, key, sandboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOperationInProgress
	}
	return nil
}

func (s *PGStore) BeginOperation(ctx context.Context, key, operation, digest string) (OperationResponse, bool, error) {
	if s == nil || s.pool == nil {
		return OperationResponse{}, false, errors.New("sandbox control store is unavailable")
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return OperationResponse{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM sandbox_operations WHERE expires_at <= now()`)
	tag, err := tx.Exec(ctx, `
		INSERT INTO sandbox_operations (
			idempotency_key,operation,status,request_digest,lease_expires_at,expires_at
		) VALUES ($1,$2,'pending',$3,now()+interval '40 minutes',now()+interval '24 hours')
		ON CONFLICT (idempotency_key) DO NOTHING`, key, operation, digest)
	if err != nil {
		return OperationResponse{}, false, err
	}
	if tag.RowsAffected() == 1 {
		if err := tx.Commit(ctx); err != nil {
			return OperationResponse{}, false, err
		}
		return OperationResponse{}, true, nil
	}
	var storedDigest, status, sandboxID string
	var leaseExpired bool
	var raw json.RawMessage
	err = tx.QueryRow(ctx, `
		SELECT request_digest,status,COALESCE(response,'{}'::jsonb),lease_expires_at <= now(),
		       COALESCE(sandbox_id,'')
		FROM sandbox_operations WHERE idempotency_key=$1 FOR UPDATE`, key).
		Scan(&storedDigest, &status, &raw, &leaseExpired, &sandboxID)
	if err != nil {
		return OperationResponse{}, false, err
	}
	if storedDigest != digest {
		return OperationResponse{}, false, ErrIdempotencyConflict
	}
	// A create operation is bound to its stable sandbox identity before the
	// worker is called. If the controller disappears after materialization (or
	// fails while finalizing the DB state), worker inventory can establish that
	// the logical create succeeded. Replaying that identity is the only safe
	// choice: allocating another ID would create a second sandbox for one key.
	if ((status == "pending" && leaseExpired) || status == "failed") && createsSandboxOperation(operation) && sandboxID != "" {
		var observed string
		instanceErr := tx.QueryRow(ctx, `
			SELECT observed_state FROM sandbox_instances
			WHERE id=$1 AND deleted_at IS NULL`, sandboxID).Scan(&observed)
		if instanceErr == nil {
			switch observed {
			case "running", "stopped", "restart_pending", "recovering", "degraded":
				replay, replayErr := boundSandboxReplay(operation, sandboxID)
				if replayErr != nil {
					return OperationResponse{}, false, replayErr
				}
				response, marshalErr := json.Marshal(replay)
				if marshalErr != nil {
					return OperationResponse{}, false, marshalErr
				}
				if _, err := tx.Exec(ctx, `
					UPDATE sandbox_operations SET status='succeeded',response=$2,
						error_code='',lease_expires_at=now(),updated_at=now()
					WHERE idempotency_key=$1 AND status IN ('pending','failed')`, key, response); err != nil {
					return OperationResponse{}, false, err
				}
				if err := tx.Commit(ctx); err != nil {
					return OperationResponse{}, false, err
				}
				return replay, false, nil
			case "starting", "stopping", "deleting":
				return OperationResponse{}, false, ErrOperationInProgress
			}
		} else if !errors.Is(instanceErr, pgx.ErrNoRows) {
			return OperationResponse{}, false, instanceErr
		}
	}
	if operation == "POST /v1/sandboxes/snapshots" && sandboxID != "" &&
		((status == "pending" && leaseExpired) || status == "failed") {
		var snapshotID string
		snapshotErr := tx.QueryRow(ctx, `
			SELECT id FROM sandbox_snapshots
			WHERE source_sandbox_id=$1 AND state IN ('ready','exported') AND deleted_at IS NULL
			ORDER BY created_at DESC,id DESC LIMIT 1`, sandboxID).Scan(&snapshotID)
		if snapshotErr == nil {
			if err := enqueueTemporarySandboxCleanup(ctx, tx, sandboxID); err != nil {
				return OperationResponse{}, false, err
			}
			body, marshalErr := json.Marshal(sandbox.CreateSnapshotResponse{SnapshotID: snapshotID})
			if marshalErr != nil {
				return OperationResponse{}, false, marshalErr
			}
			replay := OperationResponse{
				StatusCode: operationHTTPStatusCreated, ContentType: "application/json", Body: body, Replayable: true,
			}
			response, marshalErr := json.Marshal(replay)
			if marshalErr != nil {
				return OperationResponse{}, false, marshalErr
			}
			if _, err := tx.Exec(ctx, `
				UPDATE sandbox_operations SET status='succeeded',response=$2,error_code='',
					lease_expires_at=now(),updated_at=now()
				WHERE idempotency_key=$1 AND status IN ('pending','failed')`, key, response); err != nil {
				return OperationResponse{}, false, err
			}
			if err := tx.Commit(ctx); err != nil {
				return OperationResponse{}, false, err
			}
			return replay, false, nil
		}
		if !errors.Is(snapshotErr, pgx.ErrNoRows) {
			return OperationResponse{}, false, snapshotErr
		}
	}
	// Template-backed snapshot creation materializes an internal temporary VM.
	// If the controller dies after that create, the expired operation lease must
	// durably enqueue the bound VM for normal deletion before a retry allocates a
	// replacement. It is not a successful snapshot response and must never use
	// the bound-create synthetic replay path above.
	resettingTemporary := operation == "POST /v1/sandboxes/snapshots" && sandboxID != "" &&
		((status == "pending" && leaseExpired) || status == "failed")
	if resettingTemporary {
		if err := enqueueTemporarySandboxCleanup(ctx, tx, sandboxID); err != nil {
			return OperationResponse{}, false, err
		}
	}
	if status == "pending" {
		if leaseExpired {
			_, err = tx.Exec(ctx, `
				UPDATE sandbox_operations SET sandbox_id=NULL,
					lease_expires_at=now()+interval '40 minutes',
					updated_at=now(),expires_at=now()+interval '24 hours'
				WHERE idempotency_key=$1`, key)
			if err != nil {
				return OperationResponse{}, false, err
			}
			if err := tx.Commit(ctx); err != nil {
				return OperationResponse{}, false, err
			}
			return OperationResponse{}, true, nil
		}
		return OperationResponse{}, false, ErrOperationInProgress
	}
	if status == "failed" {
		_, err = tx.Exec(ctx, `
			UPDATE sandbox_operations SET status='pending',sandbox_id=NULL,error_code='',response=NULL,
				lease_expires_at=now()+interval '40 minutes',updated_at=now(),
				expires_at=now()+interval '24 hours'
			WHERE idempotency_key=$1`, key)
		if err != nil {
			return OperationResponse{}, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return OperationResponse{}, false, err
		}
		return OperationResponse{}, true, nil
	}
	var replay OperationResponse
	if err := json.Unmarshal(raw, &replay); err != nil {
		return OperationResponse{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return OperationResponse{}, false, err
	}
	return replay, false, nil
}

const operationHTTPStatusCreated = 201

func enqueueTemporarySandboxCleanup(ctx context.Context, tx pgx.Tx, sandboxID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE sandbox_instances SET desired_state='deleted',observed_state='deleting',
			cleanup_pending=true,lease_owner=NULL,lease_expires_at=NULL,
			last_error='abandoned snapshot-build operation',updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL`, sandboxID)
	return err
}

func boundSandboxReplay(_ string, sandboxID string) (OperationResponse, error) {
	response := sandbox.CreateResult{ID: sandboxID}
	body, err := json.Marshal(response)
	if err != nil {
		return OperationResponse{}, err
	}
	return OperationResponse{
		StatusCode: 201, ContentType: "application/json", Body: body, Replayable: true,
	}, nil
}

func (s *PGStore) CompleteOperation(ctx context.Context, key string, response OperationResponse) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	status := "succeeded"
	errorCode := ""
	// Capacity exhaustion and transport/worker 5xx responses are retryable
	// outcomes, not the result of the logical mutation. Release the operation
	// lease so a caller reusing the same key can make progress after recovery.
	if response.StatusCode == 429 || response.StatusCode >= 500 {
		status = "failed"
		errorCode = fmt.Sprintf("http_%d", response.StatusCode)
		payload = nil
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE sandbox_operations SET status=$2,response=$3,error_code=$4,
			lease_expires_at=now(),updated_at=now()
		WHERE idempotency_key=$1 AND status='pending'`, key, status, payload, errorCode)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrOperationInProgress
	}
	return nil
}

var _ Store = (*PGStore)(nil)

// ErrHostNotDrainable means the host holds a live lease but is in a state
// that has nothing to drain — stopped, fenced, or already gone. The operator
// asked for something that does not apply to this host.
var ErrHostNotDrainable = errors.New("host is not drainable")

// ErrHostLeaseLost means the host's controller lease has expired: the
// controller no longer owns it, so it cannot be told to do anything. This is
// plue's platform losing a host, NOT the operator's request being wrong, and
// the two used to be one error — so an admin draining a host that had silently
// died was told their request conflicted with the host's state.
var ErrHostLeaseLost = errors.New("host lease has expired")

// DrainHost enters the existing controller-owned draining state. Heartbeat
// preserves it for this boot, admission excludes it, and ClaimDrain relocates
// durable placements using the normal checkpoint/recovery machinery.
func (s *PGStore) DrainHost(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var state string
	var live bool
	err = tx.QueryRow(ctx, `SELECT state,lease_expires_at>now() FROM sandbox_hosts WHERE id=$1 FOR UPDATE`, id).Scan(&state, &live)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !live {
		return ErrHostLeaseLost
	}
	if state != "ready" && state != "draining" {
		return ErrHostNotDrainable
	}
	if _, err = tx.Exec(ctx, `UPDATE sandbox_hosts SET state='draining',updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
