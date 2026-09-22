package clusterservices

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"

	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type RunnerEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

type RunnerRegisterInput struct {
	Name     string          `json:"name"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

type RunnerAssignedTask struct {
	ID             int64           `json:"id"`
	WorkflowRunID  int64           `json:"workflow_run_id"`
	RepositoryID   int64           `json:"repository_id"`
	WorkflowStepID int64           `json:"workflow_step_id"`
	Attempt        int32           `json:"attempt"`
	Payload        json.RawMessage `json:"payload"`
}

type RunnerRegisterResult struct {
	RunnerID int64               `json:"runner_id"`
	Task     *RunnerAssignedTask `json:"task,omitempty"`
}

type RunnerStreamEventsInput struct {
	TaskID int64         `json:"task_id"`
	Events []RunnerEvent `json:"events"`
}

type RunnerCompleteTaskInput struct {
	TaskID   int64  `json:"task_id"`
	RunnerID int64  `json:"runner_id"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
}

type RunnerService interface {
	Register(ctx context.Context, input RunnerRegisterInput) (RunnerRegisterResult, error)
	ClaimTask(ctx context.Context, runnerID int64) (*RunnerAssignedTask, error)
	Heartbeat(ctx context.Context, runnerID int64) error
	Terminate(ctx context.Context, runnerID int64) error
	GetTaskRuntimeEnvironment(ctx context.Context, taskID int64) (map[string]string, error)
	StreamEvents(ctx context.Context, input RunnerStreamEventsInput) error
	CompleteTask(ctx context.Context, input RunnerCompleteTaskInput) error
}

type RunnerCommitStatusWriter interface {
	UpdateCommitStatusForWorkflowRun(ctx context.Context, workflowRunID int64, status string, description string, targetURL string) (db.CommitStatus, error)
}

type RunnerWorkflowDispatcher interface {
	DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
}

type RunnerQuerier interface {
	UpsertRunner(ctx context.Context, arg clusterdb.UpsertRunnerParams) (clusterdb.RunnerPool, error)
	TouchRunnerHeartbeat(ctx context.Context, id int64) (clusterdb.RunnerPool, error)
	ClaimIdleRunner(ctx context.Context, id int64) (clusterdb.RunnerPool, error)
	ClaimPendingTask(ctx context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error)
	MarkWorkflowTaskRunning(ctx context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error)
	MarkWorkflowTaskDone(ctx context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error)
	ReleaseRunner(ctx context.Context, id int64) (int64, error)
	TerminateRunner(ctx context.Context, id int64) (clusterdb.RunnerPool, error)
	RequeueTasksForRunner(ctx context.Context, runnerID pgtype.Int8) (int64, error)
	UpdateWorkflowRunStatusBasedOnTasks(ctx context.Context, workflowRunID int64) (string, error)
	GetWorkflowRunByRunID(ctx context.Context, runID int64) (db.WorkflowRun, error)
	GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
	GetWorkflowTaskForRunner(ctx context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error)
	GetWorkflowTaskRuntimeContext(ctx context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error)
	InsertWorkflowLog(ctx context.Context, arg db.InsertWorkflowLogParams) (db.WorkflowLog, error)
	InsertWorkflowLogNextSequence(ctx context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error)
	NotifyWorkflowLog(ctx context.Context, arg db.NotifyWorkflowLogParams) error
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	ListBlockedTasksForRun(ctx context.Context, workflowRunID int64) ([]db.ListBlockedTasksForRunRow, error)
	ListTaskStepInfoForRun(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error)
	UnblockWorkflowTask(ctx context.Context, id int64) error
	SkipBlockedWorkflowTask(ctx context.Context, id int64) error
	GetWorkflowTaskStepID(ctx context.Context, id int64) (int64, error)
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
	UpdateAgentSessionTerminalStatus(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error)
	NotifyAgentSession(ctx context.Context, arg db.NotifyAgentSessionParams) error
	GetWorkflowDefinitionNameByRunID(ctx context.Context, workflowRunID int64) (string, error)
	ListWorkflowLogsSince(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error)
}

type runnerTxStarter interface {
	BeginTx(ctx context.Context) (pgx.Tx, error)
}

type workflowLogInserter interface {
	InsertWorkflowLogNextSequence(ctx context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error)
}

// workflowRunLogNotifier publishes a log append on the run-level channel.
//
// WorkflowRunLogsStream enumerates one `workflow_step_logs_<id>` channel per
// step that exists when the client connects, and always LISTENs on
// `workflow_run_<id>`. A step created after that connect — agent dispatch, the
// sandbox scheduler — has no step channel on the wire, so a step notify alone
// leaves the client waiting for the durable repair poll. Publishing the same
// payload on the run channel too wakes every attached client immediately,
// matching what the sandbox scheduler already does for run-scoped logs.
type workflowRunLogNotifier interface {
	NotifyWorkflowRunLog(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error
}

type terminalRunnerTaskSettler interface {
	GetTerminalWorkflowTaskForRunner(ctx context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error)
	ClearTerminalWorkflowTaskRunnerOwnership(ctx context.Context, arg clusterdb.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error)
}

// atomicRunnerWorkflowTaskClaimer is implemented by the sqlc production
// store. Keeping it optional preserves the small RunnerQuerier test doubles
// while ensuring real runner claims cannot commit only part of the
// runner/task/step state transition.
type atomicRunnerWorkflowTaskClaimer interface {
	ClaimRunnerWorkflowTask(ctx context.Context, runnerID int64) (clusterdb.ClaimRunnerWorkflowTaskRow, error)
	GetRunnerStatus(ctx context.Context, runnerID int64) (string, error)
}

type runnerService struct {
	queries              RunnerQuerier
	requireTransactions  bool
	dispatcher           webhooks.Dispatcher
	commitStatusWriter   RunnerCommitStatusWriter
	checkRunService      services.GitHubCheckRunService
	installationResolver services.GitHubRepositoryInstallationResolver
	workflowDispatcher   RunnerWorkflowDispatcher
	metrics              services.WorkflowRunMetricsObserver
	secretInjector       *services.SecretInjector
}

const workflowLogInsertMaxAttempts = 5
const checkRunAnnotationLogPageSize = int32(500)
const maxCheckRunAnnotationsFromLogs = 300

// Issue #285: bound a single runner /stream request so one caller can't fan
// out unbounded log inserts/notifies (and unbounded advisory-lock hold time)
// from a single HTTP call.
const maxRunnerStreamEventsPerRequest = 1000
const maxRunnerStreamLogBytesPerRequest = 1 << 20 // 1 MiB of log text

var githubCommandAnnotationPattern = regexp.MustCompile(`^\s*::(error|warning|notice)\s*([^:]*)::(.*)$`)
var pathLineAnnotationPattern = regexp.MustCompile(`^\s*([^:\s][^:]*):(\d+)(?::(\d+))?:\s*(.+)$`)

type RunnerServiceOption func(*runnerService)

// WithRunnerTransactions requires atomic hosted task and runner transitions.
func WithRunnerTransactions() RunnerServiceOption {
	return func(s *runnerService) { s.requireTransactions = true }
}

func WithRunnerWebhookDispatcher(dispatcher webhooks.Dispatcher) RunnerServiceOption {
	return func(s *runnerService) {
		s.dispatcher = dispatcher
	}
}

func WithRunnerCommitStatusWriter(writer RunnerCommitStatusWriter) RunnerServiceOption {
	return func(s *runnerService) {
		s.commitStatusWriter = writer
	}
}

func WithRunnerGitHubCheckRunService(service services.GitHubCheckRunService) RunnerServiceOption {
	return func(s *runnerService) {
		s.checkRunService = service
	}
}

// WithRunnerGitHubInstallationResolver wires connection-scoped GitHub App
// installation resolution for check-run publishing.
func WithRunnerGitHubInstallationResolver(resolver services.GitHubRepositoryInstallationResolver) RunnerServiceOption {
	return func(s *runnerService) {
		s.installationResolver = resolver
	}
}

func WithRunnerWorkflowDispatcher(dispatcher RunnerWorkflowDispatcher) RunnerServiceOption {
	return func(s *runnerService) {
		s.workflowDispatcher = dispatcher
	}
}

func WithRunnerMetrics(metrics services.WorkflowRunMetricsObserver) RunnerServiceOption {
	return func(s *runnerService) {
		s.metrics = metrics
	}
}

func WithRunnerSecretInjector(injector *services.SecretInjector) RunnerServiceOption {
	return func(s *runnerService) {
		s.secretInjector = injector
	}
}

func NewRunnerService(queries RunnerQuerier, opts ...RunnerServiceOption) RunnerService {
	s := &runnerService{queries: queries}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

func (s *runnerService) Register(ctx context.Context, input RunnerRegisterInput) (RunnerRegisterResult, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return RunnerRegisterResult{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "Runner",
			Field:    "name",
			Code:     "missing_field",
		})
	}

	if s.queries == nil {
		return RunnerRegisterResult{}, pkgerrors.Internal("runner store unavailable")
	}

	runnerRow, err := s.queries.UpsertRunner(ctx, clusterdb.UpsertRunnerParams{
		Name:     name,
		Metadata: input.Metadata,
	})
	if err != nil {
		return RunnerRegisterResult{}, pkgerrors.Internal("failed to register runner")
	}

	return RunnerRegisterResult{RunnerID: runnerRow.ID, Task: nil}, nil
}

