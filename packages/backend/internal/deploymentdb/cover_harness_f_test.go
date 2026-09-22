package deploymentdb

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fcovSentinel is the canonical error injected by the fake DBTX used to drive
// the generated queries' error branches to 100% coverage.
var fcovSentinel = errors.New("fcov sentinel error")

// fcovDB is a configurable fake DBTX. It lets each generated query method be
// exercised down its Query/Exec/QueryRow error paths without a live database.
type fcovDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (d fcovDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, d.execErr
}

func (d fcovDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if d.queryErr != nil {
		return nil, d.queryErr
	}
	if d.rows != nil {
		return d.rows, nil
	}
	return &fcovRows{}, nil
}

func (d fcovDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if d.row != nil {
		return d.row
	}
	return fcovRow{err: fcovSentinel}
}

// fcovRow is a pgx.Row whose Scan always returns err.
type fcovRow struct {
	err error
}

func (r fcovRow) Scan(...any) error { return r.err }

// fcovRows is a pgx.Rows that yields at most one row and can fail on Scan or Err.
type fcovRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *fcovRows) Close()                                       {}
func (r *fcovRows) Err() error                                   { return r.err }
func (r *fcovRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fcovRows) FieldDescriptions() []pgconn.FieldDescription { return nil }

func (r *fcovRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *fcovRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("fcov scan unexpectedly succeeded")
}

func (r *fcovRows) Values() ([]any, error) { return nil, r.err }
func (r *fcovRows) RawValues() [][]byte    { return nil }
func (r *fcovRows) Conn() *pgx.Conn        { return nil }

// fcovManyDBs returns the three fake DBTX variants that drive a :many query
// through its Query-error, Scan-error, and rows.Err-error branches.
func fcovManyDBs() []fcovDB {
	return []fcovDB{
		{queryErr: fcovSentinel},
		{rows: &fcovRows{next: true, scanErr: fcovSentinel}},
		{rows: &fcovRows{err: fcovSentinel}},
	}
}
