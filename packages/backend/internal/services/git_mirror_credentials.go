package services

import (
	"context"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubrepo"
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
		return gitMirrorRemotes{}, pkgerrors.Internal("failed to build mirror repository URLs").WithCause(err)
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
			var conn RepoSyncConnectionChecker
			if len(connections) > 0 {
				conn = connections[0]
			}
			targetOwner, targetRepo, err := resolveGitHubDestination(ctx, q, conn, userID, repositoryID, owner, repo)
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
				return gitMirrorRemotes{}, pkgerrors.Internal("mirror source URL is not configured").WithCause(err)
			}
			scopes := string(middleware.ScopeReadRepository) + "," + middleware.RepositoryRestrictionScope(repositoryID)
			token, err := issueTemporaryRepoTokenWithTTL(ctx, q, userID, "github-mirror-read", scopes, gitMirrorSyncTimeout+5*time.Minute)
			if err != nil {
				return gitMirrorRemotes{}, pkgerrors.Internal("create mirror source credential").WithCause(err)
			}
			cleanup := func() { revokeTemporaryRepoCloneToken(context.Background(), q, userID, token.ID) }
			source, err := gitMirrorURL(sourceBaseURL, token.Plaintext, owner, repo)
			if err != nil {
				cleanup()
				return gitMirrorRemotes{}, pkgerrors.Internal("build mirror source URL").WithCause(err)
			}
			target, err := gitMirrorURL(defaultGitHubGitBaseURL, githubToken, targetOwner, targetRepo)
			if err != nil {
				cleanup()
				return gitMirrorRemotes{}, pkgerrors.Internal("build GitHub mirror destination URL").WithCause(err)
			}
			return gitMirrorRemotes{sourceURL: source, targetURL: target, cleanup: cleanup}, nil
		}
	}
}

func mirrorDestination(value string) (string, string, error) {
	owner, repo, err := githubrepo.ParseMirrorDestination(value)
	if err != nil {
		return "", "", pkgerrors.BadRequest(err.Error())
	}
	return owner, repo, nil
}
