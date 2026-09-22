package deploymentdb

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type repoGatewaysSQLHDB = chunk5SQLHDB
type repoGatewaysSQLHRow = chunk5SQLHRow
type repoGatewaysSQLHRows = chunk5SQLHRows

func TestRepoGatewaysSQL_H_RoundTripAndFilters(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	gateway, err := q.CreateRepoGateway(ctx, CreateRepoGatewayParams{RepositoryID: repoID, UserID: userID, Status: "pending"})
	require.NoError(t, err)
	assert.Equal(t, "pending", gateway.Status)
	_, err = q.GetActiveRepoGatewayForUserRepo(ctx, GetActiveRepoGatewayForUserRepoParams{RepositoryID: repoID, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	gateway, err = q.UpdateRepoGatewayExecutionInfo(ctx, UpdateRepoGatewayExecutionInfoParams{
		ID: gateway.ID, VmID: "vm-h-1", BaseUrl: "https://gateway.example", AuthTokenHash: "hash", AuthTokenCiphertext: "cipher", Status: "starting",
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-h-1", gateway.VmID)
	active, err := q.GetActiveRepoGatewayForUserRepo(ctx, GetActiveRepoGatewayForUserRepoParams{RepositoryID: repoID, UserID: userID})
	require.NoError(t, err)
	assert.Equal(t, gateway.ID, active.ID)

	running, err := q.UpdateRepoGatewayStatus(ctx, UpdateRepoGatewayStatusParams{ID: gateway.ID, Status: "running"})
	require.NoError(t, err)
	assert.Equal(t, "running", running.Status)
	require.NoError(t, q.TouchRepoGatewayActivity(ctx, gateway.ID))

	_, otherRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	stale, err := q.CreateRepoGateway(ctx, CreateRepoGatewayParams{RepositoryID: otherRepoID, UserID: userID, Status: "failed"})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE repo_gateways SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, stale.ID)
	staleRows, err := q.ListStaleRepoGateways(ctx, 60)
	require.NoError(t, err)
	require.Len(t, staleRows, 1)
	assert.Equal(t, stale.ID, staleRows[0].ID)

	softDeleted, err := q.SoftDeleteRepoGateway(ctx, gateway.ID)
	require.NoError(t, err)
	assert.Equal(t, "stopped", softDeleted.Status)
	assert.True(t, softDeleted.DeletedAt.Valid)
	_, err = q.GetActiveRepoGatewayForUserRepo(ctx, GetActiveRepoGatewayForUserRepoParams{RepositoryID: repoID, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.SoftDeleteRepoGateway(ctx, "00000000-0000-0000-0000-000000000000")
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateRepoGatewayStatus(ctx, UpdateRepoGatewayStatusParams{ID: "00000000-0000-0000-0000-000000000000", Status: "failed"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateRepoGatewayExecutionInfo(ctx, UpdateRepoGatewayExecutionInfoParams{ID: "00000000-0000-0000-0000-000000000000", Status: "running"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	empty, err := q.ListStaleRepoGateways(ctx, 3600)
	require.NoError(t, err)
	assert.Empty(t, empty)
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateRepoGateway(ctx, CreateRepoGatewayParams{RepositoryID: repoID, UserID: userID, Status: "bogus"})
		return err
	})
}

func TestRepoGatewaysSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("repo gateways h failed")
	callList := func(q *Queries) error {
		_, err := q.ListStaleRepoGateways(context.Background(), 1)
		return err
	}
	require.ErrorIs(t, callList(New(repoGatewaysSQLHDB{queryErr: sentinel})), sentinel)
	require.ErrorIs(t, callList(New(repoGatewaysSQLHDB{rows: &repoGatewaysSQLHRows{next: true, scanErr: sentinel}})), sentinel)
	require.ErrorIs(t, callList(New(repoGatewaysSQLHDB{rows: &repoGatewaysSQLHRows{err: sentinel}})), sentinel)

	rowQ := New(repoGatewaysSQLHDB{row: repoGatewaysSQLHRow{err: sentinel}})
	_, err := rowQ.CreateRepoGateway(context.Background(), CreateRepoGatewayParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetActiveRepoGatewayForUserRepo(context.Background(), GetActiveRepoGatewayForUserRepoParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.SoftDeleteRepoGateway(context.Background(), "id")
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.UpdateRepoGatewayExecutionInfo(context.Background(), UpdateRepoGatewayExecutionInfoParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.UpdateRepoGatewayStatus(context.Background(), UpdateRepoGatewayStatusParams{})
	require.ErrorIs(t, err, sentinel)

	require.ErrorIs(t, New(repoGatewaysSQLHDB{execErr: sentinel}).TouchRepoGatewayActivity(context.Background(), "id"), sentinel)
}

type chunk5SQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db chunk5SQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	if db.execErr != nil {
		return pgconn.CommandTag{}, db.execErr
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (db chunk5SQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &chunk5SQLHRows{}, nil
}

func (db chunk5SQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return chunk5SQLHRow{err: errors.New("chunk 5 row unexpectedly scanned")}
}

type chunk5SQLHRow struct {
	err error
}

func (r chunk5SQLHRow) Scan(...any) error {
	return r.err
}

type chunk5SQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *chunk5SQLHRows) Close() {}

func (r *chunk5SQLHRows) Err() error {
	return r.err
}

func (r *chunk5SQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *chunk5SQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *chunk5SQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *chunk5SQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("chunk 5 rows unexpectedly scanned")
}

func (r *chunk5SQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *chunk5SQLHRows) RawValues() [][]byte {
	return nil
}

func (r *chunk5SQLHRows) Conn() *pgx.Conn {
	return nil
}
