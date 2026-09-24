package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFCov_LinearIntegrations_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	teamID := "team-" + randSlug(t)
	webhookKey := "wk-" + randSlug(t)
	integration, err := q.CreateLinearIntegration(ctx, CreateLinearIntegrationParams{
		UserID:                userID,
		OrgID:                 pgtype.Int8{},
		LinearTeamID:          teamID,
		LinearTeamName:        "Team",
		LinearTeamKey:         "TM",
		AccessTokenEncrypted:  []byte("at"),
		RefreshTokenEncrypted: []byte("rt"),
		TokenExpiresAt:        pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		WebhookKey:            webhookKey,
		WebhookSecret:         "secret",
		JjhubRepoID:           repoID,
		JjhubRepoOwner:        "owner",
		JjhubRepoName:         "repo",
		LinearActorID:         "actor",
	})
	require.NoError(t, err)
	assert.True(t, integration.IsActive)

	got, err := q.GetLinearIntegration(ctx, integration.ID)
	require.NoError(t, err)
	assert.Equal(t, integration.ID, got.ID)

	byTeam, err := q.GetLinearIntegrationByLinearTeamID(ctx, teamID)
	require.NoError(t, err)
	assert.Equal(t, integration.ID, byTeam.ID)

	byUserAndID, err := q.GetLinearIntegrationByUserAndID(ctx, GetLinearIntegrationByUserAndIDParams{ID: integration.ID, UserID: userID})
	require.NoError(t, err)
	assert.Equal(t, integration.ID, byUserAndID.ID)

	byWebhook, err := q.GetLinearIntegrationByWebhookKey(ctx, webhookKey)
	require.NoError(t, err)
	assert.Equal(t, integration.ID, byWebhook.ID)

	active, err := q.ListActiveLinearIntegrations(ctx)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(active), 1)
	byRepo, err := q.ListLinearIntegrationsByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, byRepo, 1)
	byUser, err := q.ListLinearIntegrationsByUser(ctx, userID)
	require.NoError(t, err)
	require.Len(t, byUser, 1)

	// Issue map chain.
	issue := mustCreateIssue(t, q, repoID, userID, "linear issue")
	issueMap, err := q.CreateLinearIssueMap(ctx, CreateLinearIssueMapParams{
		IntegrationID: integration.ID, JjhubIssueID: issue.ID, JjhubIssueNumber: issue.Number,
		LinearIssueID: "li-" + randSlug(t), LinearIdentifier: "ENG-1",
	})
	require.NoError(t, err)

	byLinearIssue, err := q.GetLinearIssueMapByLinearIssue(ctx, GetLinearIssueMapByLinearIssueParams{IntegrationID: integration.ID, LinearIssueID: issueMap.LinearIssueID})
	require.NoError(t, err)
	assert.Equal(t, issueMap.ID, byLinearIssue.ID)
	bySmithersIssue, err := q.GetLinearIssueMapBySmithersIssue(ctx, GetLinearIssueMapBySmithersIssueParams{IntegrationID: integration.ID, JjhubIssueID: issue.ID})
	require.NoError(t, err)
	assert.Equal(t, issueMap.ID, bySmithersIssue.ID)
	issueMaps, err := q.ListLinearIssueMaps(ctx, integration.ID)
	require.NoError(t, err)
	require.Len(t, issueMaps, 1)

	// Comment map chain.
	linearCommentID := "lc-" + randSlug(t)
	commentMap, err := q.CreateLinearCommentMap(ctx, CreateLinearCommentMapParams{
		IssueMapID: issueMap.ID, JjhubCommentID: 101, LinearCommentID: linearCommentID,
	})
	require.NoError(t, err)
	byLinearComment, err := q.GetLinearCommentMapByLinearComment(ctx, GetLinearCommentMapByLinearCommentParams{IssueMapID: issueMap.ID, LinearCommentID: linearCommentID})
	require.NoError(t, err)
	assert.Equal(t, commentMap.ID, byLinearComment.ID)
	bySmithersComment, err := q.GetLinearCommentMapBySmithersComment(ctx, GetLinearCommentMapBySmithersCommentParams{IssueMapID: issueMap.ID, JjhubCommentID: 101})
	require.NoError(t, err)
	assert.Equal(t, commentMap.ID, bySmithersComment.ID)
	byGlobalSmithersComment, err := q.GetLinearCommentMapBySmithersCommentID(ctx, GetLinearCommentMapBySmithersCommentIDParams{IntegrationID: integration.ID, JjhubCommentID: 101})
	require.NoError(t, err)
	assert.Equal(t, commentMap.ID, byGlobalSmithersComment.ID)
	issueByComment, err := q.GetLinearIssueMapBySmithersCommentID(ctx, GetLinearIssueMapBySmithersCommentIDParams{IntegrationID: integration.ID, JjhubCommentID: 101})
	require.NoError(t, err)
	assert.Equal(t, issueMap.ID, issueByComment.ID)
	require.NoError(t, q.DeleteLinearCommentMapByLinearComment(ctx, DeleteLinearCommentMapByLinearCommentParams{IssueMapID: issueMap.ID, LinearCommentID: linearCommentID}))
	// Recreate then delete by smithers-comment id.
	_, err = q.CreateLinearCommentMap(ctx, CreateLinearCommentMapParams{IssueMapID: issueMap.ID, JjhubCommentID: 202, LinearCommentID: "lc2-" + randSlug(t)})
	require.NoError(t, err)
	require.NoError(t, q.DeleteLinearCommentMapBySmithersComment(ctx, DeleteLinearCommentMapBySmithersCommentParams{IssueMapID: issueMap.ID, JjhubCommentID: 202}))

	// Sync op log + recency check.
	_, err = q.LogLinearSyncOp(ctx, LogLinearSyncOpParams{
		IntegrationID: integration.ID, Source: "jjhub", Target: "linear", Entity: "issue",
		EntityID: "e-" + randSlug(t), Action: "create", Status: "success", ErrorMessage: "",
	})
	require.NoError(t, err)
	exists, err := q.RecentLinearSyncOpExists(ctx, RecentLinearSyncOpExistsParams{
		IntegrationID: integration.ID, Entity: "issue", EntityID: "missing", Action: "create",
	})
	require.NoError(t, err)
	assert.False(t, exists)

	// Durable sync run counters.
	run, err := q.CreateLinearSyncRun(ctx, integration.ID)
	require.NoError(t, err)
	run, err = q.MarkLinearSyncRunRunning(ctx, run.ID)
	require.NoError(t, err)
	assert.Equal(t, "running", run.State)
	run, err = q.SetLinearSyncRunTotals(ctx, SetLinearSyncRunTotalsParams{ID: run.ID, IssuesTotal: 2, CommentsTotal: 1})
	require.NoError(t, err)
	run, err = q.RecordLinearSyncRunResult(ctx, RecordLinearSyncRunResultParams{ID: run.ID, Entity: "issue", Failed: false})
	require.NoError(t, err)
	run, err = q.RecordLinearSyncRunResult(ctx, RecordLinearSyncRunResultParams{ID: run.ID, Entity: "issue", Failed: true})
	require.NoError(t, err)
	run, err = q.FinishLinearSyncRun(ctx, run.ID)
	require.NoError(t, err)
	assert.Equal(t, "failed", run.State)
	assert.Equal(t, int32(1), run.IssuesDone)
	assert.Equal(t, int32(1), run.IssuesFailed)
	storedRun, err := q.GetLinearSyncRun(ctx, GetLinearSyncRunParams{ID: run.ID, IntegrationID: integration.ID})
	require.NoError(t, err)
	assert.True(t, storedRun.FinishedAt.Valid)

	// A failed operation retains its private replay payload and creates a new
	// pending row when retried. Feed filters remain newest-first and scoped to
	// the integration.
	failedOp, err := q.LogLinearSyncOp(ctx, LogLinearSyncOpParams{
		IntegrationID: integration.ID,
		RunID:         pgtype.Int8{Int64: run.ID, Valid: true},
		Source:        "jjhub",
		Target:        "linear",
		Entity:        "issue",
		EntityID:      "44",
		Action:        "update",
		Status:        "failed",
		ErrorMessage:  "provider error verbatim",
		Payload:       []byte(`{"action":"edited"}`),
	})
	require.NoError(t, err)
	failedOps, err := q.ListLinearSyncOps(ctx, ListLinearSyncOpsParams{
		IntegrationID: integration.ID,
		StatusFilter:  "failed",
		Since:         pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true},
		PageSize:      10,
	})
	require.NoError(t, err)
	require.Len(t, failedOps, 1)
	assert.Equal(t, failedOp.ID, failedOps[0].ID)
	assert.Equal(t, "provider error verbatim", failedOps[0].ErrorMessage)
	retry, err := q.CreateLinearSyncOpRetry(ctx, CreateLinearSyncOpRetryParams{OpID: failedOp.ID, IntegrationID: integration.ID})
	require.NoError(t, err)
	assert.Equal(t, "pending", retry.Status)
	assert.Equal(t, failedOp.ID, retry.RetryOfID.Int64)
	retry, err = q.CompleteLinearSyncOpRetry(ctx, CompleteLinearSyncOpRetryParams{ID: retry.ID, Status: "success", ErrorMessage: ""})
	require.NoError(t, err)
	assert.Equal(t, "success", retry.Status)

	// Updates.
	require.NoError(t, q.UpdateLinearIntegrationLastSync(ctx, integration.ID))
	require.NoError(t, q.UpdateLinearIntegrationTokens(ctx, UpdateLinearIntegrationTokensParams{
		ID: integration.ID, AccessTokenEncrypted: []byte("at2"), RefreshTokenEncrypted: []byte("rt2"),
		TokenExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(2 * time.Hour), Valid: true},
	}))
	require.NoError(t, q.UpdateLinearIntegrationActive(ctx, UpdateLinearIntegrationActiveParams{ID: integration.ID, IsActive: false}))

	// Delete.
	require.NoError(t, q.DeleteLinearIntegration(ctx, DeleteLinearIntegrationParams{ID: integration.ID, UserID: userID}))
	_, err = q.GetLinearIntegration(ctx, integration.ID)
	require.Error(t, err)
}
