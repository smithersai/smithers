package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// Items: every open GitHub issue (and every result a workspace hands to the
// stack without one) moving through the stack. The worker advances them
// inside the stack's claim, so one writer decides; run projections only
// record outcomes (optimistic version) and wake the worker.
//
// queued -> running (coding/request on a lane) -> delivering (coding/vibe)
// -> integrating (candidate on the tip; rebase when the tip moved)
// -> verifying (coding/verify on a rebased candidate) -> proposing
// (one GitHub PR whose tree is exactly the verified candidate) -> proposed
// -> landed (merged) | rejected (closed). Failures retry with feedback, then
// re-plan appending only, then block visibly.

const (
	mythicalBindingKind    = "mythical-item"
	mythicalAttempts       = 3
	mythicalBackfillEvery  = 15 * time.Minute
	mythicalPullPollEvery  = 5 * time.Minute
	mythicalLaunchesPerRun = 4
	mythicalPromptBytes    = 24 << 10
)

var (
	mythicalSkipLabels     = map[string]bool{"question": true, "duplicate": true, "invalid": true, "wontfix": true, "epic": true, "umbrella": true, "tracking": true}
	mythicalTrustedAuthors = map[string]bool{"OWNER": true, "MEMBER": true, "COLLABORATOR": true}
	mythicalSettledStates  = map[string]bool{"skipped": true, "cancelled": true, "landed": true, "rejected": true, "blocked": true}
	mythicalLaneStates     = map[string]bool{"running": true, "delivering": true, "verifying": true}
	mythicalWorkspaceID    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// mythicalLauncher admits canonical Flow launches (flowdispatch.Service).
type mythicalLauncher interface {
	Admit(context.Context, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error)
}

// mythicalLanes provisions and retires lane workspaces for the stack actor.
type mythicalLanes interface {
	Create(ctx context.Context, repository db.Repository, owner string, actorUserID int64, name string) (string, error)
	Delete(ctx context.Context, repositoryID, actorUserID int64, workspaceID string) error
}

// SetOrchestration connects the item machinery: GitHub, Flow launches and
// lane workspaces. Without it the stack still bootstraps and folds.
func (s *MythicalService) SetOrchestration(github mythicalGitHub, launcher mythicalLauncher, lanes mythicalLanes) {
	s.github, s.launcher, s.lanes = github, launcher, lanes
}

// SetLauncher completes the construction cycle with the Flow dispatcher.
func (s *MythicalService) SetLauncher(launcher mythicalLauncher) { s.launcher = launcher }

// mythicalAdmission decides, deterministically and before any model, whether
// an issue is worked; the reason is shown for every skip.
func mythicalAdmission(issue mythicalIssue) (string, string) {
	if issue.PullRequest {
		return "skipped", "pull requests are reviewed, not implemented"
	}
	if !strings.EqualFold(issue.State, "open") {
		return "cancelled", "the issue is closed"
	}
	labeled := false
	for _, label := range issue.Labels {
		name := strings.ToLower(strings.TrimSpace(label))
		if mythicalSkipLabels[name] {
			return "skipped", "labeled " + name
		}
		labeled = labeled || name == "smithers"
	}
	if !mythicalTrustedAuthors[strings.ToUpper(issue.AuthorAssociation)] && !labeled {
		return "skipped", "waiting for a maintainer to add the smithers label"
	}
	return "queued", ""
}

func mythicalIssueDigest(issue mythicalIssue) string {
	sum := sha256.Sum256([]byte(issue.Title + "\x00" + issue.Body))
	return hex.EncodeToString(sum[:])
}

// ObserveIssue admits or updates one issue's item. An edit re-admits an item
// that has not started (a label approval does not survive an edit); a running
// item keeps the text it was given. Closing cancels an item not started yet.
func (s *MythicalService) ObserveIssue(ctx context.Context, repositoryID int64, issue mythicalIssue) error {
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	state, reason := mythicalAdmission(issue)
	digest := mythicalIssueDigest(issue)
	for range 3 {
		item, inserted, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repositoryID,
			IssueNumber: pgtype.Int8{Int64: issue.Number, Valid: true}, IssueTitle: issue.Title, IssueURL: issue.URL,
			IssueDigest: digest, Source: "issue", State: state, Reason: reason})
		if err != nil {
			return err
		}
		if inserted {
			s.itemChanged(ctx, q, stack, item.ID)
			return nil
		}
		next := item
		next.IssueTitle, next.IssueURL = issue.Title, issue.URL
		switch {
		case state == "cancelled" && (item.State == "queued" || item.State == "retrying" || item.State == "skipped"):
			next.State, next.Reason = "cancelled", reason
		case (item.State == "queued" || item.State == "skipped" || item.State == "cancelled") &&
			(item.IssueDigest != digest || item.State != state || item.Reason != reason):
			next.State, next.Reason, next.IssueDigest = state, reason, digest
		}
		if next.State == item.State && next.Reason == item.Reason && next.IssueTitle == item.IssueTitle && next.IssueURL == item.IssueURL &&
			next.IssueDigest == item.IssueDigest {
			return nil
		}
		saved, err := q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, saved.ID)
		return nil
	}
	return errors.New("the item changed concurrently; the next sweep observes the issue again")
}

// itemChanged wakes the stack worker and the event stream.
func (s *MythicalService) itemChanged(ctx context.Context, q *db.Queries, stack db.MythicalStack, itemID pgtype.UUID) {
	if _, err := q.RequestMythicalStack(ctx, stack.RepositoryID); err != nil && ctx.Err() == nil {
		s.logger.Warn("mythical.request_failed", "repository_id", stack.RepositoryID, "error", err)
	}
	s.notify(ctx, q, stack.RepositoryID, stack.Generation, "item", uuidString(itemID))
}

