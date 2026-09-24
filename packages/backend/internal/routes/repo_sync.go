package routes

import (
	"context"
	"net/http"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type RepoSyncRouteService interface {
	SyncRepo(ctx context.Context, userID int64, owner, repo string, req services.RepoSyncRequest) error
}

type RepoSyncResponse struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Synced bool   `json:"synced"`
}

func (h *RepoHandler) SyncRepo(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.RepoSyncService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repo sync service not configured"))
		return
	}

	owner, repo, ownerRepoErr := repoOwnerAndName(r)
	if ownerRepoErr != nil {
		pkgerrors.WriteError(w, ownerRepoErr.(*pkgerrors.APIError))
		return
	}

	var req services.RepoSyncRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if svcErr := h.RepoSyncService.SyncRepo(r.Context(), actor.ID, owner, repo, req); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, RepoSyncResponse{
		Owner:  owner,
		Repo:   repo,
		Synced: true,
	})
}

var _ RepoSyncRouteService = (*services.RepoSyncService)(nil)
