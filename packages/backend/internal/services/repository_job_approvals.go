package services

import (
	"context"
	"encoding/json"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// A registered flow runs a plan a person looked at and approved. The
// authenticated product route is the only writer of that provenance: the
// caller supplies the plan identity Control produced, and the approving account
// and moment come from the authenticated session and now(). No host, flow, or
// model can name either.
const repositoryJobApprovalWindow = 24 * time.Hour

type RepositoryJobApprovalInput struct {
	PlanID     string          `json:"plan_id"`
	PlanDigest string          `json:"plan_digest"`
	FlowID     string          `json:"flow_id"`
	Envelope   json.RawMessage `json:"envelope"`
}

type RepositoryJobApproval struct {
	Job        string    `json:"job"`
	PlanID     string    `json:"plan_id"`
	PlanDigest string    `json:"plan_digest"`
	FlowID     string    `json:"flow_id"`
	ApprovedBy int64     `json:"approved_by"`
	ApprovedAt time.Time `json:"approved_at"`
}

func repositoryJobApprovalOf(row db.RepositoryJobApproval) RepositoryJobApproval {
	return RepositoryJobApproval{Job: row.Job, PlanID: row.PlanID, PlanDigest: row.PlanDigest,
		FlowID: row.FlowID, ApprovedBy: row.ApprovedBy, ApprovedAt: row.ApprovedAt}
}

func (s *RepositoryJobService) RecordApproval(ctx context.Context, repoID, userID int64, job string, input RepositoryJobApprovalInput) (RepositoryJobApproval, error) {
	var empty RepositoryJobApproval
	if !repositoryFlowJobKey.MatchString(job) || !repositoryJobFlowName.MatchString(input.FlowID) {
		return empty, pkgerrors.BadRequest("invalid repository job or registered flow")
	}
	if input.PlanID == "" || len(input.PlanID) > 200 || !repositoryJobDigest.MatchString(input.PlanDigest) {
		return empty, pkgerrors.BadRequest("a flow trigger must name the plan a person approved")
	}
	if err := validateRepositoryJobEnvelope(input.Envelope); err != nil {
		return empty, err
	}
	if _, err := s.authorizedRepo(ctx, repoID, userID, true); err != nil {
		return empty, err
	}
	row, err := s.q.UpsertRepositoryJobApproval(ctx, db.UpsertRepositoryJobApprovalParams{
		RepositoryID: repoID, Job: job, PlanDigest: input.PlanDigest, PlanID: input.PlanID,
		FlowID: input.FlowID, Envelope: input.Envelope, ApprovedBy: userID,
	})
	if err != nil {
		return empty, pkgerrors.Internal("could not record the approved plan").WithCause(err)
	}
	return repositoryJobApprovalOf(row), nil
}

func (s *RepositoryJobService) Approvals(ctx context.Context, repoID, userID int64, job string) ([]RepositoryJobApproval, error) {
	if !repositoryFlowJobKey.MatchString(job) {
		return nil, pkgerrors.BadRequest("unknown repository job")
	}
	if _, err := s.authorizedRepo(ctx, repoID, userID, false); err != nil {
		return nil, err
	}
	rows, err := s.q.ListRepositoryJobApprovals(ctx, db.ListRepositoryJobApprovalsParams{RepositoryID: repoID, Job: job})
	if err != nil {
		return nil, err
	}
	result := make([]RepositoryJobApproval, 0, len(rows))
	for _, row := range rows {
		result = append(result, repositoryJobApprovalOf(row))
	}
	return result, nil
}

// The registration must reproduce one stored approval exactly: same plan, same
// flow, inside the window, and stamped by an account that still holds write.
func (s *RepositoryJobService) requireApprovedPlan(ctx context.Context, store RepositoryJobStore, repoID int64, job string, input RegisterRepositoryJobInput) error {
	refused := pkgerrors.Conflict("register only the plan a person approved; approve the preview, then apply")
	row, err := store.GetRepositoryJobApproval(ctx, db.GetRepositoryJobApprovalParams{
		RepositoryID: repoID, Job: job, PlanDigest: input.ApprovedPlanDigest,
	})
	if err != nil || row.PlanID != input.ApprovedPlanID || row.FlowID != input.FlowID {
		return refused
	}
	if s.now().Sub(row.ApprovedAt) > repositoryJobApprovalWindow {
		return refused
	}
	if _, err := (&RepositoryJobService{q: store}).authorizedRepo(ctx, repoID, row.ApprovedBy, true); err != nil {
		return refused
	}
	return nil
}
