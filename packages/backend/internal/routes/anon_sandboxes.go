package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AnonSandboxRouteService is the slice of *services.AnonSandboxService the
// handler depends on (interface so route tests drive the contract without a
// database or VM provider).
type AnonSandboxRouteService interface {
	Create(ctx context.Context, repoFullName, branch, clientIP string) (services.AnonSandboxCreation, error)
	Get(ctx context.Context, id, token string) (db.AnonSandbox, error)
	Delete(ctx context.Context, id, token string) error
}

// AnonSandboxHandler serves the ANONYMOUS sandbox surface
// (/api/public/sandboxes*): the only functional /api
// routes that do not require authentication. The security envelope lives in
// the service (server-side allowlist, caps, TTL) and the router (per-IP
// creation rate limit + the global anonymous API bucket); the handler's own
// contribution is the capability-token header and honest error mapping.
type AnonSandboxHandler struct {
	Service AnonSandboxRouteService
}

// NewAnonSandboxHandler constructs the handler.
func NewAnonSandboxHandler(service AnonSandboxRouteService) *AnonSandboxHandler {
	return &AnonSandboxHandler{Service: service}
}

// AnonSandboxTokenHeader carries the creation-time capability token on
// GET/DELETE. A header (not a query param) so tokens stay out of access logs,
// and not Authorization so the AuthLoader token parser never sees it.
const AnonSandboxTokenHeader = "X-Sandbox-Token"

// Mount registers the anonymous sandbox routes. The caller must NOT wrap
// these in RequireAuth; the creation route should additionally carry the
// per-IP AnonSandboxCreateRateLimit.
func (h *AnonSandboxHandler) Mount(r chi.Router, createLimiter func(http.Handler) http.Handler) {
	if createLimiter != nil {
		r.With(createLimiter).Post("/api/public/sandboxes", h.Create)
	} else {
		r.Post("/api/public/sandboxes", h.Create)
	}
	r.Get("/api/public/sandboxes/{id}", h.Get)
	r.Delete("/api/public/sandboxes/{id}", h.Delete)
}

// anonSandboxJSON is the wire shape. AccessToken is present ONLY in the
// creation response.
type anonSandboxJSON struct {
	ID                string    `json:"id"`
	RepoFullName      string    `json:"repo_full_name"`
	Branch            string    `json:"branch"`
	Status            string    `json:"status"`
	ProvisioningStage string    `json:"provisioning_stage,omitempty"`
	ExpiresAt         time.Time `json:"expires_at"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
	AccessToken       string    `json:"access_token,omitempty"`
}

func anonSandboxToJSON(row db.AnonSandbox, token string) anonSandboxJSON {
	return anonSandboxJSON{
		ID:                row.ID,
		RepoFullName:      row.RepoFullName,
		Branch:            row.Branch,
		Status:            row.Status,
		ProvisioningStage: row.ProvisioningStage,
		ExpiresAt:         row.ExpiresAt,
		CreatedAt:         row.CreatedAt,
		UpdatedAt:         row.UpdatedAt,
		AccessToken:       token,
	}
}

// anonSandboxErr mirrors appTimelineErr: typed APIErrors pass through; a
// missing anon_sandboxes table (migration 20260719163427 is applied manually)
// degrades honestly as 503; everything else is an opaque 500.
func anonSandboxErr(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		pkgerrors.WriteError(w, apiErr)
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeFeatureNotEnabled,
			"anonymous sandboxes are not enabled on this deployment"))
		return
	}
	writeInternalError(w, r, "sandbox operation failed", err)
}

func anonSandboxIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid id: must be a UUID"))
		return "", false
	}
	return id, true
}

// clientIPFromRequest extracts the host part of RemoteAddr (RealIP has
// already resolved the trusted-proxy chain upstream) so the per-IP
// concurrency cap keys on the same principal as the rate limiter.
func clientIPFromRequest(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

// createAnonSandboxRequest is the body of POST /api/public/sandboxes.
type createAnonSandboxRequest struct {
	RepoFullName string `json:"repo_full_name"`
	Branch       string `json:"branch,omitempty"`
}

// Create — POST /api/public/sandboxes
// Anonymous. Body: {repo_full_name, branch?}. 202 with the sandbox row plus
// the once-only access_token; the caller polls Get until running/failed.
func (h *AnonSandboxHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body createAnonSandboxRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid body"))
		return
	}
	created, err := h.Service.Create(r.Context(), body.RepoFullName, body.Branch, clientIPFromRequest(r))
	if err != nil {
		anonSandboxErr(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, anonSandboxToJSON(created.Sandbox, created.Token))
}

// Get — GET /api/public/sandboxes/{id} (X-Sandbox-Token)
func (h *AnonSandboxHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, ok := anonSandboxIDParam(w, r)
	if !ok {
		return
	}
	row, err := h.Service.Get(r.Context(), id, r.Header.Get(AnonSandboxTokenHeader))
	if err != nil {
		anonSandboxErr(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, anonSandboxToJSON(row, ""))
}

// Delete — DELETE /api/public/sandboxes/{id} (X-Sandbox-Token)
func (h *AnonSandboxHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, ok := anonSandboxIDParam(w, r)
	if !ok {
		return
	}
	if err := h.Service.Delete(r.Context(), id, r.Header.Get(AnonSandboxTokenHeader)); err != nil {
		anonSandboxErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
