package routes

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type GitMirrorSyncRouteService interface {
	StartMirrorSync(ctx context.Context, userID, repositoryID int64, owner, repo string) (int64, error)
	StartGitHubReconcile(ctx context.Context, userID, repositoryID int64, owner, repo string) (services.GitHubReconcileResult, error)
	GetMirrorSyncRun(ctx context.Context, repositoryID, runID int64) (services.GitMirrorSyncRunResult, error)
	RetryMirrorRef(ctx context.Context, userID, repositoryID int64, owner, repo, ref string) (int64, error)
}

type GitMirrorSyncHandler struct {
	Service GitMirrorSyncRouteService
}

type GitMirrorSyncResponse struct {
	RunID int64 `json:"run_id"`
}

func (h *GitMirrorSyncHandler) MirrorSync(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("git mirror sync service not configured"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	owner, repo, ownerRepoErr := repoOwnerAndName(r)
	if ownerRepoErr != nil {
		pkgerrors.WriteError(w, ownerRepoErr.(*pkgerrors.APIError))
		return
	}

	runID, svcErr := h.Service.StartMirrorSync(r.Context(), actor.ID, repoCtx.Repository.ID, owner, repo)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusAccepted, GitMirrorSyncResponse{RunID: runID})
}

// ReconcileGitHub handles POST /api/repos/{owner}/{repo}/github/reconcile.
func (h *GitMirrorSyncHandler) ReconcileGitHub(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("git mirror sync service not configured"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	owner, repo, ownerRepoErr := repoOwnerAndName(r)
	if ownerRepoErr != nil {
		pkgerrors.WriteError(w, ownerRepoErr.(*pkgerrors.APIError))
		return
	}

	run, svcErr := h.Service.StartGitHubReconcile(r.Context(), actor.ID, repoCtx.Repository.ID, owner, repo)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusAccepted, run)
}

// RetryMirrorRef handles POST
// /api/repos/{owner}/{repo}/github/mirror/refs/{ref}/retry. Ref names contain
// slashes and therefore arrive URL-escaped as a single route segment.
func (h *GitMirrorSyncHandler) RetryMirrorRef(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("git mirror sync service not configured"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}
	owner, repo, ownerRepoErr := repoOwnerAndName(r)
	if ownerRepoErr != nil {
		pkgerrors.WriteError(w, ownerRepoErr.(*pkgerrors.APIError))
		return
	}
	ref, unescapeErr := url.PathUnescape(strings.TrimSpace(chi.URLParam(r, "ref")))
	if unescapeErr != nil || ref == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid git ref"))
		return
	}
	runID, svcErr := h.Service.RetryMirrorRef(r.Context(), actor.ID, repoCtx.Repository.ID, owner, repo, ref)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, GitMirrorSyncResponse{RunID: runID})
}

// GetMirrorSyncRun handles GET /api/repos/{owner}/{repo}/mirror-sync/{run_id}.
func (h *GitMirrorSyncHandler) GetMirrorSyncRun(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("git mirror sync service not configured"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}
	runID, apiErr := parsePositiveInt64Param(chi.URLParam(r, "run_id"), "invalid mirror sync run id")
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	run, err := h.Service.GetMirrorSyncRun(r.Context(), repoCtx.Repository.ID, runID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, run)
}

var _ GitMirrorSyncRouteService = (*services.GitMirrorSyncService)(nil)
