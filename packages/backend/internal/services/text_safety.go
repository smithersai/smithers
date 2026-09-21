package services

import (
	stdErrors "errors"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// validateSafeText rejects user-supplied text that a Postgres text column
// cannot store, so the failure surfaces as a clean 422 validation error instead
// of an opaque 500 that also leaks the raw driver message (SQLSTATE + column
// details). Two byte-level hazards are caught:
//
//   - NUL (U+0000): Postgres text columns reject 0x00 with SQLSTATE 22021
//     ("invalid byte sequence for encoding UTF8: 0x00"). A JSON-escaped "\x00"
//     survives JSON decoding and reaches the DB unless rejected here.
//   - Invalid UTF-8: malformed/overlong/surrogate byte sequences (e.g. from a
//     mis-encoded client) are likewise rejected by Postgres text encoding.
//
// Callers keep their own emptiness/length checks (those differ per field);
// this helper only guards the two storage-fatal cases that were otherwise
// unhandled across the write paths (issues, comments, labels, milestones,
// landings, reviews). Returns nil when the value is safe to store.
func validateSafeText(resource, field, value string) *pkgerrors.APIError {
	if strings.IndexByte(value, 0) >= 0 || !utf8.ValidString(value) {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: resource, Field: field, Code: "invalid"})
	}
	return nil
}

// isInvalidTextRepresentation reports whether err is a Postgres
// invalid_text_representation error (SQLSTATE 22P02) — e.g. a non-UUID string
// supplied for a uuid-typed column. Callers map it to a clean 404/4xx instead
// of the opaque 500 that would otherwise leak the raw driver text.
func isInvalidTextRepresentation(err error) bool {
	var pgErr *pgconn.PgError
	return stdErrors.As(err, &pgErr) && pgErr.Code == "22P02"
}
