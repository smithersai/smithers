package db

import (
	"context"
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

func TestAlphaAccessSQL_H_WaitlistAndWhitelistRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	adminID := mustCreateUser(t, pool, uniqueTestUsername(t))
	email := uniqueTestEmail(t)
	lowerEmail := strings.ToLower(email)

	entry, err := q.UpsertWaitlistEntry(ctx, UpsertWaitlistEntryParams{
		Email: email, LowerEmail: lowerEmail, GithubUsername: "octo-h", GithubAvatarUrl: "https://avatar.example/h.png", Note: "first", Source: "github",
	})
	require.NoError(t, err)
	assert.Equal(t, "pending", entry.Status)
	assert.Equal(t, "octo-h", entry.GithubUsername)

	entry, err = q.UpsertWaitlistEntry(ctx, UpsertWaitlistEntryParams{
		Email: strings.ToUpper(email), LowerEmail: lowerEmail, Source: "manual",
	})
	require.NoError(t, err)
	assert.Equal(t, "octo-h", entry.GithubUsername)
	assert.Equal(t, "first", entry.Note)
	assert.Equal(t, "manual", entry.Source)

	secondEmail := uniqueTestEmail(t)
	secondLower := strings.ToLower(secondEmail)
	second, err := q.UpsertWaitlistEntry(ctx, UpsertWaitlistEntryParams{
		Email: secondEmail, LowerEmail: secondLower, GithubUsername: "second-h", Source: "github",
	})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE alpha_waitlist_entries SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, entry.ID)
	mustExec(t, pool, `UPDATE alpha_waitlist_entries SET created_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, second.ID)

	count, err := q.CountWaitlistEntries(ctx, "")
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
	count, err = q.CountWaitlistEntries(ctx, "pending")
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
	position, err := q.GetWaitlistPosition(ctx, secondLower)
	require.NoError(t, err)
	assert.Equal(t, int64(2), position)

	approved, err := q.ApproveWaitlistEntryByLowerEmail(ctx, ApproveWaitlistEntryByLowerEmailParams{
		ApprovedBy: pgtype.Int8{Int64: adminID, Valid: true},
		LowerEmail: lowerEmail,
	})
	require.NoError(t, err)
	assert.Equal(t, "approved", approved.Status)
	assert.Equal(t, adminID, approved.ApprovedBy.Int64)

	approved, err = q.UpsertWaitlistEntry(ctx, UpsertWaitlistEntryParams{
		Email: email, LowerEmail: lowerEmail, Source: "retry",
	})
	require.NoError(t, err)
	assert.Equal(t, "approved", approved.Status)
	assert.Equal(t, adminID, approved.ApprovedBy.Int64)

	got, err := q.GetWaitlistEntryByLowerEmail(ctx, lowerEmail)
	require.NoError(t, err)
	assert.Equal(t, approved.ID, got.ID)

	waitlist, err := q.ListWaitlistEntries(ctx, ListWaitlistEntriesParams{StatusFilter: "", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, waitlist, 2)
	approvedOnly, err := q.ListWaitlistEntries(ctx, ListWaitlistEntriesParams{StatusFilter: "approved", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, approvedOnly, 1)
	rejectedOnly, err := q.ListWaitlistEntries(ctx, ListWaitlistEntriesParams{StatusFilter: "rejected", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, rejectedOnly)

	whitelist, err := q.AddWhitelistEntry(ctx, AddWhitelistEntryParams{
		IdentityType:       "email",
		IdentityValue:      email,
		LowerIdentityValue: lowerEmail,
		CreatedBy:          pgtype.Int8{Int64: adminID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, lowerEmail, whitelist.LowerIdentityValue)
	whitelist, err = q.AddWhitelistEntry(ctx, AddWhitelistEntryParams{
		IdentityType:       "email",
		IdentityValue:      strings.ToUpper(email),
		LowerIdentityValue: lowerEmail,
		CreatedBy:          pgtype.Int8{Int64: adminID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, strings.ToUpper(email), whitelist.IdentityValue)

	exists, err := q.IsWhitelistedIdentity(ctx, IsWhitelistedIdentityParams{IdentityType: "email", LowerIdentityValue: lowerEmail})
	require.NoError(t, err)
	assert.True(t, exists)
	exists, err = q.IsWhitelistedIdentity(ctx, IsWhitelistedIdentityParams{IdentityType: "username", LowerIdentityValue: lowerEmail})
	require.NoError(t, err)
	assert.False(t, exists)

	whitelistRows, err := q.ListWhitelistEntries(ctx)
	require.NoError(t, err)
	require.Len(t, whitelistRows, 1)
	removed, err := q.RemoveWhitelistEntry(ctx, RemoveWhitelistEntryParams{IdentityType: "email", LowerIdentityValue: lowerEmail})
	require.NoError(t, err)
	assert.Equal(t, int64(1), removed)
	removed, err = q.RemoveWhitelistEntry(ctx, RemoveWhitelistEntryParams{IdentityType: "email", LowerIdentityValue: lowerEmail})
	require.NoError(t, err)
	assert.Zero(t, removed)

	_, err = q.GetWaitlistEntryByLowerEmail(ctx, "missing-alpha-h@example.com")
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.ApproveWaitlistEntryByLowerEmail(ctx, ApproveWaitlistEntryByLowerEmailParams{LowerEmail: "missing-alpha-h@example.com"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	position, err = q.GetWaitlistPosition(ctx, "missing-alpha-h@example.com")
	require.NoError(t, err)
	assert.Zero(t, position)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.AddWhitelistEntry(ctx, AddWhitelistEntryParams{
			IdentityType:       "phone",
			IdentityValue:      "bad",
			LowerIdentityValue: "bad",
		})
		return err
	})
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.ApproveWaitlistEntryByLowerEmail(ctx, ApproveWaitlistEntryByLowerEmailParams{
			ApprovedBy: pgtype.Int8{Int64: 999999, Valid: true},
			LowerEmail: secondLower,
		})
		return err
	})
}

func TestAlphaAccessSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("alpha access h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListWaitlistEntries", func(q *Queries) error {
			_, err := q.ListWaitlistEntries(context.Background(), ListWaitlistEntriesParams{PageSize: 1})
			return err
		}},
		{"ListWhitelistEntries", func(q *Queries) error {
			_, err := q.ListWhitelistEntries(context.Background())
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(alphaAccessSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(alphaAccessSQLHDB{rows: &alphaAccessSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(alphaAccessSQLHDB{rows: &alphaAccessSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestAlphaAccessSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("alpha access h row failed")
	q := New(alphaAccessSQLHDB{row: alphaAccessSQLHRow{err: sentinel}})

	_, err := q.AddWhitelistEntry(context.Background(), AddWhitelistEntryParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.ApproveWaitlistEntryByLowerEmail(context.Background(), ApproveWaitlistEntryByLowerEmailParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.CountWaitlistEntries(context.Background(), "")
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWaitlistEntryByLowerEmail(context.Background(), "email")
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetWaitlistPosition(context.Background(), "email")
	require.ErrorIs(t, err, sentinel)
	_, err = q.IsWhitelistedIdentity(context.Background(), IsWhitelistedIdentityParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpsertWaitlistEntry(context.Background(), UpsertWaitlistEntryParams{})
	require.ErrorIs(t, err, sentinel)
}

func TestAlphaAccessSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("alpha access h exec failed")
	q := New(alphaAccessSQLHDB{execErr: sentinel})

	_, err := q.RemoveWhitelistEntry(context.Background(), RemoveWhitelistEntryParams{})
	require.ErrorIs(t, err, sentinel)

	timeoutCtx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	_, err = q.CountWaitlistEntries(timeoutCtx, "")
	require.Error(t, err)
}

type alphaAccessSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db alphaAccessSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db alphaAccessSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &alphaAccessSQLHRows{}, nil
}

func (db alphaAccessSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return alphaAccessSQLHRow{err: errors.New("alpha access h row failed")}
}

type alphaAccessSQLHRow struct {
	err error
}

func (r alphaAccessSQLHRow) Scan(...any) error {
	return r.err
}

type alphaAccessSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *alphaAccessSQLHRows) Close() {}

func (r *alphaAccessSQLHRows) Err() error {
	return r.err
}

func (r *alphaAccessSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *alphaAccessSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *alphaAccessSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *alphaAccessSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("alpha access h scan unexpectedly succeeded")
}

func (r *alphaAccessSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *alphaAccessSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *alphaAccessSQLHRows) Conn() *pgx.Conn {
	return nil
}
