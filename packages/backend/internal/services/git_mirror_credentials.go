package services

import (
	"context"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type GitMirrorSyncOption func(*GitMirrorSyncService)

type gitMirrorRemotes struct {
	sourceURL string
	targetURL string
	cleanup   func()
}

func (r gitMirrorRemotes) close() {
	if r.cleanup != nil {
		r.cleanup()
	}
}

func legacyMirrorRemotes(_ context.Context, _, _ int64, owner, repo string) (gitMirrorRemotes, error) {
	source, target, err := mirrorRemoteURLs(owner, repo)
	if err != nil {
		return gitMirrorRemotes{}, pkgerrors.Internal("failed to build mirror repository URLs")
	}
	return gitMirrorRemotes{sourceURL: source, targetURL: target}, nil
}

type GitMirrorCredentialStore interface {
	accessTokenStore
	GetRepoByID(context.Context, int64) (db.Repository, error)
	ListRepositoryGitHubSources(context.Context, int64) ([]db.ListRepositoryGitHubSourcesRow, error)
}

type GitMirrorGitHubCredentials interface {
	GitHubPushToken(context.Context, int64, string, string) (string, error)
}

// WithGitMirrorCredentials replaces the legacy operator environment entirely.
// Credentials belong to the requesting user; failure never falls back to a
// global token or an installation-wide identity.
func WithGitMirrorCredentials(q GitMirrorCredentialStore, github GitMirrorGitHubCredentials, sourceBaseURL string, connections ...RepoSyncConnectionChecker) GitMirrorSyncOption {
	return func(s *GitMirrorSyncService) {
		s.resolveRemotes = func(ctx context.Context, userID, repositoryID int64, owner, repo string) (gitMirrorRemotes, error) {
			if q == nil || github == nil {
				return gitMirrorRemotes{}, pkgerrors.Internal("mirror credentials are not configured")
			}
			repository, err := q.GetRepoByID(ctx, repositoryID)
			if err != nil {
				return gitMirrorRemotes{}, pkgerrors.Internal("load mirror repository")
			}
			destination := strings.TrimSpace(repository.MirrorDestination)
			if destination == "" {
				sources, err := q.ListRepositoryGitHubSources(ctx, repositoryID)
				if err != nil {
					return gitMirrorRemotes{}, pkgerrors.Internal("load GitHub mirror destination")
				}
				if len(sources) == 1 {
					destination = sources[0].GithubOwner + "/" + sources[0].GithubRepo
				} else if len(sources) == 0 && len(connections) > 0 && connections[0] != nil {
					// A native repository may have an explicit ConnectRepo link
					// without import provenance. Never infer a link from names alone.
					connection, err := connections[0].GetRepoConnectionStatus(ctx, userID, owner, repo)
					if err != nil {
						return gitMirrorRemotes{}, err
					}
					if connection.Connected {
						destination = owner + "/" + repo
					}
				}
				if destination == "" {
					return gitMirrorRemotes{}, pkgerrors.Conflict("Connect one GitHub destination before reconciling this repository")
				}
			}
			targetOwner, targetRepo, err := mirrorDestination(destination)
			if err != nil {
				return gitMirrorRemotes{}, err
			}
			githubToken, err := github.GitHubPushToken(ctx, userID, targetOwner, targetRepo)
			if err != nil {
				return gitMirrorRemotes{}, err
			}
			if strings.TrimSpace(githubToken) == "" {
				return gitMirrorRemotes{}, pkgerrors.Unauthorized("Connect a GitHub account with push access to the mirror destination")
			}
			// Validate trusted source configuration before minting a disposable token.
			if _, err := gitMirrorURL(sourceBaseURL, "", owner, repo); err != nil {
				return gitMirrorRemotes{}, pkgerrors.Internal("mirror source URL is not configured")
			}
			scopes := string(middleware.ScopeReadRepository) + "," + middleware.RepositoryRestrictionScope(repositoryID)
			token, err := issueTemporaryRepoTokenWithTTL(ctx, q, userID, "github-mirror-read", scopes, gitMirrorSyncTimeout+5*time.Minute)
			if err != nil {
				return gitMirrorRemotes{}, pkgerrors.Internal("create mirror source credential")
			}
			cleanup := func() { revokeTemporaryRepoCloneToken(context.Background(), q, userID, token.ID) }
			source, err := gitMirrorURL(sourceBaseURL, token.Plaintext, owner, repo)
			if err != nil {
				cleanup()
				return gitMirrorRemotes{}, pkgerrors.Internal("build mirror source URL")
			}
			target, err := gitMirrorURL(defaultGitHubGitBaseURL, githubToken, targetOwner, targetRepo)
			if err != nil {
				cleanup()
				return gitMirrorRemotes{}, pkgerrors.Internal("build GitHub mirror destination URL")
			}
			return gitMirrorRemotes{sourceURL: source, targetURL: target, cleanup: cleanup}, nil
		}
	}
}

func mirrorDestination(value string) (string, string, error) {
	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", "", pkgerrors.BadRequest("Mirror destination must name an HTTPS GitHub repository")
		}
		value = strings.TrimPrefix(parsed.Path, "/")
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimSuffix(value, "/"), ".git"), "/")
	if len(parts) != 2 {
		return "", "", pkgerrors.BadRequest("Mirror destination must name owner/repository")
	}
	owner, repo, err := normalizeRepoRef(parts[0], parts[1])
	if err != nil {
		return "", "", err
	}
	return owner, repo, nil
}
