package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdmitGitHubEvent is only called from the signed, deduplicated GitHub job
// worker. The original issue/comment objects never grant repository authority.
func (s *RepositoryJobService) AdmitGitHubEvent(ctx context.Context, repoID int64, job db.GithubWebhookJob, event TriggerEvent) error {
	if strings.TrimSpace(job.DeliveryID) == "" {
		return fmt.Errorf("github job is missing its signed-body delivery identity")
	}
	var payload struct {
		Issue *struct {
			Number int64 `json:"number"`
		} `json:"issue"`
		Pull *struct {
			Number int64 `json:"number"`
		} `json:"pull_request"`
	}
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return err
	}
	var number int64
	if payload.Issue != nil {
		number = payload.Issue.Number
	} else if payload.Pull != nil {
		number = payload.Pull.Number
	}
	return s.q.AdmitRepositoryJobEvent(ctx, db.AdmitRepositoryJobEventParams{
		RepositoryID: repoID, DeliveryKey: "github:" + job.DeliveryID, Source: "github",
		EventType: event.Type, EventAction: event.Action, IssueNumber: number, Payload: job.Payload,
	})
}

// Admission and execution are independent durable queues: an accepted webhook
// is retained even when a workspace is asleep, or before the setup host receives
// the newly-created trial issue's number. No network job runs in the UI request.
func (s *RepositoryJobService) Start(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.PollOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Error("repository job worker", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func repositoryJobMatches(config RegisterRepositoryJobInput, event db.RepositoryJobEvent) bool {
	matched := false
	for _, rule := range config.Events {
		if NormalizeTriggerName(rule.Type) != NormalizeTriggerName(event.EventType) {
			continue
		}
		if len(rule.Actions) == 0 {
			matched = true
		}
		for _, action := range rule.Actions {
			if strings.EqualFold(strings.TrimSpace(action), strings.TrimSpace(event.EventAction)) {
				matched = true
			}
		}
	}
	if !matched || config.Label == "" || config.Mode == "trial" {
		return matched
	}
	var payload struct {
		Issue struct {
			Labels []struct {
				Name string `json:"name"`
			} `json:"labels"`
		} `json:"issue"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return false
	}
	for _, label := range payload.Issue.Labels {
		if label.Name == config.Label {
			return true
		}
	}
	return false
}

func (s *RepositoryJobService) PollOnce(ctx context.Context) error {
	if err := s.q.SkipRetiredRepositoryJobDispatches(ctx); err != nil {
		return err
	}
	admissions, err := s.q.ListRepositoryJobAdmissions(ctx, 100)
	if err != nil {
		return err
	}
	for _, row := range admissions {
		reg, event := row.RepositoryJobRegistration, row.RepositoryJobEvent
		var config RegisterRepositoryJobInput
		if err := json.Unmarshal(reg.Configuration, &config); err != nil {
			return fmt.Errorf("invalid repository job registration %s", reg.ID)
		}
		status := "skipped"
		if repositoryJobMatches(config, event) {
			status = "queued"
		}
		if err := s.q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{
			ID: reg.ID, Revision: reg.Revision, DeliveryKey: event.DeliveryKey, Source: event.Source,
			EventType: event.EventType, EventAction: event.EventAction, IssueNumber: event.IssueNumber,
			Payload: event.Payload, Status: status,
		}); err != nil {
			return err
		}
	}
	if err := s.enqueueSchedules(ctx); err != nil {
		return err
	}
	claims, err := s.q.ClaimRepositoryJobDispatches(ctx, 1)
	if err != nil {
		return err
	}
	for _, claim := range claims {
		// A bounded attempt may provision a sleeping workspace, but never holds
		// its DB claim longer than the two-minute fencing lease.
		attemptCtx, cancel := context.WithTimeout(ctx, 80*time.Second)
		err := s.dispatch(attemptCtx, claim)
		cancel()
		if err != nil {
			finalizeCtx, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			status := "queued"
			var apiErr *pkgerrors.APIError
			if claim.Attempts >= 8 || errors.As(err, &apiErr) && (apiErr.Status == 401 || apiErr.Status == 403 || apiErr.Status == 404) {
				status = "failed"
			}
			_, saveErr := s.settle(finalizeCtx, claim, status, claim.RunID, nil, err.Error())
			done()
			if saveErr != nil {
				return saveErr
			}
		}
	}
	return nil
}

func (s *RepositoryJobService) enqueueSchedules(ctx context.Context) error {
	registrations, err := s.q.ListDueRepositoryJobSchedules(ctx, 50)
	if err != nil {
		return err
	}
	for _, reg := range registrations {
		next, err := nextFireTime(reg.Schedule, s.now())
		if err != nil || next.IsZero() {
			return fmt.Errorf("invalid stored repository job schedule %s", reg.ID)
		}
		key := "schedule:" + reg.NextFireAt.Time.UTC().Format(time.RFC3339Nano)
		payload, _ := json.Marshal(map[string]interface{}{"scheduledAt": reg.NextFireAt.Time})
		if err := s.q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{
			ID: reg.ID, Revision: reg.Revision, DeliveryKey: key, Source: "schedule", EventType: "schedule",
			Payload: payload, Status: "queued",
		}); err != nil {
			return err
		}
		// If the process dies here, the same occurrence inserts once again via
		// the unique key. Only then may its next-fire timestamp advance.
		if _, err := s.q.AdvanceRepositoryJobSchedule(ctx, db.AdvanceRepositoryJobScheduleParams{
			ID: reg.ID, Revision: reg.Revision, NextFireAt: reg.NextFireAt, NextFireAt_2: pgtype.Timestamptz{Time: next, Valid: true},
		}); err != nil {
			return err
		}
	}
	return nil
}

type repositoryJobPlan struct {
	PlanID          string          `json:"planId"`
	FlowID          string          `json:"flowId"`
	Digest          string          `json:"digest"`
	ExecutionDigest string          `json:"executionDigest"`
	Envelope        json.RawMessage `json:"envelope"`
	Approval        json.RawMessage `json:"approval"`
}

func repositoryJobDispatchEvent(reg db.RepositoryJobRegistration, claim db.RepositoryJobDispatch) map[string]interface{} {
	event := map[string]interface{}{"source": claim.Source, "type": claim.EventType, "action": claim.EventAction,
		"deliveryKey": claim.DeliveryKey, "issueNumber": claim.IssueNumber, "payload": claim.Payload}
	// The source payload is untrusted. Trial authority comes only from the
	// persisted registration and its exact source/issue scope, never its body.
	if reg.Mode == "trial" && reg.TrialIssueNumber > 0 && reg.TrialIssueNumber == claim.IssueNumber && reg.TrialSource == claim.Source {
		event["trial"] = true
	}
	if claim.EventType == "manual" && strings.HasPrefix(claim.DeliveryKey, "manual:") && strings.HasPrefix(claim.EventAction, "manual:") {
		step := strings.TrimPrefix(claim.EventAction, "manual:")
		if repositoryJobManualStep.MatchString(step) {
			event["manualStep"] = step
		}
	}
	return event
}

func (s *RepositoryJobService) connectionInput(ctx context.Context, reg db.RepositoryJobRegistration) (RepoGatewayConnectionInput, error) {
	repo, err := s.authorizedRepo(ctx, reg.RepositoryID, reg.UserID, true)
	if err != nil {
		return RepoGatewayConnectionInput{}, err
	}
	var owner string
	if repo.UserID.Valid {
		user, err := s.q.GetUserByID(ctx, repo.UserID.Int64)
		if err != nil {
			return RepoGatewayConnectionInput{}, err
		}
		owner = user.Username
	} else if repo.OrgID.Valid {
		org, err := s.q.GetOrgByID(ctx, repo.OrgID.Int64)
		if err != nil {
			return RepoGatewayConnectionInput{}, err
		}
		owner = org.Name
	}
	if owner == "" {
		return RepoGatewayConnectionInput{}, pkgerrors.NotFound("repository owner is unavailable")
	}
	return RepoGatewayConnectionInput{RepositoryID: repo.ID, WorkspaceID: reg.WorkspaceID, UserID: reg.UserID,
		RepoOwner: owner, RepoName: repo.Name, RepoDefaultBookmark: repo.DefaultBookmark, RequiredCapability: repositoryJobsCapability}, nil
}

func (s *RepositoryJobService) dispatch(ctx context.Context, claim db.RepositoryJobDispatch) error {
	reg, err := s.q.GetRepositoryJobRegistration(ctx, claim.RegistrationID)
	if err != nil {
		return err
	}
	if !reg.Enabled || reg.Revision != claim.Revision || reg.Digest != claim.Digest {
		_, err := s.settle(ctx, claim, "skipped", "", nil, "Registration was paused or replaced")
		return err
	}
	var config RegisterRepositoryJobInput
	if err := json.Unmarshal(reg.Configuration, &config); err != nil {
		return err
	}
	connection, err := s.connectionInput(ctx, reg)
	if err != nil {
		return err
	}
	call := func(procedure string, input interface{}) (json.RawMessage, error) {
		payload, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		return s.gateway.CallRepositoryJob(ctx, connection, repositoryJobsCapability, procedure, payload)
	}
	event := repositoryJobDispatchEvent(reg, claim)
	key := "repository-job:" + claim.ID
	if claim.EventType == "issue_comment" && claim.IssueNumber > 0 {
		previous, err := s.q.LatestRepositoryJobIssueRun(ctx, db.LatestRepositoryJobIssueRunParams{
			RegistrationID: reg.ID, Revision: reg.Revision, Source: claim.Source, IssueNumber: claim.IssueNumber,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			var runs struct {
				Items []struct{ RunID, Status string } `json:"items"`
			}
			body, err := call("List", map[string]interface{}{"_tag": "runs", "filters": map[string]string{"runId": previous.RunID}, "limit": 1})
			if err != nil {
				return err
			}
			if err := json.Unmarshal(body, &runs); err != nil || len(runs.Items) != 1 || runs.Items[0].RunID != previous.RunID {
				return fmt.Errorf("gateway could not recover the issue's previous run")
			}
			status := runs.Items[0].Status
			if status != "completed" && status != "failed" && status != "cancelled" {
				result, err := call("Signal", map[string]interface{}{"runId": previous.RunID,
					"signal": map[string]interface{}{"name": "repository-job.author-reply", "payload": event}, "idempotencyKey": fmt.Sprintf("%s:reply:%d", key, claim.SignalAttempt)})
				var rpcErr *RepositoryJobRPCError
				if errors.As(err, &rpcErr) && strings.HasSuffix(rpcErr.Tag, "NoMatchingWait") {
					// Control permanently records NoMatchingWait as rejected. Only
					// that definitive refusal may advance the attempt key. An
					// ambiguous transport failure must retry the existing command.
					_, saveErr := s.q.RetryRepositoryJobSignal(ctx, db.RetryRepositoryJobSignalParams{ID: claim.ID, ClaimToken: claim.ClaimToken, RunID: previous.RunID, NextAttemptAt: s.now().Add(10 * time.Second)})
					return saveErr
				}
				if err != nil {
					return err
				}
				var receipt struct {
					Tag string `json:"_tag"`
				}
				if json.Unmarshal(result, &receipt) != nil || (receipt.Tag != "Accepted" && receipt.Tag != "AlreadyApplied") {
					return fmt.Errorf("gateway did not accept the author reply")
				}
				_, err = s.settle(ctx, claim, "submitted", previous.RunID, result, "")
				return err
			}
		}
	}
	var plan repositoryJobPlan
	if len(claim.Plan) == 0 {
		// A registered flow receives exactly the input a person approved. Trigger
		// provenance remains in the durable dispatch row and idempotency key.
		var planInput interface{}
		if repositoryFlowJobKey.MatchString(reg.Job) {
			planInput = json.RawMessage(config.Input)
		} else {
			planInput = map[string]interface{}{"repo": connection.RepoOwner + "/" + connection.RepoName, "job": reg.Job,
				"revision": reg.Revision, "digest": reg.Digest, "sourceRevision": reg.SourceRevision,
				"configuration": config.Input, "event": event}
		}
		body, err := call("Plan", map[string]interface{}{"flowId": reg.FlowID, "input": planInput, "idempotencyKey": key + ":plan"})
		if err != nil {
			return err
		}
		claim.Plan = body
		rows, err := s.q.SaveRepositoryJobPlan(ctx, db.SaveRepositoryJobPlanParams{ID: claim.ID, ClaimToken: claim.ClaimToken, Plan: body})
		if err != nil {
			return err
		}
		if rows != 1 {
			return fmt.Errorf("repository job claim expired before its plan was saved")
		}
	}
	if json.Unmarshal(claim.Plan, &plan) != nil || plan.PlanID == "" || plan.Digest == "" || plan.FlowID != reg.FlowID ||
		plan.ExecutionDigest != config.ExecutionDigest || !sameRepositoryJobJSON(plan.Envelope, config.Envelope) ||
		(repositoryFlowJobKey.MatchString(reg.Job) && plan.Digest != config.ApprovedPlanDigest) {
		_, err := s.settle(ctx, claim, "failed", "", nil, "The registered flow or its authority changed; review and apply a new version")
		return err
	}
	var approval map[string]json.RawMessage
	var target struct {
		Tag      string          `json:"_tag"`
		PlanID   string          `json:"planId"`
		Digest   string          `json:"digest"`
		Envelope json.RawMessage `json:"envelope"`
	}
	if json.Unmarshal(plan.Approval, &approval) != nil || json.Unmarshal(approval["target"], &target) != nil ||
		target.Tag != "Plan" || target.PlanID != plan.PlanID || target.Digest != plan.Digest || !sameRepositoryJobJSON(target.Envelope, config.Envelope) {
		return fmt.Errorf("gateway returned an invalid automatic plan approval")
	}
	// Recheck the active policy immediately before granting this plan. This
	// never submits a Node decision: prompts asking a person still wait.
	current, err := s.q.GetRepositoryJobRegistration(ctx, reg.ID)
	if err != nil {
		return err
	}
	if !current.Enabled || current.Revision != reg.Revision || current.Digest != reg.Digest {
		_, err := s.settle(ctx, claim, "skipped", "", nil, "Registration was paused or replaced")
		return err
	}
	if _, err := s.authorizedRepo(ctx, reg.RepositoryID, reg.UserID, true); err != nil {
		return err
	}
	approval["decision"] = json.RawMessage(`"approve"`)
	if _, err := call("Approval.Submit", approval); err != nil {
		return err
	}
	result, err := call("Run", map[string]interface{}{"_tag": "Plan", "planId": plan.PlanID,
		"digest": plan.Digest, "envelope": plan.Envelope, "idempotencyKey": key + ":run"})
	if err != nil {
		return err
	}
	var receipt struct {
		Tag   string `json:"_tag"`
		RunID string `json:"runId"`
	}
	if json.Unmarshal(result, &receipt) != nil {
		return fmt.Errorf("gateway returned an invalid run receipt")
	}
	if receipt.Tag == "Parked" {
		_, err := s.settle(ctx, claim, "waiting", "", result, "Waiting for plan approval")
		return err
	}
	if (receipt.Tag != "Accepted" && receipt.Tag != "AlreadyApplied" && receipt.Tag != "Terminal") || receipt.RunID == "" {
		return fmt.Errorf("gateway did not return an accepted run identity")
	}
	_, err = s.settle(ctx, claim, "submitted", receipt.RunID, result, "")
	return err
}

func (s *RepositoryJobService) settle(ctx context.Context, claim db.RepositoryJobDispatch, status, runID string, receipt json.RawMessage, message string) (int64, error) {
	if len(message) > 1000 {
		message = message[:1000]
	}
	backoff := time.Duration(1<<min(claim.Attempts, 6)) * time.Second
	if status == "waiting" {
		backoff = 10 * time.Second
	}
	return s.q.SettleRepositoryJobDispatch(ctx, db.SettleRepositoryJobDispatchParams{ID: claim.ID, ClaimToken: claim.ClaimToken,
		Status: status, RunID: runID, Receipt: receipt, Error: message, NextAttemptAt: s.now().Add(backoff)})
}
