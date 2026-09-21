package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type RepositoryJobStore interface {
	RepoPermQuerier
	GetUserByIDNotDeleted(context.Context, int64) (db.User, error)
	GetRepoByID(context.Context, int64) (db.Repository, error)
	GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetUserByID(context.Context, int64) (db.User, error)
	GetOrgByID(context.Context, int64) (db.Organization, error)
	RegisterRepositoryJob(context.Context, db.RegisterRepositoryJobParams) (db.RegisterRepositoryJobRow, error)
	GetRepositoryJobRegistration(context.Context, string) (db.RepositoryJobRegistration, error)
	ListRepositoryJobRegistrations(context.Context, int64) ([]db.RepositoryJobRegistration, error)
	PauseRepositoryJob(context.Context, db.PauseRepositoryJobParams) ([]db.RepositoryJobRegistration, error)
	AdmitRepositoryJobEvent(context.Context, db.AdmitRepositoryJobEventParams) error
	ListRepositoryJobAdmissions(context.Context, int32) ([]db.ListRepositoryJobAdmissionsRow, error)
	EnqueueRepositoryJobDispatch(context.Context, db.EnqueueRepositoryJobDispatchParams) error
	SkipRetiredRepositoryJobDispatches(context.Context) error
	ClaimRepositoryJobDispatches(context.Context, int32) ([]db.RepositoryJobDispatch, error)
	SaveRepositoryJobPlan(context.Context, db.SaveRepositoryJobPlanParams) (int64, error)
	SettleRepositoryJobDispatch(context.Context, db.SettleRepositoryJobDispatchParams) (int64, error)
	RetryRepositoryJobSignal(context.Context, db.RetryRepositoryJobSignalParams) (int64, error)
	LatestRepositoryJobIssueRun(context.Context, db.LatestRepositoryJobIssueRunParams) (db.RepositoryJobDispatch, error)
	ListRepositoryJobDispatches(context.Context, db.ListRepositoryJobDispatchesParams) ([]db.RepositoryJobDispatch, error)
	ListDueRepositoryJobSchedules(context.Context, int32) ([]db.RepositoryJobRegistration, error)
	AdvanceRepositoryJobSchedule(context.Context, db.AdvanceRepositoryJobScheduleParams) (int64, error)
	ListRepositoryGitHubSources(context.Context, int64) ([]db.ListRepositoryGitHubSourcesRow, error)
}

// The gateway authenticates a registration and executes through the existing
// Control protocol. It never routes a current Flow.make module into legacy CI.
type RepositoryJobGateway interface {
	AuthorizeRelay(context.Context, string, string) (RepoGatewayRelayTarget, error)
	CallRepositoryJob(ctx context.Context, input RepoGatewayConnectionInput, capability string, procedure string, payload json.RawMessage) (json.RawMessage, error)
}

type RepositoryJobService struct {
	q            RepositoryJobStore
	gateway      RepositoryJobGateway
	now          func() time.Time
	transactions RepositoryJobTransactions
}

type RepositoryJobTransactions interface {
	Begin(context.Context) (pgx.Tx, error)
}

func NewRepositoryJobService(q RepositoryJobStore, gateway RepositoryJobGateway, transactions ...RepositoryJobTransactions) *RepositoryJobService {
	s := &RepositoryJobService{q: q, gateway: gateway, now: func() time.Time { return time.Now().UTC() }}
	if len(transactions) > 0 {
		s.transactions = transactions[0]
	}
	return s
}

type RepositoryJobEventRule struct {
	Type    string   `json:"type"`
	Actions []string `json:"actions"`
}

// Registration is called by the tested setup host, using its gateway bearer.
// The browser cannot supply a claimed test result or another actor's identity.
// The input is repository policy, not another executable workflow format.
type RegisterRepositoryJobInput struct {
	Repo             string                   `json:"repo"`
	WorkspaceID      string                   `json:"workspace_id"`
	FlowID           string                   `json:"flow_id"`
	Revision         int64                    `json:"revision"`
	Digest           string                   `json:"digest"`
	SourceRevision   string                   `json:"source_revision"`
	ExecutionDigest  string                   `json:"execution_digest"`
	Envelope         json.RawMessage          `json:"envelope"`
	Mode             string                   `json:"mode"`
	TrialIssueNumber int64                    `json:"trial_issue_number,omitempty"`
	TrialSource      string                   `json:"trial_source,omitempty"`
	Events           []RepositoryJobEventRule `json:"events"`
	Label            string                   `json:"label,omitempty"`
	Schedule         string                   `json:"schedule,omitempty"`
	Input            json.RawMessage          `json:"input"`
}