// Backfill admits every open issue now and cancels items whose issue is no
// longer open and that have not started.
func (s *MythicalService) Backfill(ctx context.Context, repositoryID int64) error {
	if s.github == nil {
		return pkgerrors.Internal("GitHub is not configured for the mythical stack")
	}
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.NotFound("this repository has no mythical stack")
	}
	if err != nil {
		return err
	}
	repository, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return err
	}
	gh, err := s.github.Resolve(ctx, repository, owner, stack.ActorUserID.Int64)
	if err != nil {
		return err
	}
	issues, err := s.github.OpenIssues(ctx, gh)
	if err != nil {
		return err
	}
	open := make(map[int64]bool, len(issues))
	for _, issue := range issues {
		open[issue.Number] = true
		if err := s.ObserveIssue(ctx, repositoryID, issue); err != nil {
			return err
		}
	}
	items, err := q.ListMythicalItems(ctx, repositoryID, 1000)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.IssueNumber.Valid && !open[item.IssueNumber.Int64] && (item.State == "queued" || item.State == "retrying") {
			if err := s.ObserveIssue(ctx, repositoryID, mythicalIssue{Number: item.IssueNumber.Int64, Title: item.IssueTitle,
				URL: item.IssueURL, State: "closed"}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *MythicalService) repository(ctx context.Context, repositoryID int64) (db.Repository, string, error) {
	q := s.queries()
	repository, err := q.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return db.Repository{}, "", err
	}
	owner, err := mythicalRepositoryOwner(ctx, q, repository)
	return repository, owner, err
}

// MythicalLaneSubmission is a coding host's validated, cleaned result.
type MythicalLaneSubmission struct {
	WorkspaceID  string `json:"workspaceId"`
	Base         string `json:"base"`
	Source       string `json:"source"`
	RequestRunID string `json:"requestRunId"`
	Summary      string `json:"summary"`
}

// MythicalLaneReceipt names the item that carries a submitted result.
type MythicalLaneReceipt struct {
	ItemID string `json:"itemId"`
	State  string `json:"state"`
	Source string `json:"source"`
}

// SubmitLane records a lane's result on its item (or on a new chat item when
// the workspace is not a lane) and wakes the worker. Replays are idempotent.
func (s *MythicalService) SubmitLane(ctx context.Context, repositoryID, userID int64, input MythicalLaneSubmission) (MythicalLaneReceipt, error) {
	if !mythicalSHA.MatchString(input.Base) || !mythicalSHA.MatchString(input.Source) || !mythicalWorkspaceID.MatchString(input.WorkspaceID) ||
		strings.TrimSpace(input.Summary) == "" || len(input.Summary) > 16<<10 || strings.TrimSpace(input.RequestRunID) == "" {
		return MythicalLaneReceipt{}, pkgerrors.BadRequest("a lane submission needs exact commits, the workspace, the run and a summary")
	}
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && stack.State != "active") {
		return MythicalLaneReceipt{}, pkgerrors.Conflict("this repository has no active mythical stack")
	}
	if err != nil {
		return MythicalLaneReceipt{}, err
	}
	for range 3 {
		item, err := q.GetMythicalItemByWorkspace(ctx, repositoryID, input.WorkspaceID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Not a lane: a workspace of this repository hands a chat result
			// to the stack; only its owner may.
			workspace, err := q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: input.WorkspaceID, RepositoryID: repositoryID})
			if err != nil || workspace.DeletedAt.Valid || workspace.UserID != userID {
				return MythicalLaneReceipt{}, pkgerrors.Forbidden("the workspace does not belong to this repository and user")
			}
			return s.submitChat(ctx, q, stack, input)
		}
		// A lane runs as the stack's actor; only that account submits for it.
		if !stack.ActorUserID.Valid || stack.ActorUserID.Int64 != userID {
			return MythicalLaneReceipt{}, pkgerrors.Forbidden("only the stack's account submits a lane's result")
		}
		if err != nil {
			return MythicalLaneReceipt{}, err
		}
		if item.CandidateHead == input.Source && item.CandidateHead != "" {
			return MythicalLaneReceipt{ItemID: uuidString(item.ID), State: item.State, Source: input.Source}, nil
		}
		if item.State != "running" && item.State != "delivering" {
			return MythicalLaneReceipt{}, pkgerrors.Conflict("the lane's item is " + item.State + ", not waiting for a result")
		}
		next := item
		next.CandidateBase, next.CandidateHead, next.CandidateVerified = input.Base, input.Source, true
		next.Summary, next.VibeOutcome, next.State, next.Reason = strings.TrimSpace(input.Summary), "submitted", "integrating", ""
		saved, err := q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return MythicalLaneReceipt{}, err
		}
		s.itemChanged(ctx, q, stack, saved.ID)
		return MythicalLaneReceipt{ItemID: uuidString(saved.ID), State: saved.State, Source: input.Source}, nil
	}
	return MythicalLaneReceipt{}, pkgerrors.Conflict("the item changed concurrently; retry the submission")
}

func (s *MythicalService) submitChat(ctx context.Context, q *db.Queries, stack db.MythicalStack, input MythicalLaneSubmission) (MythicalLaneReceipt, error) {
	items, err := q.ListMythicalItems(ctx, stack.RepositoryID, 1000)
	if err != nil {
		return MythicalLaneReceipt{}, err
	}
	for _, item := range items {
		if item.Source == "chat" && item.CandidateHead == input.Source {
			return MythicalLaneReceipt{ItemID: uuidString(item.ID), State: item.State, Source: input.Source}, nil
		}
	}
	title, _, _ := strings.Cut(strings.TrimSpace(input.Summary), "\n")
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: stack.RepositoryID, IssueTitle: title, Source: "chat",
		State: "integrating", CandidateBase: input.Base, CandidateHead: input.Source, Summary: strings.TrimSpace(input.Summary)})
	if err != nil {
		return MythicalLaneReceipt{}, err
	}
	item.CandidateVerified, item.VibeOutcome, item.WorkspaceID = true, "submitted", input.WorkspaceID
	saved, err := q.SaveMythicalItem(ctx, item)
	if err != nil {
		return MythicalLaneReceipt{}, err
	}
	s.itemChanged(ctx, q, stack, saved.ID)
	return MythicalLaneReceipt{ItemID: uuidString(saved.ID), State: saved.State, Source: input.Source}, nil
}

// mythicalProjection correlates a Flow run with one item phase.
type mythicalProjection struct {
	Kind       string `json:"kind"`
	ItemID     string `json:"itemId"`
	Generation int64  `json:"generation"`
	Phase      string `json:"phase"` // request | vibe | verify
}