func (s *runnerService) ClaimTask(ctx context.Context, runnerID int64) (*RunnerAssignedTask, error) {
	if runnerID <= 0 {
		return nil, pkgerrors.BadRequest("runner id must be positive")
	}

	if s.queries == nil {
		return nil, pkgerrors.Internal("runner store unavailable")
	}

	if claimer, ok := s.queries.(atomicRunnerWorkflowTaskClaimer); ok {
		task, err := claimer.ClaimRunnerWorkflowTask(ctx, runnerID)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				status, statusErr := claimer.GetRunnerStatus(ctx, runnerID)
				if statusErr != nil {
					if stdErrors.Is(statusErr, pgx.ErrNoRows) {
						return nil, pkgerrors.Conflict("runner not available for claim")
					}
					return nil, pkgerrors.Internal("failed to inspect runner")
				}
				if status != "idle" {
					return nil, pkgerrors.Conflict("runner not available for claim")
				}
				return nil, nil
			}
			return nil, pkgerrors.Internal("failed to claim task")
		}
		return runnerAssignedAtomicTask(task), nil
	}

	if _, err := s.queries.ClaimIdleRunner(ctx, runnerID); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.Conflict("runner not available for claim")
		}
		return nil, pkgerrors.Internal("failed to claim runner")
	}

	task, err := s.queries.ClaimPendingTask(ctx, pgtype.Int8{Int64: runnerID, Valid: true})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			if _, releaseErr := s.queries.ReleaseRunner(ctx, runnerID); releaseErr != nil {
				return nil, pkgerrors.Internal("failed to release idle runner")
			}
			return nil, nil
		}
		_, _ = s.queries.ReleaseRunner(ctx, runnerID)
		return nil, pkgerrors.Internal("failed to claim task")
	}

	if err := s.markTaskRunning(ctx, task.ID, runnerID); err != nil {
		_, _ = s.queries.ReleaseRunner(ctx, runnerID)
		return nil, err
	}

	return runnerAssignedTask(task), nil
}

func runnerAssignedTask(task db.WorkflowTask) *RunnerAssignedTask {
	return &RunnerAssignedTask{
		ID:             task.ID,
		WorkflowRunID:  task.WorkflowRunID,
		RepositoryID:   task.RepositoryID,
		WorkflowStepID: task.WorkflowStepID,
		Attempt:        task.Attempt,
		Payload:        task.Payload,
	}
}

func runnerAssignedAtomicTask(task clusterdb.ClaimRunnerWorkflowTaskRow) *RunnerAssignedTask {
	return &RunnerAssignedTask{
		ID:             task.ID,
		WorkflowRunID:  task.WorkflowRunID,
		RepositoryID:   task.RepositoryID,
		WorkflowStepID: task.WorkflowStepID,
		Attempt:        task.Attempt,
		Payload:        task.Payload,
	}
}

func (s *runnerService) Heartbeat(ctx context.Context, runnerID int64) error {
	if runnerID <= 0 {
		return pkgerrors.BadRequest("runner id must be positive")
	}

	if s.queries == nil {
		return pkgerrors.Internal("runner store unavailable")
	}

	if _, err := s.queries.TouchRunnerHeartbeat(ctx, runnerID); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("runner not found")
		}
		return pkgerrors.Internal("failed to update runner heartbeat")
	}

	return nil
}

// Terminate marks a runner offline and requeues its assigned/running tasks.
// Issue #129: these two writes are performed atomically (same transaction,
// requeue before terminate) so a mid-operation failure can never strand
// tasks on a runner that looks terminated but never got its work requeued.
func (s *runnerService) Terminate(ctx context.Context, runnerID int64) error {
	if runnerID <= 0 {
		return pkgerrors.BadRequest("runner id must be positive")
	}

	if s.queries == nil {
		return pkgerrors.Internal("runner store unavailable")
	}

	if s.requireTransactions {
		if _, ok := s.queries.(interface {
			BeginTx(context.Context) (pgx.Tx, error)
			WithTx(pgx.Tx) *deploymentdb.Queries
		}); !ok {
			return pkgerrors.Internal("runner store requires transactions")
		}
	}
	if tx, txQueries, transactional, txErr := deploymentdb.BeginTx(ctx, s.queries); transactional {
		if txErr != nil {
			return pkgerrors.Internal("failed to begin runner termination transaction")
		}
		defer func() { _ = tx.Rollback(context.Background()) }()

		if _, err := txQueries.RequeueTasksForRunner(ctx, pgtype.Int8{Int64: runnerID, Valid: true}); err != nil {
			return pkgerrors.Internal("failed to requeue runner tasks")
		}
		if _, err := txQueries.TerminateRunner(ctx, runnerID); err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("runner not found")
			}
			return pkgerrors.Internal("failed to terminate runner")
		}
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit runner termination")
		}
		return nil
	}

	if _, err := s.queries.RequeueTasksForRunner(ctx, pgtype.Int8{Int64: runnerID, Valid: true}); err != nil {
		return pkgerrors.Internal("failed to requeue runner tasks")
	}
	if _, err := s.queries.TerminateRunner(ctx, runnerID); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("runner not found")
		}
		return pkgerrors.Internal("failed to terminate runner")
	}

	return nil
}

