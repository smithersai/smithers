package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Forking is an explicit act with one purpose: give a reader a namespace they
// can write in. A caller who can already write to the source has that already,
// so the request is refused by name rather than answered with a second copy of
// a repository they can edit — the copy nobody asked for is exactly the
// accident this endpoint exists to prevent.
func TestRepoService_ForkRepo_RefusesWhenTheCallerCanAlreadyWrite(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 7, Username: "forker"}

	for _, tc := range []struct {
		name   string
		source db.Repository
		stub   func(*mockRepoQuerier)
	}{
		{
			name: "owner",
			source: db.Repository{
				ID: 90, Name: "mine", LowerName: "mine", IsPublic: true,
				DefaultBookmark: "main",
				UserID:          pgtype.Int8{Int64: actor.ID, Valid: true},
			},
		},
		{
			name: "collaborator with write",
			source: db.Repository{
				ID: 91, Name: "shared", LowerName: "shared", IsPublic: true,
				DefaultBookmark: "main",
				UserID:          pgtype.Int8{Int64: 99, Valid: true},
			},
			stub: func(q *mockRepoQuerier) {
				q.getCollaboratorPermissionForRepo = func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
					return "write", nil
				}
			},
		},
		{
			name: "collaborator with admin",
			source: db.Repository{
				ID: 92, Name: "governed", LowerName: "governed", IsPublic: true,
				DefaultBookmark: "main",
				UserID:          pgtype.Int8{Int64: 99, Valid: true},
			},
			stub: func(q *mockRepoQuerier) {
				q.getCollaboratorPermissionForRepo = func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
					return "admin", nil
				}
			},
		},
	} {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			source := tc.source
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return source, nil
				},
				createForkRepoFn: func(context.Context, db.CreateForkRepoParams) (db.Repository, error) {
					t.Fatal("a writer's fork must be refused before any repository row is created")
					return db.Repository{}, nil
				},
			}
			if tc.stub != nil {
				tc.stub(q)
			}
			rh := &mockRepoHostClient{
				forkRepoFn: func(context.Context, string, string, string, string) error {
					t.Fatal("a writer's fork must be refused before the repo-host copies anything")
					return nil
				},
			}

			_, err := NewRepoService(q, rh, "s1").ForkRepo(context.Background(), actor, "alice", source.Name, "", "")

			apiErr := apiError(t, err)
			assert.Equal(t, 403, apiErr.Status)
			assert.Equal(t, errors.CodeForkNotNeeded, apiErr.Code)
			assert.Contains(t, apiErr.Message, "edit it directly instead of forking it")
			assert.Zero(t, rh.forkRepoCalls)
		})
	}
}

// A reader keeps the fork door: nothing about the refusal above narrows who
// may actually fork.
func TestRepoService_ForkRepo_AllowsAReaderWithoutWriteAccess(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 7, Username: "forker"}
	source := db.Repository{
		ID: 90, Name: "source", LowerName: "source", IsPublic: true,
		UserID: pgtype.Int8{Int64: 99, Valid: true},
	}
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.Owner == actor.Username {
				return db.Repository{}, pgx.ErrNoRows
			}
			return source, nil
		},
		createForkRepoFn: func(_ context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
			return db.Repository{
				ID: 91, Name: arg.Name, LowerName: arg.LowerName, UserID: arg.UserID,
				ForkID: arg.ForkID, IsFork: true,
			}, nil
		},
	}
	rh := &mockRepoHostClient{forkRepoFn: func(context.Context, string, string, string, string) error { return nil }}

	outcome, err := NewRepoService(q, rh, "s1").ForkRepo(context.Background(), actor, "alice", "source", "", "")

	require.NoError(t, err)
	assert.True(t, outcome.Created)
	assert.Equal(t, int64(91), outcome.Repository.ID)
	assert.Equal(t, "source", outcome.Repository.Name, "the fork keeps the upstream's name unless the caller renames it")
	assert.Equal(t, source.ID, outcome.Repository.ForkID.Int64)
	assert.Equal(t, 1, rh.forkRepoCalls)
}

// Clicking Fork twice must not leave the caller with `repo` and `repo-1`. The
// second request is answered with the repository the first one made.
func TestRepoService_ForkRepo_IsIdempotentForTheSameUpstream(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 7, Username: "forker"}
	source := db.Repository{
		ID: 90, Name: "source", LowerName: "source", IsPublic: true,
		UserID: pgtype.Int8{Int64: 99, Valid: true},
	}
	existingFork := db.Repository{
		ID: 91, Name: "source", LowerName: "source", IsFork: true,
		UserID: pgtype.Int8{Int64: actor.ID, Valid: true},
		ForkID: pgtype.Int8{Int64: source.ID, Valid: true},
	}
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.Owner == actor.Username {
				return existingFork, nil
			}
			return source, nil
		},
		createForkRepoFn: func(context.Context, db.CreateForkRepoParams) (db.Repository, error) {
			t.Fatal("a repeated fork must return the existing fork, never create a second one")
			return db.Repository{}, nil
		},
	}
	rh := &mockRepoHostClient{
		forkRepoFn: func(context.Context, string, string, string, string) error {
			t.Fatal("a repeated fork must not re-copy refs")
			return nil
		},
	}

	outcome, err := NewRepoService(q, rh, "s1").ForkRepo(context.Background(), actor, "alice", "source", "", "")

	require.NoError(t, err)
	assert.False(t, outcome.Created, "the second request did not create anything")
	assert.Equal(t, existingFork.ID, outcome.Repository.ID)
}

