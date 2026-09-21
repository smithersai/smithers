package repohostserver

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

func TestMapFFIError_Matrix(t *testing.T) {
	t.Parallel()

	existing := badRequest("already bad")
	got := mapFFIError(existing)
	require.Same(t, existing, got)

	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantMsg    string
		wantCause  bool
	}{
		{
			name:       "nil",
			err:        nil,
			wantStatus: 0,
		},
		{
			name:       "bad_request_code",
			err:        &repohostffi.Error{Code: "bad_request", Message: "bad input"},
			wantStatus: http.StatusBadRequest,
			wantMsg:    "bad input",
		},
		{
			name:       "invalid_argument_code",
			err:        &repohostffi.Error{Code: "invalid_argument", Message: "bad input"},
			wantStatus: http.StatusBadRequest,
			wantMsg:    "bad input",
		},
		{
			name:       "not_found_code",
			err:        &repohostffi.Error{Code: "not_found", Message: "missing"},
			wantStatus: http.StatusNotFound,
			wantMsg:    "missing",
		},
		{
			name:       "conflict_code",
			err:        &repohostffi.Error{Code: "conflict", Message: "already exists"},
			wantStatus: http.StatusConflict,
			wantMsg:    "already exists",
		},
		{
			name:       "unprocessable_entity_code",
			err:        &repohostffi.Error{Code: "unprocessable_entity", Message: "no path matched"},
			wantStatus: http.StatusUnprocessableEntity,
			wantMsg:    "no path matched",
		},
		{
			name:       "unknown_ffi_code_becomes_internal",
			err:        &repohostffi.Error{Code: "permission_denied", Message: "forbidden"},
			wantStatus: http.StatusInternalServerError,
			wantMsg:    "internal server error",
			wantCause:  true,
		},
		{
			name:       "generic_error_becomes_internal",
			err:        errors.New("boom"),
			wantStatus: http.StatusInternalServerError,
			wantMsg:    "internal server error",
			wantCause:  true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := mapFFIError(tc.err)
			if tc.err == nil {
				assert.Nil(t, got)
				return
			}

			require.NotNil(t, got)
			assert.Equal(t, tc.wantStatus, got.StatusCode)
			assert.Equal(t, tc.wantMsg, got.Message)
			if tc.wantCause {
				assert.ErrorIs(t, got.Cause, tc.err)
			} else {
				assert.Nil(t, got.Cause)
			}
		})
	}
}

func TestWriteJSON_SetsHeadersAndBody(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	err := writeJSON(rec, http.StatusAccepted, map[string]string{"status": "ok"})
	require.NoError(t, err)

	assert.Equal(t, http.StatusAccepted, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, map[string]string{"status": "ok"}, body)
}

func TestWriteAppError_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantBody   string
		wantLog    bool
	}{
		{
			name:       "nil_error_writes_nothing",
			err:        nil,
			wantStatus: http.StatusOK,
		},
		{
			name:       "ffi_bad_request",
			err:        &repohostffi.Error{Code: "bad_request", Message: "bad input"},
			wantStatus: http.StatusBadRequest,
			wantBody:   "bad input",
		},
		{
			name:       "generic_internal_error_logs_cause",
			err:        errors.New("boom"),
			wantStatus: http.StatusInternalServerError,
			wantBody:   "internal server error",
			wantLog:    true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))

			rec := httptest.NewRecorder()
			writeAppError(rec, tc.err, logger)

			assert.Equal(t, tc.wantStatus, rec.Code)
			if tc.err == nil {
				assert.Empty(t, rec.Body.String())
				assert.Empty(t, logs.String())
				return
			}

			var body errorEnvelope
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, tc.wantBody, body.Message)
			if tc.wantLog {
				assert.Contains(t, logs.String(), "repo-host handler failed")
				assert.Contains(t, logs.String(), "boom")
			} else {
				assert.Empty(t, logs.String())
			}
		})
	}
}
