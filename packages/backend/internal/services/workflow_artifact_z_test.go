package services

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type workflowArtifactZDispatcher struct {
	err error
}

func (d workflowArtifactZDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	return d.err
}

func (d workflowArtifactZDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return d.err
}

type workflowArtifactZErrReader struct{}

func (workflowArtifactZErrReader) Read([]byte) (int, error) {
	return 0, errors.New("read failed")
}

func workflowArtifactZReadyArtifact() db.WorkflowArtifact {
	return db.WorkflowArtifact{
		ID:            7,
		RepositoryID:  workflowArtifactRun().RepositoryID,
		WorkflowRunID: workflowArtifactRun().ID,
		Name:          "build.tar.gz",
		Size:          64,
		ContentType:   "application/gzip",
		Status:        "ready",
		GcsKey:        "key/build.tar.gz",
	}
}

func workflowArtifactZQueries(artifact db.WorkflowArtifact) *mockWorkflowArtifactQuerier {
	return &mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return artifact, nil
		},
	}
}

func TestWorkflowArtifact_Z_ServiceGuardsLookupAndIssueUpload(t *testing.T) {
	ctx := context.Background()
	guardSvc := NewWorkflowArtifactService(nil, nil, time.Minute)

	_, err := guardSvc.IssueUploadURL(ctx, workflowArtifactRun(), WorkflowArtifactUploadInput{Name: "x", Size: 1})
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = guardSvc.ConfirmUpload(ctx, workflowArtifactRun(), "x", "")
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = guardSvc.ListArtifacts(ctx, 101, 55)
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = guardSvc.GetDownloadURL(ctx, 101, 55, "x")
	assert.Equal(t, 500, apiStatus(t, err))
	err = guardSvc.DeleteArtifact(ctx, 101, 55, "x")
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = guardSvc.AttachToRelease(ctx, 101, 55, "x", "v1", "")
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = guardSvc.PruneExpired(ctx, 1)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{}, &mockBlobStore{}, time.Minute).
		IssueUploadURL(ctx, workflowArtifactRun(), WorkflowArtifactUploadInput{Name: " ", Size: 1})
	assert.Equal(t, 422, apiStatus(t, err))

	_, err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{}, &mockBlobStore{}, time.Minute).
		ConfirmUpload(ctx, workflowArtifactRun(), "build.tar.gz", "")
	assert.Equal(t, 404, apiStatus(t, err))

	existing := workflowArtifactZReadyArtifact()
	_, err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return existing, nil
		},
	}, &mockBlobStore{
		deleteFn: func(context.Context, string) error { return errors.New("delete failed") },
	}, time.Minute).IssueUploadURL(ctx, workflowArtifactRun(), WorkflowArtifactUploadInput{Name: existing.Name, Size: 1})
	assert.Equal(t, 409, apiStatus(t, err), "immutable artifact names reject replacement before blob deletion")

	_, err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		listWorkflowArtifactsByRunFn: func(context.Context, int64) ([]db.WorkflowArtifact, error) {
			return nil, errors.New("list failed")
		},
	}, &mockBlobStore{}, time.Minute).ListArtifacts(ctx, 101, 55)
	assert.Equal(t, 500, apiStatus(t, err))

	runMissing := &mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}
	_, err = NewWorkflowArtifactService(runMissing, &mockBlobStore{}, time.Minute).GetDownloadURL(ctx, 101, 55, "build.tar.gz")
	assert.Equal(t, 404, apiStatus(t, err))
	err = NewWorkflowArtifactService(runMissing, &mockBlobStore{}, time.Minute).DeleteArtifact(ctx, 101, 55, "build.tar.gz")
	assert.Equal(t, 404, apiStatus(t, err))
	_, err = NewWorkflowArtifactService(runMissing, &mockBlobStore{}, time.Minute).AttachToRelease(ctx, 101, 55, "build.tar.gz", "v1", "")
	assert.Equal(t, 404, apiStatus(t, err))

	ready := workflowArtifactZReadyArtifact()
	_, err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
	}, &mockBlobStore{}, time.Minute).GetDownloadURL(ctx, 101, 55, "build.tar.gz")
	assert.Equal(t, 404, apiStatus(t, err))

	err = NewWorkflowArtifactService(workflowArtifactZQueries(ready), &mockBlobStore{}, time.Minute).DeleteArtifact(ctx, 101, 55, " ")
	assert.Equal(t, 422, apiStatus(t, err))
	_, err = NewWorkflowArtifactService(workflowArtifactZQueries(ready), &mockBlobStore{}, time.Minute).AttachToRelease(ctx, 101, 55, " ", "v1", "")
	assert.Equal(t, 422, apiStatus(t, err))

	err = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		getWorkflowRunFn: func(context.Context, db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return workflowArtifactRun(), nil
		},
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return ready, nil
		},
		deleteClaimedWorkflowArtifactFn: func(context.Context, db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{}, errors.New("delete failed")
		},
	}, &mockBlobStore{}, time.Minute).DeleteArtifact(ctx, 101, 55, ready.Name)
	assert.Equal(t, 500, apiStatus(t, err))

	err = NewWorkflowArtifactService(workflowArtifactZQueries(ready), &mockBlobStore{
		deleteFn: func(context.Context, string) error { return errors.New("blob delete failed") },
	}, time.Minute).DeleteArtifact(ctx, 101, 55, ready.Name)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkflowArtifact_Z_PruneAndPrivateHelperBranches(t *testing.T) {
	ctx := context.Background()

	emptyPrune := NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		listPrunableWorkflowArtifactsFn: func(context.Context, db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
			return nil, nil
		},
	}, &mockBlobStore{}, time.Minute)
	deleted, err := emptyPrune.PruneExpired(ctx, 5)
	require.NoError(t, err)
	assert.Equal(t, 0, deleted)

	nilBlobPrune := NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		listPrunableWorkflowArtifactsFn: func(context.Context, db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error) {
			return []db.WorkflowArtifact{{ID: 1, GcsKey: "old"}}, nil
		},
	}, nil, time.Minute)
	deleted, err = nilBlobPrune.PruneExpired(ctx, 5)
	require.Error(t, err)
	assert.Equal(t, 0, deleted)

	svc := NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return workflowArtifactZReadyArtifact(), nil
		},
		deleteClaimedWorkflowArtifactFn: func(context.Context, db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{}, errors.New("delete failed")
		},
	}, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
	_, err = svc.deleteWorkflowArtifactReservation(ctx, workflowArtifactZReadyArtifact())
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{}, errors.New("lookup failed")
		},
	}, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
	_, err = svc.lookupArtifact(ctx, 55, "build.tar.gz")
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = svc.lookupArtifact(ctx, 55, " ")
	assert.Equal(t, 422, apiStatus(t, err))

	svc = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{}, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
	_, err = svc.lookupArtifact(ctx, 55, "build.tar.gz")
	assert.Equal(t, 404, apiStatus(t, err))

	svc = NewWorkflowArtifactService(&mockWorkflowArtifactQuerier{
		getWorkflowArtifactByNameFn: func(context.Context, db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error) {
			return db.WorkflowArtifact{}, errors.New("lookup failed")
		},
	}, &mockBlobStore{}, time.Minute).(*workflowArtifactService)
	_, err = svc.lookupArtifact(ctx, 55, "build.tar.gz")
	assert.Equal(t, 500, apiStatus(t, err))

	assert.Empty(t, (&workflowArtifactService{}).resolveSourceWorkflowName(ctx, 55))
}

