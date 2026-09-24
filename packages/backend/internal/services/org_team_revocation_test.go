package services

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// teamRevocationQuerier models team grants in memory so a test can assert
// which (user, repository) pairs lost access after a team mutation.
type teamRevocationQuerier struct {
	*mockOrgQuerier
	mu         sync.Mutex
	team       db.Team
	members    []db.User
	repos      []db.Repository
	orgOwners  map[int64]bool
	otherGrant map[[2]int64]string // {repoID, userID} -> permission from another team or collaborator
	workspaces map[[2]int64][]string
}

func newTeamRevocationQuerier(permission string, members []db.User, repos []db.Repository) *teamRevocationQuerier {
	q := &teamRevocationQuerier{
		team:       db.Team{ID: 50, OrganizationID: 7, Name: "devs", LowerName: "devs", Permission: permission},
		members:    members,
		repos:      repos,
		orgOwners:  map[int64]bool{},
		otherGrant: map[[2]int64]string{},
		workspaces: map[[2]int64][]string{},
	}
	q.mockOrgQuerier = ownerOrgQuerier(func(m *mockOrgQuerier) {
		m.getTeamByOrgAndLowerNameFn = func(context.Context, db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			return q.team, nil
		}
		m.listTeamMembersFn = func(_ context.Context, arg db.ListTeamMembersParams) ([]db.User, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			return page(q.members, arg.PageOffset, arg.PageSize), nil
		}
		m.listTeamReposFn = func(_ context.Context, arg db.ListTeamReposParams) ([]db.Repository, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			return page(q.repos, arg.PageOffset, arg.PageSize), nil
		}
		m.getUserByLowerUsernameFn = func(_ context.Context, name string) (db.User, error) {
			for _, u := range members {
				if u.LowerUsername == name {
					return u, nil
				}
			}
			return db.User{}, nil
		}
		m.getRepoByOwnerAndLowerNameFn = func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			for _, r := range repos {
				if r.LowerName == arg.LowerName {
					return r, nil
				}
			}
			return db.Repository{}, nil
		}
		m.removeTeamMemberFn = func(_ context.Context, arg db.RemoveTeamMemberParams) error {
			q.mu.Lock()
			defer q.mu.Unlock()
			kept := q.members[:0:0]
			for _, u := range q.members {
				if u.ID != arg.UserID {
					kept = append(kept, u)
				}
			}
			q.members = kept
			return nil
		}
		m.removeTeamRepoFn = func(_ context.Context, arg db.RemoveTeamRepoParams) error {
			q.mu.Lock()
			defer q.mu.Unlock()
			kept := q.repos[:0:0]
			for _, r := range q.repos {
				if r.ID != arg.RepositoryID {
					kept = append(kept, r)
				}
			}
			q.repos = kept
			return nil
		}
		m.deleteTeamFn = func(context.Context, int64) error {
			q.mu.Lock()
			defer q.mu.Unlock()
			q.members, q.repos = nil, nil
			return nil
		}
		m.updateTeamFn = func(_ context.Context, arg db.UpdateTeamParams) (db.Team, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			q.team.Permission = arg.Permission
			return q.team, nil
		}
	})
	return q
}

func page[T any](rows []T, offset, size int32) []T {
	start := int(offset)
	if start >= len(rows) {
		return nil
	}
	end := start + int(size)
	if end > len(rows) {
		end = len(rows)
	}
	return append([]T(nil), rows[start:end]...)
}

func (q *teamRevocationQuerier) IsOrgOwnerForRepoUser(_ context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return q.orgOwners[arg.UserID], nil
}

func (q *teamRevocationQuerier) GetHighestTeamPermissionForRepoUser(_ context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	permission := q.otherGrant[[2]int64{arg.RepositoryID, arg.UserID}]
	for _, u := range q.members {
		if u.ID != arg.UserID {
			continue
		}
		for _, r := range q.repos {
			if r.ID == arg.RepositoryID {
				permission = highestRepoPermission(permission, q.team.Permission)
			}
		}
	}
	return permission, nil
}

func (q *teamRevocationQuerier) GetCollaboratorPermissionForRepoUser(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (q *teamRevocationQuerier) ListWorkspacesByRepo(_ context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
	if arg.PageOffset > 0 {
		return nil, nil
	}
	var rows []db.Workspace
	for _, id := range q.workspaces[[2]int64{arg.RepositoryID, arg.UserID}] {
		rows = append(rows, db.Workspace{VmID: id})
	}
	return rows, nil
}

func teamTestRepo(id int64, name string) db.Repository {
	return db.Repository{ID: id, Name: name, LowerName: name, OrgID: pgtype.Int8{Int64: 7, Valid: true}}
}

func removedPairs(events []revocation.Event) [][2]int64 {
	var pairs [][2]int64
	for _, e := range events {
		pairs = append(pairs, [2]int64{e.RepositoryID, e.UserID})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i][0] != pairs[j][0] {
			return pairs[i][0] < pairs[j][0]
		}
		return pairs[i][1] < pairs[j][1]
	})
	return pairs
}

