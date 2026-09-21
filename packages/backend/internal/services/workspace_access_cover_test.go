package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestWorkspaceAccess_Cov_RequireAccessBranches(t *testing.T) {
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	if err := svc.requireWorkspaceAccess(context.Background(), "ws", 1, 1, WorkspaceAccessWrite); err != nil {
		t.Fatalf("owner access err = %v", err)
	}

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: "ws", GranteeUserID: 2, Level: "read"}, nil
		},
	})
	if err := svc.requireWorkspaceAccess(context.Background(), "ws", 1, 2, WorkspaceAccessRead); err != nil {
		t.Fatalf("read share read err = %v", err)
	}
	err := svc.requireWorkspaceAccess(context.Background(), "ws", 1, 2, WorkspaceAccessWrite)
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusForbidden {
		t.Fatalf("read share write err = %#v", err)
	}

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{}, pgx.ErrNoRows
		},
	})
	err = svc.requireWorkspaceAccess(context.Background(), "ws", 1, 2, WorkspaceAccessRead)
	apiErr, ok = err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusForbidden {
		t.Fatalf("missing share err = %#v", err)
	}

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{}, errors.New("db down")
		},
	})
	err = svc.requireWorkspaceAccess(context.Background(), "ws", 1, 2, WorkspaceAccessRead)
	apiErr, ok = err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusInternalServerError {
		t.Fatalf("share internal err = %#v", err)
	}
}

func TestWorkspaceAccess_Cov_TouchWorkspaceEntryRecency(t *testing.T) {
	var nilSvc *WorkspaceService
	nilSvc.touchWorkspaceEntryRecency(context.Background(), "ws", "path")
	NewWorkspaceService(nil).touchWorkspaceEntryRecency(context.Background(), "ws", "path")

	calls := 0
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		touchWorkspaceLastAccessedFn: func(context.Context, string) error {
			calls++
			return errors.New("ignored")
		},
	})
	svc.touchWorkspaceEntryRecency(context.Background(), "  ", "path")
	if calls != 0 {
		t.Fatalf("empty workspace id touched %d times", calls)
	}
	svc.touchWorkspaceEntryRecency(context.Background(), " ws ", "path")
	if calls != 1 {
		t.Fatalf("touch calls = %d", calls)
	}
}
