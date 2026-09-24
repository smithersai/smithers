package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type protectedBookmarkZQuerier struct {
	repoFn       func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	orgOwnerFn   func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error)
	teamPermFn   func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	upsertFn     func(context.Context, db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error)
	listFn       func(context.Context, db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error)
	deleteFn     func(context.Context, db.DeleteProtectedBookmarkByPatternParams) (int64, error)
}

func (q protectedBookmarkZQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if q.repoFn != nil {
		return q.repoFn(ctx, arg)
	}
	return db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
}
func (q protectedBookmarkZQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if q.orgOwnerFn != nil {
		return q.orgOwnerFn(ctx, arg)
	}
	return false, nil
}
func (q protectedBookmarkZQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if q.teamPermFn != nil {
		return q.teamPermFn(ctx, arg)
	}
	return "", nil
}
func (q protectedBookmarkZQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if q.collabPermFn != nil {
		return q.collabPermFn(ctx, arg)
	}
	return "", nil
}
func (q protectedBookmarkZQuerier) UpsertProtectedBookmark(ctx context.Context, arg db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error) {
	if q.upsertFn != nil {
		return q.upsertFn(ctx, arg)
	}
	return db.ProtectedBookmark{
		ID:                     7,
		RepositoryID:           arg.RepositoryID,
		Pattern:                arg.Pattern,
		RequireReview:          arg.RequireReview,
		RequireHumanApprovals:  arg.RequireHumanApprovals,
		RequireAgentLgtm:       arg.RequireAgentLgtm,
		RequireStatusChecks:    arg.RequireStatusChecks,
		RequiredStatusContexts: arg.RequiredStatusContexts,
	}, nil
}
func (q protectedBookmarkZQuerier) ListProtectedBookmarksByRepo(ctx context.Context, arg db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error) {
	if q.listFn != nil {
		return q.listFn(ctx, arg)
	}
	return []db.ProtectedBookmark{{ID: 8, RepositoryID: arg.RepositoryID, Pattern: "main"}}, nil
}
func (q protectedBookmarkZQuerier) DeleteProtectedBookmarkByPattern(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error) {
	if q.deleteFn != nil {
		return q.deleteFn(ctx, arg)
	}
	return 1, nil
}

func TestProtectedBookmark_Z_OperationBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 1}

	_, err := NewProtectedBookmarkService(protectedBookmarkZQuerier{}).UpsertProtectedBookmark(ctx, nil, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: "main"})
	require.Equal(t, 401, apiStatus(t, err))

	_, err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		repoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}).UpsertProtectedBookmark(ctx, actor, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: "main"})
	require.Equal(t, 404, apiStatus(t, err))

	_, err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		repoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
	}).UpsertProtectedBookmark(ctx, actor, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: "main"})
	require.Equal(t, 403, apiStatus(t, err))

	for _, pattern := range []string{" ", strings.Repeat("x", 256), "bad\x00pattern"} {
		_, err = NewProtectedBookmarkService(protectedBookmarkZQuerier{}).UpsertProtectedBookmark(ctx, actor, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: pattern})
		require.Equal(t, 422, apiStatus(t, err))
	}

	got, err := NewProtectedBookmarkService(protectedBookmarkZQuerier{}).UpsertProtectedBookmark(ctx, actor, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: " main "})
	require.NoError(t, err)
	assert.Equal(t, "main", got.Pattern)
	assert.Empty(t, got.RequiredStatusContexts)

	_, err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		upsertFn: func(context.Context, db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error) {
			return db.ProtectedBookmark{}, errors.New("upsert failed")
		},
	}).UpsertProtectedBookmark(ctx, actor, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: "main"})
	require.Equal(t, 500, apiStatus(t, err))

	_, err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		repoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}).ListProtectedBookmarks(ctx, actor, "alice", "demo", 0, 0)
	require.Equal(t, 404, apiStatus(t, err))

	_, err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		repoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
	}).ListProtectedBookmarks(ctx, actor, "alice", "demo", 0, 0)
	require.Equal(t, 403, apiStatus(t, err))

	_, err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		listFn: func(context.Context, db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error) {
			return nil, errors.New("list failed")
		},
	}).ListProtectedBookmarks(ctx, actor, "alice", "demo", -1, 0)
	require.Equal(t, 500, apiStatus(t, err))

	rows, err := NewProtectedBookmarkService(protectedBookmarkZQuerier{}).ListProtectedBookmarks(ctx, actor, "alice", "demo", -1, 0)
	require.NoError(t, err)
	require.Len(t, rows, 1)

	err = NewProtectedBookmarkService(protectedBookmarkZQuerier{}).DeleteProtectedBookmark(ctx, nil, "alice", "demo", "main")
	require.Equal(t, 401, apiStatus(t, err))

	err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		repoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}).DeleteProtectedBookmark(ctx, actor, "alice", "demo", "main")
	require.Equal(t, 404, apiStatus(t, err))

	err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		repoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
	}).DeleteProtectedBookmark(ctx, actor, "alice", "demo", "main")
	require.Equal(t, 403, apiStatus(t, err))

	err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		deleteFn: func(context.Context, db.DeleteProtectedBookmarkByPatternParams) (int64, error) {
			return 0, errors.New("delete failed")
		},
	}).DeleteProtectedBookmark(ctx, actor, "alice", "demo", "main")
	require.Equal(t, 500, apiStatus(t, err))

	err = NewProtectedBookmarkService(protectedBookmarkZQuerier{
		deleteFn: func(context.Context, db.DeleteProtectedBookmarkByPatternParams) (int64, error) {
			return 0, nil
		},
	}).DeleteProtectedBookmark(ctx, actor, "alice", "demo", "main")
	require.Equal(t, 404, apiStatus(t, err))
}

func TestProtectedBookmark_Z_AdminAccessBranches(t *testing.T) {
	ctx := context.Background()
	repo := db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 99, Valid: true}, OrgID: pgtype.Int8{Int64: 5, Valid: true}}
	svc := NewProtectedBookmarkService(protectedBookmarkZQuerier{})

	require.Equal(t, 401, apiStatus(t, svc.requireAdminAccess(ctx, repo, nil)))
	require.NoError(t, svc.requireAdminAccess(ctx, repo, &db.User{ID: 1, IsAdmin: true}))
	require.NoError(t, svc.requireAdminAccess(ctx, db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 1, Valid: true}}, &db.User{ID: 1}))

	require.NoError(t, NewProtectedBookmarkService(protectedBookmarkZQuerier{
		orgOwnerFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) { return true, nil },
	}).requireAdminAccess(ctx, repo, &db.User{ID: 1}))

	require.NoError(t, NewProtectedBookmarkService(protectedBookmarkZQuerier{
		teamPermFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "admin", nil
		},
	}).requireAdminAccess(ctx, repo, &db.User{ID: 1}))

	require.NoError(t, NewProtectedBookmarkService(protectedBookmarkZQuerier{
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "admin", nil
		},
	}).requireAdminAccess(ctx, repo, &db.User{ID: 1}))

	require.Equal(t, 403, apiStatus(t, svc.requireAdminAccess(ctx, repo, &db.User{ID: 1})))
}
