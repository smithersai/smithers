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

func TestLabel_Cov_PermissionHelpers(t *testing.T) {
	ctx := context.Background()

	t.Run("direct owner bypasses permission lookups", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{
			getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				t.Fatal("owner should not need collaborator lookup")
				return "", nil
			},
		})
		permission, isOwner, err := repoPermissionForUser(ctx, svc.queries, db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 7, Valid: true}}, 7)
		require.NoError(t, err)
		assert.Empty(t, permission)
		assert.True(t, isOwner)
	})

	t.Run("org owner is treated as owner", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return true, nil
			},
		})
		permission, isOwner, err := repoPermissionForUser(ctx, svc.queries, db.Repository{ID: 12, OrgID: pgtype.Int8{Int64: 3, Valid: true}}, 7)
		require.NoError(t, err)
		assert.Empty(t, permission)
		assert.True(t, isOwner)
	})

	t.Run("highest team or collaborator permission wins", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{
			getHighestTeamPermissionForRepoFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
				return "read", nil
			},
			getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return " ADMIN ", nil
			},
		})
		permission, isOwner, err := repoPermissionForUser(ctx, svc.queries, db.Repository{ID: 12, OrgID: pgtype.Int8{Int64: 3, Valid: true}}, 7)
		require.NoError(t, err)
		assert.Equal(t, "admin", permission)
		assert.False(t, isOwner)
	})

	t.Run("read and write guards map nil and query failures", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{})
		assert.NoError(t, svc.requireReadAccess(ctx, db.Repository{ID: 1, IsPublic: true}, nil))
		assert.Equal(t, 403, labelAPIStatus(t, svc.requireReadAccess(ctx, db.Repository{ID: 1, IsPublic: false}, nil)))
		assert.Equal(t, 401, labelAPIStatus(t, svc.requireWriteAccess(ctx, db.Repository{ID: 1}, nil)))

		svc = NewLabelService(&mockLabelQuerier{
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, errors.New("permission query failed")
			},
		})
		err := svc.requireReadAccess(ctx, db.Repository{ID: 1, IsPublic: false, OrgID: pgtype.Int8{Int64: 2, Valid: true}}, labelTestUser(7))
		assert.Equal(t, 500, labelAPIStatus(t, err))
	})
}

func TestLabel_Cov_CRUDErrorBranches(t *testing.T) {
	ctx := context.Background()
	actor := labelTestUser(1)
	repo := labelTestRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	t.Run("create and list failures", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createLabelFn: func(context.Context, db.CreateLabelParams) (db.Label, error) {
				return db.Label{}, errors.New("insert failed")
			},
		})
		_, err := svc.CreateLabel(ctx, actor, "alice", "demo", CreateLabelInput{Name: "bug", Color: "#ff00aa"})
		assert.Equal(t, 500, labelAPIStatus(t, err))

		svc = NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			countLabelsByRepoFn: func(context.Context, int64) (int64, error) {
				return 0, errors.New("count failed")
			},
		})
		_, _, err = svc.ListLabels(ctx, nil, "alice", "demo", 1, 10)
		assert.Equal(t, 500, labelAPIStatus(t, err))

		svc = NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			listLabelsByRepoFn: func(context.Context, db.ListLabelsByRepoParams) ([]db.Label, error) {
				return nil, errors.New("list failed")
			},
		})
		_, _, err = svc.ListLabels(ctx, nil, "alice", "demo", 1, 10)
		assert.Equal(t, 500, labelAPIStatus(t, err))
	})

	t.Run("get update and delete failures", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{})
		_, err := svc.GetLabel(ctx, nil, "alice", "demo", 0)
		assert.Equal(t, 400, labelAPIStatus(t, err))

		svc = NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
				return db.Label{}, errors.New("select failed")
			},
		})
		_, err = svc.GetLabel(ctx, nil, "alice", "demo", 9)
		assert.Equal(t, 500, labelAPIStatus(t, err))

		_, err = svc.UpdateLabel(ctx, actor, "alice", "demo", 9, UpdateLabelInput{Name: ptrStringLabel("triage")})
		assert.Equal(t, 500, labelAPIStatus(t, err))

		err = svc.DeleteLabel(ctx, actor, "alice", "demo", 9)
		assert.Equal(t, 500, labelAPIStatus(t, err))

		svc = NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
				return db.Label{ID: 9, RepositoryID: repo.ID, Name: "bug", Color: "#ff00aa"}, nil
			},
			updateLabelFn: func(context.Context, db.UpdateLabelParams) (db.Label, error) {
				return db.Label{}, pgx.ErrNoRows
			},
			deleteLabelFn: func(context.Context, db.DeleteLabelParams) error {
				return errors.New("delete failed")
			},
		})
		_, err = svc.UpdateLabel(ctx, actor, "alice", "demo", 9, UpdateLabelInput{Name: ptrStringLabel("triage")})
		assert.Equal(t, 404, labelAPIStatus(t, err))

		err = svc.DeleteLabel(ctx, actor, "alice", "demo", 9)
		assert.Equal(t, 500, labelAPIStatus(t, err))
	})
}

