package services

import (
	stdErrors "errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// An over-long or NUL-bearing stack field (change_id, branch_name, ci_status, ...)
// makes Postgres reject the write with SQLSTATE 22001/22021. That is client-caused
// bad input and must surface as 422, not an opaque 500.
func TestNormalizeStackWriteError_MapsOverlongAndNulTo422(t *testing.T) {
	for _, code := range []string{"22001", "22021"} {
		err := normalizeStackWriteError(&pgconn.PgError{Code: code}, "failed to upsert stack changes")
		var apiErr *pkgerrors.APIError
		if !stdErrors.As(err, &apiErr) {
			t.Fatalf("code %s: expected *APIError, got %v", code, err)
		}
		if apiErr.Status != 422 {
			t.Fatalf("code %s: status %d, want 422", code, apiErr.Status)
		}
	}
}
