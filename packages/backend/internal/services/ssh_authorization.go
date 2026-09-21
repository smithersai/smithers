package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type AccessMode string

const (
	AccessModeRead  AccessMode = "read"
	AccessModeWrite AccessMode = "write"
)

// SSHAuthzQuerier defines the query surface needed for SSH authorization.
type SSHAuthzQuerier interface {
	GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
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

	if repoRow.UserID.Valid && repoRow.UserID.Int64 == userID {
		return grant()
	}

	if repoRow.OrgID.Valid {
		isOwner, err := s.queries.IsOrgOwnerForRepoUser(ctx, db.IsOrgOwnerForRepoUserParams{
			RepositoryID: repoRow.ID,
			UserID:       userID,
		})
		if err != nil {
			return errors.Internal("failed to resolve repository access")
		}
		if isOwner {
			return grant()
		}

		permission, err := s.queries.GetHighestTeamPermissionForRepoUser(ctx, db.GetHighestTeamPermissionForRepoUserParams{
			RepositoryID: repoRow.ID,
			UserID:       userID,
		})
		if err != nil {
			return errors.Internal("failed to resolve repository access")
		}
		if permissionAllows(strings.ToLower(strings.TrimSpace(permission)), mode) {
			return grant()
		}
	}

	collabPermission, err := s.queries.GetCollaboratorPermissionForRepoUser(ctx, db.GetCollaboratorPermissionForRepoUserParams{
		RepositoryID: repoRow.ID,
		UserID:       pgtype.Int8{Int64: userID, Valid: true},
	})
	if err != nil {
		return errors.Internal("failed to resolve repository access")
	}
	if permissionAllows(strings.ToLower(strings.TrimSpace(collabPermission)), mode) {
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
		return permission == "read" || permission == "write" || permission == "admin"
	case AccessModeWrite:
		return permission == "write" || permission == "admin"
	default:
		return false
	}
}
