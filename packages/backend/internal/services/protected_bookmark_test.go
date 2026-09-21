package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockProtectedBookmarkQuerier struct {
	getRepoByOwnerAndLowerNameFn           func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn                func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoUserFn  func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoUserFn func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	upsertProtectedBookmarkFn              func(ctx context.Context, arg db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error)
	listProtectedBookmarksByRepoFn         func(ctx context.Context, arg db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error)
	deleteProtectedBookmarkByPatternFn     func(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error)
	lastUpsertArg                          db.UpsertProtectedBookmarkParams
	lastDeleteArg                          db.DeleteProtectedBookmarkByPatternParams
}

func (m *mockProtectedBookmarkQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, nil
}

func (m *mockProtectedBookmarkQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockProtectedBookmarkQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoUserFn != nil {
		return m.getHighestTeamPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockProtectedBookmarkQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoUserFn != nil {
		return m.getCollaboratorPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockProtectedBookmarkQuerier) UpsertProtectedBookmark(ctx context.Context, arg db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error) {
	m.lastUpsertArg = arg
	if m.upsertProtectedBookmarkFn != nil {
		return m.upsertProtectedBookmarkFn(ctx, arg)
	}
	return db.ProtectedBookmark{
		ID:                     1,
		RepositoryID:           arg.RepositoryID,
		Pattern:                arg.Pattern,
		RequireReview:          arg.RequireReview,
		RequireHumanApprovals:  arg.RequireHumanApprovals,
		RequireAgentLgtm:       arg.RequireAgentLgtm,
		RequireStatusChecks:    arg.RequireStatusChecks,
		RequiredStatusContexts: arg.RequiredStatusContexts,
	}, nil
}

func (m *mockProtectedBookmarkQuerier) ListProtectedBookmarksByRepo(ctx context.Context, arg db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error) {
	if m.listProtectedBookmarksByRepoFn != nil {
		return m.listProtectedBookmarksByRepoFn(ctx, arg)
	}
	return []db.ProtectedBookmark{}, nil
}

func (m *mockProtectedBookmarkQuerier) DeleteProtectedBookmarkByPattern(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error) {
	m.lastDeleteArg = arg
	if m.deleteProtectedBookmarkByPatternFn != nil {
		return m.deleteProtectedBookmarkByPatternFn(ctx, arg)
	}
	return 1, nil
}

func TestProtectedBookmarkService_Upsert_IncludesStatusCheckFields(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:     10,
		UserID: pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "owner"}

	q := &mockProtectedBookmarkQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
	svc := NewProtectedBookmarkService(q)

	result, err := svc.UpsertProtectedBookmark(context.Background(), actor, "owner", "repo", UpsertProtectedBookmarkInput{
		Pattern:                "main",
		RequireReview:          true,
		RequireHumanApprovals:  2,
		RequireAgentLGTM:       true,
		RequireStatusChecks:    true,
		RequiredStatusContexts: []string{"ci/build", "ci/lint"},
	})
	require.NoError(t, err)

	assert.Equal(t, "main", result.Pattern)
	assert.True(t, result.RequireReview)
	assert.Equal(t, int64(2), result.RequireHumanApprovals)
	assert.True(t, result.RequireAgentLGTM)
	assert.True(t, result.RequireStatusChecks)
	assert.Equal(t, []string{"ci/build", "ci/lint"}, result.RequiredStatusContexts)

	// Verify the DB params were correct.
	assert.True(t, q.lastUpsertArg.RequireStatusChecks)
	assert.Equal(t, int64(2), q.lastUpsertArg.RequireHumanApprovals)
	assert.True(t, q.lastUpsertArg.RequireAgentLgtm)
	assert.Equal(t, []string{"ci/build", "ci/lint"}, q.lastUpsertArg.RequiredStatusContexts)
}

func TestProtectedBookmarkService_Upsert_DefaultsNilContextsToEmpty(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:     10,
		UserID: pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "owner"}

	q := &mockProtectedBookmarkQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
	svc := NewProtectedBookmarkService(q)

	result, err := svc.UpsertProtectedBookmark(context.Background(), actor, "owner", "repo", UpsertProtectedBookmarkInput{
		Pattern:                "main",
		RequireStatusChecks:    true,
		RequiredStatusContexts: nil,
	})
	require.NoError(t, err)

	// Nil should be normalized to empty slice.
	assert.NotNil(t, result.RequiredStatusContexts)
	assert.Empty(t, result.RequiredStatusContexts)
	assert.NotNil(t, q.lastUpsertArg.RequiredStatusContexts)
}

func TestProtectedBookmarkService_Upsert_RequiresAuth(t *testing.T) {
	t.Parallel()

	svc := NewProtectedBookmarkService(&mockProtectedBookmarkQuerier{})

	_, err := svc.UpsertProtectedBookmark(context.Background(), nil, "owner", "repo", UpsertProtectedBookmarkInput{
		Pattern: "main",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "authentication required")
}

func TestProtectedBookmarkService_Upsert_RequiresAdminAccess(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:     10,
		UserID: pgtype.Int8{Int64: 999, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "writer"}

	q := &mockProtectedBookmarkQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
	svc := NewProtectedBookmarkService(q)

	_, err := svc.UpsertProtectedBookmark(context.Background(), actor, "owner", "repo", UpsertProtectedBookmarkInput{
		Pattern: "main",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "admin access required")
}

func TestProtectedBookmarkService_Upsert_EmptyPatternFails(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:     10,
		UserID: pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "owner"}

	q := &mockProtectedBookmarkQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
	svc := NewProtectedBookmarkService(q)

	_, err := svc.UpsertProtectedBookmark(context.Background(), actor, "owner", "repo", UpsertProtectedBookmarkInput{
		Pattern: "  ",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "validation failed")
}

func TestProtectedBookmarkService_List_ReturnsStatusCheckFields(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:     10,
		UserID: pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "owner"}

	q := &mockProtectedBookmarkQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		listProtectedBookmarksByRepoFn: func(ctx context.Context, arg db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error) {
			return []db.ProtectedBookmark{
				{
					ID:                     1,
					Pattern:                "main",
					RequireReview:          true,
					RequireHumanApprovals:  1,
					RequireAgentLgtm:       true,
					RequireStatusChecks:    true,
					RequiredStatusContexts: []string{"ci/build"},
				},
				{
					ID:                     2,
					Pattern:                "release/*",
					RequireReview:          false,
					RequireStatusChecks:    false,
					RequiredStatusContexts: nil,
				},
			}, nil
		},
	}
	svc := NewProtectedBookmarkService(q)

	results, err := svc.ListProtectedBookmarks(context.Background(), actor, "owner", "repo", 1, 30)
	require.NoError(t, err)
	require.Len(t, results, 2)

	assert.True(t, results[0].RequireStatusChecks)
	assert.Equal(t, int64(1), results[0].RequireHumanApprovals)
	assert.True(t, results[0].RequireAgentLGTM)
	assert.Equal(t, []string{"ci/build"}, results[0].RequiredStatusContexts)

	assert.False(t, results[1].RequireStatusChecks)
	assert.NotNil(t, results[1].RequiredStatusContexts)
	assert.Empty(t, results[1].RequiredStatusContexts)
}

func TestProtectedBookmarkService_Delete_ReturnsNotFoundForMissing(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:     10,
		UserID: pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "owner"}

	q := &mockProtectedBookmarkQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		deleteProtectedBookmarkByPatternFn: func(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error) {
			return 0, nil
		},
	}
	svc := NewProtectedBookmarkService(q)

	err := svc.DeleteProtectedBookmark(context.Background(), actor, "owner", "repo", "nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}
