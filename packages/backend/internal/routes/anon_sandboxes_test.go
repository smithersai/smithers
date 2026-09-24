package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const testAnonRouteID = "3f2b8a1c-5d6e-4f70-9a8b-1c2d3e4f5a6b"

type fakeAnonSandboxRouteService struct {
	createErr error
	getErr    error
	deleteErr error

	lastRepo   string
	lastBranch string
	lastIP     string
	lastToken  string
}

func (f *fakeAnonSandboxRouteService) row() db.AnonSandbox {
	return db.AnonSandbox{
		ID:                testAnonRouteID,
		RepoFullName:      "smithersai/smithers",
		Branch:            "main",
		Status:            "pending",
		ProvisioningStage: "",
		ExpiresAt:         time.Date(2026, 7, 19, 12, 30, 0, 0, time.UTC),
		CreatedAt:         time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC),
		UpdatedAt:         time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC),
	}
}

func (f *fakeAnonSandboxRouteService) Create(_ context.Context, repo, branch, ip string) (services.AnonSandboxCreation, error) {
	f.lastRepo, f.lastBranch, f.lastIP = repo, branch, ip
	if f.createErr != nil {
		return services.AnonSandboxCreation{}, f.createErr
	}
	return services.AnonSandboxCreation{Sandbox: f.row(), Token: "token-plaintext"}, nil
}

func (f *fakeAnonSandboxRouteService) Get(_ context.Context, _, token string) (db.AnonSandbox, error) {
	f.lastToken = token
	if f.getErr != nil {
		return db.AnonSandbox{}, f.getErr
	}
	row := f.row()
	row.Status = "running"
	row.ProvisioningStage = "ready"
	return row, nil
}

func (f *fakeAnonSandboxRouteService) Delete(_ context.Context, _, token string) error {
	f.lastToken = token
	return f.deleteErr
}

func newAnonSandboxTestRouter(svc AnonSandboxRouteService) http.Handler {
	r := chi.NewRouter()
	NewAnonSandboxHandler(svc).Mount(r, nil)
	return r
}

func TestAnonSandboxRoutes_CreateReturnsTokenOnce(t *testing.T) {
	svc := &fakeAnonSandboxRouteService{}
	router := newAnonSandboxTestRouter(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/public/sandboxes", strings.NewReader(`{"repo_full_name":"smithersai/smithers","branch":"main"}`))
	req.RemoteAddr = "203.0.113.9:41234"
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("want 202, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if body["access_token"] != "token-plaintext" {
		t.Fatalf("create must return the token: %v", body)
	}
	if body["id"] != testAnonRouteID || body["repo_full_name"] != "smithersai/smithers" || body["status"] != "pending" {
		t.Fatalf("row fields wrong: %v", body)
	}
	if _, ok := body["expires_at"]; !ok {
		t.Fatal("expires_at missing")
	}
	if svc.lastIP != "203.0.113.9" {
		t.Fatalf("client ip not extracted: %q", svc.lastIP)
	}

	// GET must NOT include the token.
	getReq := httptest.NewRequest(http.MethodGet, "/api/public/sandboxes/"+testAnonRouteID, nil)
	getReq.Header.Set(AnonSandboxTokenHeader, "token-plaintext")
	getRec := httptest.NewRecorder()
	router.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", getRec.Code)
	}
	if strings.Contains(getRec.Body.String(), "access_token") {
		t.Fatalf("get must omit access_token: %s", getRec.Body.String())
	}
	if svc.lastToken != "token-plaintext" {
		t.Fatalf("token header not forwarded: %q", svc.lastToken)
	}
}

func TestAnonSandboxRoutes_BadBodyAndBadID(t *testing.T) {
	router := newAnonSandboxTestRouter(&fakeAnonSandboxRouteService{})

	req := httptest.NewRequest(http.MethodPost, "/api/public/sandboxes", strings.NewReader("{"))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for bad body, got %d", rec.Code)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/public/sandboxes/not-a-uuid", nil)
	getRec := httptest.NewRecorder()
	router.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for non-uuid id, got %d", getRec.Code)
	}
}

func TestAnonSandboxRoutes_ServiceErrorMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"allowlist", pkgerrors.Forbidden("repository is not on the anonymous sandbox allowlist"), http.StatusForbidden},
		{"quota", pkgerrors.QuotaExceeded("anonymous sandbox capacity reached, try again shortly"), http.StatusTooManyRequests},
		{"disabled", pkgerrors.NotFound("anonymous sandboxes are not enabled"), http.StatusNotFound},
		{"missing table", &pgconn.PgError{Code: "42P01"}, http.StatusServiceUnavailable},
		{"opaque", context.DeadlineExceeded, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router := newAnonSandboxTestRouter(&fakeAnonSandboxRouteService{createErr: tc.err})
			req := httptest.NewRequest(http.MethodPost, "/api/public/sandboxes", strings.NewReader(`{"repo_full_name":"x/y"}`))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("want %d, got %d: %s", tc.want, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestAnonSandboxRoutes_Delete(t *testing.T) {
	svc := &fakeAnonSandboxRouteService{}
	router := newAnonSandboxTestRouter(svc)
	req := httptest.NewRequest(http.MethodDelete, "/api/public/sandboxes/"+testAnonRouteID, nil)
	req.Header.Set(AnonSandboxTokenHeader, "tok")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d", rec.Code)
	}
	if svc.lastToken != "tok" {
		t.Fatalf("token not forwarded: %q", svc.lastToken)
	}

	// Unknown-or-bad-token surfaces as uniform 404.
	svc.deleteErr = pkgerrors.NotFound("sandbox not found")
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec2.Code)
	}
}
