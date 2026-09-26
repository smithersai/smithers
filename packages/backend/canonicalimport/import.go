// Package canonicalimport writes exported legacy rows directly into their
// canonical product tables. The exporter owns extraction and secret
// re-encryption into the product format; this package never connects to or
// modifies the legacy source.
package canonicalimport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// tables are the canonical cutover destinations: identity and OAuth, durable
// jobs and repository setup requests, chat turns, and model credentials. Rows
// are applied in archive order, so the exporter orders foreign-key parents
// first.
var tables = map[string]bool{
	"users": true, "organizations": true, "owner_namespaces": true, "org_members": true,
	"email_addresses": true, "user_devices": true, "access_tokens": true, "auth_sessions": true, "oauth_accounts": true,
	"oauth2_applications": true, "oauth2_access_tokens": true, "oauth2_refresh_tokens": true, "oauth2_authorization_codes": true,
	"product_job_requests": true, "repository_setup_requests": true,
	"chat_turns": true, "chat_turn_batches": true, "chat_turn_erasures": true,
	"owner_model_credentials": true, "owner_model_defaults": true, "owner_model_credential_receipts": true,
}

// Row is one canonical row. Fields maps column names to JSON values in the
// form PostgreSQL's jsonb_populate_record accepts.
type Row struct {
	Kind     string          `json:"kind"`
	SourceID string          `json:"source_id"`
	Fields   json.RawMessage `json:"fields"`
}

type Item struct {
	Kind     string `json:"kind"`
	SourceID string `json:"source_id"`
	Checksum string `json:"checksum"`
}

type Report struct {
	Count  int            `json:"count"`
	Counts map[string]int `json:"counts"`
	// Checksum digests every row in order; dry run, apply and verify of the
	// same archive agree.
	Checksum string `json:"checksum"`
	Items    []Item `json:"items"`
}

type Importer struct{ DB *pgxpool.Pool }

var ErrConflict = errors.New("canonicalimport: row conflicts with existing data")

type decoded struct {
	Row
	fields map[string]json.RawMessage
	names  []string
}

func decode(row Row) (decoded, error) {
	d := decoded{Row: row}
	if !tables[row.Kind] {
		return d, fmt.Errorf("canonicalimport: table %q is not a cutover destination", row.Kind)
	}
	if row.SourceID == "" || strings.TrimSpace(row.SourceID) != row.SourceID {
		return d, errors.New("canonicalimport: source id required")
	}
	if err := json.Unmarshal(row.Fields, &d.fields); err != nil || len(d.fields) == 0 {
		return d, fmt.Errorf("canonicalimport: %s/%s fields must be a non-empty JSON object", row.Kind, row.SourceID)
	}
	for name := range d.fields {
		d.names = append(d.names, name)
	}
	sort.Strings(d.names)
	return d, nil
}

