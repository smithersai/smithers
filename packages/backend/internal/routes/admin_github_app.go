package routes

import (
	"context"
	stdErrors "errors"
	"net/http"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHubAppInstallationReconciler backfills github_app_installation_repositories
// from live GitHub App installation state. Implemented by
// *services.RepoConnectionService.
type GitHubAppInstallationReconciler interface {
	ReconcileGitHubAppInstallations(ctx context.Context) error
}

// AdminGitHubAppHandler handles POST /api/admin/github-app/reconcile.
type AdminGitHubAppHandler struct {
	Service GitHubAppInstallationReconciler
}

// Reconcile handles POST /api/admin/github-app/reconcile: it re-syncs the
// installation→repository mapping from GitHub. No-ops cleanly (200) when the
// GitHub App is unconfigured.
func (h *AdminGitHubAppHandler) Reconcile(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github app reconcile is not configured"))
		return
	}
	if err := h.Service.ReconcileGitHubAppInstallations(r.Context()); err != nil {
		var apiErr *pkgerrors.APIError
		if stdErrors.As(err, &apiErr) {
			pkgerrors.WriteError(w, apiErr)
			return
		}
		writeInternalError(w, r, "github app reconcile failed", err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