// ProjectFlowRuntime records a lane run's id and terminal outcome on its item
// and wakes the worker. A projection of an older generation changes nothing.
func (s *MythicalService) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	var projection mythicalProjection
	if json.Unmarshal(update.Checkpoint.Projection, &projection) != nil || projection.Kind != mythicalBindingKind {
		return nil
	}
	id, err := uuid.Parse(projection.ItemID)
	if err != nil {
		return nil
	}
	q := s.queries()
	for range 3 {
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if item.Generation != projection.Generation {
			return nil
		}
		next := item
		runID := strings.TrimSpace(update.Checkpoint.RunID)
		outcome := mythicalRunOutcome(projection.Phase, update)
		switch projection.Phase {
		case "request":
			if runID != "" {
				next.RequestRunID = runID
			}
			if outcome != "" && item.RequestOutcome == "" {
				next.RequestOutcome = outcome
				if plan := mythicalPlanSummary(update); plan != nil {
					next.Plan = plan
				}
			}
		case "vibe":
			if runID != "" {
				next.VibeRunID = runID
			}
			if outcome != "" && item.VibeOutcome == "" {
				next.VibeOutcome = outcome
			}
		case "verify":
			if runID != "" {
				next.VerifyRunID = runID
			}
			if outcome != "" && item.VerifyOutcome == "" {
				next.VerifyOutcome = outcome
			}
		default:
			return nil
		}
		if next.RequestRunID == item.RequestRunID && next.VibeRunID == item.VibeRunID && next.VerifyRunID == item.VerifyRunID &&
			next.RequestOutcome == item.RequestOutcome && next.VibeOutcome == item.VibeOutcome && next.VerifyOutcome == item.VerifyOutcome {
			return nil
		}
		saved, err := q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if stack, err := q.GetMythicalStack(ctx, saved.RepositoryID); err == nil {
			s.itemChanged(ctx, q, stack, saved.ID)
		}
		return nil
	}
	return errors.New("mythical item is busy; retry the projection")
}

// mythicalRunOutcome reads a terminal run: ” while it is not terminal.
func mythicalRunOutcome(phase string, update flowdispatch.ProjectionUpdate) string {
	switch update.State {
	case jobs.StateCompleted:
	case jobs.StateFailed, jobs.StateCancelled:
		if reason := mythicalDeclined(update); reason != "" {
			return "declined: " + reason
		}
		code := strings.TrimSpace(update.Checkpoint.FailureCode)
		if code == "" {
			code = string(update.State)
		}
		return "failed: " + code
	default:
		return ""
	}
	output := ""
	if update.Checkpoint.Run != nil && update.Checkpoint.Run.FinalOutput != nil {
		output = *update.Checkpoint.Run.FinalOutput
	}
	switch phase {
	case "request":
		var result struct {
			Outcome struct {
				Status string `json:"status"`
			} `json:"outcome"`
		}
		if json.Unmarshal([]byte(output), &result) != nil || result.Outcome.Status == "" {
			return "failed: the request finished without a result"
		}
		return result.Outcome.Status
	case "vibe":
		var result struct {
			Lane *struct {
				ItemID string `json:"itemId"`
			} `json:"lane"`
		}
		if json.Unmarshal([]byte(output), &result) != nil || result.Lane == nil {
			return "failed: the result was not handed to the stack"
		}
		return "submitted"
	case "verify":
		var result struct {
			Status string   `json:"status"`
			Failed []string `json:"failed"`
		}
		if json.Unmarshal([]byte(output), &result) != nil || result.Status == "" {
			return "failed: verification finished without a result"
		}
		if result.Status == "passed" {
			return "passed"
		}
		return "failed: " + strings.Join(result.Failed, ", ")
	}
	return ""
}

var mythicalDeclinedPattern = regexp.MustCompile(`"code"\s*:\s*"declined"\s*,\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"`)

// mythicalDeclined finds the planner's decline reason in a failed request.
func mythicalDeclined(update flowdispatch.ProjectionUpdate) string {
	var haystack []string
	if update.Checkpoint.Receipt != nil {
		haystack = append(haystack, update.Checkpoint.Receipt.Message)
	}
	if update.Checkpoint.Run != nil {
		haystack = append(haystack, update.Checkpoint.Run.ExecutionObservation)
		if update.Checkpoint.Run.FinalOutput != nil {
			haystack = append(haystack, *update.Checkpoint.Run.FinalOutput)
		}
	}
	for _, text := range haystack {
		if match := mythicalDeclinedPattern.FindStringSubmatch(text); match != nil {
			var reason string
			if json.Unmarshal([]byte(`"`+match[1]+`"`), &reason) == nil {
				return reason
			}
		}
		if strings.HasPrefix(text, "declined: ") {
			return strings.TrimPrefix(text, "declined: ")
		}
	}
	return ""
}

// mythicalPlanSummary projects the request's plan placement for the UI and
// keeps its checks for coding/verify.
func mythicalPlanSummary(update flowdispatch.ProjectionUpdate) json.RawMessage {
	if update.Checkpoint.Run == nil || update.Checkpoint.Run.FinalOutput == nil {
		return nil
	}
	var result struct {
		Plan struct {
			Changes []struct {
				Title string `json:"title"`
				Atoms []struct {
					ChangeID *string `json:"changeId"`
					Message  string  `json:"message"`
				} `json:"atoms"`
				Checks []json.RawMessage `json:"checks"`
			} `json:"changes"`
		} `json:"plan"`
	}
	if json.Unmarshal([]byte(*update.Checkpoint.Run.FinalOutput), &result) != nil || len(result.Plan.Changes) == 0 {
		return nil
	}
	type insert struct {
		After string `json:"after"`
		Title string `json:"title"`
	}
	summary := struct {
		Title   string            `json:"title"`
		Amends  []string          `json:"amends"`
		Inserts []insert          `json:"inserts"`
		Appends int               `json:"appends"`
		Checks  []json.RawMessage `json:"checks"`
	}{Title: result.Plan.Changes[0].Title, Amends: []string{}, Inserts: []insert{}}
	seen := map[string]bool{}
	var atoms []struct {
		ChangeID *string
		Message  string
	}
	for _, change := range result.Plan.Changes {
		for _, atom := range change.Atoms {
			atoms = append(atoms, struct {
				ChangeID *string
				Message  string
			}{atom.ChangeID, atom.Message})
		}
		for _, check := range change.Checks {
			var id struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(check, &id) == nil && !seen[id.ID] {
				seen[id.ID] = true
				summary.Checks = append(summary.Checks, check)
			}
		}
	}
	lastExisting := -1
	for i, atom := range atoms {
		if atom.ChangeID != nil {
			lastExisting = i
		}
	}
	previous := ""
	for i, atom := range atoms {
		switch {
		case atom.ChangeID != nil:
			summary.Amends = append(summary.Amends, *atom.ChangeID)
			previous = *atom.ChangeID
		case i < lastExisting:
			summary.Inserts = append(summary.Inserts, insert{After: previous, Title: atom.Message})
		default:
			summary.Appends++
		}
	}
	encoded, _ := json.Marshal(summary)
	return encoded
}

