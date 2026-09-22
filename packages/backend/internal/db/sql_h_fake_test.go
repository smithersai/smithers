package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

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