func TestOrgService_RemoveTeamMemberRevokesOnlyLostRepositoryAccess(t *testing.T) {
	t.Parallel()
	bob := db.User{ID: 2, Username: "bob", LowerUsername: "bob"}
	q := newTeamRevocationQuerier("write", []db.User{bob}, []db.Repository{teamTestRepo(10, "api"), teamTestRepo(11, "web")})
	q.otherGrant[[2]int64{11, 2}] = "admin"
	q.workspaces[[2]int64{10, 2}] = []string{"vm-bob"}
	publisher := &recordingPublisher{}
	svc := NewOrgService(q)
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.RemoveTeamMember(context.Background(), testOrgUser(1, "owner"), "acme", "devs", "bob"))

	events := publisher.all()
	require.Equal(t, [][2]int64{{10, 2}}, removedPairs(events))
	require.Equal(t, revocation.KindCollaboratorRemoved, events[0].Kind)
	require.Equal(t, []string{"vm-bob"}, events[0].SandboxIDs)
	require.Equal(t, int64(1), events[0].ActorID)
}

func TestOrgService_RemoveTeamRepoRevokesMembersWithoutOtherAccess(t *testing.T) {
	t.Parallel()
	alice := db.User{ID: 3, Username: "alice", LowerUsername: "alice"}
	bob := db.User{ID: 2, Username: "bob", LowerUsername: "bob"}
	q := newTeamRevocationQuerier("read", []db.User{alice, bob}, []db.Repository{teamTestRepo(10, "api")})
	q.orgOwners[3] = true
	publisher := &recordingPublisher{}
	svc := NewOrgService(q)
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.RemoveTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "devs", "acme", "api"))

	require.Equal(t, [][2]int64{{10, 2}}, removedPairs(publisher.all()))
}

func TestOrgService_DeleteTeamRevokesEveryMemberRepositoryPair(t *testing.T) {
	t.Parallel()
	alice := db.User{ID: 3, Username: "alice", LowerUsername: "alice"}
	bob := db.User{ID: 2, Username: "bob", LowerUsername: "bob"}
	q := newTeamRevocationQuerier("write", []db.User{alice, bob}, []db.Repository{teamTestRepo(10, "api"), teamTestRepo(11, "web")})
	publisher := &recordingPublisher{}
	svc := NewOrgService(q)
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.DeleteTeam(context.Background(), testOrgUser(1, "owner"), "acme", "devs"))

	require.Equal(t, [][2]int64{{10, 2}, {10, 3}, {11, 2}, {11, 3}}, removedPairs(publisher.all()))
}

func TestOrgService_UpdateTeamDowngradeRevokesLostWriteAccess(t *testing.T) {
	t.Parallel()
	alice := db.User{ID: 3, Username: "alice", LowerUsername: "alice"}
	bob := db.User{ID: 2, Username: "bob", LowerUsername: "bob"}
	q := newTeamRevocationQuerier("write", []db.User{alice, bob}, []db.Repository{teamTestRepo(10, "api")})
	q.otherGrant[[2]int64{10, 3}] = "write"
	publisher := &recordingPublisher{}
	svc := NewOrgService(q)
	svc.SetRevocationPublisher(publisher)

	_, err := svc.UpdateTeam(context.Background(), testOrgUser(1, "owner"), "acme", "devs", UpdateTeamRequest{Permission: "read"})
	require.NoError(t, err)
	require.Equal(t, [][2]int64{{10, 2}}, removedPairs(publisher.all()))

	_, err = svc.UpdateTeam(context.Background(), testOrgUser(1, "owner"), "acme", "devs", UpdateTeamRequest{Permission: "admin"})
	require.NoError(t, err)
	require.Len(t, publisher.all(), 1, "an upgrade removes no access")
}

// A webhook enqueue failure after a committed team change must not turn the
// committed change into a 500 the client retries into a conflict.
func TestOrgService_TeamRepoChangesSucceedWhenWebhookEnqueueFails(t *testing.T) {
	t.Parallel()
	q := newTeamRevocationQuerier("read", nil, []db.Repository{teamTestRepo(10, "api")})
	q.addTeamRepoIfOrgRepoFn = func(context.Context, db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
		return db.TeamRepo{}, nil
	}
	dispatcher := &mockOrgDispatcher{
		dispatchFn: func(context.Context, int64, webhooks.EventType, any) error { return errors.New("queue down") },
	}
	svc := NewOrgService(q, WithOrgWebhookDispatcher(dispatcher))

	require.NoError(t, svc.AddTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "devs", "acme", "api"))
	require.NoError(t, svc.RemoveTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "devs", "acme", "api"))
	require.Len(t, dispatcher.calls, 2, "both changes still attempt their webhook")
}