func (s *runnerService) GetTaskRuntimeEnvironment(ctx context.Context, taskID int64) (map[string]string, error) {
	if taskID <= 0 {
		return nil, pkgerrors.BadRequest("task id must be positive")
	}
	if s.queries == nil {
		return nil, pkgerrors.Internal("runner store unavailable")
	}
	if err := requireRunnerTaskCredential(ctx, taskID, 0); err != nil {
		return nil, err
	}

	var repositoryID int64
	var taskPayload []byte
	callbackToken := strings.TrimSpace(middleware.AgentTokenFromContext(ctx))
	if middleware.IsSharedAgentToken(ctx) {
		// The shared credential is held by the trusted runner process and is
		// needed before the child receives its runtime environment. Limit this
		// bootstrap path to an already-claimed/running task; pending, blocked,
		// completed, or arbitrary cross-run task IDs are rejected by the query.
		task, err := s.queries.GetWorkflowTaskForRunner(ctx, taskID)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil, pkgerrors.NotFound("task not found")
			}
			return nil, pkgerrors.Internal("failed to fetch task")
		}
		repositoryID = task.RepositoryID
		taskPayload = task.Payload
		if !task.RunnerID.Valid || task.RunnerID.Int64 <= 0 {
			return nil, pkgerrors.Conflict("task not assigned to a runner")
		}
		callbackToken, err = middleware.MintRunnerTaskToken(callbackToken, middleware.RunnerTaskTokenClaims{
			TaskID:        task.ID,
			WorkflowRunID: task.WorkflowRunID,
			RepositoryID:  task.RepositoryID,
			RunnerID:      task.RunnerID.Int64,
			Attempt:       task.Attempt,
			ExpiresAtUnix: time.Now().Add(middleware.RunnerTaskTokenTTL).Unix(),
		})
		if err != nil {
			return nil, pkgerrors.Internal("failed to issue runner task credential")
		}
	} else {
		// Workflow-run credentials remain strictly bound to their run. Do not
		// fall back to the shared-token lookup when the run-scoped query misses.
		run := middleware.WorkflowRunFromContext(ctx)
		if run == nil {
			return nil, pkgerrors.Unauthorized("invalid or missing agent token")
		}

		task, err := s.queries.GetWorkflowTaskRuntimeContext(ctx, db.GetWorkflowTaskRuntimeContextParams{
			TaskID:        taskID,
			WorkflowRunID: run.ID,
		})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil, pkgerrors.NotFound("task not found")
			}
			return nil, pkgerrors.Internal("failed to fetch task")
		}
		repositoryID = task.RepositoryID
		taskPayload = task.Payload
	}

	env := make(map[string]string)
	var secretNames []string
	var err error
	if s.secretInjector != nil {
		allowlist, restricted, parseErr := workflowTaskSecretAllowlist(taskPayload)
		if parseErr != nil {
			return nil, pkgerrors.Internal("invalid workflow task secret policy")
		}
		if !restricted || len(allowlist) > 0 {
			var secrets map[string]string
			env, secrets, err = s.secretInjector.RepositoryEnvironmentAndSecrets(ctx, repositoryID)
			if err != nil {
				return nil, pkgerrors.Internal("failed to resolve repository secrets")
			}
			if restricted {
				env = filterWorkflowTaskEnvironment(env, allowlist)
				secrets = filterWorkflowTaskEnvironment(secrets, allowlist)
			}
			for name := range secrets {
				secretNames = append(secretNames, name)
			}
		}
	}
	if callbackToken != "" {
		env["SMITHERS_AGENT_TOKEN"] = callbackToken
		secretNames = append(secretNames, "SMITHERS_AGENT_TOKEN")
	}

	// SMITHERS_SECRET_ENV_KEYS tells execute-step.ts which env values are
	// secrets (as opposed to plain variables), so the runner redacts them from
	// mirrored step output before it reaches pod stdout/stderr and cluster
	// logging. API-side redaction (StreamEvents) only covers stored/served
	// logs, not what the pod itself prints. Set last so a repo secret or
	// variable with the same name cannot override the marker.
	if len(secretNames) > 0 {
		sort.Strings(secretNames)
		env[services.SecretEnvKeysRuntimeMarker] = strings.Join(secretNames, ",")
	}

	return env, nil
}

func workflowTaskSecretAllowlist(payload []byte) (map[string]struct{}, bool, error) {
	var envelope struct {
		SecretNames *[]string `json:"secret_names"`
	}
	if len(payload) == 0 {
		return nil, false, nil
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, false, err
	}
	if envelope.SecretNames == nil {
		return nil, false, nil
	}
	if len(*envelope.SecretNames) > services.MaxInjectedEnvEntries {
		return nil, true, fmt.Errorf("too many secret names")
	}
	allowed := make(map[string]struct{}, len(*envelope.SecretNames))
	for _, rawName := range *envelope.SecretNames {
		name := strings.TrimSpace(rawName)
		if name == "" || name != rawName || !services.IsInjectedSecretName(name) {
			return nil, true, fmt.Errorf("invalid secret name %q", rawName)
		}
		if _, exists := allowed[name]; exists {
			return nil, true, fmt.Errorf("duplicate secret name %q", name)
		}
		allowed[name] = struct{}{}
	}
	return allowed, true, nil
}

func filterWorkflowTaskEnvironment(env map[string]string, allowed map[string]struct{}) map[string]string {
	filtered := make(map[string]string, len(allowed))
	for name := range allowed {
		if value, ok := env[name]; ok {
			filtered[name] = value
		}
	}
	return filtered
}

type parsedRunnerLogEvent struct {
	stream string
	text   string
}

func (s *runnerService) StreamEvents(ctx context.Context, input RunnerStreamEventsInput) error {
	if input.TaskID <= 0 {
		return pkgerrors.BadRequest("task id must be positive")
	}

	if s.queries == nil {
		return pkgerrors.Internal("runner store unavailable")
	}
	if err := requireRunnerTaskCredential(ctx, input.TaskID, 0); err != nil {
		return err
	}

	// Issue #285: reject over-budget batches before doing any DB/secrets work
	// so a single oversized request can't fan out into unbounded log inserts.
	if len(input.Events) > maxRunnerStreamEventsPerRequest {
		return pkgerrors.RequestEntityTooLarge("too many events in stream request")
	}

	task, err := s.queries.GetWorkflowTaskForRunner(ctx, input.TaskID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("task not found")
		}
		return pkgerrors.Internal("failed to fetch task")
	}

	// Enforce callback token scope: the task must belong to the workflow run
	// bound to the agent token. This prevents a runner authenticated for run A
	// from streaming log events into a task owned by run B.
	if run := middleware.WorkflowRunFromContext(ctx); run != nil {
		if task.WorkflowRunID != run.ID {
			return pkgerrors.Forbidden("task does not belong to the authorized workflow run")
		}
	}

	// Parse and size-check the log events before resolving repository secrets
	// for redaction — an oversized/garbage batch is rejected without the extra
	// secrets-fetch round trip.
	logEvents := make([]parsedRunnerLogEvent, 0, len(input.Events))
	var totalBytes int
	for _, event := range input.Events {
		if event.Type != "log" {
			continue
		}

		var logData struct {
			Stream string `json:"stream"`
			Text   string `json:"text"`
		}
		if err := json.Unmarshal(event.Data, &logData); err != nil {
			return pkgerrors.BadRequest("invalid log event data")
		}
		totalBytes += len(logData.Text)
		if totalBytes > maxRunnerStreamLogBytesPerRequest {
			return pkgerrors.RequestEntityTooLarge("log payload too large")
		}
		logEvents = append(logEvents, parsedRunnerLogEvent{stream: logData.Stream, text: logData.Text})
	}

	if len(logEvents) == 0 {
		return nil
	}

	// Use only secrets (not variables) for redaction — variables are plain text
	// and must not be masked in log output.
	redactionEnv := make(map[string]string)
	if s.secretInjector != nil {
		redactionEnv, err = s.secretInjector.RepositorySecrets(ctx, task.RepositoryID)
		if err != nil {
			return pkgerrors.Internal("failed to resolve repository secrets")
		}
	}
	if token := strings.TrimSpace(middleware.AgentTokenFromContext(ctx)); token != "" {
		redactionEnv["SMITHERS_AGENT_TOKEN"] = token
	}

	for i := range logEvents {
		logEvents[i].text = services.RedactSecretValues(redactionEnv, logEvents[i].text)
	}

	if starter, ok := s.queries.(runnerTxStarter); ok {
		return s.streamLogEventsWithTx(ctx, starter, task, logEvents)
	}

	payloads := make([]string, 0, len(logEvents))
	for _, logEvent := range logEvents {
		inserted, insertErr := insertWorkflowLog(ctx, s.queries, task.WorkflowRunID, task.WorkflowStepID, logEvent)
		if insertErr != nil {
			return insertErr
		}
		payloads = append(payloads, marshalWorkflowLogPayload(inserted))
	}
	return s.notifyWorkflowLogPayloads(ctx, task, payloads)
}

// notifyWorkflowLogPayloads wakes every attached log stream for one committed
// batch of appends, in insertion order, on both the step channel and the
// run channel.
func (s *runnerService) notifyWorkflowLogPayloads(
	ctx context.Context,
	task db.GetWorkflowTaskForRunnerRow,
	payloads []string,
) error {
	runNotifier, hasRunNotifier := s.queries.(workflowRunLogNotifier)
	for _, payload := range payloads {
		if err := s.queries.NotifyWorkflowLog(ctx, db.NotifyWorkflowLogParams{
			StepID:  task.WorkflowStepID,
			Payload: payload,
		}); err != nil {
			return pkgerrors.Internal("failed to notify log")
		}
		if !hasRunNotifier {
			continue
		}
		if err := runNotifier.NotifyWorkflowRunLog(ctx, db.NotifyWorkflowRunLogParams{
			RunID:   task.WorkflowRunID,
			Payload: payload,
		}); err != nil {
			return pkgerrors.Internal("failed to notify log")
		}
	}

	return nil
}

