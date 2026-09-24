package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Append observations reuse the existing task and native transaction receipt.
// Neither the queue state nor a mutable bookmark can prove the append landed.
type LandingAppendObservation struct {
	Status  string               `json:"status"`
	TaskID  int64                `json:"task_id"`
	Request repohost.LandRequest `json:"request"`
	Result  *repohost.LandResult `json:"result,omitempty"`
}

func (s *LandingService) ObserveLandingAppend(ctx context.Context, viewer *db.User, owner, repo string, number int64) (LandingAppendObservation, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingAppendObservation{}, err
	}
	if err = s.requireReadAccess(ctx, repository, viewer); err != nil {
		return LandingAppendObservation{}, err
	}
	row, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingAppendObservation{}, err
	}
	task, err := s.queries.GetLandingTaskByLandingRequestID(ctx, row.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return LandingAppendObservation{}, pkgerrors.New(pkgerrors.CodeAppendTaskMissing, "append has not been queued")
	}
	if err != nil {
		return LandingAppendObservation{}, pkgerrors.Internal("failed to load append task")
	}
	request, err := decodeLandingAppend(task, landingRecordFromRow(row))
	if err != nil {
		return LandingAppendObservation{}, pkgerrors.New(pkgerrors.CodeAppendReceiptInvalid, "durable append request is invalid")
	}
	if request == nil {
		return LandingAppendObservation{}, pkgerrors.New(pkgerrors.CodeAppendNotRequested, "landing task is not an append")
	}
	result, err := readLandingAppendReceipt(ctx, s.repoHost, owner, repo, *request)
	if err != nil {
		return LandingAppendObservation{}, pkgerrors.New(pkgerrors.CodeAppendReceiptUnavailable, "exact native append receipt could not be verified")
	}
	observation := LandingAppendObservation{TaskID: task.ID, Request: *request, Result: result}
	if result != nil {
		observation.Status = "landed"
		return observation, nil
	}
	switch task.Status {
	case "append_pending":
		observation.Status = "pending"
	case "running":
		observation.Status = "running"
	case "failed":
		observation.Status = "failed"
	default:
		return LandingAppendObservation{}, pkgerrors.New(pkgerrors.CodeAppendReceiptInvalid, "append task state has no matching native receipt")
	}
	return observation, nil
}
