package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// NixOS CI plane tests. Owner decision (2026-09-15): a repository that declares
// .smithers/environment.nix runs each CI job in its own kind=vm NixOS guest
// booted from the repository's closure, not on the Debian gVisor runner pool.

// ---------------------------------------------------------------- pure rules

func nixTask(id int64, job string, needs ...string) nixCITask {
	return nixCITask{
		ID:            id,
		WorkflowRunID: 7,
		StepID:        id * 10,
		StepName:      job,
		Job:           job,
		Needs:         needs,
		Steps:         []StepConfig{{Name: job, Run: "make " + job}},
	}
}

func TestNixCIReadyTasks_ReleasesJobsOnlyWhenDependenciesSucceed(t *testing.T) {
	t.Parallel()
	tasks := []nixCITask{nixTask(1, "build"), nixTask(2, "test", "build"), nixTask(3, "lint")}

	ready, skip := nixCIReadyTasks(tasks, map[string]nixCITaskOutcome{}, map[int64]bool{})
	require.Empty(t, skip)
	assert.Equal(t, []string{"build", "lint"}, nixCIJobNames(ready),
		"independent jobs start together; a job with unmet needs waits")

	started := map[int64]bool{1: true, 3: true}
	ready, skip = nixCIReadyTasks(tasks, map[string]nixCITaskOutcome{
		"build": nixCITaskDone, "lint": nixCITaskDone,
	}, started)
	require.Empty(t, skip)
	assert.Equal(t, []string{"test"}, nixCIJobNames(ready))
}

func TestNixCIReadyTasks_SkipsDependentsOfAFailedJob(t *testing.T) {
	t.Parallel()
	tasks := []nixCITask{nixTask(1, "build"), nixTask(2, "test", "build")}

	ready, skip := nixCIReadyTasks(tasks, map[string]nixCITaskOutcome{"build": nixCITaskFailed}, map[int64]bool{1: true})

	assert.Empty(t, ready)
	assert.Equal(t, []string{"test"}, nixCIJobNames(skip),
		"a job whose dependency failed is skipped, as on the runner plane")
}

func nixCIJobNames(tasks []nixCITask) []string {
	names := make([]string, 0, len(tasks))
	for _, task := range tasks {
		names = append(names, task.Job)
	}
	return names
}

func TestNixCIRunOutcome_FailureWinsThenCancellation(t *testing.T) {
	t.Parallel()
	assert.Equal(t, nixCITaskDone, nixCIRunOutcome(map[string]nixCITaskOutcome{"a": nixCITaskDone, "b": nixCITaskSkipped}))
	assert.Equal(t, nixCITaskCancelled, nixCIRunOutcome(map[string]nixCITaskOutcome{"a": nixCITaskDone, "b": nixCITaskCancelled}))
	assert.Equal(t, nixCITaskFailed, nixCIRunOutcome(map[string]nixCITaskOutcome{"a": nixCITaskCancelled, "b": nixCITaskFailed}))
}

func TestNixCITaskCommand_RendersStepsInOrderAndRejectsUses(t *testing.T) {
	t.Parallel()
	script, err := nixCITaskCommand(nixCITask{Job: "build", Steps: []StepConfig{
		{Name: "install", Run: "bun install"},
		{Run: "zig build ci-local"},
	}})
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(script, "set -euo pipefail\n"), "first failing step must end the job")
	assert.Less(t, strings.Index(script, "bun install"), strings.Index(script, "zig build ci-local"))
	assert.Contains(t, script, "cd '"+nixCITaskWorkdir+"'")

	_, err = nixCITaskCommand(nixCITask{Job: "build", Steps: []StepConfig{{Uses: "actions/checkout@v4"}}})
	assert.Error(t, err, "unsupported step kinds must fail loudly, not be silently skipped")

	_, err = nixCITaskCommand(nixCITask{Job: "empty"})
	assert.Error(t, err)
}

func TestParseNixCIExitMarker(t *testing.T) {
	t.Parallel()
	_, done := parseNixCIExitMarker("")
	assert.False(t, done, "no marker means the job is still running")

	code, done := parseNixCIExitMarker("warning: something\n" + nixCITaskExitMarker + "0")
	assert.True(t, done)
	assert.Equal(t, int32(0), code)

	code, done = parseNixCIExitMarker(nixCITaskExitMarker + "17")
	assert.True(t, done)
	assert.Equal(t, int32(17), code)

	code, done = parseNixCIExitMarker(nixCITaskExitMarker + "garbage")
	assert.True(t, done)
	assert.Equal(t, int32(1), code, "an unreadable exit status is a failure, not a success")
}

