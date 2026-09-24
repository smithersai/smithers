package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestReviewScopeSeparatorsPreserveResourceRestrictions(t *testing.T) {
	for name, separator := range map[string]string{
		"comma": ",", "space": " ", "tab": "\t", "newline": "\n", "unicode_space": "\u2003",
	} {
		t.Run(name, func(t *testing.T) {
			bindings := []struct {
				name, entry string
				check       func(*AuthInfo)
			}{
				{"repository", RepositoryRestrictionScope(42), func(auth *AuthInfo) {
					assert.Equal(t, int64(42), auth.RepositoryRestriction())
				}},
				{"agent_session", AgentSessionRestrictionScope("session-42"), func(auth *AuthInfo) {
					assert.Equal(t, "session-42", ParseTokenAgentSessionRestriction(auth.RawScopes))
				}},
				{"path", PathRestrictionScopes([]string{"src/with space/*.go"})[0], func(auth *AuthInfo) {
					assert.Equal(t, []string{"src/with space/*.go"}, ParseTokenPathRestrictions(auth.RawScopes))
				}},
				{"workspace", WorkspaceRestrictionScope("workspace-42"), func(auth *AuthInfo) {
					assert.Equal(t, "workspace-42", auth.WorkspaceRestriction())
				}},
			}
			for _, binding := range bindings {
				t.Run(binding.name, func(t *testing.T) {
					auth := unrestrictedTokenAuthInfo(strings.Join([]string{"write:repository", binding.entry}, separator))
					require.True(t, auth.Scopes.Has(ScopeWriteRepository), "this representation grants permissions")
					binding.check(auth)
					assert.True(t, auth.IsResourceBound(), "credential minting must not strip a recognized binding")
				})
			}

			auth := unrestrictedTokenAuthInfo("write:repository" + separator + "repo:42")
			for _, gate := range []func(TokenScope) func(http.Handler) http.Handler{RequireScope, RequireTokenScope} {
				global := serveScoped(t, auth, http.MethodPost, "/user/repos", func(r chi.Router, next http.HandlerFunc) {
					r.With(gate(ScopeWriteRepository)).Post("/user/repos", next)
				})
				assert.Equal(t, http.StatusForbidden, global.Code, "bound credentials cannot create another repository")
				repo := serveScoped(t, auth, http.MethodPost, "/repos/alice/widget/issues", func(r chi.Router, next http.HandlerFunc) {
					r.With(gate(ScopeWriteRepository)).Post("/repos/{owner}/{repo}/issues", next)
				})
				assert.Equal(t, http.StatusNoContent, repo.Code, "repo-addressed calls reach the repository permission gate")
			}
		})
	}
}

func TestReviewRateLimitRetryAfterSurvivesHeaderStripping(t *testing.T) {
	for _, tc := range []struct {
		name  string
		limit int
		wait  int
	}{
		{"auth", 5, 12}, {"telemetry", 10, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			limiter := newLimiter(&mockRateLimitStore{}, tc.name, tc.limit, time.Minute, tc.limit, time.Minute, nil)
			limiter.nowFn = func() time.Time { return time.Unix(1_800_000_000, 0).UTC() }
			handler := limiter.middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))
			for i := 0; i < tc.limit; i++ {
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/report", nil))
				require.Equal(t, http.StatusNoContent, rec.Code)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/report", nil))
			assertReviewRetryAfter(t, rec, tc.wait)
		})
	}

	t.Run("count_quota", func(t *testing.T) {
		handler := userCountCapMiddleware(func(context.Context, int64) (int, error) { return 3, nil }, 3, "test", "full")(
			http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("full quota reached handler") }),
		)
		req := httptest.NewRequest(http.MethodPost, "/sandboxes", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 7}}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		assertReviewRetryAfter(t, rec, 60)
	})
}

func assertReviewRetryAfter(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, strconv.Itoa(want), rec.Header().Get("Retry-After"))
	// The Worker forwards this JSON body without the upstream header.
	var body struct {
		RetryAfter int `json:"retry_after"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, want, body.RetryAfter)
}

func TestReviewStructuredLoggerRecordsWireStatus(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		handle http.HandlerFunc
	}{
		{"explicit_then_error", http.StatusCreated, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusCreated)
			w.WriteHeader(http.StatusInternalServerError)
		}},
		{"body_then_error", http.StatusOK, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("partial response"))
			w.WriteHeader(http.StatusInternalServerError)
		}},
		{"flush_then_error", http.StatusOK, func(w http.ResponseWriter, _ *http.Request) {
			w.(http.Flusher).Flush()
			w.WriteHeader(http.StatusServiceUnavailable)
		}},
		{"informational_only", http.StatusOK, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusEarlyHints)
		}},
		{"informational_then_final", http.StatusCreated, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusEarlyHints)
			w.WriteHeader(http.StatusCreated)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logged := make(chan struct{})
			handler := StructuredLogger(slog.New(slog.NewJSONHandler(&logs, nil)))(tc.handle)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(logged)
				handler.ServeHTTP(w, r)
			}))
			defer server.Close()
			res, err := server.Client().Get(server.URL)
			require.NoError(t, err)
			_, err = io.Copy(io.Discard, res.Body)
			require.NoError(t, err)
			require.NoError(t, res.Body.Close())
			require.Equal(t, tc.status, res.StatusCode)
			<-logged
			var entry struct {
				Request struct {
					Status int `json:"status"`
				} `json:"httpRequest"`
			}
			require.NoError(t, json.Unmarshal(logs.Bytes(), &entry))
			assert.Equal(t, res.StatusCode, entry.Request.Status, "access log must describe the final wire response")
		})
	}
}
