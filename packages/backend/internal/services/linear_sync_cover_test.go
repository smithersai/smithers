package services

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type linearSyncCovQuerier struct {
	integration  db.LinearIntegration
	integrations []db.LinearIntegration

	listIntegrationsErr     error
	getIntegrationByTeamErr error
	recentExists            bool
	recentErr               error
	issueMap                db.LinearIssueMap
	issueMapByLinear        db.LinearIssueMap
	issueMapBySmithersErr   error
	issueMapByLinearErr     error
	commentMap              db.LinearCommentMap
	commentMapBySmithersErr error
	commentMapByLinearErr   error

	createdIssueMaps       []db.CreateLinearIssueMapParams
	createdCommentMaps     []db.CreateLinearCommentMapParams
	deletedSmithersComment []db.DeleteLinearCommentMapBySmithersCommentParams
	deletedLinearComment   []db.DeleteLinearCommentMapByLinearCommentParams
	logs                   []db.LogLinearSyncOpParams
	logErr                 error
	lastSyncIDs            []int64

	createIssueErr         error
	createIssueMapErr      error
	createdIssue           db.Issue
	updatedIssueComment    []db.UpdateIssueCommentParams
	updateIssueCommentErr  error
	getIssueCommentErr     error
	issueComment           db.IssueComment
	deletedIssueCommentIDs []int64
	deleteIssueCommentErr  error
}

func (q *linearSyncCovQuerier) GetLinearIntegration(ctx context.Context, id int64) (db.LinearIntegration, error) {
	return q.integration, nil
}

func (q *linearSyncCovQuerier) GetLinearIntegrationByLinearTeamID(ctx context.Context, linearTeamID string) (db.LinearIntegration, error) {
	if q.getIntegrationByTeamErr != nil {
		return db.LinearIntegration{}, q.getIntegrationByTeamErr
	}
	if q.integration.LinearTeamID == linearTeamID {
		return q.integration, nil
	}
	return db.LinearIntegration{}, pgx.ErrNoRows
}

func (q *linearSyncCovQuerier) ListLinearIntegrationsByRepo(ctx context.Context, smithersRepoID int64) ([]db.LinearIntegration, error) {
	if q.listIntegrationsErr != nil {
		return nil, q.listIntegrationsErr
	}
	if q.integrations != nil {
		return q.integrations, nil
	}
	return []db.LinearIntegration{q.integration}, nil
}

func (q *linearSyncCovQuerier) UpdateLinearIntegrationLastSync(ctx context.Context, id int64) error {
	q.lastSyncIDs = append(q.lastSyncIDs, id)
	return nil
}

func (q *linearSyncCovQuerier) CreateLinearIssueMap(ctx context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error) {
	if q.createIssueMapErr != nil {
		return db.LinearIssueMap{}, q.createIssueMapErr
	}
	q.createdIssueMaps = append(q.createdIssueMaps, arg)
	q.issueMap = db.LinearIssueMap{
		ID:               int64(len(q.createdIssueMaps)),
		IntegrationID:    arg.IntegrationID,
		JjhubIssueID:     arg.JjhubIssueID,
		JjhubIssueNumber: arg.JjhubIssueNumber,
		LinearIssueID:    arg.LinearIssueID,
		LinearIdentifier: arg.LinearIdentifier,
	}
	q.issueMapByLinear = q.issueMap
	return q.issueMap, nil
}

func (q *linearSyncCovQuerier) GetLinearIssueMapBySmithersIssue(ctx context.Context, arg db.GetLinearIssueMapBySmithersIssueParams) (db.LinearIssueMap, error) {
	if q.issueMapBySmithersErr != nil {
		return db.LinearIssueMap{}, q.issueMapBySmithersErr
	}
	if q.issueMap.LinearIssueID != "" || q.issueMap.ID != 0 {
		return q.issueMap, nil
	}
	return db.LinearIssueMap{}, pgx.ErrNoRows
}