func TestNixCIPollCommand_TailsFromTheByteOffset(t *testing.T) {
	t.Parallel()
	assert.Contains(t, nixCIPollCommand(0), "tail -c +1 ")
	assert.Contains(t, nixCIPollCommand(97), "tail -c +97 ")
}

// ------------------------------------------------------- guest lifecycle

// nixCIGuestScript is a fake NixOS guest: it accepts the start exec, then
// serves the job's output in chunks and finally the exit marker.
type nixCIGuestScript struct {
	chunks   []string
	exitCode string
}

// fakeNixCIGuests drives mockWorkflowSandboxVMClient as a set of per-job
// guests, keyed by the job the create request checks out.
type fakeNixCIGuests struct {
	mu       sync.Mutex
	scripts  map[string]nixCIGuestScript
	polls    map[string]int
	vmForJob map[string]string
	nextVM   int
	requests []sandbox.CreateRequest
}

func (f *fakeNixCIGuests) CIGuestVMRequest(_ context.Context, repositoryID int64, gitRepos []sandbox.GitRepositorySpec) (sandbox.CreateRequest, error) {
	req := sandbox.CreateRequest{Kind: "vm", Image: "registry.test/nix:closure", GitRepos: gitRepos}
	f.mu.Lock()
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	return req, nil
}

func (f *fakeNixCIGuests) client(t *testing.T) *mockWorkflowSandboxVMClient {
	t.Helper()
	jobForVM := map[string]string{}
	return &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.nextVM++
			return sandbox.CreateResult{ID: "vm-" + string(rune('0'+f.nextVM))}, nil
		},
		execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			ok := int32(0)
			if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
				// The start exec carries the rendered job script, which names
				// the job through its `make <job>` step.
				for job := range f.scripts {
					if strings.Contains(req.Command, "make "+job) {
						jobForVM[vmID] = job
					}
				}
				return sandbox.ExecResult{StatusCode: &ok}, nil
			}
			job := jobForVM[vmID]
			script := f.scripts[job]
			idx := f.polls[vmID]
			f.polls[vmID] = idx + 1
			if idx < len(script.chunks) {
				return sandbox.ExecResult{Stdout: script.chunks[idx], StatusCode: &ok}, nil
			}
			return sandbox.ExecResult{Stderr: nixCITaskExitMarker + script.exitCode, StatusCode: &ok}, nil
		},
	}
}

func nixCITaskRow(id int64, stepID int64, job string, needs []string) db.WorkflowTask {
	payload, _ := json.Marshal(map[string]any{
		"job":   job,
		"steps": []StepConfig{{Name: job, Run: "make " + job}},
		"needs": needs,
	})
	return db.WorkflowTask{
		ID:             id,
		WorkflowRunID:  42,
		WorkflowStepID: stepID,
		RepositoryID:   100,
		Status:         "pending",
		Payload:        payload,
	}
}

// nixCIQuerier builds a scheduler querier that claims one sandbox-plane run
// whose job graph is the supplied tasks.
func nixCIQuerier(tasks []db.WorkflowTask) *mockWorkflowSandboxSchedulerQuerier {
	byID := map[int64]db.WorkflowTask{}
	rows := make([]db.ListTaskStepInfoForRunRow, 0, len(tasks))
	for _, task := range tasks {
		byID[task.ID] = task
		var payload nixCITaskPayload
		_ = json.Unmarshal(task.Payload, &payload)
		rows = append(rows, db.ListTaskStepInfoForRunRow{ID: task.ID, Status: task.Status, StepName: payload.Job})
	}
	return &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   42,
				RepositoryID:         100,
				WorkflowDefinitionID: 5,
				TriggerRef:           "main",
				TriggerCommitSha:     "cafebabe",
				ExecutionPlane:       WorkflowRunPlaneSandbox,
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 5, RepositoryID: 100, Path: ".smithers/workflows/ci.tsx"}, nil
		},
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return testRepositoryOwnedByUser(100, 9, "demo"), nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 9, Username: "alice"}, nil
		},
		listTaskStepInfoForRunFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return rows, nil
		},
		getWorkflowTaskFn: func(_ context.Context, arg db.GetWorkflowTaskParams) (db.WorkflowTask, error) {
			task, ok := byID[arg.ID]
			if !ok {
				return db.WorkflowTask{}, errors.New("no such task")
			}
			return task, nil
		},
	}
}

