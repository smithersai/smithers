package services

import (
	"context"
	stdErrors "errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type AccessMode string

const (
	AccessModeRead  AccessMode = "read"
	AccessModeWrite AccessMode = "write"
)

// SSHAuthzQuerier defines the query surface needed for SSH authorization:
// the repository lookup plus the canonical permission queries.
type SSHAuthzQuerier interface {
	RepoPermQuerier
	GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
}

// SSHAuthorizer is implemented by services that can authorize SSH repository access.
type SSHAuthorizer interface {
	Authorize(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error
}

// SSHAuthorizationService handles repository-level SSH authorization decisions.
type SSHAuthorizationService struct {
	queries SSHAuthzQuerier
}

// NewSSHAuthorizationService creates an SSHAuthorizationService.
func NewSSHAuthorizationService(q SSHAuthzQuerier) *SSHAuthorizationService {
	return &SSHAuthorizationService{queries: q}
}

// AccessModeFromGitCommand maps git SSH verbs to authorization modes.
func AccessModeFromGitCommand(cmd string) (AccessMode, error) {
	switch cmd {
	case "git-upload-pack":
		return AccessModeRead, nil
	case "git-receive-pack":
		return AccessModeWrite, nil
	default:
		return "", errors.BadRequest(fmt.Sprintf("unsupported git command: %s", cmd))
	}
}

// Authorize resolves repository access for a specific user and command mode.
func (s *SSHAuthorizationService) Authorize(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
	repoRow, err := s.queries.GetRepoByOwnerAndName(ctx, db.GetRepoByOwnerAndNameParams{
		Owner: owner,
		Name:  repo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return errors.NotFound("repository not found")
		}
		return errors.Internal("failed to resolve repository")
	}

	// The archived check runs only after an access grant: a caller with no
	// access must get the same "permission denied" as for any other private
	// repository, never a reason that reveals the repository exists and is
	// archived (matching the uniform denial the SSH gateway returns).
	grant := func() error {
		if mode == AccessModeWrite && repoRow.IsArchived {
			return errors.Forbidden("repository is archived")
		}
		return nil
	}

	permission, isOwner, err := repoPermissionForUser(ctx, s.queries, db.Repository{
		ID:     repoRow.ID,
		UserID: repoRow.UserID,
		OrgID:  repoRow.OrgID,
	}, userID)
	if err != nil {
		return errors.Internal("failed to resolve repository access")
	}
	if isOwner || permissionAllows(permission, mode) {
		return grant()
	}

	if mode == AccessModeRead && repoRow.IsPublic {
		return nil
	}

	return errors.Forbidden("permission denied")
}

func permissionAllows(permission string, mode AccessMode) bool {
	switch mode {
	case AccessModeRead:
		return repoPermissionRank(permission) >= repoPermissionRank("read")
	case AccessModeWrite:
		return repoPermissionRank(permission) >= repoPermissionRank("write")
	default:
		return false
	}
}