func (q *linearSyncCovQuerier) GetLinearIssueMapByLinearIssue(ctx context.Context, arg db.GetLinearIssueMapByLinearIssueParams) (db.LinearIssueMap, error) {
	if q.issueMapByLinearErr != nil {
		return db.LinearIssueMap{}, q.issueMapByLinearErr
	}
	if q.issueMapByLinear.LinearIssueID != "" || q.issueMapByLinear.ID != 0 {
		return q.issueMapByLinear, nil
	}
	return db.LinearIssueMap{}, pgx.ErrNoRows
}

func (q *linearSyncCovQuerier) ListLinearIssueMaps(ctx context.Context, integrationID int64) ([]db.LinearIssueMap, error) {
	if q.issueMap.ID == 0 && q.issueMap.LinearIssueID == "" {
		return nil, nil
	}
	return []db.LinearIssueMap{q.issueMap}, nil
}

func (q *linearSyncCovQuerier) CreateLinearCommentMap(ctx context.Context, arg db.CreateLinearCommentMapParams) (db.LinearCommentMap, error) {
	q.createdCommentMaps = append(q.createdCommentMaps, arg)
	q.commentMap = db.LinearCommentMap{
		ID:              int64(len(q.createdCommentMaps)),
		IssueMapID:      arg.IssueMapID,
		JjhubCommentID:  arg.JjhubCommentID,
		LinearCommentID: arg.LinearCommentID,
	}
	return q.commentMap, nil
}

func (q *linearSyncCovQuerier) GetLinearCommentMapBySmithersComment(ctx context.Context, arg db.GetLinearCommentMapBySmithersCommentParams) (db.LinearCommentMap, error) {
	if q.commentMapBySmithersErr != nil {
		return db.LinearCommentMap{}, q.commentMapBySmithersErr
	}
	if q.commentMap.LinearCommentID != "" || q.commentMap.ID != 0 {
		return q.commentMap, nil
	}
	return db.LinearCommentMap{}, pgx.ErrNoRows
}

func (q *linearSyncCovQuerier) GetLinearCommentMapByLinearComment(ctx context.Context, arg db.GetLinearCommentMapByLinearCommentParams) (db.LinearCommentMap, error) {
	if q.commentMapByLinearErr != nil {
		return db.LinearCommentMap{}, q.commentMapByLinearErr
	}
	if q.commentMap.LinearCommentID != "" || q.commentMap.ID != 0 {
		return q.commentMap, nil
	}
	return db.LinearCommentMap{}, pgx.ErrNoRows
}

func (q *linearSyncCovQuerier) DeleteLinearCommentMapBySmithersComment(ctx context.Context, arg db.DeleteLinearCommentMapBySmithersCommentParams) error {
	q.deletedSmithersComment = append(q.deletedSmithersComment, arg)
	q.commentMap = db.LinearCommentMap{}
	return nil
}

func (q *linearSyncCovQuerier) DeleteLinearCommentMapByLinearComment(ctx context.Context, arg db.DeleteLinearCommentMapByLinearCommentParams) error {
	q.deletedLinearComment = append(q.deletedLinearComment, arg)
	q.commentMap = db.LinearCommentMap{}
	return nil
}

func (q *linearSyncCovQuerier) LogLinearSyncOp(ctx context.Context, arg db.LogLinearSyncOpParams) (db.LinearSyncOp, error) {
	if q.logErr != nil {
		return db.LinearSyncOp{}, q.logErr
	}
	q.logs = append(q.logs, arg)
	return db.LinearSyncOp{ID: int64(len(q.logs)), IntegrationID: arg.IntegrationID}, nil
}

func (q *linearSyncCovQuerier) RecentLinearSyncOpExists(ctx context.Context, arg db.RecentLinearSyncOpExistsParams) (bool, error) {
	return q.recentExists, q.recentErr
}

func (q *linearSyncCovQuerier) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	if q.createIssueErr != nil {
		return db.Issue{}, q.createIssueErr
	}
	if q.createdIssue.ID != 0 {
		return q.createdIssue, nil
	}
	return db.Issue{ID: 101, Number: 7, RepositoryID: arg.RepositoryID, AuthorID: arg.AuthorID, Title: arg.Title, Body: arg.Body}, nil
}

func (q *linearSyncCovQuerier) GetIssueCommentByID(ctx context.Context, id int64) (db.IssueComment, error) {
	if q.getIssueCommentErr != nil {
		return db.IssueComment{}, q.getIssueCommentErr
	}
	if q.issueComment.ID != 0 {
		return q.issueComment, nil
	}
	return db.IssueComment{ID: id, IssueID: 42}, nil
}

func (q *linearSyncCovQuerier) UpdateIssueComment(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error) {
	if q.updateIssueCommentErr != nil {
		return db.IssueComment{}, q.updateIssueCommentErr
	}
	q.updatedIssueComment = append(q.updatedIssueComment, arg)
	return db.IssueComment{ID: arg.ID, Body: arg.Body}, nil
}

func (q *linearSyncCovQuerier) DeleteIssueComment(ctx context.Context, id int64) error {
	if q.deleteIssueCommentErr != nil {
		return q.deleteIssueCommentErr
	}
	q.deletedIssueCommentIDs = append(q.deletedIssueCommentIDs, id)
	return nil
}

type linearSyncCovImportTx struct {
	createIssueErr error
	mapErr         error
	commitErr      error
	committed      bool
	rolledBack     bool
}

func (tx *linearSyncCovImportTx) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	if tx.createIssueErr != nil {
		return db.Issue{}, tx.createIssueErr
	}
	return db.Issue{ID: 303, Number: 13, Title: arg.Title, Body: arg.Body, AuthorID: arg.AuthorID}, nil
}

func (tx *linearSyncCovImportTx) CreateLinearIssueMap(ctx context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error) {
	if tx.mapErr != nil {
		return db.LinearIssueMap{}, tx.mapErr
	}
	return db.LinearIssueMap{IntegrationID: arg.IntegrationID, JjhubIssueID: arg.JjhubIssueID}, nil
}

func (tx *linearSyncCovImportTx) Commit(ctx context.Context) error {
	tx.committed = true
	return tx.commitErr
}

func (tx *linearSyncCovImportTx) Rollback(ctx context.Context) error {
	tx.rolledBack = true
	return nil
}

type linearSyncCovImportTxManager struct {
	tx       *linearSyncCovImportTx
	beginErr error
}

func (m *linearSyncCovImportTxManager) BeginLinearIssueImportTx(ctx context.Context) (linearIssueImportTx, error) {
	if m.beginErr != nil {
		return nil, m.beginErr
	}
	return m.tx, nil
}

func linearSyncCovIntegration(t *testing.T) (db.LinearIntegration, *LinearIntegrationService) {
	t.Helper()

	const secret = "linear-sync-cover-secret"
	key := smitherscrypto.DeriveKey(secret)
	accessToken, err := smitherscrypto.Encrypt(key, []byte("linear-access-cover"))
	require.NoError(t, err)
	webhookSecret, err := smitherscrypto.Encrypt(key, []byte("linear-webhook-cover"))
	require.NoError(t, err)

	integration := db.LinearIntegration{
		ID:                   11,
		UserID:               22,
		JjhubRepoID:          33,
		JjhubRepoOwner:       "acme",
		JjhubRepoName:        "repo",
		LinearTeamID:         "team-cover",
		LinearTeamName:       "Platform",
		LinearTeamKey:        "PLT",
		AccessTokenEncrypted: accessToken,
		WebhookSecret:        base64.StdEncoding.EncodeToString(webhookSecret),
		LinearActorID:        "linear-app-user",
	}
	return integration, NewLinearIntegrationService(nil, nil, secret)
}

func linearSyncCovHTTPClient(t *testing.T, captured *[]string, responder func(body string) (int, string, error)) *http.Client {
	t.Helper()
	return &http.Client{
		Transport: linearSyncRoundTripper(func(req *http.Request) (*http.Response, error) {
			bodyBytes, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			body := string(bodyBytes)
			if captured != nil {
				*captured = append(*captured, body)
			}
			if responder == nil {
				responder = func(string) (int, string, error) {
					return http.StatusOK, `{"data":{}}`, nil
				}
			}
			status, responseBody, roundTripErr := responder(body)
			if roundTripErr != nil {
				return nil, roundTripErr
			}
			return &http.Response{
				StatusCode: status,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(responseBody)),
			}, nil
		}),
	}
}

func TestLinearSync_Cov_ConstructorsAndPgxImportTx(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	queries := db.New(pool)

	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)

	svc := NewLinearSyncService(nil, nil)
	require.NotNil(t, svc.httpClient)
	assert.Equal(t, 15, int(svc.httpClient.Timeout.Seconds()))

	svc = NewLinearSyncServiceWithPool(queries, nil, pool)
	require.NotNil(t, svc.issueImportTxManager)

	manager := &pgxLinearIssueImportTxManager{pool: pool}
	tx, err := manager.BeginLinearIssueImportTx(ctx)
	require.NoError(t, err)
	issue, err := tx.CreateIssue(ctx, db.CreateIssueParams{
		RepositoryID: integration.JjhubRepoID,
		Title:        "Linear tx cover issue",
		Body:         "Created in tx",
		AuthorID:     integration.UserID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	_, err = tx.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     issue.ID,
		JjhubIssueNumber: issue.Number,
		LinearIssueID:    "lin-tx-cover",
		LinearIdentifier: "PLT-TX",
	})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))

	tx, err = manager.BeginLinearIssueImportTx(ctx)
	require.NoError(t, err)
	_, err = tx.CreateIssue(ctx, db.CreateIssueParams{
		RepositoryID: integration.JjhubRepoID,
		Title:        "Rolled back Linear tx cover issue",
		Body:         "",
		AuthorID:     integration.UserID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
}

func TestLinearSync_Cov_SmithersIssueOutboundPaths(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)

	q := &linearSyncCovQuerier{integration: integration}
	var captured []string
	svc := NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, &captured, func(body string) (int, string, error) {
		assert.Contains(t, body, "IssueCreate")
		return http.StatusOK, `{"data":{"issueCreate":{"success":true,"issue":{"id":"lin-100","identifier":"PLT-100"}}}}`, nil
	})

	svc.HandleSmithersIssueEvent(ctx, integration.JjhubRepoID, webhooks.IssueEventPayload{
		Action: "opened",
		Issue:  webhooks.IssuePayload{ID: 100, Number: 5, Title: "Created from Smithers", Body: "body"},
	})

	require.Len(t, captured, 1)
	require.Len(t, q.createdIssueMaps, 1)
	assert.Equal(t, "lin-100", q.createdIssueMaps[0].LinearIssueID)
	require.Len(t, q.logs, 1)
	assert.Equal(t, "success", q.logs[0].Status)

	mapped := db.LinearIssueMap{ID: 5, IntegrationID: integration.ID, JjhubIssueID: 100, LinearIssueID: "lin-100", LinearIdentifier: "PLT-100"}
	q = &linearSyncCovQuerier{integration: integration, issueMap: mapped}
	captured = nil
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, &captured, func(body string) (int, string, error) {
		switch {
		case strings.Contains(body, "WorkflowStates"):
			return http.StatusOK, `{"data":{"workflowStates":{"nodes":[{"id":"done-id","name":"Done","type":"completed"},{"id":"todo-by-type","name":"Backlog","type":"unstarted"}]}}}`, nil
		case strings.Contains(body, "IssueUpdate"):
			return http.StatusOK, `{"data":{"issueUpdate":{"success":true}}}`, nil
		default:
			return http.StatusInternalServerError, `unexpected`, nil
		}
	})

	event := webhooks.IssueEventPayload{Action: "edited", Issue: webhooks.IssuePayload{ID: 100, Number: 5, Title: "Updated", Body: "new body"}}
	require.NoError(t, svc.updateLinearIssue(ctx, integration, "linear-access-cover", event))
	require.NoError(t, svc.closeLinearIssue(ctx, integration, "linear-access-cover", event))
	require.NoError(t, svc.reopenLinearIssue(ctx, integration, "linear-access-cover", event))
	require.Len(t, captured, 5)
	assert.Contains(t, strings.Join(captured, "\n"), "done-id")
	assert.Contains(t, strings.Join(captured, "\n"), "todo-by-type")

	captured = nil
	q = &linearSyncCovQuerier{integration: integration}
	svc = NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, &captured, nil)
	require.NoError(t, svc.updateLinearIssue(ctx, integration, "linear-access-cover", event))
	assert.Empty(t, captured, "unmapped Smithers issues are skipped without calling Linear")
}

