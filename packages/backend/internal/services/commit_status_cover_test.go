package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type commitStatusCovFailDispatcher struct{}

func (commitStatusCovFailDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	return errors.New("queue down")
}

func (commitStatusCovFailDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return nil
}

func TestCommitStatus_Cov_DispatchAndResolveRepoNameBranches(t *testing.T) {
	q := &mockCommitStatusQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{Name: "loaded-name"}, nil
		},
	}
	dispatcher := &mockCommitStatusDispatcher{}
	svc := NewCommitStatusService(q, WithCommitStatusWebhookDispatcher(dispatcher))

	status := sampleCommitStatus()
	if err := svc.dispatchCommitStatusEvent(context.Background(), status.RepositoryID, svc.resolveRepoName(context.Background(), status.RepositoryID, ""), status, &db.User{ID: 5, Username: "alice"}); err != nil {
		t.Fatalf("dispatchCommitStatusEvent returned error: %v", err)
	}
	if len(dispatcher.calls) != 1 || dispatcher.calls[0].repoID != status.RepositoryID || dispatcher.calls[0].eventType != webhooks.EventTypeStatus {
		t.Fatalf("dispatch calls = %+v", dispatcher.calls)
	}
	payload := dispatcher.calls[0].payload.(webhooks.CommitStatusEventPayload)
	if payload.Repository.Name != "loaded-name" || payload.Sender.Login != "alice" || payload.CommitStatus.ChangeID == "" || payload.CommitStatus.SHA == "" {
		t.Fatalf("payload = %+v", payload)
	}

	if got := NewCommitStatusService(nil).resolveRepoName(context.Background(), 1, "fallback"); got != "fallback" {
		t.Fatalf("fallback repo name = %q", got)
	}
	if got := NewCommitStatusService(q).resolveRepoName(context.Background(), 1, "explicit"); got != "explicit" {
		t.Fatalf("explicit repo name = %q", got)
	}
}

func TestCommitStatus_Cov_ErrorBranches(t *testing.T) {
	t.Run("dispatch error maps internal", func(t *testing.T) {
		err := NewCommitStatusService(&mockCommitStatusQuerier{}, WithCommitStatusWebhookDispatcher(commitStatusCovFailDispatcher{})).
			dispatchCommitStatusEvent(context.Background(), 10, "demo", sampleCommitStatus(), nil)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})

	t.Run("workflow validation internal", func(t *testing.T) {
		runID := int64(9)
		q := &mockCommitStatusQuerier{
			getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, errors.New("db down")
			},
		}
		_, err := NewCommitStatusService(q).CreateCommitStatus(context.Background(), 10, "sha", CreateCommitStatusInput{
			Context: "ci", Status: "success", WorkflowRunID: &runID,
		})
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})

	t.Run("update not found", func(t *testing.T) {
		q := &mockCommitStatusQuerier{
			updateByWorkflowRunFn: func(context.Context, db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error) {
				return db.CommitStatus{}, pgx.ErrNoRows
			},
		}
		_, err := NewCommitStatusService(q).UpdateCommitStatusForWorkflowRun(context.Background(), 5, "success", "done", "")
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusNotFound {
			t.Fatalf("err = %#v, want not found", err)
		}
	})
}
