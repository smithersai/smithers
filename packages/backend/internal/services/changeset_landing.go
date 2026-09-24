package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A durable plan records immutable inputs before any repository changes. Each
// storage operation writes its receipt atomically with the jj bookmark update.
// Replaying after a lost HTTP response therefore cannot land a second revision.
type changesetLandingPlan struct {
	Attempt string                   `json:"attempt"`
	Phase   string                   `json:"phase"`
	Members []changesetLandingMember `json:"members"`
	Super   changesetLandingMember   `json:"super"`
	Failure string                   `json:"failure,omitempty"`
}
type changesetLandingMember struct {
	ID       int64  `json:"id"`
	Repo     string `json:"repo"`
	Target   string `json:"target"`
	Commit   string `json:"commit"`
	Previous string `json:"previous"`
	Landed   string `json:"landed,omitempty"`
}

// LandChangeset resumes an interrupted attempt under the organization lock.
// Compensation is conditional: another writer's bookmark is never overwritten.
func (s *ChangesetService) LandChangeset(ctx context.Context, actor *db.User, orgName string, id int64) (ChangesetResponse, error) {
	if actor == nil {
		return ChangesetResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.requireOrgMember(ctx, actor, orgName)
	if err != nil {
		return ChangesetResponse{}, err
	}
	unlock, err := s.locker.LockOrganization(ctx, org.ID)
	if err != nil {
		return ChangesetResponse{}, pkgerrors.Internal("failed to serialize changeset landing").WithCause(err)
	}
	defer unlock()
	cs, members, super, err := s.loadChangeset(ctx, org, id)
	if err != nil {
		return ChangesetResponse{}, err
	}
	if err = s.requireMembersAccess(ctx, actor.ID, members, true); err != nil {
		return ChangesetResponse{}, err
	}
	if cs.State == changesetStateLanded {
		return ChangesetResponse{}, pkgerrors.Conflict("changeset is already landed")
	}
	if len(members) == 0 {
		return ChangesetResponse{}, pkgerrors.Conflict("changeset has no members")
	}
	var plan changesetLandingPlan
	if len(cs.LandingPlan) > 0 {
		if err = json.Unmarshal(cs.LandingPlan, &plan); err != nil {
			return ChangesetResponse{}, pkgerrors.Internal("invalid changeset recovery plan").WithCause(err)
		}
	}
	if cs.State == changesetStateLanding && plan.Attempt == "" {
		return ChangesetResponse{}, pkgerrors.Conflict("legacy landing has no recovery plan; reconcile repository bookmarks before retrying")
	}
	resuming := cs.State == changesetStateLanding && plan.Attempt != ""
	// Finish any interrupted compensation before starting a new attempt.
	if plan.Phase == "rollback" {
		if err = s.rollbackChangeset(ctx, org, cs.ID, &plan); err != nil {
			return ChangesetResponse{}, err
		}
	}
	if cs.State != changesetStateLanding || plan.Attempt == "" || plan.Phase == "rolled_back" {
		plan, err = s.prepareChangesetLanding(ctx, org, cs, members, super)
		if err != nil {
			_, _ = s.queries.MarkChangesetFailed(ctx, db.MarkChangesetFailedParams{ID: cs.ID, FailureReason: err.Error()})
			return ChangesetResponse{}, err
		}
		if err = s.saveChangesetPlan(ctx, cs.ID, changesetStateLanding, &plan); err != nil {
			return ChangesetResponse{}, err
		}
		for _, member := range plan.Members {
			if err = s.queries.RecordChangesetMemberPreviousCommit(ctx, db.RecordChangesetMemberPreviousCommitParams{ID: member.ID, PreviousCommitID: member.Previous}); err != nil {
				return ChangesetResponse{}, pkgerrors.Internal("failed to record previous head; retry is safe").WithCause(err)
			}
		}
	}
	if resuming && plan.Phase != "rolled_back" {
		if err = s.recoverChangesetReceipts(ctx, org.Name, &plan); err != nil {
			return ChangesetResponse{}, err
		}
		if err = s.saveChangesetPlan(ctx, cs.ID, changesetStateLanding, &plan); err != nil {
			return ChangesetResponse{}, err
		}
	}
	// Re-check policy on every retry, including permissions removed since the
	// initial attempt. Storage receives the pinned immutable commit, not change ID.
	if plan.Super.Landed == "" {
		for _, member := range members {
			repo, err := s.queries.GetRepoByID(ctx, member.RepositoryID)
			if err != nil {
				return ChangesetResponse{}, pkgerrors.Internal("failed to load member repository").WithCause(err)
			}
			if err = s.checkLandingPolicy(ctx, repo, org.Name, member.ChangeID, member.CommitID, member.TargetBookmark); err != nil {
				return ChangesetResponse{}, s.failChangesetLanding(ctx, org, cs.ID, &plan, err)
			}
		}
	}
	for i := range plan.Members {
		member := &plan.Members[i]
		if member.Landed != "" {
			continue
		}
		result, err := s.landChangesetMember(ctx, org.Name, *member, fmt.Sprintf("%s/member/%d", plan.Attempt, member.ID))
		if err != nil {
			if definiteLandingFailure(err) {
				return ChangesetResponse{}, s.failChangesetLanding(ctx, org, cs.ID, &plan, err)
			}
			return ChangesetResponse{}, pkgerrors.Internal("landing outcome is pending; retry will recover its storage receipt").WithCause(err)
		}
		member.Landed = result.TargetCommitID
		if err = s.saveChangesetPlan(ctx, cs.ID, changesetStateLanding, &plan); err != nil {
			return ChangesetResponse{}, err
		}
		if err = s.queries.RecordChangesetMemberLanded(ctx, db.RecordChangesetMemberLandedParams{ID: member.ID, LandedCommitID: member.Landed}); err != nil {
			return ChangesetResponse{}, pkgerrors.Internal("failed to record landed member; retry is safe").WithCause(err)
		}
	}
	// Persist the composed superproject input before landing it. Recomposition
	// after a crash can leave an unreferenced object, but cannot move a bookmark.
	if plan.Phase == "members" {
		pins := make([]repohost.SuperprojectMember, 0, len(plan.Members))
		merged := false
		for _, member := range plan.Members {
			pins = append(pins, repohost.SuperprojectMember{Path: member.Repo, CommitID: member.Landed})
			merged = merged || member.Commit != member.Landed
		}
		if merged {
			composed, err := s.repoHost.ComposeSuperproject(ctx, org.Name, super.Name, repohost.ComposeSuperprojectRequest{Members: pins, ParentChangeID: cs.CommitID, Description: "land changeset " + cs.ChangeID})
			if err != nil {
				return ChangesetResponse{}, s.failChangesetLanding(ctx, org, cs.ID, &plan, err)
			}
			plan.Super.Commit = composed.CommitID
		}
		plan.Phase = "superproject"
		if err = s.saveChangesetPlan(ctx, cs.ID, changesetStateLanding, &plan); err != nil {
			return ChangesetResponse{}, err
		}
	}
	if plan.Super.Landed == "" {
		change, err := s.repoHost.GetChange(ctx, org.Name, super.Name, plan.Super.Commit)
		if err != nil {
			return ChangesetResponse{}, s.failChangesetLanding(ctx, org, cs.ID, &plan, err)
		}
		if err = s.checkLandingPolicy(ctx, super, org.Name, change.ChangeID, plan.Super.Commit, plan.Super.Target); err != nil {
			return ChangesetResponse{}, s.failChangesetLanding(ctx, org, cs.ID, &plan, err)
		}
	}
	result, err := s.landChangesetMember(ctx, org.Name, plan.Super, plan.Attempt+"/superproject")
	if err != nil {
		if definiteLandingFailure(err) {
			return ChangesetResponse{}, s.failChangesetLanding(ctx, org, cs.ID, &plan, err)
		}
		return ChangesetResponse{}, pkgerrors.Internal("superproject landing outcome is pending; retry will recover its storage receipt").WithCause(err)
	}
	finalizeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	for _, member := range plan.Members {
		if err = s.queries.RecordChangesetMemberPreviousCommit(finalizeCtx, db.RecordChangesetMemberPreviousCommitParams{ID: member.ID, PreviousCommitID: member.Previous}); err != nil {
			return ChangesetResponse{}, pkgerrors.Internal("failed to finalize previous head; retry is safe").WithCause(err)
		}
		if err = s.queries.RecordChangesetMemberLanded(finalizeCtx, db.RecordChangesetMemberLandedParams{ID: member.ID, LandedCommitID: member.Landed}); err != nil {
			return ChangesetResponse{}, pkgerrors.Internal("failed to finalize member; retry is safe").WithCause(err)
		}
	}
	updated, err := s.queries.MarkChangesetLanded(finalizeCtx, db.MarkChangesetLandedParams{ID: cs.ID, LandedCommitID: result.TargetCommitID})
	if err != nil {
		return ChangesetResponse{}, pkgerrors.Internal("changeset landed; retry will finalize its record").WithCause(err)
	}
	finalMembers, err := s.queries.ListChangesetMembers(finalizeCtx, cs.ID)
	if err != nil {
		return ChangesetResponse{}, pkgerrors.Internal("failed to reload changeset members").WithCause(err)
	}
	return s.buildResponse(finalizeCtx, org, super, updated, finalMembers)
}

func (s *ChangesetService) prepareChangesetLanding(ctx context.Context, org db.Organization, cs db.Changeset, members []db.ChangesetMember, super db.Repository) (changesetLandingPlan, error) {
	plan := changesetLandingPlan{Attempt: uuid.NewString(), Phase: "members"}
	for _, member := range members {
		repo, err := s.queries.GetRepoByID(ctx, member.RepositoryID)
		if err != nil {
			return plan, pkgerrors.Internal("failed to load member repository").WithCause(err)
		}
		if err = s.checkLandingPolicy(ctx, repo, org.Name, member.ChangeID, member.CommitID, member.TargetBookmark); err != nil {
			return plan, err
		}
		change, err := s.repoHost.GetChange(ctx, org.Name, repo.Name, member.CommitID)
		if err != nil {
			return plan, mapChangesetRepoHostError(err, "member change", "failed to load pinned member")
		}
		if change.HasConflict {
			return plan, pkgerrors.Conflict("member has unresolved conflicts")
		}
		bookmark, _, err := s.findBookmark(ctx, org.Name, repo.Name, member.TargetBookmark)
		if err != nil {
			return plan, pkgerrors.Internal("failed to read member bookmark").WithCause(err)
		}
		plan.Members = append(plan.Members, changesetLandingMember{ID: member.ID, Repo: repo.Name, Target: member.TargetBookmark, Commit: member.CommitID, Previous: bookmark.TargetCommitID})
	}
	if err := s.checkLandingPolicy(ctx, super, org.Name, cs.ChangeID, cs.CommitID, cs.TargetBookmark); err != nil {
		return plan, err
	}
	bookmark, _, err := s.findBookmark(ctx, org.Name, super.Name, cs.TargetBookmark)
	if err != nil {
		return plan, pkgerrors.Internal("failed to read superproject bookmark").WithCause(err)
	}
	plan.Super = changesetLandingMember{Repo: super.Name, Target: cs.TargetBookmark, Commit: cs.CommitID, Previous: bookmark.TargetCommitID}
	return plan, nil
}

func (s *ChangesetService) landChangesetMember(ctx context.Context, owner string, member changesetLandingMember, key string) (repohost.LandResult, error) {
	landCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
	defer cancel()
	return s.repoHost.LandChanges(landCtx, owner, member.Repo, repohost.LandRequest{ChangeIDs: []string{member.Commit}, TargetBookmark: member.Target, ExpectedCommitID: &member.Previous, OperationKey: key})
}

func (s *ChangesetService) saveChangesetPlan(ctx context.Context, id int64, state string, plan *changesetLandingPlan) error {
	body, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	_, err = s.queries.SaveChangesetLandingPlan(saveCtx, db.SaveChangesetLandingPlanParams{ID: id, State: state, LandingPlan: body, FailureReason: plan.Failure})
	if err != nil {
		return pkgerrors.Internal("failed to persist changeset recovery plan; retry is safe").WithCause(err)
	}
	return nil
}

func definiteLandingFailure(err error) bool {
	var status *repohost.StatusError
	return errors.As(err, &status) && status.StatusCode >= 400 && status.StatusCode < 500
}

func (s *ChangesetService) failChangesetLanding(ctx context.Context, org db.Organization, id int64, plan *changesetLandingPlan, cause error) error {
	plan.Phase, plan.Failure = "rollback", cause.Error()
	if err := s.saveChangesetPlan(ctx, id, changesetStateLanding, plan); err != nil {
		return err
	}
	if err := s.rollbackChangeset(ctx, org, id, plan); err != nil {
		return err
	}
	var apiErr *pkgerrors.APIError
	if errors.As(cause, &apiErr) {
		return cause
	}
	return mapChangesetRepoHostError(cause, "changeset member", "failed to land changeset")
}

func (s *ChangesetService) rollbackChangeset(ctx context.Context, org db.Organization, id int64, plan *changesetLandingPlan) error {
	rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	var problems []string
	for i := len(plan.Members) - 1; i >= 0; i-- {
		member := &plan.Members[i]
		if member.Landed == "" {
			continue
		}
		current, _, err := s.findBookmark(rbCtx, org.Name, member.Repo, member.Target)
		if err == nil && current.TargetCommitID != member.Previous {
			_, err = s.repoHost.CreateBookmark(rbCtx, org.Name, member.Repo, repohost.CreateBookmarkRequest{Name: member.Target, TargetChangeID: member.Previous, ExpectedCommitID: &member.Landed, Delete: member.Previous == ""})
		}
		if err != nil {
			problems = append(problems, member.Repo+": "+summarizeRepoHostError(err))
			continue
		}
		member.Landed = ""
		if err = s.queries.RecordChangesetMemberLanded(rbCtx, db.RecordChangesetMemberLandedParams{ID: member.ID, LandedCommitID: ""}); err != nil {
			problems = append(problems, member.Repo+": failed to clear marker")
		}
	}
	if len(problems) > 0 {
		plan.Failure += "; rollback incomplete: " + strings.Join(problems, "; ")
		if err := s.saveChangesetPlan(rbCtx, id, changesetStateFailed, plan); err != nil {
			return err
		}
		return pkgerrors.Conflict(plan.Failure)
	}
	plan.Phase = "rolled_back"
	return s.saveChangesetPlan(rbCtx, id, changesetStateFailed, plan)
}

func (s *ChangesetService) recoverChangesetReceipts(ctx context.Context, owner string, plan *changesetLandingPlan) error {
	recoverOne := func(member *changesetLandingMember, key string) error {
		if member.Landed != "" {
			return nil
		}
		result, err := s.repoHost.LandChanges(ctx, owner, member.Repo, repohost.LandRequest{ChangeIDs: []string{member.Commit}, TargetBookmark: member.Target, ExpectedCommitID: &member.Previous, OperationKey: key, LookupOnly: true})
		var status *repohost.StatusError
		if errors.As(err, &status) && status.StatusCode == 404 {
			return nil
		}
		if err != nil {
			return pkgerrors.Internal("could not recover storage receipt; retry is safe").WithCause(err)
		}
		member.Landed = result.TargetCommitID
		return nil
	}
	for i := range plan.Members {
		if err := recoverOne(&plan.Members[i], fmt.Sprintf("%s/member/%d", plan.Attempt, plan.Members[i].ID)); err != nil {
			return err
		}
	}
	if plan.Phase == "superproject" {
		return recoverOne(&plan.Super, plan.Attempt+"/superproject")
	}
	return nil
}