var repositoryJobNames = map[string]bool{"issues": true, "review": true, "ci": true, "feature": true, "chores": true}
var repositoryJobFlowName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$`)
var repositoryJobDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validateRepositoryJob(job string, input RegisterRepositoryJobInput, now time.Time) (pgtype.Timestamptz, error) {
	bad := func(message string) (pgtype.Timestamptz, error) {
		return pgtype.Timestamptz{}, pkgerrors.BadRequest(message)
	}
	if !repositoryJobNames[job] || !repositoryJobFlowName.MatchString(input.FlowID) || strings.Contains(input.FlowID, "..") {
		return bad("invalid repository job or registered flow")
	}
	if _, err := uuid.Parse(input.WorkspaceID); err != nil {
		return bad("workspace_id must identify the owning workspace")
	}
	if input.Revision <= 0 || !repositoryJobDigest.MatchString(input.Digest) || !repositoryJobDigest.MatchString(input.ExecutionDigest) || !isImmutableGitObjectID(input.SourceRevision) {
		return bad("registration requires an exact candidate, executable digest and source revision")
	}
	if input.Mode != "enabled" && input.Mode != "trial" {
		return bad("mode must be enabled or trial")
	}
	if input.Mode == "trial" && (input.TrialIssueNumber <= 0 || (input.TrialSource != "github" && input.TrialSource != "smithers-cloud")) {
		return bad("trial registration requires one real source issue")
	}
	if input.Mode == "enabled" && (input.TrialIssueNumber != 0 || input.TrialSource != "") {
		return bad("an enabled registration cannot retain trial-only scope")
	}
	var envelope struct {
		Capabilities []string `json:"capabilities"`
		Flows        []string `json:"flows"`
		Budget       struct {
			Tokens       float64 `json:"tokens"`
			Milliseconds float64 `json:"milliseconds"`
		} `json:"budget"`
	}
	if json.Unmarshal(input.Envelope, &envelope) != nil || envelope.Capabilities == nil || envelope.Flows == nil ||
		envelope.Budget.Tokens <= 0 || envelope.Budget.Milliseconds <= 0 || envelope.Budget.Milliseconds > float64((2*time.Hour)/time.Millisecond) {
		return bad("automatic work needs the reviewed envelope and finite token/time limits")
	}
	if len(input.Input) == 0 || !json.Valid(input.Input) || string(input.Input) == "null" {
		return bad("input must contain the reviewed repository configuration")
	}
	if len(input.Events) > 16 || len(input.Label) > 100 {
		return bad("too many event rules or an invalid label")
	}
	for _, rule := range input.Events {
		switch normalizeTriggerName(rule.Type) {
		case "issue", "issue_comment", "pull_request", "pull_request_review", "push", "check_run", "check_suite":
		default:
			return bad("unsupported repository job event")
		}
		if len(rule.Actions) > 20 {
			return bad("too many event actions")
		}
		for _, action := range rule.Actions {
			if strings.TrimSpace(action) == "" || len(action) > 100 {
				return bad("invalid event action")
			}
		}
	}
	if input.Schedule == "" {
		return pgtype.Timestamptz{}, nil
	}
	if input.Mode != "enabled" || job != "chores" || len(input.Schedule) > 200 {
		return bad("only enabled chores may register a schedule")
	}
	if len(strings.Fields(input.Schedule)) != 5 {
		return bad("schedule must have five cron fields in UTC")
	}
	next, err := nextFireTime(input.Schedule, now)
	if err != nil || next.IsZero() {
		return bad("schedule must be a valid five-field cron expression")
	}
	return pgtype.Timestamptz{Time: next, Valid: true}, nil
}

func (s *RepositoryJobService) authorizedRepo(ctx context.Context, repoID, userID int64, write bool) (db.Repository, error) {
	repo, err := s.q.GetRepoByID(ctx, repoID)
	if err != nil {
		return db.Repository{}, pkgerrors.NotFound("repository not found")
	}
	actor, err := s.q.GetUserByIDNotDeleted(ctx, userID)
	if err != nil || !actor.IsActive || actor.ProhibitLogin {
		return db.Repository{}, pkgerrors.Unauthorized("repository job user is unavailable")
	}
	var allowed bool
	if write {
		if repo.IsArchived {
			return db.Repository{}, pkgerrors.Forbidden("repository is archived")
		}
		allowed, err = canWriteRepo(ctx, s.q, repo, userID)
	} else {
		allowed, err = canReadRepo(ctx, s.q, repo, userID)
	}
	if err != nil {
		return db.Repository{}, err
	}
	if !allowed {
		return db.Repository{}, pkgerrors.Forbidden("repository permission required")
	}
	return repo, nil
}

func (s *RepositoryJobService) authorizeJobGateway(ctx context.Context, gatewayID, bearer, repoName, workspaceID string) (db.Repository, RepoGatewayRelayTarget, error) {
	target, err := s.gateway.AuthorizeRelay(ctx, gatewayID, bearer)
	if err != nil {
		return db.Repository{}, target, err
	}
	if target.WorkspaceID == "" || !strings.EqualFold(target.WorkspaceID, workspaceID) {
		return db.Repository{}, target, pkgerrors.Forbidden("registration must use its owning workspace gateway")
	}
	owner, name, found := strings.Cut(repoName, "/")
	if !found || owner == "" || name == "" || strings.Contains(name, "/") {
		return db.Repository{}, target, pkgerrors.BadRequest("repo must be owner/name")
	}
	repo, err := s.q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(owner), LowerName: strings.ToLower(name)})
	if err != nil || repo.ID != target.RepositoryID {
		return db.Repository{}, target, pkgerrors.Forbidden("gateway cannot configure another repository")
	}
	if _, err := s.authorizedRepo(ctx, repo.ID, target.UserID, true); err != nil {
		return db.Repository{}, target, err
	}
	return repo, target, nil
}

func (s *RepositoryJobService) Register(ctx context.Context, gatewayID, bearer, job string, input RegisterRepositoryJobInput) (db.RegisterRepositoryJobRow, error) {
	var empty db.RegisterRepositoryJobRow
	repo, target, err := s.authorizeJobGateway(ctx, gatewayID, bearer, input.Repo, input.WorkspaceID)
	if err != nil {
		return empty, err
	}
	next, err := validateRepositoryJob(job, input, s.now())
	if err != nil {
		return empty, err
	}
	configuration, err := json.Marshal(input)
	if err != nil {
		return empty, pkgerrors.BadRequest("invalid repository job configuration")
	}
	store := s.q
	var tx pgx.Tx
	if s.transactions != nil {
		tx, err = s.transactions.Begin(ctx)
		if err != nil {
			return empty, err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, repo.ID); err != nil {
			return empty, err
		}
		queries := db.New(tx)
		if err = queries.LockWorkspaceCapability(ctx, db.LockWorkspaceCapabilityParams{RepositoryID: repo.ID, UserID: target.UserID}); err != nil {
			return empty, err
		}
		workspace, workspaceErr := queries.GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: target.WorkspaceID, RepositoryID: repo.ID, UserID: target.UserID})
		if workspaceErr != nil || workspace.DeletedAt.Valid || workspace.Status == "failed" {
			return empty, pkgerrors.Conflict("the registration workspace is unavailable")
		}
		store = queries
		fresh, checkErr := (&RepositoryJobService{q: store}).authorizedRepo(ctx, repo.ID, target.UserID, true)
		if checkErr != nil {
			return empty, checkErr
		}
		if fresh.UserID != repo.UserID || fresh.OrgID != repo.OrgID || fresh.Name != repo.Name {
			return empty, pkgerrors.Conflict("repository ownership changed")
		}
	}
	row, err := store.RegisterRepositoryJob(ctx, db.RegisterRepositoryJobParams{
		RepositoryID: repo.ID, WorkspaceID: target.WorkspaceID, UserID: target.UserID,
		Job: job, Mode: input.Mode, Revision: input.Revision, Digest: input.Digest,
		SourceRevision: input.SourceRevision, FlowID: input.FlowID, Configuration: configuration,
		TrialIssueNumber: input.TrialIssueNumber, TrialSource: input.TrialSource,
		Schedule: input.Schedule, NextFireAt: next,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, pkgerrors.Conflict("registration was paused, replaced, or changed; apply a newer reviewed revision")
	}
	if err != nil {
		return empty, pkgerrors.Internal("could not save repository job registration")
	}
	if tx != nil {
		if err := tx.Commit(ctx); err != nil {
			return empty, err
		}
	}
	return row, nil
}

func (s *RepositoryJobService) List(ctx context.Context, repoID, userID int64) ([]db.RepositoryJobRegistration, error) {
	if _, err := s.authorizedRepo(ctx, repoID, userID, false); err != nil {
		return nil, err
	}
	return s.q.ListRepositoryJobRegistrations(ctx, repoID)
}

type RepositorySource struct {
	Source   string `json:"source"`
	FullName string `json:"full_name,omitempty"`
}

func (s *RepositoryJobService) Source(ctx context.Context, repoID, userID int64) (RepositorySource, error) {
	if _, err := s.authorizedRepo(ctx, repoID, userID, false); err != nil {
		return RepositorySource{}, err
	}
	rows, err := s.q.ListRepositoryGitHubSources(ctx, repoID)
	if err != nil {
		return RepositorySource{}, err
	}
	if len(rows) > 1 {
		return RepositorySource{}, pkgerrors.Conflict("repository source mappings disagree")
	}
	if len(rows) == 1 {
		return RepositorySource{Source: "github", FullName: rows[0].GithubOwner + "/" + rows[0].GithubRepo}, nil
	}
	return RepositorySource{Source: "smithers-cloud"}, nil
}

func (s *RepositoryJobService) Pause(ctx context.Context, repoID, userID int64, job string) ([]db.RepositoryJobRegistration, error) {
	if !repositoryJobNames[job] {
		return nil, pkgerrors.BadRequest("unknown repository job")
	}
	if _, err := s.authorizedRepo(ctx, repoID, userID, true); err != nil {
		return nil, err
	}
	return s.q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repoID, Job: job})
}

type RepositoryJobDispatchReceipt struct {
	ID             string          `json:"id"`
	RegistrationID string          `json:"registration_id"`
	Revision       int64           `json:"revision"`
	Digest         string          `json:"digest"`
	DeliveryKey    string          `json:"delivery_key"`
	Source         string          `json:"source"`
	IssueNumber    int64           `json:"issue_number"`
	Status         string          `json:"status"`
	RunID          string          `json:"run_id"`
	Receipt        json.RawMessage `json:"receipt,omitempty"`
	Error          string          `json:"error,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