func TestLabel_Cov_IssueLabelErrorBranchesAndPagination(t *testing.T) {
	ctx := context.Background()
	actor := labelTestUser(1)
	repo := labelTestRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	issue := db.Issue{ID: 101, RepositoryID: repo.ID, Number: 3, AuthorID: actor.ID}

	t.Run("list issue labels maps issue and count/list errors", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
				return db.Issue{}, errors.New("issue failed")
			},
		})
		_, _, err := svc.ListIssueLabels(ctx, nil, "alice", "demo", 3, 1, 10)
		assert.Equal(t, 500, labelAPIStatus(t, err))

		svc = NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
				return issue, nil
			},
			countLabelsForIssueFn: func(context.Context, int64) (int64, error) {
				return 0, errors.New("count failed")
			},
		})
		_, _, err = svc.ListIssueLabels(ctx, nil, "alice", "demo", 3, 1, 10)
		assert.Equal(t, 500, labelAPIStatus(t, err))

		svc = NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
				return issue, nil
			},
			countLabelsForIssueFn: func(context.Context, int64) (int64, error) {
				return 1, nil
			},
			listLabelsForIssueFn: func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) {
				return nil, errors.New("list failed")
			},
		})
		_, _, err = svc.ListIssueLabels(ctx, nil, "alice", "demo", 3, 1, 10)
		assert.Equal(t, 500, labelAPIStatus(t, err))
	})

	t.Run("remove issue label maps remove failure", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
				return issue, nil
			},
			removeIssueLabelByNameFn: func(context.Context, db.RemoveIssueLabelByNameParams) (int64, error) {
				return 0, errors.New("remove failed")
			},
		})
		err := svc.RemoveIssueLabelByName(ctx, actor, "alice", "demo", 3, "bug")
		assert.Equal(t, 500, labelAPIStatus(t, err))
	})

	t.Run("listAllLabelsForIssue returns empty and paginates partial final page", func(t *testing.T) {
		svc := NewLabelService(&mockLabelQuerier{
			countLabelsForIssueFn: func(context.Context, int64) (int64, error) {
				return 0, nil
			},
		})
		labels, err := svc.listAllLabelsForIssue(ctx, 101)
		require.NoError(t, err)
		assert.Empty(t, labels)

		offsets := []int32{}
		svc = NewLabelService(&mockLabelQuerier{
			countLabelsForIssueFn: func(context.Context, int64) (int64, error) {
				return 3, nil
			},
			listLabelsForIssueFn: func(_ context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
				offsets = append(offsets, arg.PageOffset)
				switch arg.PageOffset {
				case 0:
					return []db.Label{{ID: 1, Name: "bug"}, {ID: 2, Name: "triage"}}, nil
				case 2:
					return []db.Label{{ID: 3, Name: "ops"}}, nil
				default:
					return nil, nil
				}
			},
		})

		labels, err = svc.listAllLabelsForIssue(ctx, 101)
		require.NoError(t, err)
		require.Len(t, labels, 3)
		assert.Equal(t, []int32{0, 2}, offsets)
		assert.Equal(t, "ops", labels[2].Name)
	})
}