// ---- the worker's side ----

type mythicalItemStep struct {
	s        *MythicalService
	r        *mythicalRun
	q        *db.Queries
	gh       *mythicalGitHubRepo
	ghErr    error
	launches int
	issues   []string // other open item titles, for duplicate detection
	now      time.Time
}

// advanceItems moves every unsettled item one step. It runs inside the stack
// claim when no stack write is pending, so it is the only decider.
func (s *MythicalService) advanceItems(ctx context.Context, r *mythicalRun) {
	q := s.queries()
	if s.github != nil && s.now().Sub(s.lastBackfill(r.row.RepositoryID)) >= mythicalBackfillEvery {
		s.markBackfill(r.row.RepositoryID)
		if err := s.Backfill(ctx, r.row.RepositoryID); err != nil && ctx.Err() == nil {
			s.logger.Warn("mythical.backfill_failed", "repository_id", r.row.RepositoryID, "error", err)
		}
	}
	items, err := q.ListMythicalItems(ctx, r.row.RepositoryID, 1000)
	if err != nil {
		s.logger.Warn("mythical.items_failed", "repository_id", r.row.RepositoryID, "error", err)
		return
	}
	step := &mythicalItemStep{s: s, r: r, q: q, now: s.now()}
	for _, item := range items {
		if item.IssueNumber.Valid && item.State != "cancelled" && item.State != "landed" && item.State != "rejected" {
			step.issues = append(step.issues, fmt.Sprintf("#%d %s", item.IssueNumber.Int64, item.IssueTitle))
		}
	}
	busy := 0
	for _, item := range items {
		if mythicalLaneStates[item.State] {
			busy++
		}
	}
	// Oldest issue first; chat items after issues in arrival order.
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.IssueNumber.Valid != b.IssueNumber.Valid {
			return a.IssueNumber.Valid
		}
		return a.IssueNumber.Int64 < b.IssueNumber.Int64
	})
	for _, item := range items {
		if ctx.Err() != nil {
			return
		}
		if mythicalSettledStates[item.State] || (item.NextAttemptAt.Valid && item.NextAttemptAt.Time.After(step.now)) {
			continue
		}
		if (item.State == "queued" || item.State == "retrying") && (busy >= int(r.row.MaxParallel) || step.launches >= mythicalLaunchesPerRun) {
			continue
		}
		next, err := step.advance(ctx, item)
		if err != nil {
			s.logger.Warn("mythical.item_failed", "repository_id", r.row.RepositoryID, "item", uuidString(item.ID), "error", err)
			continue
		}
		if next == nil {
			continue
		}
		if !mythicalLaneStates[item.State] && mythicalLaneStates[next.State] {
			busy++
		}
		saved, err := q.SaveMythicalItem(ctx, *next)
		if err != nil {
			s.logger.Warn("mythical.item_save_failed", "repository_id", r.row.RepositoryID, "item", uuidString(item.ID), "error", err)
			continue
		}
		s.notify(ctx, q, r.row.RepositoryID, r.row.Generation, "item", uuidString(saved.ID))
		if mythicalSettledStates[saved.State] || saved.State == "proposed" {
			s.releaseLane(ctx, r, saved)
		}
	}
}

func (s *MythicalService) lastBackfill(repositoryID int64) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.backfills[repositoryID]
}

func (s *MythicalService) markBackfill(repositoryID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.backfills == nil {
		s.backfills = map[int64]time.Time{}
	}
	s.backfills[repositoryID] = s.now()
}

// releaseLane retires a finished item's lane workspace (best effort; the
// candidate is pinned, so nothing depends on the workspace any more).
func (s *MythicalService) releaseLane(ctx context.Context, r *mythicalRun, item db.MythicalItem) {
	if s.lanes == nil || item.WorkspaceID == "" || item.Source != "issue" || !r.row.ActorUserID.Valid {
		return
	}
	if err := s.lanes.Delete(ctx, r.row.RepositoryID, r.row.ActorUserID.Int64, item.WorkspaceID); err != nil && ctx.Err() == nil {
		s.logger.Warn("mythical.lane_release_failed", "workspace_id", item.WorkspaceID, "error", err)
		return
	}
	next := item
	next.WorkspaceID, next.Lane = "", pgtype.Int4{}
	if _, err := s.queries().SaveMythicalItem(ctx, next); err != nil {
		s.logger.Warn("mythical.lane_release_save_failed", "item", uuidString(item.ID), "error", err)
	}
}

// retry sends an item back to a lane, or blocks it after the last attempt.
func mythicalRetry(item db.MythicalItem, reason string, now time.Time) *db.MythicalItem {
	next := item
	if item.Attempt >= mythicalAttempts {
		next.State, next.Reason = "blocked", reason
		return &next
	}
	next.State, next.Reason = "retrying", reason
	next.NextAttemptAt = pgtype.Timestamptz{Time: now.Add(30 * time.Second), Valid: true}
	return &next
}

// advance decides one item's next step, or nil when it waits.
func (st *mythicalItemStep) advance(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	switch item.State {
	case "queued", "retrying":
		return st.start(ctx, item)
	case "running":
		switch outcome := item.RequestOutcome; {
		case outcome == "":
			return nil, nil
		case outcome == "validated":
			return st.deliver(ctx, item)
		case strings.HasPrefix(outcome, "declined: "):
			next := item
			next.State, next.Reason = "skipped", strings.TrimPrefix(outcome, "declined: ")
			return &next, nil
		default:
			return mythicalRetry(item, "the lane's request ended "+outcome, st.now), nil
		}
	case "delivering":
		if item.VibeOutcome == "" || item.VibeOutcome == "submitted" {
			return nil, nil
		}
		return mythicalRetry(item, "delivering the result "+item.VibeOutcome, st.now), nil
	case "integrating":
		return st.integrate(ctx, item)
	case "verifying":
		switch outcome := item.VerifyOutcome; {
		case outcome == "":
			return nil, nil
		case outcome == "passed":
			next := item
			next.CandidateVerified, next.State, next.Reason = true, "proposing", ""
			return &next, nil
		default:
			return mythicalRetry(item, "checks on the rebased result "+outcome, st.now), nil
		}
	case "proposing", "waiting":
		return st.propose(ctx, item)
	case "proposed":
		return st.follow(ctx, item)
	}
	return nil, nil
}

