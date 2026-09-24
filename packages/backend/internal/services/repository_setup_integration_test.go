package services

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

type setupBlockedRuntime struct {
	flowruntime.Runtime
	entered  chan struct{}
	release  chan struct{}
	once     sync.Once
	complete atomic.Bool
	launches atomic.Int32
	input    SetupInput
}

func (r *setupBlockedRuntime) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}, nil
}
func (r *setupBlockedRuntime) Launch(ctx context.Context, input flowruntime.Launch) (flowruntime.LaunchResult, error) {
	r.launches.Add(1)
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
	case <-ctx.Done():
		return flowruntime.LaunchResult{}, ctx.Err()
	}
	return flowruntime.LaunchResult{ApplicationRequestID: input.ApplicationRequestID, OwnerGeneration: input.OwnerGeneration, RuntimeArtifactDigest: input.RuntimeArtifactDigest, SourceRevision: input.SourceRevision, PlanID: "plan-setup", Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: "receipt-setup", RunID: "run-setup"}}, nil
}
func (r *setupBlockedRuntime) Observe(_ context.Context, runID, cursor string, _ int) (flowruntime.Observation, error) {
	status := "running"
	var output *string
	if r.complete.Load() {
		status = "completed"
		response := setupInitial(r.input)
		response.Receipt.Phase = "completed"
		response.Receipt.RunID = runID
		raw, _ := json.Marshal(response)
		text := string(raw)
		output = &text
	}
	return flowruntime.Observation{Run: flowruntime.Run{RunID: runID, FlowID: "repository/setup", Status: status, FinalOutput: output}, NextCursor: cursor, Terminal: status == "completed"}, nil
}

func TestRepositorySetupDurableAdmissionAndRuntimeCompletion(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	var repo string
	require.NoError(t, pool.QueryRow(ctx, `SELECT u.username||'/'||r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID).Scan(&repo))
	input := setupFixtureInput(t)
	input.Repo = repo
	input.Digest = setupCandidateDigest(input, false)
	input.WorkspaceID = uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, input.WorkspaceID, repoID, userID)
	require.NoError(t, err)
	product := NewRepositorySetupService(pool, NewRepositoryJobService(db.New(pool), nil, pool), nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	runtime := &setupBlockedRuntime{entered: make(chan struct{}), release: make(chan struct{}), input: input}
	var resolutions atomic.Int32
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: product, ObservationDelay: time.Millisecond, MaxObservationDelay: 5 * time.Millisecond, Resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
		resolutions.Add(1)
		authority, err := product.ResolveFlowHostTarget(ctx, target)
		if err != nil {
			return nil, err
		}
		if authority.CatalogKey != "coding" {
			t.Errorf("setup selected wrong catalog %s", authority.CatalogKey)
		}
		return runtime, nil
	})})
	require.NoError(t, err)
	product.SetFlowDispatcher(dispatcher)
	first, err := product.Request(ctx, repoID, userID, input)
	require.NoError(t, err)
	require.Equal(t, "queued", first.Response.Receipt.Phase)
	require.Zero(t, resolutions.Load())
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "setup-test", Capacity: 1, Lease: 2 * time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop")
		}
	})
	select {
	case <-runtime.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not enter unresolved launch")
	}
	// The actual shared worker is blocked in launch. Duplicate HTTP intents and
	// recovery still complete through durable database state.
	bounded, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	joined, err := product.Request(bounded, repoID, userID, input)
	require.NoError(t, err)
	require.Equal(t, first.ID, joined.ID)
	require.False(t, joined.Terminal)
	read, err := product.Read(bounded, repoID, userID, repo, input.Job, input.RequestID)
	require.NoError(t, err)
	require.False(t, read.Terminal)
	before := resolutions.Load()
	recovered, err := product.Recover(bounded, repoID, userID, "owner", repo, input.Job)
	require.NoError(t, err)
	require.Equal(t, "found", recovered.Setup.State)
	require.Equal(t, before, resolutions.Load())
	changed := input
	changed.Operation = "evaluate"
	_, err = product.Request(ctx, repoID, userID, changed)
	require.Error(t, err)
	var jobsCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&jobsCount))
	require.Equal(t, 1, jobsCount)
	close(runtime.release)
	require.Eventually(t, func() bool {
		row, e := product.Read(ctx, repoID, userID, repo, input.Job, input.RequestID)
		return e == nil && !row.Terminal && row.Response.Receipt.Phase == "running"
	}, 5*time.Second, 5*time.Millisecond)
	runtime.complete.Store(true)
	require.Eventually(t, func() bool {
		row, e := product.Read(ctx, repoID, userID, repo, input.Job, input.RequestID)
		return e == nil && row.Terminal && row.Response.Receipt.Phase == "completed" && row.Response.Receipt.RunID == "run-setup"
	}, 5*time.Second, 5*time.Millisecond)
	require.EqualValues(t, 1, runtime.launches.Load())
	// The completed request survives a new service instance and no resolver runs.
	reconnected := NewRepositorySetupService(pool, product.repositoryJobs, nil)
	row, err := reconnected.Read(ctx, repoID, userID, repo, input.Job, input.RequestID)
	require.NoError(t, err)
	require.True(t, row.Terminal)
}

func TestRepositorySetupProjectionRejectsForeignAndMissingCompletion(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	product := NewRepositorySetupService(pool, NewRepositoryJobService(db.New(pool), nil, pool), nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: product, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Fatal("projection read launched a host")
		return nil, nil
	})})
	require.NoError(t, err)
	product.SetFlowDispatcher(dispatcher)
	for _, state := range []string{"completed", "failed", "cancelled"} {
		input := setupFixtureInput(t)
		input.RequestID = state
		var repo string
		require.NoError(t, pool.QueryRow(ctx, `SELECT u.username||'/'||r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID).Scan(&repo))
		input.Repo = repo
		input.Digest = setupCandidateDigest(input, false)
		record, err := product.Request(ctx, repoID, userID, input)
		require.NoError(t, err)
		scope := repositoryJobFlowScope(repoID, userID)
		projection, _ := json.Marshal(map[string]string{"kind": repositorySetupBinding, "id": record.ID})
		checkpoint := flowdispatch.RuntimeCheckpoint{Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, BindingKind: repositorySetupBinding, BindingID: record.ID}, FlowID: "repository/setup", Projection: projection, RunID: "run-1", Run: &flowruntime.Run{RunID: "run-1", FlowID: "repository/setup", Status: state}}
		update := flowdispatch.ProjectionUpdate{OperationID: record.OperationID, Scope: scope, State: jobs.StateCompleted, Checkpoint: checkpoint}
		foreign := update
		foreign.Scope.PrincipalID = "user:0"
		require.Error(t, product.ProjectFlowRuntime(ctx, foreign))
		require.NoError(t, product.ProjectFlowRuntime(ctx, update))
		saved, err := product.Read(ctx, repoID, userID, input.Repo, input.Job, input.RequestID)
		require.NoError(t, err)
		require.True(t, saved.Terminal)
		if state == "cancelled" {
			require.Equal(t, "stopped", saved.Response.Receipt.Phase)
		} else {
			require.Equal(t, "failed", saved.Response.Receipt.Phase)
		}
		if state == "completed" {
			require.NotEmpty(t, saved.ObservationError)
		}
	}
}