func digest(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func rowChecksum(d decoded) (string, error) {
	// Canonical field encoding: sorted names, compact values.
	canonical, err := json.Marshal(d.fields)
	if err != nil {
		return "", err
	}
	return digest(d.Kind, d.SourceID, string(canonical)), nil
}

// DryRun validates the archive and counts rows per table without a database.
func (i Importer) DryRun(rows []Row) (Report, error) {
	_, report, err := prepare(rows)
	return report, err
}

func prepare(rows []Row) ([]decoded, Report, error) {
	out := Report{Counts: map[string]int{}, Items: make([]Item, 0, len(rows))}
	all := make([]decoded, 0, len(rows))
	seen := map[string]bool{}
	for _, row := range rows {
		d, err := decode(row)
		if err != nil {
			return nil, Report{}, err
		}
		key := row.Kind + "\x00" + row.SourceID
		if seen[key] {
			return nil, Report{}, fmt.Errorf("canonicalimport: duplicate source %s/%s", row.Kind, row.SourceID)
		}
		seen[key] = true
		sum, err := rowChecksum(d)
		if err != nil {
			return nil, Report{}, err
		}
		out.Items = append(out.Items, Item{row.Kind, row.SourceID, sum})
		out.Counts[row.Kind]++
		all = append(all, d)
	}
	out.Count = len(out.Items)
	var sums []string
	for _, item := range out.Items {
		sums = append(sums, item.Checksum)
	}
	out.Checksum = digest(sums...)
	return all, out, nil
}

type table struct {
	columns map[string]bool
	pk      []string
	serial  map[string]string // column -> owned sequence
}

func describe(ctx context.Context, q pgx.Tx, name string) (table, error) {
	t := table{columns: map[string]bool{}, serial: map[string]string{}}
	rows, err := q.Query(ctx, `SELECT column_name, COALESCE(pg_get_serial_sequence(format('public.%I', table_name), column_name), '')
		FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`, name)
	if err != nil {
		return t, err
	}
	for rows.Next() {
		var column, sequence string
		if err = rows.Scan(&column, &sequence); err != nil {
			rows.Close()
			return t, err
		}
		t.columns[column] = true
		if sequence != "" {
			t.serial[column] = sequence
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return t, err
	}
	rows, err = q.Query(ctx, `SELECT a.attname FROM pg_index i
		JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
		JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		WHERE i.indrelid = format('public.%I', $1::text)::regclass AND i.indisprimary ORDER BY k.ord`, name)
	if err != nil {
		return t, err
	}
	for rows.Next() {
		var column string
		if err = rows.Scan(&column); err != nil {
			rows.Close()
			return t, err
		}
		t.pk = append(t.pk, column)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return t, err
	}
	if len(t.columns) == 0 || len(t.pk) == 0 {
		return t, fmt.Errorf("canonicalimport: table %s or its primary key is missing", name)
	}
	return t, nil
}

func (t table) check(d decoded) error {
	for _, name := range d.names {
		if !t.columns[name] {
			return fmt.Errorf("canonicalimport: %s has no column %s", d.Kind, name)
		}
	}
	for _, key := range t.pk {
		if _, ok := d.fields[key]; !ok {
			return fmt.Errorf("canonicalimport: %s/%s is missing primary key %s", d.Kind, d.SourceID, key)
		}
	}
	return nil
}

// matches reports whether the stored row with this primary key equals every
// supplied field after PostgreSQL's own type conversion.
func matches(ctx context.Context, tx pgx.Tx, t table, d decoded) (bool, error) {
	qTable := pgx.Identifier{"public", d.Kind}.Sanitize()
	where := make([]string, 0, len(t.pk))
	for _, key := range t.pk {
		q := pgx.Identifier{key}.Sanitize()
		where = append(where, "t."+q+" = s."+q)
	}
	equal := make([]string, 0, len(d.names))
	for _, name := range d.names {
		q := pgx.Identifier{name}.Sanitize()
		equal = append(equal, "t."+q+" IS NOT DISTINCT FROM s."+q)
	}
	var same bool
	err := tx.QueryRow(ctx, `SELECT `+strings.Join(equal, " AND ")+` FROM `+qTable+` t, jsonb_populate_record(NULL::`+qTable+`, $1::jsonb) s WHERE `+
		strings.Join(where, " AND "), string(d.Fields)).Scan(&same)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return same, err
}

// Apply writes each row with its receipt in one transaction. An exact replay
// is a no-op; a changed row for an imported source, or a pre-existing
// canonical row with different contents, is ErrConflict. Identity sequences
// are advanced past imported keys.
func (i Importer) Apply(ctx context.Context, rows []Row) (Report, error) {
	all, report, err := prepare(rows)
	if err != nil {
		return report, err
	}
	if i.DB == nil {
		return report, errors.New("canonicalimport: PostgreSQL pool required")
	}
	for n, d := range all {
		if err = i.applyOne(ctx, d, report.Items[n].Checksum); err != nil {
			return report, fmt.Errorf("%s/%s: %w", d.Kind, d.SourceID, err)
		}
	}
	return report, nil
}

func (i Importer) transaction(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := i.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (i Importer) applyOne(ctx context.Context, d decoded, sum string) error {
	return i.transaction(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "canonicalimport:"+d.Kind+":"+d.SourceID); err != nil {
			return err
		}
		var recorded string
		err := tx.QueryRow(ctx, `SELECT checksum FROM canonical_import_receipts WHERE source_kind = $1 AND source_id = $2`, d.Kind, d.SourceID).Scan(&recorded)
		if err == nil {
			if recorded != sum {
				return ErrConflict
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		t, err := describe(ctx, tx, d.Kind)
		if err != nil {
			return err
		}
		if err = t.check(d); err != nil {
			return err
		}
		qTable := pgx.Identifier{"public", d.Kind}.Sanitize()
		quoted := make([]string, len(d.names))
		values := make([]string, len(d.names))
		for n, name := range d.names {
			quoted[n] = pgx.Identifier{name}.Sanitize()
			values[n] = "s." + quoted[n]
		}
		tag, err := tx.Exec(ctx, `INSERT INTO `+qTable+` (`+strings.Join(quoted, ", ")+`) OVERRIDING SYSTEM VALUE SELECT `+strings.Join(values, ", ")+
			` FROM jsonb_populate_record(NULL::`+qTable+`, $1::jsonb) s ON CONFLICT DO NOTHING`, string(d.Fields))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Only an identical pre-existing row may be claimed.
			same, err := matches(ctx, tx, t, d)
			if err != nil {
				return err
			}
			if !same {
				return ErrConflict
			}
		}
		// The key is read back through the column types, so "42" and 42
		// name the same row.
		pairs := make([]string, 0, 2*len(t.pk))
		for _, column := range t.pk {
			pairs = append(pairs, quoteLiteral(column), "s."+pgx.Identifier{column}.Sanitize())
		}
		tag, err = tx.Exec(ctx, `INSERT INTO canonical_import_receipts (source_kind, source_id, target_table, primary_key, checksum)
			SELECT $1, $2, $3, jsonb_build_object(`+strings.Join(pairs, ", ")+`), $5
			FROM jsonb_populate_record(NULL::`+qTable+`, $4::jsonb) s
			ON CONFLICT (target_table, primary_key) DO NOTHING`, d.Kind, d.SourceID, d.Kind, string(d.Fields), sum)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Another source already claimed this canonical row.
			return ErrConflict
		}
		return advanceSequences(ctx, tx, d.Kind, t)
	})
}

func quoteLiteral(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// advanceSequences moves each owned sequence past the table's largest key so
// rows created after the import cannot collide with imported ids.
func advanceSequences(ctx context.Context, tx pgx.Tx, kind string, t table) error {
	for column, sequence := range t.serial {
		q := pgx.Identifier{column}.Sanitize()
		if _, err := tx.Exec(ctx, `SELECT setval($1::regclass, m) FROM (SELECT max(`+q+`)::bigint AS m FROM `+pgx.Identifier{"public", kind}.Sanitize()+`) x
			WHERE m IS NOT NULL AND m > (SELECT COALESCE(last_value, 0) FROM pg_sequences WHERE format('%I.%I', schemaname, sequencename)::regclass = $1::regclass)`, sequence); err != nil {
			return err
		}
	}
	return nil
}

// Verify reads every receipt and canonical row back and compares each
// supplied field; a missing or altered row fails the cutover.
func (i Importer) Verify(ctx context.Context, rows []Row) (Report, error) {
	all, report, err := prepare(rows)
	if err != nil {
		return report, err
	}
	if i.DB == nil {
		return report, errors.New("canonicalimport: PostgreSQL pool required")
	}
	var receipts int
	if err = i.DB.QueryRow(ctx, `SELECT count(*) FROM canonical_import_receipts`).Scan(&receipts); err != nil {
		return report, err
	}
	if receipts != len(all) {
		return report, fmt.Errorf("verify: %d receipts stored, %d rows in the archive: %w", receipts, len(all), ErrConflict)
	}
	for n, d := range all {
		err = i.transaction(ctx, func(tx pgx.Tx) error {
			var recorded string
			if err := tx.QueryRow(ctx, `SELECT checksum FROM canonical_import_receipts WHERE source_kind = $1 AND source_id = $2`,
				d.Kind, d.SourceID).Scan(&recorded); err != nil {
				return fmt.Errorf("receipt: %w", err)
			}
			if recorded != report.Items[n].Checksum {
				return ErrConflict
			}
			t, err := describe(ctx, tx, d.Kind)
			if err != nil {
				return err
			}
			if err = t.check(d); err != nil {
				return err
			}
			same, err := matches(ctx, tx, t, d)
			if err != nil {
				return err
			}
			if !same {
				return ErrConflict
			}
			return nil
		})
		if err != nil {
			return report, fmt.Errorf("verify %s/%s: %w", d.Kind, d.SourceID, err)
		}
	}
	return report, nil
}
