package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestRepoConnection_Cov_SetTrackerAndNormalize(t *testing.T) {
	var nilSvc *RepoConnectionService
	nilSvc.SetGitHubBudgetTracker(NewBudgetTrackerWithLimits(1, time.Minute))

	svc := NewRepoConnectionService(&mockRepoConnectionDB{})
	tracker := NewBudgetTrackerWithLimits(2, time.Minute)
	svc.SetGitHubBudgetTracker(tracker)
	if svc.gitHubBudgetTracker != tracker {
		t.Fatal("SetGitHubBudgetTracker did not install tracker")
	}

	owner, repo, err := normalizeRepoRef(" Alice ", " Demo ")
	if err != nil || owner != "alice" || repo != "demo" {
		t.Fatalf("normalizeRepoRef = %q, %q, %v", owner, repo, err)
	}
	if _, _, err := normalizeRepoRef("", "repo"); err == nil || !strings.Contains(err.Error(), "owner") {
		t.Fatalf("missing owner err = %v", err)
	}
	if _, _, err := normalizeRepoRef("alice", " "); err == nil || !strings.Contains(err.Error(), "repository name") {
		t.Fatalf("missing repo err = %v", err)
	}
}

func TestRepoConnection_Cov_StatusAndDisconnectBranches(t *testing.T) {
	t.Run("status connected", func(t *testing.T) {
		now := time.Now().UTC()
		svc := NewRepoConnectionService(&mockRepoConnectionDB{
			queryRowFn: func(context.Context, string, ...any) pgx.Row {
				return mockRepoConnectionRow{scanFn: func(dest ...any) error {
					*(dest[0].(*int64)) = 9
					*(dest[1].(*string)) = "Alice"
					*(dest[2].(*string)) = "Demo"
					*(dest[3].(*string)) = "Apache-2.0"
					*(dest[4].(*time.Time)) = now
					*(dest[5].(*time.Time)) = now
					return nil
				}}
			},
		})
		status, err := svc.GetRepoConnectionStatus(context.Background(), 9, "alice", "demo")
		if err != nil {
			t.Fatalf("GetRepoConnectionStatus returned error: %v", err)
		}
		if !status.Connected || status.LicenseSPDX != "Apache-2.0" || status.Owner != "Alice" {
			t.Fatalf("status = %+v", status)
		}
	})

	t.Run("scan error maps internal", func(t *testing.T) {
		svc := NewRepoConnectionService(&mockRepoConnectionDB{
			queryRowFn: func(context.Context, string, ...any) pgx.Row {
				return mockRepoConnectionRow{scanFn: func(...any) error { return errors.New("scan failed") }}
			},
		})
		_, err := svc.GetRepoConnectionStatus(context.Background(), 1, "alice", "demo")
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})

	t.Run("disconnect false and exec error", func(t *testing.T) {
		svc := NewRepoConnectionService(&mockRepoConnectionDB{
			execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
				return pgconn.NewCommandTag("DELETE 0"), nil
			},
		})
		deleted, err := svc.DisconnectRepo(context.Background(), 1, "alice", "demo")
		if err != nil || deleted {
			t.Fatalf("deleted=%v err=%v, want false nil", deleted, err)
		}

		svc = NewRepoConnectionService(&mockRepoConnectionDB{
			execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
				return pgconn.CommandTag{}, errors.New("db down")
			},
		})
		_, err = svc.DisconnectRepo(context.Background(), 1, "alice", "demo")
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})
}
