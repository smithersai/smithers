package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type LinearIssueLinkRouteService interface {
	LinkIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, input services.LinearIssueLinkInput) (services.LinearIssueReference, error)
	UnlinkIssue(ctx context.Context, actor *db.User, owner, repo string, number int64) error
}

type linearIssueLinkRequest struct {
	Identifier string `json:"identifier"`
}

// PostLinearIssueLink handles POST /api/repos/{owner}/{repo}/issues/{number}/linear-link.
func (h *IssueHandler) PostLinearIssueLink(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Linking an issue to Linear"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req linearIssueLinkRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if h.LinearLink == nil {
		writeRouteError(w, r, errors.Internal("Linear issue linking is unavailable"))
		return
	}

	linked, err := h.LinearLink.LinkIssue(r.Context(), actor, owner, repo, number, services.LinearIssueLinkInput{Identifier: req.Identifier})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, linked)
}

// DeleteLinearIssueLink handles DELETE /api/repos/{owner}/{repo}/issues/{number}/linear-link.
func (h *IssueHandler) DeleteLinearIssueLink(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Unlinking an issue from Linear"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if h.LinearLink == nil {
		writeRouteError(w, r, errors.Internal("Linear issue linking is unavailable"))
		return
	}

	if err := h.LinearLink.UnlinkIssue(r.Context(), actor, owner, repo, number); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