// start opens a lane for a new attempt: a fresh workspace on the stack, the
// tip retained into its source ref, and coding/request launched on it.
func (st *mythicalItemStep) start(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	s, r := st.s, st.r
	if item.Source != "issue" {
		next := item
		next.State, next.Reason = "blocked", "a chat result that no longer applies to the tip must be requested again"
		return &next, nil
	}
	if s.launcher == nil || s.lanes == nil || !r.row.ActorUserID.Valid {
		return nil, nil
	}
	repository, owner, err := s.repository(ctx, r.row.RepositoryID)
	if err != nil {
		return nil, err
	}
	next := item
	next.Attempt, next.Generation = item.Attempt+1, item.Generation+1
	next.RequestOutcome, next.VibeOutcome, next.VerifyOutcome = "", "", ""
	next.RequestRunID, next.VibeRunID, next.VerifyRunID = "", "", ""
	next.CandidateBase, next.CandidateHead, next.CandidateVerified = "", "", false
	name := fmt.Sprintf("mythical #%d attempt %d", item.IssueNumber.Int64, next.Attempt)
	workspaceID, err := s.lanes.Create(ctx, repository, owner, r.row.ActorUserID.Int64, name)
	if err != nil {
		return mythicalRetry(item, "no lane workspace: "+err.Error(), st.now), nil
	}
	next.WorkspaceID, next.BaseCommit = workspaceID, r.row.TipCommit
	next.Lane = pgtype.Int4{Int32: int32(next.Attempt % 8), Valid: true}
	ref, err := s.retainFor(ctx, r, workspaceID, r.row.TipCommit)
	if err != nil {
		return mythicalRetry(item, "the stack tip could not reach the lane: "+err.Error(), st.now), nil
	}
	payload, _ := json.Marshal(map[string]any{"prompt": st.prompt(item, next.Attempt), "maxRounds": 3,
		"base": map[string]string{"commitId": r.row.TipCommit, "ref": ref}})
	if err := st.launch(ctx, next, "request", "coding/request", payload); err != nil {
		_ = s.lanes.Delete(ctx, r.row.RepositoryID, r.row.ActorUserID.Int64, workspaceID)
		return mythicalRetry(item, "the request could not be launched: "+err.Error(), st.now), nil
	}
	next.State, next.Reason = "running", ""
	next.NextAttemptAt = pgtype.Timestamptz{}
	return &next, nil
}

// prompt is the issue as the planner reads it, with the retry ladder's
// feedback on later attempts.
func (st *mythicalItemStep) prompt(item db.MythicalItem, attempt int32) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Resolve GitHub issue #%d: %s\n\n", item.IssueNumber.Int64, item.IssueTitle)
	fmt.Fprintf(&b, "The issue: %s\n", item.IssueURL)
	b.WriteString("You are working on the repository's mythical stack. Decline with the reason when the issue is not actionable as a code change: already done, only a question, a duplicate of another open issue, or waiting on a product decision.\n")
	if len(st.issues) > 0 {
		b.WriteString("\nOther open issues:\n")
		for _, line := range st.issues {
			if b.Len() > mythicalPromptBytes/2 {
				break
			}
			if !strings.HasPrefix(line, fmt.Sprintf("#%d ", item.IssueNumber.Int64)) {
				b.WriteString("- " + line + "\n")
			}
		}
	}
	if attempt > 1 && item.Reason != "" {
		fmt.Fprintf(&b, "\nAn earlier attempt did not finish: %s\n", item.Reason)
	}
	if attempt >= mythicalAttempts {
		b.WriteString("Append new changes at the head only; do not amend or insert into existing history.\n")
	}
	out := b.String()
	if len(out) > mythicalPromptBytes {
		out = out[:mythicalPromptBytes]
	}
	return out
}

func (st *mythicalItemStep) launch(ctx context.Context, item db.MythicalItem, phase, flowID string, payload json.RawMessage) error {
	s, r := st.s, st.r
	id := uuidString(item.ID)
	projection, _ := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: id, Generation: item.Generation, Phase: phase})
	authorization, _ := json.Marshal(map[string]any{"repositoryId": r.row.RepositoryID, "userId": r.row.ActorUserID.Int64,
		"workspaceId": item.WorkspaceID, "itemId": id, "generation": item.Generation})
	_, err := s.launcher.Admit(ctx, flowdispatch.LaunchRequest{
		Scope:     jobs.Scope{TenantID: "repository:" + strconv.FormatInt(r.row.RepositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(r.row.ActorUserID.Int64, 10)},
		RequestID: fmt.Sprintf("mythical:%s:%d:%s:%d", id, item.Attempt, phase, item.Generation),
		Target: flowruntime.FlowRuntimeTarget{TenantID: "repository:" + strconv.FormatInt(r.row.RepositoryID, 10),
			PrincipalID: "user:" + strconv.FormatInt(r.row.ActorUserID.Int64, 10), WorkspaceID: item.WorkspaceID,
			BindingKind: mythicalBindingKind, BindingID: id},
		FlowID: flowID, Payload: payload, AuthorizationContext: authorization, Projection: projection,
		// The owner turned the stack on for this repository; its items run
		// without a per-plan approval, and reach main only as a PR they merge.
		ApprovalPolicy: flowdispatch.ApprovalAuto,
	})
	return err
}

func (st *mythicalItemStep) deliver(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	payload, _ := json.Marshal(map[string]string{"requestExecutionId": item.RequestRunID})
	if item.RequestRunID == "" {
		return nil, nil
	}
	if err := st.launch(ctx, item, "vibe", "coding/vibe", payload); err != nil {
		return mythicalRetry(item, "delivery could not be launched: "+err.Error(), st.now), nil
	}
	next := item
	next.State = "delivering"
	return &next, nil
}