func (s *RepositoryJobService) Dispatches(ctx context.Context, repoID, userID int64, job string) ([]RepositoryJobDispatchReceipt, error) {
	if !repositoryJobNames[job] {
		return nil, pkgerrors.BadRequest("unknown repository job")
	}
	if _, err := s.authorizedRepo(ctx, repoID, userID, false); err != nil {
		return nil, err
	}
	rows, err := s.q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repoID, Job: job})
	if err != nil {
		return nil, err
	}
	result := make([]RepositoryJobDispatchReceipt, 0, len(rows))
	for _, row := range rows {
		result = append(result, RepositoryJobDispatchReceipt{
			ID: row.ID, RegistrationID: row.RegistrationID, Revision: row.Revision, Digest: row.Digest,
			DeliveryKey: row.DeliveryKey, Source: row.Source, IssueNumber: row.IssueNumber,
			Status: row.Status, RunID: row.RunID, Receipt: row.Receipt, Error: row.Error,
			CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		})
	}
	return result, nil
}

func sameRepositoryJobJSON(a, b json.RawMessage) bool {
	var av, bv interface{}
	if json.Unmarshal(a, &av) != nil || json.Unmarshal(b, &bv) != nil {
		return false
	}
	ac, _ := json.Marshal(av)
	bc, _ := json.Marshal(bv)
	return bytes.Equal(ac, bc)
}