func (s *runnerService) streamLogEventsWithTx(
	ctx context.Context,
	starter runnerTxStarter,
	task db.GetWorkflowTaskForRunnerRow,
	logEvents []parsedRunnerLogEvent,
) error {
	tx, err := starter.BeginTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin log stream transaction")
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	// All step and run log writers take the run row lock before allocating
	// an ID (and before their sequence lock). IDs need not be contiguous,
	// but a committed ID must never overtake an uncommitted ID in this run.
	if _, err := tx.Exec(ctx, `SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE`, task.WorkflowRunID); err != nil {
		return pkgerrors.Internal("failed to lock workflow run log stream")
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, task.WorkflowStepID); err != nil {
		return pkgerrors.Internal("failed to lock workflow log stream")
	}

	txQueries := deploymentdb.New(tx)
	payloads := make([]string, 0, len(logEvents))
	for _, logEvent := range logEvents {
		inserted, insertErr := insertWorkflowLog(ctx, txQueries, task.WorkflowRunID, task.WorkflowStepID, logEvent)
		if insertErr != nil {
			return insertErr
		}
		payloads = append(payloads, marshalWorkflowLogPayload(inserted))
	}

	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit log stream transaction")
	}
	return s.notifyWorkflowLogPayloads(ctx, task, payloads)
}

func insertWorkflowLog(
	ctx context.Context,
	inserter workflowLogInserter,
	workflowRunID, workflowStepID int64,
	logEvent parsedRunnerLogEvent,
) (db.InsertWorkflowLogNextSequenceRow, error) {
	var inserted db.InsertWorkflowLogNextSequenceRow
	var err error
	for attempt := 0; attempt < workflowLogInsertMaxAttempts; attempt++ {
		inserted, err = inserter.InsertWorkflowLogNextSequence(ctx, db.InsertWorkflowLogNextSequenceParams{
			WorkflowRunID:  workflowRunID,
			WorkflowStepID: workflowStepID,
			Stream:         logEvent.stream,
			Entry:          logEvent.text,
		})
		if err == nil {
			return inserted, nil
		}
		if isWorkflowLogBudgetExceeded(err) {
			return db.InsertWorkflowLogNextSequenceRow{}, pkgerrors.RequestEntityTooLarge("workflow log storage limit reached")
		}
		if !isWorkflowLogSequenceConflict(err) {
			return db.InsertWorkflowLogNextSequenceRow{}, pkgerrors.Internal("failed to insert log")
		}
	}
	return db.InsertWorkflowLogNextSequenceRow{}, pkgerrors.Internal("failed to insert log")
}

func isWorkflowLogBudgetExceeded(err error) bool {
	var pgErr *pgconn.PgError
	return stdErrors.As(err, &pgErr) &&
		pgErr.Code == "54000" &&
		pgErr.ConstraintName == "workflow_run_log_budget"
}

func marshalWorkflowLogPayload(inserted db.InsertWorkflowLogNextSequenceRow) string {
	payload, _ := json.Marshal(map[string]any{
		"log_id":           inserted.ID,
		"workflow_step_id": inserted.WorkflowStepID,
		"sequence":         inserted.Sequence,
		"stream":           inserted.Stream,
		"entry":            inserted.Entry,
	})
	return string(payload)
}

func isWorkflowLogSequenceConflict(err error) bool {
	var pgErr *pgconn.PgError
	if !stdErrors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23505"
}

func (s *runnerService) markTaskRunning(ctx context.Context, taskID, runnerID int64) error {
	rows, err := s.queries.MarkWorkflowTaskRunning(ctx, db.MarkWorkflowTaskRunningParams{
		ID:       taskID,
		RunnerID: pgtype.Int8{Int64: runnerID, Valid: true},
	})
	if err != nil {
		return pkgerrors.Internal("failed to mark task running")
	}
	if rows == 0 {
		return pkgerrors.Conflict("task not assigned to this runner")
	}

	stepID, err := s.queries.GetWorkflowTaskStepID(ctx, taskID)
	if err != nil {
		return pkgerrors.Internal("failed to load task step")
	}
	if _, err := s.queries.UpdateWorkflowStepStatusRunning(ctx, stepID); err != nil {
		return pkgerrors.Internal("failed to update workflow step")
	}

	return nil
}

func (s *runnerService) CompleteTask(ctx context.Context, input RunnerCompleteTaskInput) error {
	if input.TaskID <= 0 {
		return pkgerrors.BadRequest("task id must be positive")
	}
	if input.RunnerID <= 0 {
		return pkgerrors.BadRequest("runner id must be positive")
	}

	status := strings.ToLower(strings.TrimSpace(input.Status))
	switch status {
	case "done", "failed", "cancelled":
	default:
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "Task",
			Field:    "status",
			Code:     "invalid",
		})
	}

	if s.queries == nil {
		return pkgerrors.Internal("runner store unavailable")
	}
	// Only the trusted runner control process may settle a task. Workflow code
	// receives a task-scoped token for logs, artifacts, and other narrowly
	// authorized callbacks, but that child can read its own parent environment
	// through /proc. Allowing either a task token or the legacy run token here
	// would let untrusted code forge success and unblock downstream jobs before
	// the child exits and the runner finishes its process/filesystem quarantine.
	if _, taskScoped := middleware.RunnerTaskTokenFromContext(ctx); taskScoped {
		return pkgerrors.Forbidden("task-scoped credentials cannot complete tasks")
	}
	if middleware.WorkflowRunFromContext(ctx) != nil && !middleware.IsSharedAgentToken(ctx) {
		return pkgerrors.Forbidden("workflow credentials cannot complete tasks")
	}
	if err := requireRunnerTaskCredential(ctx, input.TaskID, input.RunnerID); err != nil {
		return err
	}
	releaseRunnerLease := true

	// Enforce callback token scope: verify the task belongs to the workflow run
	// bound to the agent token before marking it done. This prevents a runner
	// authenticated for run A from completing a task owned by run B.
	if run := middleware.WorkflowRunFromContext(ctx); run != nil {
		task, err := s.queries.GetWorkflowTaskForRunner(ctx, input.TaskID)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				workflowRunID, terminalErr := getTerminalRunnerTaskRunID(ctx, s.queries, input)
				if stdErrors.Is(terminalErr, pgx.ErrNoRows) {
					return pkgerrors.Conflict("task not running or not assigned to this runner")
				}
				if terminalErr != nil {
					return pkgerrors.Internal("failed to fetch task")
				}
				if workflowRunID != run.ID {
					return pkgerrors.Forbidden("task does not belong to the authorized workflow run")
				}
			} else {
				return pkgerrors.Internal("failed to fetch task")
			}
		} else if task.WorkflowRunID != run.ID {
			return pkgerrors.Forbidden("task does not belong to the authorized workflow run")
		}
	}

	if s.requireTransactions {
		if _, ok := s.queries.(interface {
			BeginTx(context.Context) (pgx.Tx, error)
			WithTx(pgx.Tx) *deploymentdb.Queries
		}); !ok {
			return pkgerrors.Internal("runner store requires transactions")
		}
	}
	if tx, txQueries, transactional, txErr := deploymentdb.BeginTx(ctx, s.queries); transactional {
		if txErr != nil {
			return pkgerrors.Internal("failed to begin task completion transaction")
		}
		return s.completeTaskWithTransaction(ctx, tx, txQueries, input, status, releaseRunnerLease)
	}

	workflowRunID, err := s.queries.MarkWorkflowTaskDone(ctx, db.MarkWorkflowTaskDoneParams{
		ID:       input.TaskID,
		RunnerID: pgtype.Int8{Int64: input.RunnerID, Valid: true},
		Status:   status,
		LastError: pgtype.Text{
			String: input.Error,
			Valid:  input.Error != "",
		},
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return acknowledgeTerminalRunnerTask(ctx, s.queries, input, releaseRunnerLease)
		}
		return pkgerrors.Internal("failed to complete task")
	}
	finalizeTaskStep(ctx, s.queries, workflowRunID, input.TaskID, status)
	if releaseRunnerLease {
		if err := clearTerminalRunnerOwnershipAndRelease(ctx, s.queries, input); err != nil {
			return err
		}
	}

	run, runErr := s.queries.GetWorkflowRunByRunID(ctx, workflowRunID)
	if runErr != nil && !stdErrors.Is(runErr, pgx.ErrNoRows) {
		middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
			Warn("failed to load workflow run before terminal metric update", "error", runErr)
	}
	// Progress downstream dependency-blocked tasks.
	if err := s.progressDependencies(ctx, workflowRunID); err != nil {
		return pkgerrors.Internal("failed to progress dependencies")
	}

	// Update aggregate run status based on all tasks for this run.
	runStatus, err := s.queries.UpdateWorkflowRunStatusBasedOnTasks(ctx, workflowRunID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// Run was deleted; ignore.
			return nil
		}
		return pkgerrors.Internal("failed to update workflow run status")
	}
	if runErr == nil {
		services.ObserveWorkflowRunCompletion(s.metrics, run, runStatus)
	}
	if services.IsTerminalWorkflowRunStatus(runStatus) {
		s.transitionAgentSessionForTerminalWorkflowRun(ctx, workflowRunID, runStatus)
		repoID := int64(0)
		if runErr == nil {
			repoID = run.RepositoryID
		}
		services.RevokeWorkflowRunCredentials(ctx, s.queries, workflowRunID, repoID)
	}
	if s.commitStatusWriter != nil && services.IsTerminalWorkflowRunStatus(runStatus) {
		if _, err := s.commitStatusWriter.UpdateCommitStatusForWorkflowRun(ctx, workflowRunID, runStatus, services.WorkflowRunStatusDescription(runStatus), ""); err != nil {
			middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
				Error("failed to update commit status for workflow run", "status", runStatus, "error", err)
		}
	}
	if runErr == nil && s.checkRunService != nil && services.IsTerminalWorkflowRunStatus(runStatus) {
		if err := s.updateGitHubCheckRunForCompletion(ctx, run, runStatus); err != nil {
			middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
				Warn("failed to update github check run for workflow completion", "status", runStatus, "error", err)
		}
	}
	services.NotifyWorkflowRunEvent(ctx, s.queries, workflowRunID, "runner.complete_task")
	_ = s.dispatchWorkflowRunEvent(ctx, workflowRunID, runStatus)
	if runErr == nil {
		if err := s.dispatchTriggeredWorkflowRuns(ctx, run, runStatus); err != nil {
			middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
				Error("failed to dispatch downstream workflow_run triggers", "status", runStatus, "error", err)
		}
	}

	return nil
}

func requireRunnerTaskCredential(ctx context.Context, taskID, runnerID int64) error {
	claims, ok := middleware.RunnerTaskTokenFromContext(ctx)
	if !ok {
		return nil
	}
	if claims.TaskID != taskID {
		return pkgerrors.NotFound("task not found")
	}
	if runnerID > 0 && claims.RunnerID != runnerID {
		return pkgerrors.Forbidden("task does not belong to the authorized runner")
	}
	return nil
}

func terminalRunnerTaskParams(input RunnerCompleteTaskInput) db.GetTerminalWorkflowTaskForRunnerParams {
	return db.GetTerminalWorkflowTaskForRunnerParams{
		TaskID:   input.TaskID,
		RunnerID: pgtype.Int8{Int64: input.RunnerID, Valid: true},
	}
}

func getTerminalRunnerTaskRunID(ctx context.Context, queries any, input RunnerCompleteTaskInput) (int64, error) {
	settler, ok := queries.(terminalRunnerTaskSettler)
	if !ok {
		return 0, pgx.ErrNoRows
	}
	return settler.GetTerminalWorkflowTaskForRunner(ctx, terminalRunnerTaskParams(input))
}

func clearTerminalRunnerOwnershipAndRelease(ctx context.Context, queries RunnerQuerier, input RunnerCompleteTaskInput) error {
	settler, ok := queries.(terminalRunnerTaskSettler)
	if !ok {
		return pkgerrors.Internal("runner task settlement unavailable")
	}
	cleared, err := settler.ClearTerminalWorkflowTaskRunnerOwnership(ctx, clusterdb.ClearTerminalWorkflowTaskRunnerOwnershipParams{
		TaskID:   input.TaskID,
		RunnerID: pgtype.Int8{Int64: input.RunnerID, Valid: true},
	})
	if err != nil {
		return pkgerrors.Internal("failed to settle runner task ownership")
	}
	if cleared == 0 {
		return pkgerrors.Conflict("task not running or not assigned to this runner")
	}
	if _, err := queries.ReleaseRunner(ctx, input.RunnerID); err != nil {
		return pkgerrors.Internal("failed to release runner")
	}
	return nil
}

func acknowledgeTerminalRunnerTask(ctx context.Context, queries RunnerQuerier, input RunnerCompleteTaskInput, releaseRunnerLease bool) error {
	if _, err := getTerminalRunnerTaskRunID(ctx, queries, input); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Conflict("task not running or not assigned to this runner")
		}
		return pkgerrors.Internal("failed to fetch task")
	}
	if !releaseRunnerLease {
		return nil
	}
	return clearTerminalRunnerOwnershipAndRelease(ctx, queries, input)
}

func (s *runnerService) completeTaskWithTransaction(
	ctx context.Context,
	tx pgx.Tx,
	queries *deploymentdb.Queries,
	input RunnerCompleteTaskInput,
	status string,
	releaseRunnerLease bool,
) error {
	defer func() { _ = tx.Rollback(context.Background()) }()

	task, err := queries.GetWorkflowTaskForRunner(ctx, input.TaskID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return acknowledgeTerminalRunnerTaskWithTransaction(ctx, tx, queries, input, releaseRunnerLease)
		}
		return pkgerrors.Internal("failed to fetch task")
	}
	if task.RunnerID.Valid && task.RunnerID.Int64 != input.RunnerID {
		return pkgerrors.Conflict("task not running or not assigned to this runner")
	}
	if err := services.LockWorkflowRun(ctx, tx, task.WorkflowRunID); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Conflict("workflow run not found")
		}
		return pkgerrors.Internal("failed to lock workflow run")
	}

	workflowRunID, err := queries.MarkWorkflowTaskDone(ctx, db.MarkWorkflowTaskDoneParams{
		ID:       input.TaskID,
		RunnerID: pgtype.Int8{Int64: input.RunnerID, Valid: true},
		Status:   status,
		LastError: pgtype.Text{
			String: input.Error,
			Valid:  input.Error != "",
		},
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return acknowledgeTerminalRunnerTaskWithTransaction(ctx, tx, queries, input, releaseRunnerLease)
		}
		return pkgerrors.Internal("failed to complete task")
	}
	finalizeTaskStep(ctx, queries, workflowRunID, input.TaskID, status)
	if releaseRunnerLease {
		if err := clearTerminalRunnerOwnershipAndRelease(ctx, queries, input); err != nil {
			return err
		}
	}
	if err := s.progressDependenciesWith(ctx, queries, workflowRunID); err != nil {
		return pkgerrors.Internal("failed to progress dependencies")
	}

	run, err := queries.GetWorkflowRunByRunID(ctx, workflowRunID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Internal("workflow run not found")
		}
		return pkgerrors.Internal("failed to load workflow run")
	}
	if services.IsTerminalWorkflowRunStatus(run.Status) {
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit task completion transaction")
		}
		return nil
	}

	runStatus, err := queries.UpdateWorkflowRunStatusBasedOnTasks(ctx, workflowRunID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return pkgerrors.Internal("failed to commit task completion transaction")
			}
			return nil
		}
		return pkgerrors.Internal("failed to update workflow run status")
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit task completion transaction")
	}

	if services.IsTerminalWorkflowRunStatus(runStatus) {
		services.ObserveWorkflowRunCompletion(s.metrics, run, runStatus)
		s.transitionAgentSessionForTerminalWorkflowRun(ctx, workflowRunID, runStatus)
		services.RevokeWorkflowRunCredentials(ctx, s.queries, workflowRunID, run.RepositoryID)
		if s.commitStatusWriter != nil {
			if _, err := s.commitStatusWriter.UpdateCommitStatusForWorkflowRun(ctx, workflowRunID, runStatus, services.WorkflowRunStatusDescription(runStatus), ""); err != nil {
				middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
					Error("failed to update commit status for workflow run", "status", runStatus, "error", err)
			}
		}
		if s.checkRunService != nil {
			if err := s.updateGitHubCheckRunForCompletion(ctx, run, runStatus); err != nil {
				middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
					Warn("failed to update github check run for workflow completion", "status", runStatus, "error", err)
			}
		}
	}
	services.NotifyWorkflowRunEvent(ctx, s.queries, workflowRunID, "runner.complete_task")
	_ = s.dispatchWorkflowRunEvent(ctx, workflowRunID, runStatus)
	if err := s.dispatchTriggeredWorkflowRuns(ctx, run, runStatus); err != nil {
		middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
			Error("failed to dispatch downstream workflow_run triggers", "status", runStatus, "error", err)
	}
	return nil
}

func acknowledgeTerminalRunnerTaskWithTransaction(
	ctx context.Context,
	tx pgx.Tx,
	queries *deploymentdb.Queries,
	input RunnerCompleteTaskInput,
	releaseRunnerLease bool,
) error {
	workflowRunID, err := queries.GetTerminalWorkflowTaskForRunner(ctx, terminalRunnerTaskParams(input))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Conflict("task not running or not assigned to this runner")
		}
		return pkgerrors.Internal("failed to fetch task")
	}
	if err := services.LockWorkflowRun(ctx, tx, workflowRunID); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Conflict("workflow run not found")
		}
		return pkgerrors.Internal("failed to lock workflow run")
	}

	// Revalidate after taking the workflow-run lock. Resume takes the same lock,
	// so it cannot requeue a terminal task between our lookup and lease release.
	revalidatedRunID, err := queries.GetTerminalWorkflowTaskForRunner(ctx, terminalRunnerTaskParams(input))
	if err != nil || revalidatedRunID != workflowRunID {
		if err == nil || stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Conflict("task not running or not assigned to this runner")
		}
		return pkgerrors.Internal("failed to fetch task")
	}
	if releaseRunnerLease {
		if err := clearTerminalRunnerOwnershipAndRelease(ctx, queries, input); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit task completion transaction")
	}
	return nil
}

type runnerAgentTaskPayload struct {
	Kind      string `json:"kind"`
	SessionID string `json:"session_id"`
}

func (s *runnerService) transitionAgentSessionForTerminalWorkflowRun(ctx context.Context, workflowRunID int64, runStatus string) {
	if s == nil || s.queries == nil {
		return
	}

	task, err := s.queries.GetWorkflowTaskByRunID(ctx, workflowRunID)
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
				Warn("failed to load workflow task for agent session terminal transition", "error", err)
		}
		return
	}

	var payload runnerAgentTaskPayload
	if err := json.Unmarshal(task.Payload, &payload); err != nil {
		return
	}
	if strings.TrimSpace(payload.Kind) != "agent" || strings.TrimSpace(payload.SessionID) == "" {
		return
	}

	sessionStatus := agentSessionStatusForWorkflowRunStatus(runStatus)
	session, err := s.queries.UpdateAgentSessionTerminalStatus(ctx, db.UpdateAgentSessionTerminalStatusParams{
		ID:         payload.SessionID,
		Status:     sessionStatus,
		FinishedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, payload.SessionID, workflowRunID).
				Warn("failed to transition agent session after workflow terminal status", "status", sessionStatus, "error", err)
		}
		return
	}

	eventPayload, _ := json.Marshal(services.AgentSessionEvent{
		SessionID: session.ID,
		Action:    "status",
		Status:    session.Status,
	})
	_ = s.queries.NotifyAgentSession(ctx, db.NotifyAgentSessionParams{
		SessionID: strings.ReplaceAll(session.ID, "-", ""),
		Payload:   string(eventPayload),
	})
}

func agentSessionStatusForWorkflowRunStatus(runStatus string) string {
	switch runStatus {
	case "success":
		return "completed"
	case "cancelled":
		return "cancelled"
	default:
		return "failed"
	}
}

type runnerRepoOwnerResolver interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
}

func (s *runnerService) updateGitHubCheckRunForCompletion(ctx context.Context, run db.WorkflowRun, runStatus string) error {
	if s.checkRunService == nil {
		return nil
	}
	if !run.CheckRunID.Valid || run.CheckRunID.Int64 <= 0 {
		return nil
	}

	repoOwnerResolver, ok := s.queries.(runnerRepoOwnerResolver)
	if !ok {
		return nil
	}
	if s.installationResolver == nil {
		return nil
	}

	repository, err := repoOwnerResolver.GetRepoByID(ctx, run.RepositoryID)
	if err != nil {
		return nil
	}
	owner := resolveRepositoryOwnerForChecks(ctx, repository, repoOwnerResolver)
	repoName := strings.TrimSpace(repository.Name)
	if owner == "" || repoName == "" {
		return nil
	}

	installationID, err := s.installationResolver.GetGitHubInstallationIDForRepositoryOwner(
		ctx,
		repository.UserID.Int64,
		repository.OrgID.Int64,
		owner,
		repoName,
	)
	if err != nil || installationID <= 0 {
		return nil
	}

	checkConclusion := workflowRunStatusToCheckRunConclusion(runStatus)
	output := &services.GitHubCheckRunOutput{
		Title:   "Workflow completed",
		Summary: fmt.Sprintf("Workflow run #%d completed with status `%s`.", run.ID, runStatus),
	}
	annotations, annotationErr := s.collectCheckRunAnnotationsFromLogs(ctx, run.ID)
	if annotationErr != nil {
		middleware.LoggerWithWorkflowRun(ctx, run.ID).
			Warn("failed to load workflow log annotations for github check run", "error", annotationErr)
	} else if len(annotations) > 0 {
		output.Annotations = annotations
		output.Summary = fmt.Sprintf(
			"Workflow run #%d completed with status `%s`.\n\nDetected %d inline annotation(s) from workflow logs.",
			run.ID,
			runStatus,
			len(annotations),
		)
	}

	_, err = s.checkRunService.UpdateCheckRun(ctx, installationID, owner, repoName, run.CheckRunID.Int64, services.GitHubCheckRunUpdate{
		Status:     "completed",
		Conclusion: checkConclusion,
		Output:     output,
	})
	return err
}

func (s *runnerService) collectCheckRunAnnotationsFromLogs(ctx context.Context, runID int64) ([]services.GitHubCheckRunAnnotation, error) {
	afterID := int64(0)
	annotations := make([]services.GitHubCheckRunAnnotation, 0, 16)
	seen := make(map[string]struct{})

	for len(annotations) < maxCheckRunAnnotationsFromLogs {
		logs, err := s.queries.ListWorkflowLogsSince(ctx, db.ListWorkflowLogsSinceParams{
			RunID:    runID,
			AfterID:  afterID,
			PageSize: checkRunAnnotationLogPageSize,
		})
		if err != nil {
			return nil, err
		}
		if len(logs) == 0 {
			break
		}

		for _, logRow := range logs {
			afterID = logRow.ID
			lineAnnotations := parseCheckRunAnnotationsFromLogEntry(logRow.Entry)
			for _, annotation := range lineAnnotations {
				key := checkRunAnnotationKey(annotation)
				if _, exists := seen[key]; exists {
					continue
				}
				seen[key] = struct{}{}
				annotations = append(annotations, annotation)
				if len(annotations) >= maxCheckRunAnnotationsFromLogs {
					return annotations, nil
				}
			}
		}

		if len(logs) < int(checkRunAnnotationLogPageSize) {
			break
		}
	}

	return annotations, nil
}

func parseCheckRunAnnotationsFromLogEntry(entry string) []services.GitHubCheckRunAnnotation {
	normalized := strings.ReplaceAll(entry, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	annotations := make([]services.GitHubCheckRunAnnotation, 0, len(lines))
	for _, line := range lines {
		annotation, ok := parseCheckRunAnnotationLine(line)
		if !ok {
			continue
		}
		annotations = append(annotations, annotation)
	}
	return annotations
}

func parseCheckRunAnnotationLine(line string) (services.GitHubCheckRunAnnotation, bool) {
	if annotation, ok := parseGitHubCommandAnnotation(line); ok {
		return annotation, true
	}
	return parsePathLineAnnotation(line)
}

func parseGitHubCommandAnnotation(line string) (services.GitHubCheckRunAnnotation, bool) {
	matches := githubCommandAnnotationPattern.FindStringSubmatch(line)
	if len(matches) != 4 {
		return services.GitHubCheckRunAnnotation{}, false
	}

	level := normalizeCheckRunAnnotationLevel(matches[1])

	params := parseGitHubCommandAnnotationParams(matches[2])
	path := normalizeCheckRunAnnotationPath(params["file"])
	if path == "" {
		return services.GitHubCheckRunAnnotation{}, false
	}

	startLine := parsePositiveInt(params["line"], 1)
	endLine := parsePositiveInt(params["endline"], startLine)
	if endLine < startLine {
		endLine = startLine
	}

	message := strings.TrimSpace(unescapeGitHubCommandValue(matches[3]))
	if message == "" {
		return services.GitHubCheckRunAnnotation{}, false
	}

	return services.GitHubCheckRunAnnotation{
		Path:            path,
		StartLine:       startLine,
		EndLine:         endLine,
		AnnotationLevel: level,
		Message:         message,
	}, true
}

func parsePathLineAnnotation(line string) (services.GitHubCheckRunAnnotation, bool) {
	matches := pathLineAnnotationPattern.FindStringSubmatch(line)
	if len(matches) != 5 {
		return services.GitHubCheckRunAnnotation{}, false
	}

	path := normalizeCheckRunAnnotationPath(matches[1])
	if path == "" {
		return services.GitHubCheckRunAnnotation{}, false
	}

	startLine := parsePositiveInt(matches[2], 0)
	if startLine <= 0 {
		return services.GitHubCheckRunAnnotation{}, false
	}

	endLine := startLine
	if strings.TrimSpace(matches[3]) != "" {
		parsedEndLine := parsePositiveInt(matches[3], startLine)
		if parsedEndLine >= startLine {
			endLine = parsedEndLine
		}
	}

	level, message := splitAnnotationLevelAndMessage(matches[4])
	if level == "" || strings.TrimSpace(message) == "" {
		return services.GitHubCheckRunAnnotation{}, false
	}

	return services.GitHubCheckRunAnnotation{
		Path:            path,
		StartLine:       startLine,
		EndLine:         endLine,
		AnnotationLevel: level,
		Message:         strings.TrimSpace(message),
	}, true
}

func parseGitHubCommandAnnotationParams(raw string) map[string]string {
	params := make(map[string]string)
	for _, token := range strings.Split(strings.TrimSpace(raw), ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		pair := strings.SplitN(token, "=", 2)
		if len(pair) != 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(pair[0]))
		if key == "" {
			continue
		}
		params[key] = unescapeGitHubCommandValue(strings.TrimSpace(pair[1]))
	}
	return params
}

func unescapeGitHubCommandValue(value string) string {
	replacer := strings.NewReplacer(
		"%0D", "\r",
		"%0A", "\n",
		"%2C", ",",
		"%3A", ":",
		"%25", "%",
	)
	return replacer.Replace(value)
}

func normalizeCheckRunAnnotationPath(rawPath string) string {
	path := strings.TrimSpace(rawPath)
	path = strings.Trim(path, `"'`)
	if path == "" {
		return ""
	}
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimPrefix(path, "./")
	if idx := strings.Index(path, "/workspace/"); idx >= 0 {
		path = path[idx+len("/workspace/"):]
	}
	path = strings.TrimPrefix(path, "/")
	path = strings.TrimSpace(path)
	if path == "" || strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return ""
	}
	return path
}

func parsePositiveInt(raw string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func normalizeCheckRunAnnotationLevel(rawLevel string) string {
	switch strings.ToLower(strings.TrimSpace(rawLevel)) {
	case "failure", "error":
		return "failure"
	case "warning", "warn":
		return "warning"
	case "notice", "info", "information":
		return "notice"
	default:
		return ""
	}
}

func splitAnnotationLevelAndMessage(raw string) (string, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}

	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "error:"):
		return "failure", strings.TrimSpace(trimmed[len("error:"):])
	case strings.HasPrefix(lower, "warning:"):
		return "warning", strings.TrimSpace(trimmed[len("warning:"):])
	case strings.HasPrefix(lower, "notice:"):
		return "notice", strings.TrimSpace(trimmed[len("notice:"):])
	}

	switch {
	case strings.Contains(lower, "error"), strings.Contains(lower, "failed"):
		return "failure", trimmed
	case strings.Contains(lower, "warn"):
		return "warning", trimmed
	default:
		return "notice", trimmed
	}
}

func checkRunAnnotationKey(annotation services.GitHubCheckRunAnnotation) string {
	return fmt.Sprintf(
		"%s|%d|%d|%s|%s",
		annotation.Path,
		annotation.StartLine,
		annotation.EndLine,
		annotation.AnnotationLevel,
		annotation.Message,
	)
}

func resolveRepositoryOwnerForChecks(ctx context.Context, repository db.Repository, resolver runnerRepoOwnerResolver) string {
	if repository.UserID.Valid {
		user, err := resolver.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(user.Username)
	}
	if repository.OrgID.Valid {
		org, err := resolver.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(org.Name)
	}
	return ""
}

func workflowRunStatusToCheckRunConclusion(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success":
		return "success"
	case "failure", "error":
		return "failure"
	case "cancelled":
		return "neutral"
	default:
		return "neutral"
	}
}

// progressDependencies checks blocked tasks in a workflow run and either
// unblocks them (all dependencies done) or skips them (any dependency failed).
// It loops until convergence for transitive dependencies.
//
// If a task has an "if" expression (e.g., `always()`, `needs.JOB.result == "value"`),
// the expression is re-evaluated with actual needs results before deciding to skip.
// A task with `if: always()` will be unblocked even when dependencies fail.
func (s *runnerService) progressDependencies(ctx context.Context, workflowRunID int64) error {
	return s.progressDependenciesWith(ctx, s.queries, workflowRunID)
}