// integrate puts a submitted candidate onto the current tip: as is when it
// was built on the tip, else rebased (appended candidates only) and sent to
// coding/verify. The candidate is pinned so it outlives its lane.
func (st *mythicalItemStep) integrate(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	s, r := st.s, st.r
	if item.CandidateHead == "" {
		return nil, nil
	}
	if err := st.fetchCandidate(ctx, item); err != nil {
		return nil, err
	}
	if err := s.pin(ctx, r, item.CandidateHead); err != nil {
		return nil, err
	}
	next := item
	if item.CandidateBase == r.row.TipCommit {
		integration, _ := json.Marshal(map[string]any{"kind": "fast-forward"})
		next.Integration, next.State, next.Reason = integration, "proposing", ""
		return &next, nil
	}
	rebased, err := r.g.rebaseCandidate(ctx, r.row.TipCommit, mythicalCandidate{ItemID: uuidString(item.ID), Issue: item.IssueNumber.Int64,
		Base: item.CandidateBase, Head: item.CandidateHead}, mythicalChainLimit)
	var conflict *errMythicalConflict
	switch {
	case errors.Is(err, errMythicalRewrite):
		return mythicalRetry(item, "the stack moved while this attempt amended or inserted changes; re-planning on the new tip", st.now), nil
	case errors.As(err, &conflict):
		integration, _ := json.Marshal(map[string]any{"conflict": map[string]any{"paths": conflict.Paths}})
		retried := mythicalRetry(item, "rebasing onto the new tip conflicted in "+strings.Join(conflict.Paths, ", "), st.now)
		retried.Integration = integration
		return retried, nil
	case err != nil:
		return nil, err
	}
	if item.Source != "issue" || item.WorkspaceID == "" {
		next.State, next.Reason = "blocked", "the stack moved; request this change again on the current tip"
		return &next, nil
	}
	if err := s.pin(ctx, r, rebased); err != nil {
		return nil, err
	}
	ref, err := s.retainFor(ctx, r, item.WorkspaceID, rebased)
	if err != nil {
		return nil, err
	}
	var plan struct {
		Checks []json.RawMessage `json:"checks"`
	}
	if json.Unmarshal(item.Plan, &plan) != nil || len(plan.Checks) == 0 {
		return mythicalRetry(item, "the rebased result has no checks to run; re-planning on the new tip", st.now), nil
	}
	next.Generation++
	next.CandidateBase, next.CandidateHead, next.CandidateVerified, next.VerifyOutcome, next.VerifyRunID = r.row.TipCommit, rebased, false, "", ""
	payload, _ := json.Marshal(map[string]any{"source": map[string]string{"commitId": rebased, "ref": ref}, "checks": plan.Checks})
	if err := st.launch(ctx, next, "verify", "coding/verify", payload); err != nil {
		return nil, err
	}
	integration, _ := json.Marshal(map[string]any{"kind": "rebased"})
	next.Integration, next.State, next.Reason = integration, "verifying", ""
	return &next, nil
}

func (st *mythicalItemStep) fetchCandidate(ctx context.Context, item db.MythicalItem) error {
	r := st.r
	if r.g.has(ctx, item.CandidateHead) {
		return nil
	}
	refs := []string{repohost.MythicalBookmarkRef}
	if item.WorkspaceID != "" {
		refs = append(refs, repohost.WorkspaceSourceRef(item.WorkspaceID, item.CandidateHead))
	}
	if err := r.g.fetch(ctx, r.bridge.URL(), 0, 0, refs...); err != nil {
		keep := repohost.MythicalReservedRefNS + "keep/" + item.CandidateHead
		if err2 := r.g.fetch(ctx, r.bridge.URL(), 0, 0, repohost.MythicalBookmarkRef, keep); err2 != nil {
			return fmt.Errorf("fetch the candidate: %s", sanitizeMirrorError(err, r.bridge.URL()))
		}
	}
	if !r.g.has(ctx, item.CandidateHead) {
		return errors.New("the candidate is not retained in the repository")
	}
	return nil
}

// propose opens (or finds, or updates) the item's pull request: one commit
// on main whose tree is exactly the verified candidate built on the current,
// folded tip. The branch head is recorded before the push.
func (st *mythicalItemStep) propose(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	s, r := st.s, st.r
	next := item
	if item.CandidateBase != r.row.TipCommit {
		next.State, next.Reason = "integrating", ""
		return &next, nil
	}
	if r.mainTip != r.row.LandedMain {
		if item.State == "waiting" {
			return nil, nil
		}
		next.State, next.Reason = "waiting", "the stack is folding the latest main"
		return &next, nil
	}
	if s.github == nil || !r.row.ActorUserID.Valid {
		return nil, nil
	}
	if st.gh == nil && st.ghErr == nil {
		repository, owner, err := s.repository(ctx, r.row.RepositoryID)
		if err != nil {
			return nil, err
		}
		gh, err := s.github.Resolve(ctx, repository, owner, r.row.ActorUserID.Int64)
		st.gh, st.ghErr = &gh, err
	}
	if st.ghErr != nil {
		if item.State == "waiting" && item.Reason == st.ghErr.Error() {
			return nil, nil
		}
		next.State, next.Reason = "waiting", st.ghErr.Error()
		return &next, nil
	}
	gh := *st.gh
	candidate, err := r.g.readCommit(ctx, item.CandidateHead)
	if err != nil {
		if fetchErr := st.fetchCandidate(ctx, item); fetchErr != nil {
			return nil, fetchErr
		}
		if candidate, err = r.g.readCommit(ctx, item.CandidateHead); err != nil {
			return nil, err
		}
	}
	title, body := st.proposal(item)
	stamp := "0 +0000"
	if item.CreatedAt.Valid {
		stamp = strconv.FormatInt(item.CreatedAt.Time.Unix(), 10) + " +0000"
	}
	identity := "Smithers <smithers@smithers.sh> " + stamp
	commit, err := r.g.writeCommit(ctx, mythicalCommit{Tree: candidate.Tree, Parents: []string{r.mainTip}, Author: identity,
		Committer: identity, Message: title + "\n\n" + body + "\n"})
	if err != nil {
		return nil, err
	}
	branch := mythicalBranch(item)
	if item.PRHead != commit {
		// Record the intended head first: a crash after the push is settled
		// by comparing the branch with it.
		pending, _ := json.Marshal(map[string]string{"branch": branch, "expected": item.PRHead, "head": commit})
		next.PendingOp = pending
		saved, err := st.q.SaveMythicalItem(ctx, next)
		if err != nil {
			return nil, err
		}
		next = saved
		lease := "--force-with-lease=refs/heads/" + branch + ":" + item.PRHead
		if _, err := r.g.git(ctx, "push", "--porcelain", "--no-verify", lease, gh.GitURL, commit+":refs/heads/"+branch); err != nil {
			current, lsErr := r.g.lsRemote(ctx, gh.GitURL)
			if lsErr != nil || current["refs/heads/"+branch] != commit {
				next.State, next.Reason = "blocked", "the pull request branch "+branch+" moved outside Smithers"
				return &next, nil
			}
		}
		next.PRHead = commit
	}
	pull, err := s.github.FindPull(ctx, gh, branch)
	if err != nil {
		return nil, err
	}
	if pull == nil {
		repository, _, err := s.repository(ctx, r.row.RepositoryID)
		if err != nil {
			return nil, err
		}
		base := strings.TrimSpace(repository.DefaultBookmark)
		if base == "" {
			base = "main"
		}
		created, err := s.github.CreatePull(ctx, gh, title, branch, base, body)
		if err != nil {
			return nil, err
		}
		pull = &created
	}
	next.PRNumber = pgtype.Int8{Int64: pull.Number, Valid: true}
	next.PRURL, next.PRState, next.PendingOp = pull.URL, pull.State, nil
	next.State, next.Reason = "proposed", ""
	next.NextAttemptAt = pgtype.Timestamptz{Time: st.now.Add(mythicalPullPollEvery), Valid: true}
	return &next, nil
}

