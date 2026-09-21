package services

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Revocation publishing. Every service that ends an authorization announces
// it here so live consumers (SSE streams, terminal WebSockets, SSH sessions,
// gateway relays, sandbox egress proxies) terminate within seconds instead of
// at their own end of life. Publishing is best effort after the revocation
// itself succeeded: the durable change is the authority, the announcement is
// latency.

// WithAuthRevocationPublisher announces token revocations from AuthService.
func WithAuthRevocationPublisher(p revocation.Publisher) AuthServiceOption {
	return func(s *AuthService) { s.revocations = p }
}

// WithAdminRevocationPublisher announces token and user revocations from
// AdminUserService.
func WithAdminRevocationPublisher(p revocation.Publisher) AdminUserServiceOption {
	return func(s *AdminUserService) { s.revocations = p }
}

// SetRevocationPublisher announces organization membership removals.
func (s *OrgService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces OAuth2 access-token revocations.
func (s *OAuth2Service) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces workspace share removals.
func (s *PairSessionService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// WithRepoGatewayRevocationPublisher announces gateway teardowns.
func WithRepoGatewayRevocationPublisher(p revocation.Publisher) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.revocations = p }
}

// WithAgentRevocationPublisher announces cancelled agent sessions.
func WithAgentRevocationPublisher(p revocation.Publisher) AgentServiceOption {
	return func(s *AgentService) { s.revocations = p }
}

// WithRepoRevocationPublisher announces collaborator removals.
func WithRepoRevocationPublisher(p revocation.Publisher) RepoServiceOption {
	return func(s *RepoService) { s.revocations = p }
}

// accessTokenHashReader is the optional store surface that lets a token
// revocation carry the hash live consumers were authorized under.
type accessTokenHashReader interface {
	GetAccessTokenHashByID(ctx context.Context, id int64) (db.GetAccessTokenHashByIDRow, error)
}

// workspaceLister resolves a user's workspace VMs in a repository so a
// repository-level revocation can name the SSH sessions it ends.
type workspaceLister interface {
	ListWorkspacesByRepo(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error)
}

type collaboratorLister interface {
	ListCollaboratorsByRepo(ctx context.Context, repositoryID int64) ([]db.Collaborator, error)
}

type workspaceGetter interface {
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
}

// workspaceVMIDs returns the VM ids of a user's live workspaces in a
// repository, or nil when the store cannot list them.
func workspaceVMIDs(ctx context.Context, store any, repositoryID, userID int64) []string {
	lister, ok := store.(workspaceLister)
	if !ok {
		return nil
	}
	var ids []string
	for offset := int32(0); ; offset += 200 {
		rows, err := lister.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{RepositoryID: repositoryID, UserID: userID, PageOffset: offset, PageSize: 200})
		if err != nil {
			return ids
		}
		for _, row := range rows {
			if row.VmID != "" {
				ids = append(ids, row.VmID)
			}
		}
		if len(rows) < 200 {
			break
		}
	}
	return ids
}

type orgRepositoryLister interface {
	ListOrgRepos(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error)
}

// organizationWorkspaceVMIDs resolves every repository owned by an
// organization, then names every live workspace VM the removed member owns in
// those repositories. SSH principals know the sandbox, not the organization,
// so the concrete VM ids are required to end those sessions.
func organizationWorkspaceVMIDs(ctx context.Context, store any, organizationID, userID int64) []string {
	repos, ok := store.(orgRepositoryLister)
	if !ok {
		return nil
	}
	seen := make(map[string]struct{})
	var ids []string
	for offset := int32(0); ; offset += 200 {
		rows, err := repos.ListOrgRepos(ctx, db.ListOrgReposParams{
			OrgID:      pgtype.Int8{Int64: organizationID, Valid: organizationID != 0},
			PageOffset: offset,
			PageSize:   200,
		})
		if err != nil {
			return ids
		}
		for _, repository := range rows {
			for _, id := range workspaceVMIDs(ctx, store, repository.ID, userID) {
				if _, exists := seen[id]; exists {
					continue
				}
				seen[id] = struct{}{}
				ids = append(ids, id)
			}
		}
		if len(rows) < 200 {
			break
		}
	}
	return ids
}

// collaboratorsOf lists a repository's collaborators before they are dropped,
// so the removal can be announced per user afterwards.
func (s *RepoService) collaboratorsOf(ctx context.Context, repositoryID int64) []db.Collaborator {
	if s == nil || s.revocations == nil {
		return nil
	}
	lister, ok := s.queries.(collaboratorLister)
	if !ok {
		return nil
	}
	rows, err := lister.ListCollaboratorsByRepo(ctx, repositoryID)
	if err != nil {
		return nil
	}
	return rows
}

// publishCollaboratorsRemoved announces every collaborator dropped from a
// repository, naming each user's workspace VMs so SSH sessions end too.
func (s *RepoService) publishCollaboratorsRemoved(ctx context.Context, repositoryID int64, removed []db.Collaborator, actorID int64, reason string) {
	if s == nil || s.revocations == nil {
		return
	}
	for _, collaborator := range removed {
		if !collaborator.UserID.Valid {
			continue
		}
		userID := collaborator.UserID.Int64
		revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
			Kind:         revocation.KindCollaboratorRemoved,
			UserID:       userID,
			RepositoryID: repositoryID,
			SandboxIDs:   workspaceVMIDs(ctx, s.queries, repositoryID, userID),
			Reason:       reason,
			ActorID:      actorID,
		})
	}
}

// adminActorID names the acting administrator for an event, or 0 when the
// mutation did not come through an admin route.
func adminActorID(ctx context.Context) int64 {
	if actor, ok := AdminAuditActorFromContext(ctx); ok {
		return actor.UserID
	}
	return 0
}

// SetRevocationPublisher announces token deletions.
func (s *AuthService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces admin token revocations and user suspensions.
func (s *AdminUserService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces gateway teardowns.
func (s *RepoGatewayService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces cancelled agent sessions.
func (s *AgentService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces collaborator removals.
func (s *RepoService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }
