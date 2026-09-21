package db

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWebhooksSQL_H_WebhooksAndDeliveriesRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	username := uniqueTestUsername(t)
	repoName := uniqueTestRepoName(t)
	_, repoID := mustCreateUserAndRepo(t, pool, username, repoName)
	orgID := webhooksSQLHCreateOrg(t, pool, "org-"+randSlug(t))
	orgRepoID := webhooksSQLHCreateOrgRepo(t, pool, orgID, "org-repo-"+randSlug(t))

	active, err := q.CreateWebhook(ctx, CreateWebhookParams{RepositoryID: repoID, Url: "https://hooks.example/active", Secret: "secret-1", Events: []string{"push", "release"}, IsActive: true})
	require.NoError(t, err)
	inactive, err := q.CreateWebhook(ctx, CreateWebhookParams{RepositoryID: repoID, Url: "https://hooks.example/inactive", Secret: "secret-2", Events: []string{"issues"}, IsActive: false})
	require.NoError(t, err)
	orgHook, err := q.CreateWebhook(ctx, CreateWebhookParams{RepositoryID: orgRepoID, Url: "https://hooks.example/org", Secret: "secret-org", Events: []string{"push"}, IsActive: true})
	require.NoError(t, err)

	count, err := q.CountWebhooksByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
	got, err := q.GetWebhookByID(ctx, active.ID)
	require.NoError(t, err)
	assert.Equal(t, active.Url, got.Url)
	byOwner, err := q.GetRepoWebhookByOwnerAndRepo(ctx, GetRepoWebhookByOwnerAndRepoParams{WebhookID: active.ID, Owner: strings.ToUpper(username), Repo: strings.ToUpper(repoName)})
	require.NoError(t, err)
	assert.Equal(t, active.ID, byOwner.ID)

	byRepo, err := q.ListWebhooksByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, byRepo, 2)
	byIDs, err := q.ListWebhooksByIDs(ctx, []int64{inactive.ID, active.ID})
	require.NoError(t, err)
	require.Len(t, byIDs, 2)
	activeByRepo, err := q.ListActiveWebhooksByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, activeByRepo, 1)
	assert.Equal(t, active.ID, activeByRepo[0].ID)
	activeByOrg, err := q.ListActiveWebhooksByOrg(ctx, orgID)
	require.NoError(t, err)
	require.Len(t, activeByOrg, 1)
	assert.Equal(t, orgHook.ID, activeByOrg[0].ID)
	byOwnerList, err := q.ListRepoWebhooksByOwnerAndRepo(ctx, ListRepoWebhooksByOwnerAndRepoParams{Owner: username, Repo: repoName})
	require.NoError(t, err)
	require.Len(t, byOwnerList, 2)

	require.NoError(t, q.SetWebhookActive(ctx, SetWebhookActiveParams{ID: inactive.ID, IsActive: true}))
	activeByRepo, err = q.ListActiveWebhooksByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, activeByRepo, 2)

	updated, err := q.UpdateRepoWebhookByOwnerAndRepo(ctx, UpdateRepoWebhookByOwnerAndRepoParams{
		WebhookID: active.ID,
		Owner:     username,
		Repo:      repoName,
		Url:       "https://hooks.example/updated",
		Secret:    "secret-updated",
		Events:    []string{"workflow_run"},
		IsActive:  false,
	})
	require.NoError(t, err)
	assert.Equal(t, "https://hooks.example/updated", updated.Url)
	assert.False(t, updated.IsActive)

	pending, err := q.CreateWebhookDelivery(ctx, CreateWebhookDeliveryParams{WebhookID: active.ID, EventType: "push", Payload: json.RawMessage(`{"ref":"main"}`), Status: "pending"})
	require.NoError(t, err)
	futurePending, err := q.CreateWebhookDelivery(ctx, CreateWebhookDeliveryParams{WebhookID: active.ID, EventType: "release", Payload: json.RawMessage(`{"tag":"v1"}`), Status: "pending"})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE webhook_deliveries SET next_retry_at = NOW() + INTERVAL '1 hour' WHERE id = $1`, futurePending.ID)
	success, err := q.CreateWebhookDelivery(ctx, CreateWebhookDeliveryParams{WebhookID: active.ID, EventType: "issues", Payload: json.RawMessage(`{"number":1}`), Status: "success"})
	require.NoError(t, err)

	claimed, err := q.ClaimDueWebhookDeliveries(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, pending.ID, claimed[0].ID)
	assert.Equal(t, int32(1), claimed[0].Attempts)

	require.NoError(t, q.UpdateWebhookDeliveryResult(ctx, UpdateWebhookDeliveryResultParams{
		ID:             pending.ID,
		Status:         "success",
		ResponseStatus: pgtype.Int4{Int32: 200, Valid: true},
		ResponseBody:   "ok",
	}))
	retryAt := time.Now().Add(5 * time.Minute)
	require.NoError(t, q.UpdateWebhookDeliveryRetry(ctx, UpdateWebhookDeliveryRetryParams{
		ID:             futurePending.ID,
		Status:         "failed",
		ResponseStatus: pgtype.Int4{Int32: 503, Valid: true},
		ResponseBody:   "retry later",
		NextRetryAt:    pgtype.Timestamptz{Time: retryAt, Valid: true},
	}))
	claimed, err = q.ClaimDueWebhookDeliveries(ctx, 10)
	require.NoError(t, err)
	assert.Empty(t, claimed)

	delivery, err := q.GetWebhookDeliveryForRepo(ctx, GetWebhookDeliveryForRepoParams{DeliveryID: futurePending.ID, WebhookID: active.ID, Owner: username, Repo: repoName})
	require.NoError(t, err)
	assert.Equal(t, "failed", delivery.Status)
	assert.Equal(t, int32(503), delivery.ResponseStatus.Int32)

	statuses, err := q.ListRecentWebhookDeliveryStatuses(ctx, active.ID)
	require.NoError(t, err)
	require.Len(t, statuses, 3)
	assert.Contains(t, statuses, "failed")
	deliveries, err := q.ListWebhookDeliveriesForRepo(ctx, ListWebhookDeliveriesForRepoParams{WebhookID: active.ID, Owner: username, Repo: repoName, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, deliveries, 3)
	assert.Equal(t, success.ID, deliveries[0].ID)

	deletedRows, err := q.DeleteRepoWebhookByOwnerAndRepo(ctx, DeleteRepoWebhookByOwnerAndRepoParams{WebhookID: inactive.ID, Owner: username, Repo: repoName})
	require.NoError(t, err)
	assert.Equal(t, int64(1), deletedRows)
	deletedRows, err = q.DeleteRepoWebhookByOwnerAndRepo(ctx, DeleteRepoWebhookByOwnerAndRepoParams{WebhookID: inactive.ID, Owner: username, Repo: repoName})
	require.NoError(t, err)
	assert.Zero(t, deletedRows)
	require.NoError(t, q.DeleteWebhookByID(ctx, DeleteWebhookByIDParams{RepositoryID: repoID, ID: active.ID}))
	_, err = q.GetWebhookByID(ctx, active.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, q.DeleteWebhookByID(ctx, DeleteWebhookByIDParams{RepositoryID: repoID, ID: active.ID}))

	_, err = q.GetWebhookByID(ctx, 999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetRepoWebhookByOwnerAndRepo(ctx, GetRepoWebhookByOwnerAndRepoParams{WebhookID: orgHook.ID, Owner: username, Repo: repoName})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetWebhookDeliveryForRepo(ctx, GetWebhookDeliveryForRepoParams{DeliveryID: 999999, WebhookID: orgHook.ID, Owner: "org-" + randSlug(t), Repo: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateRepoWebhookByOwnerAndRepo(ctx, UpdateRepoWebhookByOwnerAndRepoParams{WebhookID: 999999, Owner: username, Repo: repoName})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	emptyList, err := q.ListRepoWebhooksByOwnerAndRepo(ctx, ListRepoWebhooksByOwnerAndRepoParams{Owner: "missing", Repo: "missing"})
	require.NoError(t, err)
	assert.Empty(t, emptyList)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateWebhook(ctx, CreateWebhookParams{RepositoryID: 999999, Url: "https://bad.example", Events: []string{"push"}, IsActive: true})
		return err
	})
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateWebhookDelivery(ctx, CreateWebhookDeliveryParams{WebhookID: orgHook.ID, EventType: "bad", Payload: json.RawMessage(`[]`), Status: "pending"})
		return err
	})
}

func TestWebhooksSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("webhooks h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ClaimDueWebhookDeliveries", func(q *Queries) error { _, err := q.ClaimDueWebhookDeliveries(context.Background(), 1); return err }},
		{"ListActiveWebhooksByOrg", func(q *Queries) error { _, err := q.ListActiveWebhooksByOrg(context.Background(), 1); return err }},
		{"ListActiveWebhooksByRepo", func(q *Queries) error { _, err := q.ListActiveWebhooksByRepo(context.Background(), 1); return err }},
		{"ListRecentWebhookDeliveryStatuses", func(q *Queries) error {
			_, err := q.ListRecentWebhookDeliveryStatuses(context.Background(), 1)
			return err
		}},
		{"ListRepoWebhooksByOwnerAndRepo", func(q *Queries) error {
			_, err := q.ListRepoWebhooksByOwnerAndRepo(context.Background(), ListRepoWebhooksByOwnerAndRepoParams{Owner: "owner", Repo: "repo"})
			return err
		}},
		{"ListWebhookDeliveriesForRepo", func(q *Queries) error {
			_, err := q.ListWebhookDeliveriesForRepo(context.Background(), ListWebhookDeliveriesForRepoParams{WebhookID: 1, Owner: "owner", Repo: "repo", PageSize: 1})
			return err
		}},
		{"ListWebhooksByIDs", func(q *Queries) error { _, err := q.ListWebhooksByIDs(context.Background(), []int64{1}); return err }},
		{"ListWebhooksByRepo", func(q *Queries) error { _, err := q.ListWebhooksByRepo(context.Background(), 1); return err }},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(webhooksSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(webhooksSQLHDB{rows: &webhooksSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(webhooksSQLHDB{rows: &webhooksSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestWebhooksSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("webhooks h row failed")
	q := New(webhooksSQLHDB{row: webhooksSQLHRow{err: sentinel}})

	_, err := q.CountWebhooksByRepo(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetRepoWebhookByOwnerAndRepo(context.Background(), GetRepoWebhookByOwnerAndRepoParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWebhookByID(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWebhookDeliveryForRepo(context.Background(), GetWebhookDeliveryForRepoParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpdateRepoWebhookByOwnerAndRepo(context.Background(), UpdateRepoWebhookByOwnerAndRepoParams{})
	require.ErrorIs(t, err, sentinel)
}

func TestWebhooksSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("webhooks h exec failed")
	q := New(webhooksSQLHDB{execErr: sentinel})

	_, err := q.DeleteRepoWebhookByOwnerAndRepo(context.Background(), DeleteRepoWebhookByOwnerAndRepoParams{})
	require.ErrorIs(t, err, sentinel)
	require.ErrorIs(t, q.DeleteWebhookByID(context.Background(), DeleteWebhookByIDParams{}), sentinel)
	require.ErrorIs(t, q.SetWebhookActive(context.Background(), SetWebhookActiveParams{}), sentinel)
	require.ErrorIs(t, q.UpdateWebhookDeliveryRetry(context.Background(), UpdateWebhookDeliveryRetryParams{}), sentinel)
}

func webhooksSQLHCreateOrg(t *testing.T, pool DBTX, name string) int64 {
	t.Helper()
	lowerName := strings.ToLower(name)
	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO organizations (name, lower_name, description) VALUES ($1, $2, '') RETURNING id`,
		name,
		lowerName,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func webhooksSQLHCreateOrgRepo(t *testing.T, pool DBTX, orgID int64, name string) int64 {
	t.Helper()
	lowerName := strings.ToLower(name)
	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (org_id, name, lower_name, description, storage_set_id, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', 's1', TRUE, 'main', 1) RETURNING id`,
		orgID,
		name,
		lowerName,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

type webhooksSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db webhooksSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db webhooksSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &webhooksSQLHRows{}, nil
}

func (db webhooksSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return webhooksSQLHRow{err: errors.New("webhooks h row failed")}
}

type webhooksSQLHRow struct {
	err error
}

func (r webhooksSQLHRow) Scan(...any) error {
	return r.err
}

type webhooksSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *webhooksSQLHRows) Close() {}

func (r *webhooksSQLHRows) Err() error {
	return r.err
}

func (r *webhooksSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *webhooksSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *webhooksSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *webhooksSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("webhooks h scan unexpectedly succeeded")
}

func (r *webhooksSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *webhooksSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *webhooksSQLHRows) Conn() *pgx.Conn {
	return nil
}