func TestLinearSync_Cov_SmithersCommentOutboundPaths(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)
	issueMap := db.LinearIssueMap{ID: 44, IntegrationID: integration.ID, JjhubIssueID: 200, LinearIssueID: "lin-issue-200"}

	q := &linearSyncCovQuerier{integration: integration, issueMap: issueMap}
	var captured []string
	svc := NewLinearSyncService(q, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, &captured, func(body string) (int, string, error) {
		assert.Contains(t, body, "CommentCreate")
		return http.StatusOK, `{"data":{"commentCreate":{"success":true,"comment":{"id":"lin-comment-1"}}}}`, nil
	})

	svc.HandleSmithersCommentEvent(ctx, integration.JjhubRepoID, webhooks.IssueCommentEventPayload{
		Action:  "created",
		Issue:   webhooks.IssuePayload{ID: 200},
		Comment: webhooks.IssueCommentPayload{ID: 301, IssueID: 200, Body: "hello", Commenter: "alice"},
	})
	require.Len(t, q.createdCommentMaps, 1)
	assert.Equal(t, "lin-comment-1", q.createdCommentMaps[0].LinearCommentID)

	q.commentMap = db.LinearCommentMap{ID: 55, IssueMapID: issueMap.ID, JjhubCommentID: 301, LinearCommentID: "lin-comment-1"}
	captured = nil
	svc.httpClient = linearSyncCovHTTPClient(t, &captured, func(body string) (int, string, error) {
		if strings.Contains(body, "CommentDelete") {
			return http.StatusOK, `{"data":{"commentDelete":{"success":true}}}`, nil
		}
		return http.StatusOK, `{"data":{"commentUpdate":{"success":true}}}`, nil
	})

	event := webhooks.IssueCommentEventPayload{
		Action:  "edited",
		Issue:   webhooks.IssuePayload{ID: 200},
		Comment: webhooks.IssueCommentPayload{ID: 301, IssueID: 200, Body: "edited", Commenter: "alice"},
	}
	require.NoError(t, svc.updateLinearComment(ctx, integration, "linear-access-cover", issueMap, event))
	event.Action = "deleted"
	require.NoError(t, svc.deleteLinearComment(ctx, integration, "linear-access-cover", issueMap, event))
	assert.Contains(t, strings.Join(captured, "\n"), "CommentUpdate")
	assert.Contains(t, strings.Join(captured, "\n"), "CommentDelete")
	require.Len(t, q.deletedSmithersComment, 1)
}

func TestLinearSync_Cov_HandleLinearWebhookValidationAndIssueRoute(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)

	svc := NewLinearSyncService(&linearSyncCovQuerier{}, integrationSvc)
	err := svc.HandleLinearWebhook(ctx, []byte(`{`), "")
	requireAPIErrorStatus(t, err, http.StatusBadRequest)

	require.NoError(t, svc.HandleLinearWebhook(ctx, []byte(`{"action":"urlVerification","type":"Issue","data":{}}`), ""))
	require.NoError(t, svc.HandleLinearWebhook(ctx, []byte(`{"action":"update","type":"Issue","data":{"id":"lin-no-team"}}`), ""))

	q := &linearSyncCovQuerier{integration: integration, getIntegrationByTeamErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	body := []byte(`{"action":"update","type":"Issue","data":{"id":"lin-issue","teamId":"team-cover","creatorId":"someone"}}`)
	require.NoError(t, svc.HandleLinearWebhook(ctx, body, "not-checked-when-team-is-unknown"))

	q = &linearSyncCovQuerier{integration: integration}
	svc = NewLinearSyncService(q, nil)
	err = svc.HandleLinearWebhook(ctx, body, "")
	requireAPIErrorStatus(t, err, http.StatusUnauthorized)

	svc = NewLinearSyncService(q, integrationSvc)
	err = svc.HandleLinearWebhook(ctx, body, "bad-signature")
	requireAPIErrorStatus(t, err, http.StatusUnauthorized)

	ownAction := withFreshWebhookTimestamp(t, `{"action":"update","type":"Issue","data":{"id":"lin-issue","teamId":"team-cover","creatorId":"linear-app-user"}}`)
	require.NoError(t, svc.HandleLinearWebhook(ctx, ownAction, computeTestHMAC(t, ownAction, "linear-webhook-cover")))
	assert.Empty(t, q.logs)

	issueBody := withFreshWebhookTimestamp(t, `{"action":"update","type":"Issue","data":{"id":"lin-issue","identifier":"PLT-1","title":"Linear title","description":"Linear body","teamId":"team-cover","creatorId":"other-user"}}`)
	require.NoError(t, svc.HandleLinearWebhook(ctx, issueBody, computeTestHMAC(t, issueBody, "linear-webhook-cover")))
	require.Len(t, q.logs, 1)
	assert.Equal(t, "linear", q.logs[0].Source)
	assert.Equal(t, "issue", q.logs[0].Entity)
	assert.Equal(t, []int64{integration.ID}, q.lastSyncIDs)
}

func TestLinearSync_Cov_HandleLinearWebhookCommentRoutes(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)
	issueMap := db.LinearIssueMap{ID: 66, IntegrationID: integration.ID, JjhubIssueID: 700, LinearIssueID: "lin-issue-700"}
	commentMap := db.LinearCommentMap{ID: 77, IssueMapID: issueMap.ID, JjhubCommentID: 800, LinearCommentID: "lin-comment-800"}

	q := &linearSyncCovQuerier{integration: integration, issueMapByLinear: issueMap, commentMap: commentMap}
	svc := NewLinearSyncService(q, integrationSvc)

	updateBody := withFreshWebhookTimestamp(t, `{"action":"update","type":"Comment","data":{"id":"lin-comment-800","body":"Updated from Linear","issueId":"lin-issue-700","teamId":"team-cover","creatorId":"other-user"}}`)
	require.NoError(t, svc.HandleLinearWebhook(ctx, updateBody, computeTestHMAC(t, updateBody, "linear-webhook-cover")))
	require.Len(t, q.updatedIssueComment, 1)
	assert.Equal(t, int64(800), q.updatedIssueComment[0].ID)
	assert.Equal(t, "Updated from Linear", q.updatedIssueComment[0].Body)

	q.commentMap = commentMap
	q.issueComment = db.IssueComment{ID: 800, IssueID: 700}
	removeBody := withFreshWebhookTimestamp(t, `{"action":"remove","type":"Comment","data":{"id":"lin-comment-800","body":"n/a","issueId":"lin-issue-700","teamId":"team-cover","creatorId":"other-user"}}`)
	require.NoError(t, svc.HandleLinearWebhook(ctx, removeBody, computeTestHMAC(t, removeBody, "linear-webhook-cover")))
	assert.Equal(t, []int64{800}, q.deletedIssueCommentIDs)
	require.Len(t, q.deletedLinearComment, 1)

	q = &linearSyncCovQuerier{integration: integration, issueMapByLinear: issueMap, commentMapByLinearErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.HandleLinearWebhook(ctx, updateBody, computeTestHMAC(t, updateBody, "linear-webhook-cover")))
	assert.Empty(t, q.updatedIssueComment)
}

