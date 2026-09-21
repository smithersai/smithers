package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type failingImportCleanupHost struct {
	GitHubImportRepoHost
}

func (failingImportCleanupHost) DeleteRepo(context.Context, string, string) error {
	return errors.New("repo-host unavailable")
}

type recordingImportCleanupDB struct {
	GitHubImportRepoDB
	deleteCalls int
}

func (db *recordingImportCleanupDB) DeleteRepo(context.Context, int64) error {
	db.deleteCalls++
	return nil
}

func TestTransferRepo_FailsClosedOnDestinationLookupErrors(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 1, Username: "alice"}
	repository := testRepo(nil)

	t.Run("user lookup failure is not treated as an absent user", func(t *testing.T) {
		orgLookups := 0
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repository, nil
			},
			getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
				return db.User{}, errors.New("database unavailable")
			},
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				orgLookups++
				return db.Organization{}, nil
			},
		}

		_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").TransferRepo(
			context.Background(), actor, "alice", repository.Name, "bob",
		)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Zero(t, orgLookups)
		assert.False(t, q.transferToUserCalled)
		assert.False(t, q.transferToOrgCalled)
	})

	t.Run("user destination duplicate lookup failure is not treated as free", func(t *testing.T) {
		lookups := 0
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				lookups++
				if lookups == 1 {
					return repository, nil
				}
				return db.Repository{}, errors.New("database unavailable")
			},
			getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			},
		}

		_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").TransferRepo(
			context.Background(), actor, "alice", repository.Name, "bob",
		)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.False(t, q.transferToUserCalled)
	})

	t.Run("organization destination duplicate lookup failure is not treated as free", func(t *testing.T) {
		lookups := 0
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				lookups++
				if lookups == 1 {
					return repository, nil
				}
				return db.Repository{}, errors.New("database unavailable")
			},
			getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{ID: 3, Name: "acme", LowerName: "acme"}, nil
			},
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 3, UserID: actor.ID, Role: "owner"}, nil
			},
		}

		_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").TransferRepo(
			context.Background(), actor, "alice", repository.Name, "acme",
		)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.False(t, q.transferToOrgCalled)
	})
}

func TestCreateRepo_RequiresAuthenticatedUser(t *testing.T) {
	t.Parallel()

	_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").CreateRepo(
		context.Background(), nil, "demo", "", true, "main", false,
	)
	assert.Equal(t, 401, apiStatus(t, err))
}

func TestForkRepo_UsesSourceStorageSetForSameHostCopy(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 7, Username: "bob", LowerUsername: "bob"}
	source := testRepo(func(repository *db.Repository) {
		repository.ID = 41
		repository.UserID = pgtype.Int8{Int64: 2, Valid: true}
		repository.Name = "source"
		repository.LowerName = "source"
		repository.StorageSetID = "legacy-s7"
		repository.IsPublic = true
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return source, nil
		},
		createForkRepoFn: func(_ context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
			assert.Equal(t, source.StorageSetID, arg.StorageSetID)
			return db.Repository{
				ID:              42,
				UserID:          arg.UserID,
				Name:            arg.Name,
				LowerName:       arg.LowerName,
				Description:     arg.Description,
				StorageSetID:    arg.StorageSetID,
				IsPublic:        arg.IsPublic,
				DefaultBookmark: arg.DefaultBookmark,
				IsFork:          true,
				ForkID:          arg.ForkID,
			}, nil
		},
	}
	rh := &mockRepoHostClient{forkRepoFn: func(context.Context, string, string, string, string) error {
		return nil
	}}

	forked, err := NewRepoService(q, rh, "active-s9").ForkRepo(
		context.Background(), actor, "alice", source.Name, "copy", "",
	)
	require.NoError(t, err)
	assert.Equal(t, source.StorageSetID, forked.Repository.StorageSetID)
	assert.Equal(t, 1, rh.forkRepoCalls)
}

func TestGitHubImport_UsesConfiguredActiveStorageSet(t *testing.T) {
	t.Parallel()

	var createArg db.CreateRepoParams
	repoDB := &reconciliationImportRepoDB{
		getFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
		createFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
			createArg = arg
			return recoveredUserRepository(arg, 71), nil
		},
	}
	host := &reconciliationImportRepoHost{}
	svc := NewGitHubImportService(nil, repoDB, nil, host, nil, "https://smithers.test",
		WithGitHubImportStorageSet(" active-s9 "))

	repository, reused, err := svc.ensureLocalRepo(
		context.Background(), 7, "alice", "octocat", "demo", "main",
	)
	require.NoError(t, err)
	assert.False(t, reused)
	assert.Equal(t, "active-s9", createArg.StorageSetID)
	assert.Equal(t, "active-s9", repository.StorageSetID)
}

func TestProvisioningCleanup_PreservesPlacementRowWhenStorageDeletionFails(t *testing.T) {
	t.Parallel()

	t.Run("ordinary repository", func(t *testing.T) {
		q := &mockRepoQuerier{}
		rh := &mockRepoHostClient{deleteRepoFn: func(context.Context, string, string) error {
			return errors.New("repo-host unavailable")
		}}

		NewRepoService(q, rh, "s1").rollbackProvisionedRepo(
			context.Background(), 41, "alice", "demo",
		)
		assert.False(t, q.deleteCalled)
	})

	t.Run("github import", func(t *testing.T) {
		repoDB := &recordingImportCleanupDB{}
		svc := &GitHubImportService{
			repoDB:   repoDB,
			repoHost: failingImportCleanupHost{},
		}

		svc.rollbackFreshImportRepo(context.Background(), 42, "alice", "demo")
		assert.Zero(t, repoDB.deleteCalls)
	})
}
