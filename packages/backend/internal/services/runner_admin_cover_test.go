package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type runnerAdminCovQuerier struct {
	countErr error
	listErr  error
	countArg string
	listArg  db.ListRunnersParams
}

func (q *runnerAdminCovQuerier) ListRunners(_ context.Context, arg db.ListRunnersParams) ([]db.RunnerPool, error) {
	q.listArg = arg
	if q.listErr != nil {
		return nil, q.listErr
	}
	return []db.RunnerPool{{ID: 1, Name: "runner-1", Status: arg.StatusFilter}}, nil
}

func (q *runnerAdminCovQuerier) CountRunners(_ context.Context, statusFilter string) (int64, error) {
	q.countArg = statusFilter
	if q.countErr != nil {
		return 0, q.countErr
	}
	return 1, nil
}

func TestRunnerAdmin_Cov_ListPaginationAndErrors(t *testing.T) {
	q := &runnerAdminCovQuerier{}
	rows, total, err := NewRunnerAdminService(q).ListRunners(context.Background(), RunnerAdminListInput{Page: -1, PerPage: -1, StatusFilter: "idle"})
	if err != nil || total != 1 || len(rows) != 1 || q.listArg.PageOffset != 0 || q.listArg.PageSize != 30 || q.countArg != "idle" {
		t.Fatalf("rows=%+v total=%d err=%v q=%+v", rows, total, err, q)
	}

	_, _, err = NewRunnerAdminService(q).ListRunners(context.Background(), RunnerAdminListInput{StatusFilter: "invalid"})
	runnerAdminCovRequireStatus(t, err, http.StatusBadRequest)

	q = &runnerAdminCovQuerier{countErr: errors.New("count failed")}
	_, _, err = NewRunnerAdminService(q).ListRunners(context.Background(), RunnerAdminListInput{})
	runnerAdminCovRequireStatus(t, err, http.StatusInternalServerError)

	q = &runnerAdminCovQuerier{listErr: errors.New("list failed")}
	_, _, err = NewRunnerAdminService(q).ListRunners(context.Background(), RunnerAdminListInput{})
	runnerAdminCovRequireStatus(t, err, http.StatusInternalServerError)
}

func runnerAdminCovRequireStatus(t *testing.T, err error, status int) {
	t.Helper()
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != status {
		t.Fatalf("err = %#v, want status %d", err, status)
	}
}
