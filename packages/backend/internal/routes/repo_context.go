package routes

import (
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// repoOwnerAndName resolves owner/repo from middleware RepoContext when present.
// It falls back to route params for compatibility with direct handler tests.
func repoOwnerAndName(r *http.Request) (owner string, repo string, err error) {
	if repoCtx := middleware.RepoContextFromContext(r.Context()); repoCtx != nil && repoCtx.Repository != nil {
		owner = strings.TrimSpace(repoCtx.Owner)
		if owner == "" {
			owner, err = routeParam(r, "owner", "owner is required")
			if err != nil {
				return "", "", err
			}
		}
		repo = strings.TrimSpace(repoCtx.Repository.Name)
		if repo == "" {
			return "", "", errors.Internal("repository context missing repository name")
		}
		return owner, repo, nil
	}

	owner, err = routeParam(r, "owner", "owner is required")
	if err != nil {
		return "", "", err
	}
	repo, err = routeParam(r, "repo", "repository name is required")
	if err != nil {
		return "", "", err
	}

	return owner, repo, nil
}

// refuseGitHubSourceWrite refuses a mutating request that addressed a
// repository by its GitHub SOURCE coordinates.
//
// Mirrors live under the importing user's namespace, and repo_context resolves
// "octocat/Hello-World" to that user's own mirror so reads follow the name the
// client picked. A WRITE resolved the same way is a different act: the row
// lands in the private mirror, the API answers 200, and the product tells the
// user it opened an issue on a repository they may not even be able to write —
// the mirror's numbering restarts at #1 while the real repository is thousands
// of issues in. Importable is not writable, so refuse and name both halves.
//
// Returns nil when the request did not come in through the alias, which is
// every ordinary write to a repository addressed by its own Smithers name.
func refuseGitHubSourceWrite(r *http.Request, act string) *errors.APIError {
	sourceOwner, sourceRepo, aliased := middleware.GitHubSourceAliasFromContext(r.Context())
	if !aliased {
		return nil
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	mirror := "its Smithers mirror"
	if repoCtx != nil && repoCtx.Repository != nil {
		mirror = repoCtx.Owner + "/" + repoCtx.Repository.Name
	}
	return errors.Conflict(
		sourceOwner + "/" + sourceRepo + " is a GitHub repository mirrored into Smithers as " +
			mirror + ". " + act + " here would stay in the mirror and never reach github.com/" +
			sourceOwner + "/" + sourceRepo + ". Address " + mirror + " directly if you meant the mirror.")
}