func testRepositoryOwnedByUser(id, userID int64, name string) db.Repository {
	repo := db.Repository{ID: id, Name: name}
	repo.UserID.Int64 = userID
	repo.UserID.Valid = true
	return repo
}

func newNixCIWorker(t *testing.T, queries *mockWorkflowSandboxSchedulerQuerier, guests *fakeNixCIGuests) (*WorkflowSandboxSchedulerWorker, *mockWorkflowSandboxVMClient) {
	t.Helper()
	client := guests.client(t)
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
	)
	return worker, client
}

func TestNixCIRun_BootsOneGuestPerJobAndStreamsLogsInOrder(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{
		nixCITaskRow(1, 11, "build", nil),
		nixCITaskRow(2, 22, "test", []string{"build"}),
	})
	guests := &fakeNixCIGuests{
		polls: map[string]int{},
		scripts: map[string]nixCIGuestScript{
			"build": {chunks: []string{"compiling\n", "linking\n"}, exitCode: "0"},
			"test":  {chunks: []string{"running tests\n"}, exitCode: "0"},
		},
	}
	worker, client := newNixCIWorker(t, queries, guests)

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Len(t, client.createCalls, 2, "each job gets its own guest")
	for _, req := range client.createCalls {
		assert.Equal(t, "vm", req.Kind, "CI guests are NixOS kind=vm, not the Debian runner image")
		require.Len(t, req.GitRepos, 1)
		assert.Equal(t, "cafebabe", req.GitRepos[0].Rev, "the guest checks out the trigger commit")
		assert.Equal(t, nixCITaskWorkdir, req.GitRepos[0].Path)
	}
	assert.Len(t, client.deleteCalls, 2, "every guest is destroyed when its job ends")

	assert.Equal(t, []string{"compiling", "linking"}, nixCILogEntriesForStep(queries, 11),
		"log lines arrive in the order the guest produced them")
	assert.Equal(t, []string{"running tests"}, nixCILogEntriesForStep(queries, 22))

	assert.Equal(t, map[int64]string{1: "done", 2: "done"}, nixCITaskStatuses(queries))
	assert.Equal(t, map[int64]string{11: "success", 22: "success"}, nixCIStepStatuses(queries))
	assert.Equal(t, []int64{42}, queries.markSuccessIDs)
}

func TestNixCIRun_FailingJobFailsTheRunAndSkipsDependents(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{
		nixCITaskRow(1, 11, "build", nil),
		nixCITaskRow(2, 22, "test", []string{"build"}),
	})
	guests := &fakeNixCIGuests{
		polls: map[string]int{},
		scripts: map[string]nixCIGuestScript{
			"build": {chunks: []string{"boom\n"}, exitCode: "2"},
			"test":  {exitCode: "0"},
		},
	}
	worker, client := newNixCIWorker(t, queries, guests)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "a failed run is terminalized, not surfaced as a poll error")

	assert.Len(t, client.createCalls, 1, "a job whose dependency failed never boots a guest")
	assert.Equal(t, map[int64]string{1: "failed", 2: "skipped"}, nixCITaskStatuses(queries))
	assert.Equal(t, map[int64]string{11: "failure", 22: "skipped"}, nixCIStepStatuses(queries))
	assert.Equal(t, []int64{42}, queries.markFailureIDs)
	assert.Empty(t, queries.markSuccessIDs)
}

func TestNixCIRun_ParallelJobsRunConcurrently(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{
		nixCITaskRow(1, 11, "build", nil),
		nixCITaskRow(2, 22, "lint", nil),
		nixCITaskRow(3, 33, "typecheck", nil),
	})
	guests := &fakeNixCIGuests{
		polls: map[string]int{},
		scripts: map[string]nixCIGuestScript{
			"build":     {exitCode: "0"},
			"lint":      {exitCode: "0"},
			"typecheck": {exitCode: "0"},
		},
	}
	worker, client := newNixCIWorker(t, queries, guests)

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Len(t, client.createCalls, 3)
	assert.Equal(t, map[int64]string{1: "done", 2: "done", 3: "done"}, nixCITaskStatuses(queries))
	assert.Equal(t, []int64{42}, queries.markSuccessIDs)
}

func TestNixCIRun_CancellationMarksTasksCancelledAndDestroysGuests(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "build", nil)})
	guests := &fakeNixCIGuests{
		polls:   map[string]int{},
		scripts: map[string]nixCIGuestScript{"build": {}},
	}
	worker, client := newNixCIWorker(t, queries, guests)

	ctx, cancel := context.WithCancel(context.Background())
	// The guest never reports an exit; canceling the run context is what the
	// claim watchdog does when CancelRun takes the run out of 'running'.
	guests.scripts["build"] = nixCIGuestScript{chunks: []string{"working\n"}, exitCode: ""}
	client.execAwaitFn = func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		ok := int32(0)
		if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
			return sandbox.ExecResult{StatusCode: &ok}, nil
		}
		cancel()
		return sandbox.ExecResult{Stdout: "working\n", StatusCode: &ok}, nil
	}

	_ = worker.PollOnce(ctx)

	assert.Equal(t, map[int64]string{1: "cancelled"}, nixCITaskStatuses(queries))
	assert.Equal(t, map[int64]string{11: "cancelled"}, nixCIStepStatuses(queries))
	assert.Equal(t, []string{"vm-1"}, client.deleteCalls, "a cancelled job still destroys its guest")
}

func TestNixCIRun_GuestProvisionFailureFailsTheTask(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "build", nil)})
	guests := &fakeNixCIGuests{polls: map[string]int{}, scripts: map[string]nixCIGuestScript{"build": {exitCode: "0"}}}
	worker, client := newNixCIWorker(t, queries, guests)
	client.createVMFn = func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
		return sandbox.CreateResult{}, errors.New("no capacity")
	}

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Len(t, client.createCalls, defaultNixCIProvisionAttempts,
		"provisioning — and only provisioning — is retried")
	assert.Equal(t, map[int64]string{1: "failed"}, nixCITaskStatuses(queries))
	assert.Equal(t, []int64{42}, queries.markFailureIDs)
}

func TestNixCIRun_RunWithoutTaskGraphKeepsTheOrchestratorPath(t *testing.T) {
	// InvokeWorkflow creates a sandbox-plane run with no tasks. That run must
	// keep booting the single whole-workflow VM, not one guest per job.
	queries := nixCIQuerier(nil)
	guests := &fakeNixCIGuests{polls: map[string]int{}, scripts: map[string]nixCIGuestScript{}}
	worker, client := newNixCIWorker(t, queries, guests)

	require.NoError(t, worker.PollOnce(context.Background()))

	require.Len(t, client.createCalls, 1)
	assert.Empty(t, guests.requests, "the NixOS CI guest provisioner is never consulted")
	assert.NotEqual(t, "registry.test/nix:closure", client.createCalls[0].Image)
	assert.Equal(t, []int64{42}, queries.markSuccessIDs)
}

func TestNixCIRun_WithoutAProvisionerEveryRunKeepsTheOrchestratorPath(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "build", nil)})
	client := &mockWorkflowSandboxVMClient{}
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"))

	require.NoError(t, worker.PollOnce(context.Background()))

	require.Len(t, client.createCalls, 1)
	assert.Equal(t, "", client.createCalls[0].Kind, "the legacy whole-workflow VM request is unchanged")
}

// ------------------------------------------------------------------ helpers

func nixCILogEntriesForStep(q *mockWorkflowSandboxSchedulerQuerier, stepID int64) []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	entries := []string{}
	for _, insert := range q.logInserts {
		if insert.WorkflowStepID == stepID && insert.Stream == "stdout" {
			entries = append(entries, insert.Entry)
		}
	}
	return entries
}

func nixCITaskStatuses(q *mockWorkflowSandboxSchedulerQuerier) map[int64]string {
	q.mu.Lock()
	defer q.mu.Unlock()
	statuses := map[int64]string{}
	for _, terminal := range q.terminalTasks {
		statuses[terminal.ID] = terminal.Status
	}
	return statuses
}

func nixCIStepStatuses(q *mockWorkflowSandboxSchedulerQuerier) map[int64]string {
	q.mu.Lock()
	defer q.mu.Unlock()
	statuses := map[int64]string{}
	for _, terminal := range q.terminalSteps {
		statuses[terminal.StepID] = terminal.Status
	}
	return statuses
}