// A same-named repository in the caller's namespace that is NOT a fork of this
// upstream is somebody else's work, not an idempotent repeat: the request goes
// down the normal create path and collides there.
func TestRepoService_ForkRepo_DoesNotAdoptAnUnrelatedRepositoryOfTheSameName(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 7, Username: "forker"}
	source := db.Repository{
		ID: 90, Name: "source", LowerName: "source", IsPublic: true,
		UserID: pgtype.Int8{Int64: 99, Valid: true},
	}
	unrelated := db.Repository{
		ID: 55, Name: "source", LowerName: "source",
		UserID: pgtype.Int8{Int64: actor.ID, Valid: true},
	}
	created := 0
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.Owner == actor.Username {
				return unrelated, nil
			}
			return source, nil
		},
		createForkRepoFn: func(context.Context, db.CreateForkRepoParams) (db.Repository, error) {
			created++
			//nolint:nilerr // the collision is the point of this test
			return db.Repository{}, &pgconn.PgError{Code: "23505"}
		},
	}
	rh := &mockRepoHostClient{forkRepoFn: func(context.Context, string, string, string, string) error { return nil }}

	_, err := NewRepoService(q, rh, "s1").ForkRepo(context.Background(), actor, "alice", "source", "", "")

	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, 1, created, "the create path runs and reports the collision; the unrelated repo is never adopted")
	assert.Zero(t, rh.forkRepoCalls)
}

// GetRepoView is the read a client uses to decide whether to offer editing or
// forking. Both answers come from the same call so no client has to infer one.
func TestRepoService_GetRepoView_ReportsWriteAccessAndUpstream(t *testing.T) {
	t.Parallel()

	upstream := db.Repository{ID: 90, Name: "source", LowerName: "source", IsPublic: true,
		UserID: pgtype.Int8{Int64: 99, Valid: true}}
	fork := db.Repository{ID: 91, Name: "source", LowerName: "source", IsPublic: true, IsFork: true,
		UserID: pgtype.Int8{Int64: 7, Valid: true},
		ForkID: pgtype.Int8{Int64: upstream.ID, Valid: true}}

	t.Run("a reader sees no write access and no upstream", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return upstream, nil
		}}

		view, err := NewRepoService(q, &mockRepoHostClient{}, "s1").
			GetRepoView(context.Background(), &db.User{ID: 7, Username: "forker"}, "alice", "source")

		require.NoError(t, err)
		assert.False(t, view.CanWrite)
		assert.Empty(t, view.ForkOf)
		assert.Equal(t, upstream.ID, view.Repository.ID)
	})

	t.Run("the fork's owner sees write access and the upstream", func(t *testing.T) {
		t.Parallel()
		q := &forkOwnerNamingQuerier{mockRepoQuerier: &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return fork, nil
			},
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				assert.Equal(t, upstream.ID, id)
				return upstream, nil
			},
		}, users: map[int64]db.User{99: {ID: 99, Username: "alice", LowerUsername: "alice"}}}

		view, err := NewRepoService(q, &mockRepoHostClient{}, "s1").
			GetRepoView(context.Background(), &db.User{ID: 7, Username: "forker"}, "forker", "source")

		require.NoError(t, err)
		assert.True(t, view.CanWrite)
		assert.Equal(t, "alice/source", view.ForkOf)
	})

	t.Run("a signed-out viewer of a public repository can never write", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return upstream, nil
		}}

		view, err := NewRepoService(q, &mockRepoHostClient{}, "s1").
			GetRepoView(context.Background(), nil, "alice", "source")

		require.NoError(t, err)
		assert.False(t, view.CanWrite)
	})
}

// forkOwnerNamingQuerier adds the owner-name lookups production's db.Queries
// has, so a test can prove fork_of renders "owner/name" rather than the empty
// string the lightweight mock falls back to.
type forkOwnerNamingQuerier struct {
	*mockRepoQuerier
	users map[int64]db.User
}

func (q *forkOwnerNamingQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	user, ok := q.users[id]
	if !ok {
		return db.User{}, pgx.ErrNoRows
	}
	return user, nil
}

func (q *forkOwnerNamingQuerier) GetOrgByID(_ context.Context, _ int64) (db.Organization, error) {
	return db.Organization{}, pgx.ErrNoRows
}
