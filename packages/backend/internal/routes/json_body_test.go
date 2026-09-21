package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestDecodeJSONBody(t *testing.T) {
	t.Parallel()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	cases := []struct {
		name        string
		body        string
		wantStatus  int
		wantMessage string
	}{
		{
			name:        "malformed JSON returns 400",
			body:        `{"name":`,
			wantStatus:  http.StatusBadRequest,
			wantMessage: "invalid request body",
		},
		{
			name:        "oversized body returns 413",
			body:        `{"name":"` + strings.Repeat("a", int(middleware.MaxRequestBodySize)) + `"}`,
			wantStatus:  http.StatusRequestEntityTooLarge,
			wantMessage: "request body too large",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			require.Equal(t, tc.wantStatus, rec.Code)

			var payload map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
			assert.Equal(t, tc.wantMessage, payload["message"])
		})
	}
}

func TestDecodeOptionalJSONBody(t *testing.T) {
	t.Parallel()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
		}
		if !decodeOptionalJSONBody(w, r, &req) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	cases := []struct {
		name        string
		body        string
		wantStatus  int
		wantMessage string
	}{
		{
			name:       "empty body is allowed",
			body:       "",
			wantStatus: http.StatusNoContent,
		},
		{
			name:        "malformed JSON returns 400",
			body:        `{"name":`,
			wantStatus:  http.StatusBadRequest,
			wantMessage: "invalid request body",
		},
		{
			name:        "oversized body returns 413",
			body:        `{"name":"` + strings.Repeat("a", int(middleware.MaxRequestBodySize)) + `"}`,
			wantStatus:  http.StatusRequestEntityTooLarge,
			wantMessage: "request body too large",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			require.Equal(t, tc.wantStatus, rec.Code)
			if tc.wantMessage == "" {
				return
			}

			var payload map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
			assert.Equal(t, tc.wantMessage, payload["message"])
		})
	}
}