func mythicalBranch(item db.MythicalItem) string {
	if item.IssueNumber.Valid {
		return "smithers/issue-" + strconv.FormatInt(item.IssueNumber.Int64, 10)
	}
	return "smithers/change-" + strings.ReplaceAll(uuidString(item.ID), "-", "")[:12]
}

func (st *mythicalItemStep) proposal(item db.MythicalItem) (string, string) {
	summary := strings.TrimSpace(item.Summary)
	title, rest, _ := strings.Cut(summary, "\n")
	title = strings.TrimSpace(title)
	if title == "" {
		title = item.IssueTitle
	}
	if len(title) > 250 {
		title = title[:250]
	}
	body := strings.TrimSpace(rest)
	if item.IssueNumber.Valid {
		if body != "" {
			body += "\n\n"
		}
		body += "Closes #" + strconv.FormatInt(item.IssueNumber.Int64, 10)
	}
	body += "\n\nOne commit carrying this item's verified change from the repository's mythical stack."
	return title, strings.TrimSpace(body)
}

// follow reads the item's pull request: merged lands it (the fold adopts its
// changes), closed unmerged rejects it; the stack itself is untouched.
func (st *mythicalItemStep) follow(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	s, r := st.s, st.r
	if s.github == nil || !item.PRNumber.Valid || !r.row.ActorUserID.Valid {
		return nil, nil
	}
	if st.gh == nil && st.ghErr == nil {
		repository, owner, err := s.repository(ctx, r.row.RepositoryID)
		if err != nil {
			return nil, err
		}
		gh, err := s.github.Resolve(ctx, repository, owner, r.row.ActorUserID.Int64)
		st.gh, st.ghErr = &gh, err
	}
	if st.ghErr != nil {
		return nil, st.ghErr
	}
	pull, err := s.github.Pull(ctx, *st.gh, item.PRNumber.Int64)
	if err != nil {
		return nil, err
	}
	next := item
	next.NextAttemptAt = pgtype.Timestamptz{Time: st.now.Add(mythicalPullPollEvery), Valid: true}
	switch {
	case pull.Merged:
		next.PRState, next.PRMergeCommit, next.State, next.Reason = "merged", pull.MergeCommit, "landed", ""
	case pull.State == "closed":
		next.PRState, next.State, next.Reason = "closed", "rejected", "the pull request was closed without merging"
	default:
		next.PRState = pull.State
	}
	return &next, nil
}

// pin keeps a commit reachable from the control plane's own namespace.
func (s *MythicalService) pin(ctx context.Context, r *mythicalRun, commit string) error {
	ref := repohost.MythicalReservedRefNS + "keep/" + commit
	r.bridge.permit([]mythicalRefUpdate{{Ref: ref, Old: strings.Repeat("0", 40), New: commit}},
		repohost.ReceivePackMetadata{ControlPlane: true, PusherLogin: "smithers"})
	if _, err := r.g.git(ctx, "push", "--porcelain", "--no-verify", r.bridge.URL(), commit+":"+ref); err != nil {
		refs, lsErr := r.g.lsRemote(ctx, r.bridge.URL())
		if lsErr == nil && refs[ref] == commit {
			return nil
		}
		return fmt.Errorf("pin %s: %s", short(commit), sanitizeMirrorError(err, r.bridge.URL()))
	}
	return nil
}

// retainFor writes a commit into a lane workspace's source ref, the only ref
// the workspace's native import accepts, and answers that ref.
func (s *MythicalService) retainFor(ctx context.Context, r *mythicalRun, workspaceID, commit string) (string, error) {
	ref := repohost.WorkspaceSourceRef(workspaceID, commit)
	if !r.g.has(ctx, commit) {
		if err := r.g.fetch(ctx, r.bridge.URL(), 0, 0, repohost.MythicalBookmarkRef); err != nil {
			return "", fmt.Errorf("fetch the stack: %s", sanitizeMirrorError(err, r.bridge.URL()))
		}
	}
	r.bridge.permit([]mythicalRefUpdate{{Ref: ref, Old: strings.Repeat("0", 40), New: commit}},
		repohost.ReceivePackMetadata{WorkspaceID: workspaceID, PusherLogin: "smithers"})
	if _, err := r.g.git(ctx, "push", "--porcelain", "--no-verify", r.bridge.URL(), commit+":"+ref); err != nil {
		refs, lsErr := r.g.lsRemote(ctx, r.bridge.URL())
		if lsErr == nil && refs[ref] == commit {
			return ref, nil
		}
		return "", fmt.Errorf("retain %s for the lane: %s", short(commit), sanitizeMirrorError(err, r.bridge.URL()))
	}
	return ref, nil
}

// MythicalFlowHostTargetResolver authorizes an item's lane launches against
// the persisted item and stack before the flowhost resolver starts a host.
type MythicalFlowHostTargetResolver struct{ service *MythicalService }

func NewMythicalFlowHostTargetResolver(service *MythicalService) *MythicalFlowHostTargetResolver {
	return &MythicalFlowHostTargetResolver{service: service}
}

func (resolver *MythicalFlowHostTargetResolver) ResolveFlowHostTarget(ctx context.Context, target flowruntime.FlowRuntimeTarget) (flowhost.Authority, error) {
	if resolver == nil || resolver.service == nil || target.BindingKind != mythicalBindingKind {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_unsupported"}
	}
	repositoryID, repositoryOK := scopedFlowRuntimeID(target.TenantID, "repository:")
	userID, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	id, err := uuid.Parse(target.BindingID)
	if !repositoryOK || !userOK || err != nil {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_invalid"}
	}
	q := resolver.service.queries()
	item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_not_found"}
		}
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: true}
	}
	stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
	if err != nil {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: !errors.Is(err, pgx.ErrNoRows)}
	}
	if item.RepositoryID != repositoryID || !stack.ActorUserID.Valid || stack.ActorUserID.Int64 != userID || item.WorkspaceID == "" ||
		(target.WorkspaceID != "" && target.WorkspaceID != item.WorkspaceID) {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}
	return flowhost.Authority{Target: target, RepositoryID: repositoryID, UserID: userID, WorkspaceID: item.WorkspaceID,
		CatalogKey: flowhost.CatalogCoding}, nil
}

type mythicalFlowFailure struct {
	code      string
	retryable bool
}

func (failure mythicalFlowFailure) Error() string              { return "mythical Flow runtime: " + failure.code }
func (failure mythicalFlowFailure) FlowRuntimeCode() string    { return failure.code }
func (failure mythicalFlowFailure) FlowRuntimeRetryable() bool { return failure.retryable }

// workspaceMythicalLanes provisions one fresh workspace per item attempt on
// the stack's own bookmark, so no lane ever holds two versions of a change,
// and deletes it when the item leaves the lane.
type workspaceMythicalLanes struct{ workspaces *WorkspaceService }

// NewWorkspaceMythicalLanes backs lanes with the repository's workspaces.
func NewWorkspaceMythicalLanes(workspaces *WorkspaceService) *workspaceMythicalLanes {
	return &workspaceMythicalLanes{workspaces: workspaces}
}

func (l *workspaceMythicalLanes) Create(ctx context.Context, repository db.Repository, owner string, actorUserID int64, name string) (string, error) {
	if l == nil || l.workspaces == nil || l.workspaces.q == nil {
		return "", pkgerrors.Internal("workspaces are unavailable")
	}
	workspace, err := l.workspaces.createDerivedWorkspaceForBookmark(ctx, repository.ID, actorUserID, name, MythicalBookmark, workspaceCreateMetadata{})
	if err != nil {
		return "", err
	}
	l.workspaces.provisionWorkspaceAsync(ctx, workspace, CreateWorkspaceSessionInput{RepositoryID: repository.ID, UserID: actorUserID,
		RepoOwner: owner, RepoName: repository.Name, SourceBookmark: MythicalBookmark})
	return workspace.ID, nil
}

func (l *workspaceMythicalLanes) Delete(ctx context.Context, repositoryID, actorUserID int64, workspaceID string) error {
	if l == nil || l.workspaces == nil {
		return nil
	}
	err := l.workspaces.DeleteWorkspace(ctx, workspaceID, repositoryID, actorUserID)
	var api *pkgerrors.APIError
	if errors.As(err, &api) && api.Status == 404 {
		return nil
	}
	return err
}

// SetMaxParallel sets how many lanes work at once (1..8).
func (s *MythicalService) SetMaxParallel(ctx context.Context, repositoryID int64, maxParallel int32) error {
	if maxParallel < 1 || maxParallel > 8 {
		return pkgerrors.BadRequest("maxParallel must be between 1 and 8")
	}
	updated, err := s.queries().SetMythicalMaxParallel(ctx, repositoryID, maxParallel)
	if err != nil {
		return err
	}
	if updated == 0 {
		return pkgerrors.NotFound("this repository has no mythical stack")
	}
	return nil
}

// RetryItem gives a blocked, rejected or declined item a fresh set of attempts.
func (s *MythicalService) RetryItem(ctx context.Context, repositoryID int64, itemID string) (MythicalItemView, error) {
	id, err := uuid.Parse(itemID)
	if err != nil {
		return MythicalItemView{}, pkgerrors.BadRequest("invalid item id")
	}
	q := s.queries()
	for range 3 {
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && item.RepositoryID != repositoryID) {
			return MythicalItemView{}, pkgerrors.NotFound("item not found")
		}
		if err != nil {
			return MythicalItemView{}, err
		}
		if item.State != "blocked" && item.State != "rejected" && item.State != "skipped" {
			return MythicalItemView{}, pkgerrors.Conflict("only a blocked, rejected or skipped item is retried")
		}
		if item.Source != "issue" {
			return MythicalItemView{}, pkgerrors.Conflict("request a chat change again from its workspace")
		}
		next := item
		next.State, next.Reason, next.Attempt, next.NextAttemptAt = "queued", "", 0, pgtype.Timestamptz{}
		next.PRState = ""
		saved, err := q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return MythicalItemView{}, err
		}
		if stack, err := q.GetMythicalStack(ctx, repositoryID); err == nil {
			s.itemChanged(ctx, q, stack, saved.ID)
		}
		return mythicalItemView(saved), nil
	}
	return MythicalItemView{}, pkgerrors.Conflict("the item changed concurrently; retry")
}

// ObserveGitHubEvent admits an issue event for every stack whose repository's
// GitHub source it is. Other events are ignored.
func (s *MythicalService) ObserveGitHubEvent(ctx context.Context, eventType string, payload []byte) error {
	if s == nil || !strings.EqualFold(strings.TrimSpace(eventType), "issues") {
		return nil
	}
	var event struct {
		Issue      *mythicalGitHubIssue `json:"issue"`
		Repository *struct {
			Name  string `json:"name"`
			Owner struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"repository"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Issue == nil || event.Repository == nil {
		return nil
	}
	ids, err := s.queries().ListRepositoryIDsForGitHubSource(ctx, event.Repository.Owner.Login, event.Repository.Name)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := s.ObserveIssue(ctx, id, event.Issue.issue()); err != nil {
			return err
		}
	}
	return nil
}
