package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowArtifactsSQLHDB = chunk4SQLHDB
type workflowArtifactsSQLHRow = chunk4SQLHRow
type workflowArtifactsSQLHRows = chunk4SQLHRows

func TestWorkflowArtifactsSQL_H_RoundTripPruneAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID, runID := workflowArtifactsSQLHCreateRun(t, q, pool)
	expiresFuture := time.Now().Add(time.Hour)

	artifact, err := q.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
		RepositoryID:  repoID,
		WorkflowRunID: runID,
		Name:          "artifact-" + randSlug(t),
		Size:          123,
		ContentType:   "text/plain",
		ExpiresAt:     expiresFuture,
	})
	require.NoError(t, err)
	assert.Equal(t, "pending", artifact.Status)
	assert.Contains(t, artifact.GcsKey, artifact.Name)

	got, err := q.GetWorkflowArtifactByName(ctx, GetWorkflowArtifactByNameParams{WorkflowRunID: runID, Name: artifact.Name})
	require.NoError(t, err)
	assert.Equal(t, artifact.ID, got.ID)

	// A stale confirmer must not mark a same-name replacement ready.
	stale := artifact
	require.NoError(t, q.DeleteWorkflowArtifactByID(ctx, stale.ID))
	artifact, err = q.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
		RepositoryID: repoID, WorkflowRunID: runID, Name: stale.Name, Size: stale.Size,
		ContentType: stale.ContentType, ExpiresAt: expiresFuture,
	})
	require.NoError(t, err)
	_, err = q.ConfirmWorkflowArtifactUpload(ctx, ConfirmWorkflowArtifactUploadParams{
		ID: stale.ID, RepositoryID: stale.RepositoryID, WorkflowRunID: stale.WorkflowRunID,
		Name: stale.Name, GcsKey: stale.GcsKey,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	replacement, err := q.GetWorkflowArtifactByName(ctx, GetWorkflowArtifactByNameParams{WorkflowRunID: runID, Name: artifact.Name})
	require.NoError(t, err)
	assert.Equal(t, "pending", replacement.Status)

	confirmed, err := q.ConfirmWorkflowArtifactUpload(ctx, ConfirmWorkflowArtifactUploadParams{
		ID: artifact.ID, RepositoryID: artifact.RepositoryID, WorkflowRunID: artifact.WorkflowRunID,
		Name: artifact.Name, GcsKey: artifact.GcsKey,
	})
	require.NoError(t, err)
	assert.Equal(t, "ready", confirmed.Status)
	assert.True(t, confirmed.ConfirmedAt.Valid)
	_ = mustExpectError(t, pool, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx,
			`UPDATE workflow_artifacts SET deletion_token = 'invalid-live-token' WHERE id = $1`, artifact.ID)
		return updateErr
	})

	attached, err := q.AttachWorkflowArtifactToRelease(ctx, AttachWorkflowArtifactToReleaseParams{
		WorkflowRunID:    runID,
		Name:             artifact.Name,
		ReleaseTag:       pgtype.Text{String: "v1.0.0", Valid: true},
		ReleaseAssetName: pgtype.Text{String: "asset.txt", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "v1.0.0", attached.ReleaseTag.String)
	assert.True(t, attached.ReleaseAttachedAt.Valid)

	listed, err := q.ListWorkflowArtifactsByRun(ctx, runID)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	assert.Equal(t, artifact.ID, listed[0].ID)
	emptyList, err := q.ListWorkflowArtifactsByRun(ctx, 999999)
	require.NoError(t, err)
	assert.Empty(t, emptyList)

	defName, err := q.GetWorkflowDefinitionNameByRunID(ctx, runID)
	require.NoError(t, err)
	assert.Equal(t, "build-h", defName)

	expired, err := q.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
		RepositoryID:  repoID,
		WorkflowRunID: runID,
		Name:          "expired-" + randSlug(t),
		Size:          1,
		ContentType:   "application/octet-stream",
		ExpiresAt:     time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)
	pruned, err := q.PruneExpiredWorkflowArtifacts(ctx, PruneExpiredWorkflowArtifactsParams{ExpiresBefore: time.Now(), LimitRows: 10})
	require.NoError(t, err)
	require.Len(t, pruned, 1)
	assert.Equal(t, expired.ID, pruned[0].ID)
	pruned, err = q.PruneExpiredWorkflowArtifacts(ctx, PruneExpiredWorkflowArtifactsParams{ExpiresBefore: time.Now(), LimitRows: 10})
	require.NoError(t, err)
	assert.Empty(t, pruned)

	require.NoError(t, q.DeleteWorkflowArtifact(ctx, DeleteWorkflowArtifactParams{WorkflowRunID: runID, Name: artifact.Name}))
	_, err = q.GetWorkflowArtifactByName(ctx, GetWorkflowArtifactByNameParams{WorkflowRunID: runID, Name: artifact.Name})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	byID, err := q.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
		RepositoryID: repoID, WorkflowRunID: runID, Name: "delete-by-id-" + randSlug(t), Size: 2, ContentType: "text/plain", ExpiresAt: expiresFuture,
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteWorkflowArtifactByID(ctx, byID.ID))
	_, err = q.GetWorkflowArtifactByName(ctx, GetWorkflowArtifactByNameParams{WorkflowRunID: runID, Name: byID.Name})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.ConfirmWorkflowArtifactUpload(ctx, ConfirmWorkflowArtifactUploadParams{WorkflowRunID: runID, Name: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.AttachWorkflowArtifactToRelease(ctx, AttachWorkflowArtifactToReleaseParams{WorkflowRunID: runID, Name: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWorkflowDefinitionNameByRunID(ctx, 999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, otherRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	_, err = q.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
		RepositoryID: otherRepoID, WorkflowRunID: runID, Name: "wrong-repo-" + randSlug(t),
		Size: 1, ContentType: "text/plain", ExpiresAt: expiresFuture,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
			RepositoryID: repoID, WorkflowRunID: 999999, Name: "bad", Size: 1, ContentType: "text/plain", ExpiresAt: expiresFuture,
		})
		return err
	})
}

