package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func immutableLandingCommit(id string) bool {
	if len(id) != 40 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validateLandingAppend(request repohost.LandRequest) error {
	if request.Append == nil || request.ExpectedCommitID == nil || !immutableLandingCommit(*request.ExpectedCommitID) ||
		!immutableLandingCommit(request.Append.SourceCommitID) || !immutableLandingCommit(request.Append.SourceBaseCommitID) ||
		strings.TrimSpace(request.Append.Description) == "" || len(request.Append.Description) > 32768 ||
		request.OperationKey == "" || len(request.ChangeIDs) == 0 || len(request.ChangeIDs) > maxLandingStackChanges || request.ChangeIDs[len(request.ChangeIDs)-1] != request.Append.SourceCommitID {
		return fmt.Errorf("append requires immutable source, source base, expected target, a receipt key, and a bounded description")
	}
	for _, id := range request.ChangeIDs {
		if !immutableLandingCommit(id) {
			return fmt.Errorf("append stack must contain immutable commit IDs")
		}
	}
	return nil
}

func (s *LandingService) prepareLandingAppend(ctx context.Context, repository db.Repository, owner, repo string, landing db.GetLandingRequestWithChangeIDsByNumberRow, input LandLandingRequestInput) (json.RawMessage, error) {
	if input.Append == nil {
		return nil, nil
	}
	if input.CommitID != input.Append.SourceCommitID {
		return nil, pkgerrors.BadRequest("append source must match commit_id")
	}
	if len(landing.ChangeIds) == 0 || len(landing.ChangeIds) > maxLandingStackChanges {
		return nil, pkgerrors.BadRequest("append requires a bounded complete landing stack")
	}
	request := repohost.LandRequest{TargetBookmark: landing.TargetBookmark, ExpectedCommitID: input.ExpectedCommitID, Append: input.Append}
	if native, ok := s.repoHost.(landingAppendPreparer); ok {
		if input.ExpectedCommitID == nil {
			return nil, pkgerrors.BadRequest("expected_commit_id is required")
		}
		prepared, err := native.PrepareLandAppend(ctx, owner, repo, repohost.AppendPreparationRequest{TargetBookmark: landing.TargetBookmark, ExpectedCommitID: *input.ExpectedCommitID, SourceCommitID: input.Append.SourceCommitID, SourceBaseCommitID: input.Append.SourceBaseCommitID})
		if err != nil {
			return nil, mapLandingRepoHostError(err, "failed to pin native append suffix")
		}
		if prepared.Status != "prepared" || len(prepared.Changes) != len(landing.ChangeIds) {
			return nil, pkgerrors.Conflict("landing does not contain the complete native append suffix")
		}
		for i, change := range prepared.Changes {
			if change.ChangeID != landing.ChangeIds[i] {
				return nil, pkgerrors.Conflict("landing native suffix order changed")
			}
			request.ChangeIDs = append(request.ChangeIDs, change.CommitID)
		}
	} else {
		for _, id := range landing.ChangeIds {
			change, err := s.repoHost.GetChange(ctx, owner, repo, id)
			if err != nil {
				return nil, mapLandingRepoHostError(err, "failed to pin append stack")
			}
			request.ChangeIDs = append(request.ChangeIDs, change.CommitID)
		}
	}
	// The immutable request is also the retry identity: no mutable task attempt or
	// current bookmark value participates after it has been durably enqueued.
	canonical, err := json.Marshal(request)
	if err != nil {
		return nil, pkgerrors.Internal("failed to encode append request").WithCause(err)
	}
	request.OperationKey = fmt.Sprintf("landing/%d/%d/append/%x", repository.ID, landing.ID, sha256.Sum256(canonical))
	if err := validateLandingAppend(request); err != nil {
		return nil, pkgerrors.BadRequest(err.Error())
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, pkgerrors.Internal("failed to encode append request").WithCause(err)
	}
	return encoded, nil
}

func decodeLandingAppend(task db.LandingTask, lr db.LandingRequest) (*repohost.LandRequest, error) {
	if len(task.AppendRequest) == 0 {
		return nil, nil
	}
	var request repohost.LandRequest
	if err := json.Unmarshal(task.AppendRequest, &request); err != nil {
		return nil, fmt.Errorf("invalid durable append request: %w", err)
	}
	if err := validateLandingAppend(request); err != nil {
		return nil, err
	}
	if request.TargetBookmark != lr.TargetBookmark || request.LookupOnly {
		return nil, fmt.Errorf("durable append request does not match landing target")
	}
	return &request, nil
}

func lookupLandingAppend(ctx context.Context, rh LandingWorkerRepoHostClient, owner, repo string, request repohost.LandRequest) (bool, error) {
	result, err := readLandingAppendReceipt(ctx, rh, owner, repo, request)
	return result != nil, err
}

func readLandingAppendReceipt(ctx context.Context, rh LandingWorkerRepoHostClient, owner, repo string, request repohost.LandRequest) (*repohost.LandResult, error) {
	request.LookupOnly = true
	result, err := rh.LandChanges(ctx, owner, repo, request)
	var status *repohost.StatusError
	if errors.As(err, &status) && status.StatusCode == 404 && status.Code == "landing_receipt_missing" {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("recover append receipt: %w", err)
	}
	if result.TargetBookmark != request.TargetBookmark || !immutableLandingCommit(result.TargetCommitID) || result.LandedCount != len(request.ChangeIDs) {
		return nil, fmt.Errorf("append receipt does not match the durable request")
	}
	return &result, nil
}

// Recover only an identical, previously authorized durable request. This runs
// after current caller authorization and never mutates storage. A missing ABI
// or route is not evidence that the operation did not commit.
func (s *LandingService) recoverLandingAppend(ctx context.Context, repository db.Repository, owner, repo string, landing db.GetLandingRequestWithChangeIDsByNumberRow, input LandLandingRequestInput) (json.RawMessage, bool, error) {
	if input.Append == nil {
		return nil, false, nil
	}
	task, err := s.queries.GetLandingTaskByLandingRequestID(ctx, landing.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, pkgerrors.Internal("failed to read append task").WithCause(err)
	}
	if len(task.AppendRequest) == 0 || (task.Status != "failed" && task.Status != "done") {
		return nil, false, nil
	}
	var request repohost.LandRequest
	if json.Unmarshal(task.AppendRequest, &request) != nil || validateLandingAppend(request) != nil {
		return nil, false, pkgerrors.Internal("invalid durable append request")
	}
	recovered, err := lookupLandingAppend(ctx, s.repoHost, owner, repo, request)
	if err != nil {
		return nil, false, pkgerrors.Internal("could not recover append receipt; retry is safe").WithCause(err)
	}
	if !recovered {
		return nil, false, nil
	}
	if request.TargetBookmark != landing.TargetBookmark || input.ExpectedCommitID == nil ||
		*request.ExpectedCommitID != *input.ExpectedCommitID || *request.Append != *input.Append || input.CommitID != request.Append.SourceCommitID {
		return nil, false, pkgerrors.Conflict("previous append already committed; retry its exact request to finish reconciliation")
	}
	return task.AppendRequest, true, nil
}