func TestLinearSync_Cov_GraphQLAndWorkflowStateBranches(t *testing.T) {
	ctx := context.Background()

	t.Run("marshal error", func(t *testing.T) {
		svc := NewLinearSyncService(&linearSyncCovQuerier{}, nil)
		_, err := svc.linearGraphQLMutation(ctx, "token", "query", map[string]any{"bad": make(chan int)})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "marshal graphql request")
	})

	t.Run("transport and response errors", func(t *testing.T) {
		svc := NewLinearSyncService(&linearSyncCovQuerier{}, nil)
		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return 0, "", errors.New("network down")
		})
		_, err := svc.linearGraphQLMutation(ctx, "token", "query", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "graphql request failed")

		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return http.StatusBadGateway, "bad gateway", nil
		})
		_, err = svc.linearGraphQLMutation(ctx, "token", "query", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "status 502")

		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return http.StatusOK, `{not-json`, nil
		})
		_, err = svc.linearGraphQLMutation(ctx, "token", "query", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode graphql response")

		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return http.StatusOK, `{"errors":[{"message":"bad query"}]}`, nil
		})
		_, err = svc.linearGraphQLMutation(ctx, "token", "query", nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "bad query")
	})

	t.Run("workflow state response shapes", func(t *testing.T) {
		svc := NewLinearSyncService(&linearSyncCovQuerier{}, nil)
		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return http.StatusOK, `{"data":{"workflowStates":"bad-shape"}}`, nil
		})
		_, err := svc.getLinearWorkflowStateID(ctx, "token", "team", "Done")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "unexpected workflowStates")

		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return http.StatusOK, `{"data":{"workflowStates":{"nodes":"bad"}}}`, nil
		})
		_, err = svc.getLinearWorkflowStateID(ctx, "token", "team", "Done")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no nodes")

		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return http.StatusOK, `{"data":{"workflowStates":{"nodes":[{"id":"completed-by-type","name":"Shipped","type":"completed"}]}}}`, nil
		})
		id, err := svc.getLinearWorkflowStateID(ctx, "token", "team", "Done")
		require.NoError(t, err)
		assert.Equal(t, "completed-by-type", id)

		svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
			return http.StatusOK, `{"data":{"workflowStates":{"nodes":[{"id":"other","name":"Review","type":"started"}]}}}`, nil
		})
		_, err = svc.getLinearWorkflowStateID(ctx, "token", "team", "Done")
		require.Error(t, err)
		assert.Contains(t, err.Error(), `workflow state "Done" not found`)
	})
}

func TestLinearSync_Cov_ImportHelpersAndErrors(t *testing.T) {
	ctx := context.Background()
	integration, _ := linearSyncCovIntegration(t)

	q := &linearSyncCovQuerier{
		integration:  integration,
		createdIssue: db.Issue{ID: 501, Number: 99, Title: "Fallback", Body: "Body", AuthorID: integration.UserID},
	}
	svc := NewLinearSyncService(q, nil)
	require.NoError(t, svc.importLinearIssue(ctx, integration, "lin-import", "PLT-501", "  ", "Imported body"))
	require.Len(t, q.createdIssueMaps, 1)
	require.Len(t, q.logs, 1)
	assert.Contains(t, q.logs[0].ErrorMessage, "smithers_issue_number=99")

	created, err := svc.createImportedLinearIssueMapping(ctx, q, integration, "lin-empty", "", "  ", "  ")
	require.NoError(t, err)
	assert.Equal(t, "Fallback", created.Title)
	assert.Equal(t, "", formatImportedLinearIssueBody("", ""))
	assert.Equal(t, "Imported from Linear issue `PLT-9`.", formatImportedLinearIssueBody("PLT-9", " "))
	assert.Equal(t, "Imported from Linear issue `PLT-9`.\n\nBody", formatImportedLinearIssueBody("PLT-9", " Body "))

	svc.logImportedLinearIssueSuccess(ctx, db.LinearIntegration{ID: 999}, "lin-no-query", "PLT-NIL", db.Issue{})

	q.logErr = errors.New("log insert failed")
	svc.logSyncOp(ctx, integration.ID, "linear", "smithers", "issue", "lin-log", "sync", "failed", "boom")

	tx := &linearSyncCovImportTx{commitErr: errors.New("commit failed")}
	svc = &LinearSyncService{
		queries:              &linearSyncCovQuerier{integration: integration},
		issueImportTxManager: &linearSyncCovImportTxManager{tx: tx},
	}
	err = svc.importLinearIssue(ctx, integration, "lin-commit", "PLT-C", "Title", "Body")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "commit linear issue import transaction")
	assert.True(t, tx.committed)
	assert.True(t, tx.rolledBack)

	svc.issueImportTxManager = &linearSyncCovImportTxManager{beginErr: errors.New("begin failed")}
	err = svc.importLinearIssue(ctx, integration, "lin-begin", "PLT-B", "Title", "Body")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "begin linear issue import transaction")

	for _, tc := range []struct {
		name string
		tx   *linearSyncCovImportTx
		want string
	}{
		{"create issue", &linearSyncCovImportTx{createIssueErr: errors.New("create failed")}, "create smithers issue"},
		{"map", &linearSyncCovImportTx{mapErr: errors.New("map failed")}, "create linear issue map"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc.issueImportTxManager = &linearSyncCovImportTxManager{tx: tc.tx}
			err := svc.importLinearIssue(ctx, integration, "lin-"+tc.name, "PLT", "Title", "Body")
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
			assert.True(t, tc.tx.rolledBack)
		})
	}
}

