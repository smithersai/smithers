package microsandbox

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	. "github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestParseStatusError_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		status    int
		body      string
		wantCode  string
		wantMsg   string
		wantError string
	}{
		{
			name:     "structured_error_and_message",
			status:   http.StatusBadGateway,
			body:     `{"error":" UPSTREAM_DOWN ","message":" backend unavailable "}`,
			wantCode: "UPSTREAM_DOWN",
			wantMsg:  "backend unavailable",
		},
		{
			name:     "structured_error_only",
			status:   http.StatusBadRequest,
			body:     `{"error":"INVALID_ARGUMENT"}`,
			wantCode: "INVALID_ARGUMENT",
		},
		{
			name:    "structured_message_only",
			status:  http.StatusUnauthorized,
			body:    `{"message":" auth required "}`,
			wantMsg: "auth required",
		},
		{
			name:    "structured_blank_fields_falls_back_to_raw_body",
			status:  http.StatusConflict,
			body:    `{"error":" ","message":" "}`,
			wantMsg: `{"error":" ","message":" "}`,
		},
		{
			name:    "plain_text_body",
			status:  http.StatusServiceUnavailable,
			body:    " backend unavailable \n",
			wantMsg: "backend unavailable",
		},
		{
			name:    "invalid_json_body",
			status:  http.StatusInternalServerError,
			body:    `{"error":`,
			wantMsg: `{"error":`,
		},
		{
			name:    "empty_body",
			status:  http.StatusNotFound,
			body:    "",
			wantMsg: "",
		},
		{
			name:    "oversized_body_is_truncated",
			status:  http.StatusBadGateway,
			body:    strings.Repeat("a", maxErrorBodyDiscardBytes+512),
			wantMsg: strings.Repeat("a", maxErrorBodyDiscardBytes),
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := parseStatusError(&http.Response{
				StatusCode: tc.status,
				Body:       io.NopCloser(strings.NewReader(tc.body)),
			})
			assert.Equal(t, tc.status, err.StatusCode)
			assert.Equal(t, tc.wantCode, err.ErrorCode)
			assert.Equal(t, tc.wantMsg, err.Message)
			if tc.wantError != "" {
				assert.Equal(t, tc.wantError, err.Error())
			}
		})
	}
}

func TestParseStatusError_ReadFailure(t *testing.T) {
	t.Parallel()

	err := parseStatusError(&http.Response{
		StatusCode: http.StatusBadGateway,
		Body:       failingReadCloser{err: errors.New("read failed")},
	})

	assert.Equal(t, http.StatusBadGateway, err.StatusCode)
	assert.Empty(t, err.ErrorCode)
	assert.Empty(t, err.Message)
}

func TestStatusError_ErrorMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   StatusError
		want string
	}{
		{
			name: "code_and_message",
			in:   StatusError{StatusCode: 502, ErrorCode: "UPSTREAM_DOWN", Message: "backend unavailable"},
			want: "microsandbox api returned status 502 (UPSTREAM_DOWN): backend unavailable",
		},
		{
			name: "message_only",
			in:   StatusError{StatusCode: 503, Message: "backend unavailable"},
			want: "microsandbox api returned status 503: backend unavailable",
		},
		{
			name: "status_only",
			in:   StatusError{StatusCode: 500},
			want: "microsandbox api returned status 500",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.in.Error())
		})
	}
}

func TestDiscardErrorBody_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for size := 0; size <= maxErrorBodyDiscardBytes*2; size += 97 {
		caseCount++

		reader := strings.NewReader(strings.Repeat("a", size))
		discardErrorBody(reader)
		rest, err := io.ReadAll(reader)
		assert.NoError(t, err)

		wantRemaining := size - maxErrorBodyDiscardBytes
		if wantRemaining < 0 {
			wantRemaining = 0
		}
		assert.Lenf(t, rest, wantRemaining, "size=%d", size)
	}

	discardErrorBody(nil)

	assert.Equal(t, 85, caseCount)
}

type failingReadCloser struct {
	err error
}

func (f failingReadCloser) Read([]byte) (int, error) {
	return 0, f.err
}

func (f failingReadCloser) Close() error {
	return nil
}