func TestListPrunableWorkflowArtifactsReleasedClaimObservesCooldown(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID, runID := workflowArtifactsSQLHCreateRun(t, q, pool)
	artifact, err := q.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
		RepositoryID: repoID, WorkflowRunID: runID, Name: "retry-" + randSlug(t),
		Size: 9, ContentType: "application/octet-stream", ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)

	token := pgtype.Text{String: "retry-cooldown-" + randSlug(t), Valid: true}
	_, err = q.ClaimWorkflowArtifactDeletion(ctx, ClaimWorkflowArtifactDeletionParams{
		ID: artifact.ID, RepositoryID: repoID, WorkflowRunID: runID, Name: artifact.Name,
		GcsKey: artifact.GcsKey, ExpectedStatus: "pending", DeletionToken: token,
	})
	require.NoError(t, err)
	require.NoError(t, q.ReleaseWorkflowArtifactDeletionClaim(ctx, ReleaseWorkflowArtifactDeletionClaimParams{
		ID: artifact.ID, RepositoryID: repoID, WorkflowRunID: runID, Name: artifact.Name,
		GcsKey: artifact.GcsKey, DeletionToken: token,
	}))

	params := ListPrunableWorkflowArtifactsParams{
		PendingCreatedBefore: time.Now().Add(-8 * 24 * time.Hour),
		ReadyExpiresBefore:   time.Now(),
		DeletionStaleBefore:  time.Now().Add(-5 * time.Minute),
		LimitRows:            10,
	}
	rows, err := q.ListPrunableWorkflowArtifacts(ctx, params)
	require.NoError(t, err)
	assert.NotContains(t, workflowArtifactIDs(rows), artifact.ID,
		"a tokenless failed deletion must not be retried immediately")

	_, err = pool.Exec(ctx, `UPDATE workflow_artifacts SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, artifact.ID)
	require.NoError(t, err)
	rows, err = q.ListPrunableWorkflowArtifacts(ctx, params)
	require.NoError(t, err)
	assert.Contains(t, workflowArtifactIDs(rows), artifact.ID)
}

func TestWorkflowArtifactDeletingClaimRejectsLegacyConfirmation(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID, runID := workflowArtifactsSQLHCreateRun(t, q, pool)
	artifact, err := q.CreateWorkflowArtifact(ctx, CreateWorkflowArtifactParams{
		RepositoryID: repoID, WorkflowRunID: runID, Name: "legacy-confirm-" + randSlug(t),
		Size: 19, ContentType: "text/plain", ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	token := pgtype.Text{String: "legacy-claim-" + randSlug(t), Valid: true}
	_, err = q.ClaimWorkflowArtifactDeletion(ctx, ClaimWorkflowArtifactDeletionParams{
		ID: artifact.ID, RepositoryID: repoID, WorkflowRunID: runID, Name: artifact.Name,
		GcsKey: artifact.GcsKey, ExpectedStatus: "pending", DeletionToken: token,
	})
	require.NoError(t, err)
	require.NoError(t, q.ReleaseWorkflowArtifactDeletionClaim(ctx, ReleaseWorkflowArtifactDeletionClaimParams{
		ID: artifact.ID, RepositoryID: repoID, WorkflowRunID: runID, Name: artifact.Name,
		GcsKey: artifact.GcsKey, DeletionToken: token,
	}))

	command, err := pool.Exec(ctx, `
		UPDATE workflow_artifacts
		SET status = 'ready', confirmed_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, artifact.ID)
	require.NoError(t, err)
	assert.Zero(t, command.RowsAffected())
	var (
		status        string
		deletionToken pgtype.Text
	)
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT status, deletion_token FROM workflow_artifacts WHERE id = $1`, artifact.ID,
	).Scan(&status, &deletionToken))
	assert.Equal(t, "deleting", status)
	assert.False(t, deletionToken.Valid)
}

func workflowArtifactIDs(rows []WorkflowArtifact) []int64 {
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func TestWorkflowArtifactsSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("workflow artifacts h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListWorkflowArtifactsByRun", func(q *Queries) error { _, err := q.ListWorkflowArtifactsByRun(context.Background(), 1); return err }},
		{"PruneExpiredWorkflowArtifacts", func(q *Queries) error {
			_, err := q.PruneExpiredWorkflowArtifacts(context.Background(), PruneExpiredWorkflowArtifactsParams{ExpiresBefore: time.Now(), LimitRows: 1})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(workflowArtifactsSQLHDB{queryErr: sentinel})), sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(workflowArtifactsSQLHDB{rows: &workflowArtifactsSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(workflowArtifactsSQLHDB{rows: &workflowArtifactsSQLHRows{err: sentinel}})), sentinel)
		})
	}
}

func TestWorkflowArtifactsSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("workflow artifacts h failed")
	rowQ := New(workflowArtifactsSQLHDB{row: workflowArtifactsSQLHRow{err: sentinel}})
	_, err := rowQ.AttachWorkflowArtifactToRelease(context.Background(), AttachWorkflowArtifactToReleaseParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.ConfirmWorkflowArtifactUpload(context.Background(), ConfirmWorkflowArtifactUploadParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.CreateWorkflowArtifact(context.Background(), CreateWorkflowArtifactParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetWorkflowArtifactByName(context.Background(), GetWorkflowArtifactByNameParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetWorkflowDefinitionNameByRunID(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)

	execQ := New(workflowArtifactsSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteWorkflowArtifact(context.Background(), DeleteWorkflowArtifactParams{}), sentinel)
	require.ErrorIs(t, execQ.DeleteWorkflowArtifactByID(context.Background(), 1), sentinel)
}

func workflowArtifactsSQLHCreateRun(t *testing.T, q *Queries, pool DBTX) (int64, int64, int64) {
	t.Helper()
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "build-h",
		Path:         ".smithers/workflows/build-" + randSlug(t) + ".yml",
		Config:       json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "refs/heads/main",
		TriggerCommitSha:     "sha-" + randSlug(t),
		DispatchInputs:       []byte(`{}`),
	})
	require.NoError(t, err)
	return userID, repoID, run.ID
}