func (s *runnerService) progressDependenciesWith(ctx context.Context, queries RunnerQuerier, workflowRunID int64) error {
	for {
		blockedTasks, err := queries.ListBlockedTasksForRun(ctx, workflowRunID)
		if err != nil {
			return err
		}
		if len(blockedTasks) == 0 {
			return nil
		}

		taskInfos, err := queries.ListTaskStepInfoForRun(ctx, workflowRunID)
		if err != nil {
			return err
		}
		stepStatus := make(map[string]string, len(taskInfos))
		for _, info := range taskInfos {
			stepStatus[info.StepName] = info.Status
		}

		changed := false
		for _, bt := range blockedTasks {
			needs := parseNeedsFromPayload(bt.Payload)
			if len(needs) == 0 {
				if err := queries.UnblockWorkflowTask(ctx, bt.ID); err != nil {
					return err
				}
				changed = true
				continue
			}

			allDone := true
			anyFailed := false
			needsResults := make(map[string]string, len(needs))
			for _, need := range needs {
				st, ok := stepStatus[need]
				if !ok || st == "blocked" || st == "pending" || st == "assigned" || st == "running" {
					allDone = false
					continue
				}
				// Map task statuses to result values for if-expression evaluation
				needsResults[need] = taskStatusToResult(st)
				if st == "failed" || st == "cancelled" || st == "skipped" {
					anyFailed = true
				}
			}

			if !allDone {
				continue
			}

			// All dependencies are terminal. Evaluate any explicit if-expression
			// with the original event inputs plus resolved needs results.
			ifExpr := parseIfExprFromPayload(bt.Payload)
			if ifExpr != "" {
				shouldRun, evalErr := services.EvaluateIfExpression(ifExpr, parseTriggerEventFromPayload(bt.Payload), needsResults)
				if evalErr != nil {
					// Fail closed: an author-defined gate we cannot evaluate
					// must never fall through to the default unblock path. The
					// dispatch path rejects the same malformed expressions with
					// a BadRequest; here the run already exists, so skip the
					// guarded job instead of running it unconditionally.
					middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
						Warn("skipping workflow task with invalid if expression", "task_id", bt.ID, "if", ifExpr, "error", evalErr)
					if err := s.skipTaskAndStepWith(ctx, queries, bt.ID); err != nil {
						return err
					}
					changed = true
					continue
				}
				if shouldRun {
					if err := queries.UnblockWorkflowTask(ctx, bt.ID); err != nil {
						return err
					}
				} else {
					if err := s.skipTaskAndStepWith(ctx, queries, bt.ID); err != nil {
						return err
					}
				}
				changed = true
				continue
			}

			if anyFailed {
				if err := s.skipTaskAndStepWith(ctx, queries, bt.ID); err != nil {
					return err
				}
				changed = true
			} else {
				if err := queries.UnblockWorkflowTask(ctx, bt.ID); err != nil {
					return err
				}
				changed = true
			}
		}

		if !changed {
			return nil
		}
	}
}

// skipTaskAndStep marks a blocked task as skipped and also updates its
// corresponding workflow step to "skipped" for status consistency.
func (s *runnerService) skipTaskAndStep(ctx context.Context, taskID int64) error {
	return s.skipTaskAndStepWith(ctx, s.queries, taskID)
}

func (s *runnerService) skipTaskAndStepWith(ctx context.Context, queries RunnerQuerier, taskID int64) error {
	if err := queries.SkipBlockedWorkflowTask(ctx, taskID); err != nil {
		return err
	}
	stepID, err := queries.GetWorkflowTaskStepID(ctx, taskID)
	if err != nil {
		// Non-fatal: task was skipped even if we can't update the step
		return nil
	}
	_, _ = queries.UpdateWorkflowStepStatusTerminal(ctx, db.UpdateWorkflowStepStatusTerminalParams{
		Status: "skipped",
		StepID: stepID,
	})
	return nil
}

// finalizeTaskStep mirrors a settled runner task's status onto its workflow
// step. Without it a runner-executed task that reaches 'done', 'failed', or
// 'cancelled' leaves workflow_steps stuck at status='running' with a NULL
// completed_at forever, so the run detail API and the UI render every node of a
// finished run as still running (observed on Cloud CI runs 11702 and 11706).
//
// It is called immediately after MarkWorkflowTaskDone wins the task transition,
// so on the transactional path task status and step status commit together, the
// way the sandbox scheduler already finalizes its step. Requeues never reach
// this path: RequeueTasksForRunner resets a running step back to 'queued' with a
// NULL completed_at instead of terminalizing it.
func finalizeTaskStep(ctx context.Context, queries RunnerQuerier, workflowRunID, taskID int64, taskStatus string) {
	stepID, err := queries.GetWorkflowTaskStepID(ctx, taskID)
	if err != nil {
		middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
			Warn("failed to load workflow step for completed task", "task_id", taskID, "error", err)
		return
	}
	if _, err := queries.UpdateWorkflowStepStatusTerminal(ctx, db.UpdateWorkflowStepStatusTerminalParams{
		Status: taskStatusToResult(taskStatus),
		StepID: stepID,
	}); err != nil {
		middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
			Warn("failed to finalize workflow step for completed task",
				"task_id", taskID, "step_id", stepID, "task_status", taskStatus, "error", err)
	}
}

// taskStatusToResult maps task statuses to the result values used in
// if-expression evaluation (e.g., needs.JOB.result == "success").
func taskStatusToResult(status string) string {
	switch status {
	case "done":
		return "success"
	case "failed":
		return "failure"
	case "cancelled":
		return "cancelled"
	case "skipped":
		return "skipped"
	default:
		return status
	}
}

// parseIfExprFromPayload extracts the "if" expression from a task payload.
func parseIfExprFromPayload(payload json.RawMessage) string {
	var p struct {
		If string `json:"if"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return ""
	}
	return p.If
}

func parseTriggerEventFromPayload(payload json.RawMessage) services.TriggerEvent {
	var p struct {
		Event  string                 `json:"event"`
		Inputs map[string]interface{} `json:"inputs"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return services.TriggerEvent{}
	}
	return services.TriggerEvent{
		Type:   p.Event,
		Inputs: p.Inputs,
	}
}

// parseNeedsFromPayload extracts the needs array from a task payload.
func parseNeedsFromPayload(payload json.RawMessage) []string {
	var p struct {
		Needs []string `json:"needs"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil
	}
	return p.Needs
}

func workflowRunStatusToAction(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "queued":
		return "queued"
	case "running":
		return "in_progress"
	case "success":
		return "completed"
	case "failure", "error":
		return "failure"
	case "cancelled":
		return "cancelled"
	default:
		return ""
	}
}

func (s *runnerService) dispatchTriggeredWorkflowRuns(ctx context.Context, run db.WorkflowRun, runStatus string) error {
	if s.workflowDispatcher == nil {
		return nil
	}
	// Recursion guard (mirrors GitHub Actions): a run that was itself
	// workflow_run-triggered must not emit another workflow_run trigger event,
	// otherwise a definition whose on.workflow_run.workflows filter matches its
	// own name (or a mutually-referential pair) chains runs forever and
	// monopolizes the shared runner pool.
	if services.NormalizeTriggerName(run.TriggerEvent) == "workflow_run" {
		return nil
	}
	if strings.TrimSpace(run.TriggerCommitSha) == "" {
		return nil
	}

	action := workflowRunStatusToAction(runStatus)
	if action == "" {
		return nil
	}

	sourceWorkflow, err := s.queries.GetWorkflowDefinitionNameByRunID(ctx, run.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("fetch workflow definition for run %d: %w", run.ID, err)
	}

	_, err = s.workflowDispatcher.DispatchForEvent(ctx, services.DispatchForEventInput{
		RepositoryID: run.RepositoryID,
		Event: services.TriggerEvent{
			Type:           "workflow_run",
			Ref:            run.TriggerRef,
			CommitSHA:      run.TriggerCommitSha,
			Action:         action,
			SourceWorkflow: sourceWorkflow,
		},
	})
	if err != nil {
		return fmt.Errorf("dispatch workflow_run trigger: %w", err)
	}
	return nil
}

// dispatchWorkflowRunEvent enqueues a "workflow_run" webhook event (non-fatal).
func (s *runnerService) dispatchWorkflowRunEvent(ctx context.Context, workflowRunID int64, runStatus string) error {
	if s.dispatcher == nil {
		return nil
	}

	action := workflowRunStatusToAction(runStatus)
	if action == "" {
		return nil
	}

	run, err := s.queries.GetWorkflowRunByRunID(ctx, workflowRunID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("fetch workflow_run %d: %w", workflowRunID, err)
	}

	payload := webhooks.WorkflowRunEventPayload{
		Action: action,
		WorkflowRun: webhooks.WorkflowRunPayload{
			ID:           run.ID,
			Status:       run.Status,
			TriggerEvent: run.TriggerEvent,
			TriggerRef:   run.TriggerRef,
			CommitSHA:    run.TriggerCommitSha,
			CreatedAt:    run.CreatedAt,
		},
		Repository: webhooks.RepositoryPayload{ID: run.RepositoryID},
	}
	if err := s.dispatcher.DispatchEvent(ctx, run.RepositoryID, webhooks.EventTypeWorkflowRun, payload); err != nil {
		return fmt.Errorf("dispatch workflow_run webhook: %w", err)
	}
	return nil
}
