package routes

import (
	"context"
	"net/http"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// GitHubSyncedReposRouteService is the sync registry feed github-sync reads in
// place of its static SMITHERS_SYNC_MAPPINGS entry.
type GitHubSyncedReposRouteService interface {
	ListSyncedRepos(ctx context.Context, refsOnly bool) ([]services.GitHubSyncedRepoSummary, error)
	RecordMirrorStatus(ctx context.Context, mirrorOwner, mirrorRepo string, report services.GitHubMirrorStatusReport) error
}

type recordGitHubMirrorStatusRequest struct {
	MirrorStatus string `json:"mirror_status"`
	GitHubHead   string `json:"github_head"`
	Error        string `json:"error"`
	BehindRefs   int32  `json:"behind_refs"`
	FailedRefs   int32  `json:"failed_refs"`
}

type GitHubSyncedReposHandler struct {
	Service GitHubSyncedReposRouteService
}

// ListSyncedRepos serves GET /api/github/synced-repos. The registry names every
// repository the platform syncs (including private ones), so the route is
// admin-scoped: it is a service-to-service feed, not a user-facing listing.
//
// `?refs=true` narrows it to the repos whose git refs are mirrored — what
// github-sync's mirror mode needs.
func (h *GitHubSyncedReposHandler) ListSyncedRepos(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github sync registry unavailable"))
		return
	}

	refsOnly := false
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("refs"))) {
	case "1", "true", "yes":
		refsOnly = true
	}

	repos, err := h.Service.ListSyncedRepos(r.Context(), refsOnly)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"repositories": repos})
}

// RecordMirrorStatus serves POST
// /api/github/synced-repos/{owner}/{repo}/mirror-status. The admin-scoped
// github-sync worker calls it at the start and completion of each push mirror.
func (h *GitHubSyncedReposHandler) RecordMirrorStatus(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github sync registry unavailable"))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req recordGitHubMirrorStatusRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if err := h.Service.RecordMirrorStatus(r.Context(), owner, repo, services.GitHubMirrorStatusReport{
		Status:     req.MirrorStatus,
		GitHubHead: req.GitHubHead,
		Error:      req.Error,
		BehindRefs: req.BehindRefs,
		FailedRefs: req.FailedRefs,
	}); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
