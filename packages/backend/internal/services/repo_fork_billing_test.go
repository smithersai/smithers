package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Forking a private repo creates a new private repo owned by the actor, so it
// must enforce the actor's private-repo entitlement exactly like CreateRepo.
// Otherwise the private-repo quota is trivially bypassed via fork.
func TestRepoService_ForkRepo_EnforcesPrivateRepoBilling(t *testing.T) {
	actor := &db.User{ID: 1, Username: "actor"}
	// Owned by somebody else: a caller who can already write to the source is
	// refused with fork_not_needed before any of this runs, so the only caller
	// who reaches the billing path is a reader. The read grant is the
	// collaborator "read" permission each subtest stubs.
	privateSource := db.Repository{
		ID:              42,
		Name:            "secret",
		LowerName:       "secret",
		Description:     "classified",
		IsPublic:        false,
		DefaultBookmark: "main",
		UserID:          pgtype.Int8{Int64: 77, Valid: true},
	}
	readOnly := func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "read", nil
	}

	t.Run("over quota rejects before creating fork", func(t *testing.T) {
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return privateSource, nil
			},
			getCollaboratorPermissionForRepo: readOnly,
			createForkRepoFn: func(ctx context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
				t.Fatal("CreateForkRepo must not be called when private-repo billing rejects")
				return db.Repository{}, nil
			},
		}
		stub := &stubBillingPolicy{
			authorizePrivateRepoFn: func(ctx context.Context, ownerType string, ownerID int64) error {
				return errors.Forbidden("private repositories are not included in your plan")
			},
		}
		rh := &mockRepoHostClient{
			forkRepoFn: func(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
				t.Fatal("repo-host fork must not be called when private-repo billing rejects")
				return nil
			},
		}
		svc := NewRepoService(q, rh, "smithers-repo-host-0", WithRepoBillingPolicy(stub))

		_, err := svc.ForkRepo(context.Background(), actor, "owner", "secret", "", "")

		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Contains(t, err.Error(), "private repositories are not included in your plan")
		assert.Equal(t, 1, stub.privateRepoCalls, "fork of a private repo must consult the private-repo entitlement")
		assert.Equal(t, BillingOwnerTypeUser, stub.lastOwnerType)
		assert.Equal(t, actor.ID, stub.lastOwnerID)
		assert.Equal(t, 0, rh.forkRepoCalls)
	})

	t.Run("allowed private fork succeeds", func(t *testing.T) {
		var createForkCalls int
		var createArg db.CreateForkRepoParams
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return privateSource, nil
			},
			getCollaboratorPermissionForRepo: readOnly,
			createForkRepoFn: func(ctx context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
				createForkCalls++
				createArg = arg
				return db.Repository{
					ID:              99,
					UserID:          arg.UserID,
					Name:            arg.Name,
					LowerName:       arg.LowerName,
					Description:     arg.Description,
					IsPublic:        arg.IsPublic,
					DefaultBookmark: arg.DefaultBookmark,
					ForkID:          arg.ForkID,
				}, nil
			},
		}
		stub := &stubBillingPolicy{}
		rh := &mockRepoHostClient{}
		svc := NewRepoService(q, rh, "smithers-repo-host-0", WithRepoBillingPolicy(stub))

		forkedRepo, err := svc.ForkRepo(context.Background(), actor, "owner", "secret", "secret-copy", "copied private repo")

		require.NoError(t, err)
		assert.True(t, forkedRepo.Created)
		assert.Equal(t, int64(99), forkedRepo.Repository.ID)
		assert.Equal(t, "secret-copy", forkedRepo.Repository.Name)
		assert.False(t, forkedRepo.Repository.IsPublic)
		assert.Equal(t, 1, stub.privateRepoCalls)
		assert.Equal(t, BillingOwnerTypeUser, stub.lastOwnerType)
		assert.Equal(t, actor.ID, stub.lastOwnerID)
		assert.Equal(t, 1, createForkCalls)
		assert.Equal(t, actor.ID, createArg.UserID.Int64)
		assert.True(t, createArg.UserID.Valid)
		assert.Equal(t, "secret-copy", createArg.Name)
		assert.Equal(t, "secret-copy", createArg.LowerName)
		assert.Equal(t, "copied private repo", createArg.Description)
		assert.False(t, createArg.IsPublic)
		assert.Equal(t, privateSource.ID, createArg.ForkID.Int64)
		assert.True(t, createArg.ForkID.Valid)
		assert.Equal(t, 1, rh.forkRepoCalls)
	})
}
