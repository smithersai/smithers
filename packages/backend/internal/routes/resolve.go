package routes

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type ResolveHandler struct {
	Queries *db.Queries
}

type ResolveResponse struct {
	Type string `json:"type"`
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// GetResolve checks if a name belongs to a user or an organization.
// It tries to find a user first, then an organization, and returns 404 if neither is found.
func (h *ResolveHandler) GetResolve(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "name")))
	if name == "" {
		errors.WriteError(w, errors.BadRequest("name is required"))
		return
	}

	user, err := h.Queries.GetUserByLowerUsername(r.Context(), name)
	if err == nil {
		errors.WriteJSON(w, http.StatusOK, ResolveResponse{
			Type: "user",
			ID:   user.ID,
			Name: user.Username,
		})
		return
	}

	org, err := h.Queries.GetOrgByLowerName(r.Context(), name)
	if err == nil {
		errors.WriteJSON(w, http.StatusOK, ResolveResponse{
			Type: "org",
			ID:   org.ID,
			Name: org.Name,
		})
		return
	}

	errors.WriteError(w, errors.NotFound("user or organization not found"))
}
