package routes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AdminAgentSessionRouteService interface {
	ListAgentSessions(context.Context, db.AdminListAgentSessionsParams) ([]services.AdminAgentSession, error)
	CancelAgentSession(context.Context, string, string) (services.AdminManageStatus, error)
}
type AdminAgentSessionHandler struct{ Service AdminAgentSessionRouteService }

func (h *AdminAgentSessionHandler) List(w http.ResponseWriter, r *http.Request) {
	limit, err := manageQueryInt(r, "limit", 100, 1, 200)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	synthetic, err := manageSynthetic(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	result, err := h.Service.ListAgentSessions(r.Context(), db.AdminListAgentSessionsParams{Status: r.URL.Query().Get("status"), IncludeSynthetic: synthetic, RowLimit: limit})
	manageRespond(w, r, result, err)
}
func (h *AdminAgentSessionHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	id, err := manageID(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if !manageBody(w, r, &body) {
		return
	}
	result, err := h.Service.CancelAgentSession(adminUserAuditContext(r), id, body.Reason)
	manageRespond(w, r, result, err)
}
func manageRespond(w http.ResponseWriter, r *http.Request, result any, err error) {
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
func manageQueryInt(r *http.Request, key string, def, min, max int32) (int32, error) {
	v, ok := r.URL.Query()[key]
	if !ok {
		return def, nil
	}
	if len(v) != 1 {
		return 0, pkgerrors.BadRequest("invalid " + key)
	}
	n, err := strconv.ParseInt(v[0], 10, 32)
	if err != nil || n < int64(min) || n > int64(max) {
		return 0, pkgerrors.BadRequest("invalid " + key)
	}
	return int32(n), nil
}
func manageSynthetic(r *http.Request) (bool, error) {
	v, ok := r.URL.Query()["include_synthetic"]
	if !ok {
		return false, nil
	}
	if len(v) != 1 || (v[0] != "true" && v[0] != "false") {
		return false, pkgerrors.BadRequest("include_synthetic must be true or false")
	}
	return v[0] == "true", nil
}

// manageID reads the {id} path parameter; agent session and workspace IDs are UUIDs.
func manageID(r *http.Request) (string, error) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		return "", pkgerrors.BadRequest("invalid id")
	}
	return id, nil
}

// Mutation bodies are optional, bounded, and must contain at most one JSON object.
func manageBody(w http.ResponseWriter, r *http.Request, v any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	var raw json.RawMessage
	err := decoder.Decode(&raw)
	if errors.Is(err, io.EOF) {
		return true
	}
	if err != nil || len(raw) == 0 || raw[0] != '{' {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid JSON body"))
		return false
	}
	// Decode again with unknown-field rejection after checking the root shape.
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if err = d.Decode(v); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid JSON body"))
		return false
	}
	if err = decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid JSON body"))
		return false
	}
	return true
}