func TestWorkflowArtifact_Z_ConfirmDigestAndDispatchErrors(t *testing.T) {
	ctx := context.Background()
	pending := workflowArtifactZReadyArtifact()
	pending.Status = "pending"
	pending.Size = 11

	_, err := NewWorkflowArtifactService(workflowArtifactZQueries(pending), &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: 11}, nil
		},
	}, time.Minute, WithWorkflowArtifactMaxUploadSize(10)).
		ConfirmUpload(ctx, workflowArtifactRun(), pending.Name, "")
	assert.Equal(t, 400, apiStatus(t, err))

	pending.Size = 64
	_, err = NewWorkflowArtifactService(workflowArtifactZQueries(pending), &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: 64}, nil
		},
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return nil, blob.ErrObjectNotFound
		},
	}, time.Minute).ConfirmUpload(ctx, workflowArtifactRun(), pending.Name, "deadbeef")
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = NewWorkflowArtifactService(workflowArtifactZQueries(pending), &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: 64}, nil
		},
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(workflowArtifactZErrReader{}), nil
		},
	}, time.Minute).ConfirmUpload(ctx, workflowArtifactRun(), pending.Name, "deadbeef")
	assert.Equal(t, 500, apiStatus(t, err))

	svc := &workflowArtifactService{
		dispatcher: workflowArtifactZDispatcher{err: errors.New("dispatch failed")},
	}
	svc.dispatchConfirmedArtifactWebhook(ctx, 101, workflowArtifactZReadyArtifact(), "ci")

	svc.workflowRuns = &mockArtifactWorkflowRunService{
		dispatchFn: func(context.Context, DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, errors.New("dispatch failed")
		},
	}
	svc.dispatchConfirmedArtifactRuns(ctx, workflowArtifactRun(), workflowArtifactZReadyArtifact(), "ci")
}
