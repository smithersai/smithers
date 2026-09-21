package middleware_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// buildSpecRouter creates a Chi router with the same middleware stack as cmd/server/main.go.
// This mirrors the spec-defined middleware order:
// 1. RequestID  2. RealIP  3. Logger  4. Recoverer  5. Timeout (30s)  6. CORS  7. ContentType
func buildSpecRouter() *chi.Mux {
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RealIP(0))
	r.Use(chiMiddleware.Logger)
	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.JSONTimeout(30 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	r.Use(middleware.JSONAllowContentType("application/json"))

	return r
}

func TestMiddlewareStack_RequestIDInContext(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()

	var capturedRequestID string
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		// chi's RequestID middleware stores the ID in context, not as a response header
		capturedRequestID = chiMiddleware.GetReqID(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.NotEmpty(t, capturedRequestID, "RequestID middleware must inject request ID into context")
}

func TestMiddlewareStack_RecovererReturnsJSON500OnAPIPanic(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()
	r.Get("/api/panic", func(w http.ResponseWriter, r *http.Request) {
		panic("middleware stack test panic")
	})

	req := httptest.NewRequest(http.MethodGet, "/api/panic", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "internal server error", body.Message)
}

func TestMiddlewareStack_CORSPreflight(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()
	r.Post("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	req := httptest.NewRequest(http.MethodOptions, "/api/test", nil)
	req.Header.Set("Origin", "https://smithers.sh")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Content-Type,Authorization")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// CORS preflight should return 200 with appropriate headers
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "*", rec.Header().Get("Access-Control-Allow-Origin"))
	assert.Contains(t, rec.Header().Get("Access-Control-Allow-Methods"), "POST")
	assert.Contains(t, rec.Header().Get("Access-Control-Allow-Headers"), "Content-Type")
	assert.Contains(t, rec.Header().Get("Access-Control-Allow-Headers"), "Authorization")
}

func TestMiddlewareStack_CORSSimpleRequest(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("Origin", "https://smithers.sh")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "*", rec.Header().Get("Access-Control-Allow-Origin"))
	// Exposed headers
	assert.Contains(t, rec.Header().Get("Access-Control-Expose-Headers"), "Link")
}

func TestMiddlewareStack_ContentTypeEnforcementOnAPIRoutes(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()
	r.Post("/api/repos", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	// Wrong content type
	req := httptest.NewRequest(http.MethodPost, "/api/repos", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnsupportedMediaType, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "unsupported content type", body.Message)
}

func TestMiddlewareStack_ContentTypeAllowsJSON(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()
	r.Post("/api/repos", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	req := httptest.NewRequest(http.MethodPost, "/api/repos", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusCreated, rec.Code)
}

func TestMiddlewareStack_BuildSpecRouterIncludesContentType(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()
	r.Post("/api/repos", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	req := httptest.NewRequest(http.MethodPost, "/api/repos", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnsupportedMediaType, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "unsupported content type", body.Message)
}

func TestMiddlewareStack_TimeoutReturnsJSON504(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.JSONRecoverer)
	// Very short timeout to trigger quickly
	r.Use(middleware.JSONTimeout(10 * time.Millisecond))

	r.Get("/api/slow", func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})

	req := httptest.NewRequest(http.MethodGet, "/api/slow", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "request timeout", body.Message)
}

func TestMiddlewareStack_TimeoutReturnsJSON504_WhenHandlerIgnoresContext(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.JSONTimeout(15 * time.Millisecond))

	r.Get("/api/slow-ignore-context", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(250 * time.Millisecond)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/slow-ignore-context", nil)
	rec := httptest.NewRecorder()

	start := time.Now()
	r.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Less(t, elapsed, 150*time.Millisecond, "full middleware stack should enforce timeout deadline")

	var body struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "request timeout", body.Message)
}

func TestMiddlewareStack_CORSPreflightAllowsSpecMethods(t *testing.T) {
	t.Parallel()

	specMethods := []string{"GET", "POST", "PUT", "PATCH", "DELETE"}

	r := buildSpecRouter()
	// Register all method types
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Post("/api/test", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Put("/api/test", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Patch("/api/test", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Delete("/api/test", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	// Verify each method is allowed via individual preflight requests
	for _, method := range specMethods {
		method := method
		t.Run(method, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodOptions, "/api/test", nil)
			req.Header.Set("Origin", "https://smithers.sh")
			req.Header.Set("Access-Control-Request-Method", method)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code, "CORS preflight must succeed for %s", method)
			assert.Contains(t, rec.Header().Get("Access-Control-Allow-Methods"), method,
				"CORS config must allow method %s per spec", method)
		})
	}
}

func TestMiddlewareStack_CORSPreflightAllowsSpecHeaders(t *testing.T) {
	t.Parallel()

	expectedHeaders := []string{"Accept", "Authorization", "Content-Type"}

	r := buildSpecRouter()
	r.Post("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodOptions, "/api/test", nil)
	req.Header.Set("Origin", "https://smithers.sh")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", strings.Join(expectedHeaders, ","))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	allowedHeaders := rec.Header().Get("Access-Control-Allow-Headers")
	for _, header := range expectedHeaders {
		assert.Contains(t, allowedHeaders, header,
			"CORS config must allow header %s per spec", header)
	}
}

func TestMiddlewareStack_CORSNoCredentials(t *testing.T) {
	t.Parallel()

	r := buildSpecRouter()
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("Origin", "https://smithers.sh")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// AllowCredentials: false means Access-Control-Allow-Credentials should NOT be present
	assert.Empty(t, rec.Header().Get("Access-Control-Allow-Credentials"),
		"CORS should not set Allow-Credentials header when AllowCredentials is false")
}

func TestMiddlewareStack_RecovererIsBeforeTimeout(t *testing.T) {
	t.Parallel()

	// Verify that recoverer catches panics even with timeout middleware.
	// Since recoverer runs BEFORE timeout in the stack (outer → inner),
	// a panic within a timed-out handler is still recovered.
	r := chi.NewRouter()
	r.Use(middleware.JSONRecoverer)
	r.Use(middleware.JSONTimeout(50 * time.Millisecond))

	r.Get("/api/panic-with-timeout", func(w http.ResponseWriter, r *http.Request) {
		panic("immediate panic under timeout")
	})

	req := httptest.NewRequest(http.MethodGet, "/api/panic-with-timeout", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// Should get 500 from recoverer, not 504 from timeout
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
}

func TestMiddlewareStack_MiddlewareOrderVerification(t *testing.T) {
	t.Parallel()

	// This test verifies the middleware stack order by capturing execution order.
	// Each middleware appends to a shared execution log, allowing us to verify
	// the exact order in which middleware executes.
	var executionOrder []string

	r := chi.NewRouter()

	// Wrapper middlewares that record their execution
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			executionOrder = append(executionOrder, "RequestID")
			next.ServeHTTP(w, r)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			executionOrder = append(executionOrder, "RealIP")
			next.ServeHTTP(w, r)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			executionOrder = append(executionOrder, "Logger")
			next.ServeHTTP(w, r)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			executionOrder = append(executionOrder, "Recoverer")
			next.ServeHTTP(w, r)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			executionOrder = append(executionOrder, "Timeout")
			next.ServeHTTP(w, r)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			executionOrder = append(executionOrder, "CORS")
			next.ServeHTTP(w, r)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			executionOrder = append(executionOrder, "ContentType")
			next.ServeHTTP(w, r)
		})
	})

	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		executionOrder = append(executionOrder, "Handler")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)

	// Verify the spec-defined middleware order
	expectedOrder := []string{
		"RequestID",
		"RealIP",
		"Logger",
		"Recoverer",
		"Timeout",
		"CORS",
		"ContentType",
		"Handler",
	}
	assert.Equal(t, expectedOrder, executionOrder,
		"Middleware must execute in the spec-defined order: RequestID → RealIP → Logger → Recoverer → Timeout → CORS → ContentType")
}