func TestLinearSync_Cov_SkipAndFailureBranches(t *testing.T) {
	ctx := context.Background()
	integration, integrationSvc := linearSyncCovIntegration(t)

	q := &linearSyncCovQuerier{integration: integration, recentExists: true}
	svc := NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.syncIssueToLinear(ctx, integration, webhooks.IssueEventPayload{
		Action: "opened",
		Issue:  webhooks.IssuePayload{ID: 1, Number: 1},
	}))
	assert.Empty(t, q.logs)

	q = &linearSyncCovQuerier{integration: integration, issueMapBySmithersErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.syncCommentToLinear(ctx, integration, webhooks.IssueCommentEventPayload{
		Action:  "created",
		Issue:   webhooks.IssuePayload{ID: 1},
		Comment: webhooks.IssueCommentPayload{ID: 2},
	}))
	assert.Empty(t, q.logs)

	q = &linearSyncCovQuerier{integration: integration, issueMap: db.LinearIssueMap{ID: 1, LinearIssueID: "lin-1"}, commentMapBySmithersErr: pgx.ErrNoRows}
	svc = NewLinearSyncService(q, integrationSvc)
	require.NoError(t, svc.deleteLinearComment(ctx, integration, "token", q.issueMap, webhooks.IssueCommentEventPayload{
		Comment: webhooks.IssueCommentPayload{ID: 2},
	}))
	assert.Empty(t, q.deletedSmithersComment)

	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(body string) (int, string, error) {
		return http.StatusOK, `{"data":{"issueCreate":{"success":true}}}`, nil
	})
	q.issueMap = db.LinearIssueMap{}
	err := svc.createLinearIssue(ctx, integration, "token", webhooks.IssueEventPayload{
		Issue: webhooks.IssuePayload{ID: 3, Number: 3, Title: "bad shape"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no issue")

	err = svc.handleLinearIssueWebhook(ctx, integration, "update", []byte(`{bad json`))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to unmarshal linear issue")

	err = svc.handleLinearCommentWebhook(ctx, integration, "update", []byte(`{bad json`))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to unmarshal linear comment")

	assert.False(t, svc.verifyWebhookSignature([]byte("body"), "", "secret"))
	assert.False(t, svc.verifyWebhookSignature([]byte("body"), "sig", ""))
	validSig := computeTestHMAC(t, []byte("body"), "secret")
	assert.True(t, svc.verifyWebhookSignature([]byte("body"), validSig, "secret"))

	svc.HandleSmithersIssueEvent(ctx, 123, webhooks.IssueEventPayload{Action: "ignored"})
	q.listIntegrationsErr = errors.New("list failed")
	svc.HandleSmithersCommentEvent(ctx, 123, webhooks.IssueCommentEventPayload{Action: "ignored"})
}
