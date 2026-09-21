package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockLabelQuerier struct {
	getRepoByOwnerAndLowerNameFn      func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn           func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoFn func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepo  func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	createLabelFn                     func(ctx context.Context, arg db.CreateLabelParams) (db.Label, error)
	listLabelsByRepoFn                func(ctx context.Context, arg db.ListLabelsByRepoParams) ([]db.Label, error)
	countLabelsByRepoFn               func(ctx context.Context, repositoryID int64) (int64, error)
	getLabelByIDFn                    func(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error)
	getLabelByNameFn                  func(ctx context.Context, arg db.GetLabelByNameParams) (db.Label, error)
	listLabelsByNamesFn               func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error)
	updateLabelFn                     func(ctx context.Context, arg db.UpdateLabelParams) (db.Label, error)
	deleteLabelFn                     func(ctx context.Context, arg db.DeleteLabelParams) error
	getIssueByNumberFn                func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error)
	addIssueLabelFn                   func(ctx context.Context, arg db.AddIssueLabelParams) (db.IssueLabel, error)
	addIssueLabelsFn                  func(ctx context.Context, arg db.AddIssueLabelsParams) error
	listLabelsForIssueFn              func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error)
	countLabelsForIssueFn             func(ctx context.Context, issueID int64) (int64, error)
	removeIssueLabelByNameFn          func(ctx context.Context, arg db.RemoveIssueLabelByNameParams) (int64, error)
	listIssueAssigneesFn              func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error)

	lastListLabelsByRepoArg   db.ListLabelsByRepoParams
	lastCreateLabelArg        db.CreateLabelParams
	lastUpdateLabelArg        db.UpdateLabelParams
	lastListLabelsByNamesArg  db.ListLabelsByNamesParams
	lastAddIssueLabelsArg     db.AddIssueLabelsParams
	lastListLabelsForIssueArg db.ListLabelsForIssueParams
}

func (m *mockLabelQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockLabelQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockLabelQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoFn != nil {
		return m.getHighestTeamPermissionForRepoFn(ctx, arg)
	}
	return "", nil
}

func (m *mockLabelQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepo != nil {
		return m.getCollaboratorPermissionForRepo(ctx, arg)
	}
	return "", nil
}

func (m *mockLabelQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	return db.User{ID: id, Username: fmt.Sprintf("u-%d", id), LowerUsername: fmt.Sprintf("u-%d", id)}, nil
}

func (m *mockLabelQuerier) CreateLabel(ctx context.Context, arg db.CreateLabelParams) (db.Label, error) {
	m.lastCreateLabelArg = arg
	if m.createLabelFn != nil {
		return m.createLabelFn(ctx, arg)
	}
	return db.Label{ID: 1, RepositoryID: arg.RepositoryID, Name: arg.Name, Color: arg.Color, Description: arg.Description}, nil
}

func (m *mockLabelQuerier) ListLabelsByRepo(ctx context.Context, arg db.ListLabelsByRepoParams) ([]db.Label, error) {
	m.lastListLabelsByRepoArg = arg
	if m.listLabelsByRepoFn != nil {
		return m.listLabelsByRepoFn(ctx, arg)
	}
	return []db.Label{}, nil
}

func (m *mockLabelQuerier) CountLabelsByRepo(ctx context.Context, repositoryID int64) (int64, error) {
	if m.countLabelsByRepoFn != nil {
		return m.countLabelsByRepoFn(ctx, repositoryID)
	}
	return 0, nil
}

func (m *mockLabelQuerier) GetLabelByID(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error) {
	if m.getLabelByIDFn != nil {
		return m.getLabelByIDFn(ctx, arg)
	}
	return db.Label{}, pgx.ErrNoRows
}

func (m *mockLabelQuerier) GetLabelByName(ctx context.Context, arg db.GetLabelByNameParams) (db.Label, error) {
	if m.getLabelByNameFn != nil {
		return m.getLabelByNameFn(ctx, arg)
	}
	return db.Label{}, pgx.ErrNoRows
}

func (m *mockLabelQuerier) ListLabelsByNames(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
	m.lastListLabelsByNamesArg = arg
	if m.listLabelsByNamesFn != nil {
		return m.listLabelsByNamesFn(ctx, arg)
	}
	return []db.Label{}, nil
}

func (m *mockLabelQuerier) UpdateLabel(ctx context.Context, arg db.UpdateLabelParams) (db.Label, error) {
	m.lastUpdateLabelArg = arg
	if m.updateLabelFn != nil {
		return m.updateLabelFn(ctx, arg)
	}
	return db.Label{ID: arg.ID, RepositoryID: arg.RepositoryID, Name: arg.Name, Color: arg.Color, Description: arg.Description}, nil
}

func (m *mockLabelQuerier) DeleteLabel(ctx context.Context, arg db.DeleteLabelParams) error {
	if m.deleteLabelFn != nil {
		return m.deleteLabelFn(ctx, arg)
	}
	return nil
}

func (m *mockLabelQuerier) GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
	if m.getIssueByNumberFn != nil {
		return m.getIssueByNumberFn(ctx, arg)
	}
	return db.Issue{}, pgx.ErrNoRows
}

func (m *mockLabelQuerier) AddIssueLabel(ctx context.Context, arg db.AddIssueLabelParams) (db.IssueLabel, error) {
	if m.addIssueLabelFn != nil {
		return m.addIssueLabelFn(ctx, arg)
	}
	return db.IssueLabel{IssueID: arg.IssueID, LabelID: arg.LabelID}, nil
}

func (m *mockLabelQuerier) AddIssueLabels(ctx context.Context, arg db.AddIssueLabelsParams) error {
	m.lastAddIssueLabelsArg = arg
	if m.addIssueLabelsFn != nil {
		return m.addIssueLabelsFn(ctx, arg)
	}
	return nil
}

func (m *mockLabelQuerier) ListLabelsForIssue(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
	m.lastListLabelsForIssueArg = arg
	if m.listLabelsForIssueFn != nil {
		return m.listLabelsForIssueFn(ctx, arg)
	}
	return []db.Label{}, nil
}

func (m *mockLabelQuerier) CountLabelsForIssue(ctx context.Context, issueID int64) (int64, error) {
	if m.countLabelsForIssueFn != nil {
		return m.countLabelsForIssueFn(ctx, issueID)
	}
	return 0, nil
}

func (m *mockLabelQuerier) RemoveIssueLabelByName(ctx context.Context, arg db.RemoveIssueLabelByNameParams) (int64, error) {
	if m.removeIssueLabelByNameFn != nil {
		return m.removeIssueLabelByNameFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockLabelQuerier) ListIssueAssignees(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
	if m.listIssueAssigneesFn != nil {
		return m.listIssueAssigneesFn(ctx, issueID)
	}
	return nil, nil
}

func labelTestRepo(overrides func(*db.Repository)) db.Repository {
	repo := db.Repository{
		ID:        11,
		Name:      "demo",
		LowerName: "demo",
		IsPublic:  false,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
	}
	if overrides != nil {
		overrides(&repo)
	}
	return repo
}

func labelTestUser(id int64) *db.User {
	return &db.User{ID: id, Username: "alice", LowerUsername: "alice"}
}

func ptrStringLabel(v string) *string { return &v }

func labelAPIStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	return apiErr.Status
}

func TestLabelService_CreateLabel_ValidatesColorAndAuth(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		actor      *db.User
		input      CreateLabelInput
		expectCode int
	}{
		{
			name:       "requires auth",
			actor:      nil,
			input:      CreateLabelInput{Name: "bug", Color: "#d73a4a"},
			expectCode: 401,
		},
		{
			name:       "invalid color",
			actor:      labelTestUser(1),
			input:      CreateLabelInput{Name: "bug", Color: "not-a-color"},
			expectCode: 422,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			q := &mockLabelQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return labelTestRepo(nil), nil
				},
			}
			svc := NewLabelService(q)
			_, err := svc.CreateLabel(context.Background(), tc.actor, "alice", "demo", tc.input)
			assert.Equal(t, tc.expectCode, labelAPIStatus(t, err))
		})
	}

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
	}
	svc := NewLabelService(q)
	created, err := svc.CreateLabel(context.Background(), labelTestUser(1), "alice", "demo", CreateLabelInput{
		Name:        "bug",
		Color:       "D73A4A",
		Description: "desc",
	})
	require.NoError(t, err)
	assert.Equal(t, "#d73a4a", created.Color)
	assert.Equal(t, "#d73a4a", q.lastCreateLabelArg.Color)
}

func TestLabelService_CreateLabel_DuplicateConflict(t *testing.T) {
	t.Parallel()

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		createLabelFn: func(ctx context.Context, arg db.CreateLabelParams) (db.Label, error) {
			return db.Label{}, &pgconn.PgError{Code: "23505"}
		},
	}
	svc := NewLabelService(q)

	_, err := svc.CreateLabel(context.Background(), labelTestUser(1), "alice", "demo", CreateLabelInput{Name: "bug", Color: "#d73a4a"})
	assert.Equal(t, 409, labelAPIStatus(t, err))
}

func TestLabelService_CreateLabel_CollaboratorWriteAllowed(t *testing.T) {
	t.Parallel()

	actor := labelTestUser(44)
	repo := labelTestRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.OrgID = pgtype.Int8{}
	})

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getCollaboratorPermissionForRepo: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Equal(t, actor.ID, arg.UserID.Int64)
			return "write", nil
		},
	}
	svc := NewLabelService(q)

	created, err := svc.CreateLabel(context.Background(), actor, "owner", "demo", CreateLabelInput{
		Name:  "bug",
		Color: "#d73a4a",
	})
	require.NoError(t, err)
	assert.Equal(t, "bug", created.Name)
}

func TestLabelService_ListLabels_PaginationAndReadAccess(t *testing.T) {
	t.Parallel()

	privateRepo := labelTestRepo(func(repo *db.Repository) {
		repo.UserID = pgtype.Int8{}
		repo.OrgID = pgtype.Int8{Int64: 7, Valid: true}
	})

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
		countLabelsByRepoFn: func(ctx context.Context, repositoryID int64) (int64, error) {
			return 11, nil
		},
		listLabelsByRepoFn: func(ctx context.Context, arg db.ListLabelsByRepoParams) ([]db.Label, error) {
			return []db.Label{{ID: 1, Name: "bug", Color: "#d73a4a"}}, nil
		},
		getHighestTeamPermissionForRepoFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
	}
	svc := NewLabelService(q)

	_, _, err := svc.ListLabels(context.Background(), nil, "alice", "demo", 1, 10)
	assert.Equal(t, 403, labelAPIStatus(t, err))

	items, total, err := svc.ListLabels(context.Background(), labelTestUser(2), "alice", "demo", 2, 5)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, int64(11), total)
	assert.Equal(t, int32(5), q.lastListLabelsByRepoArg.PageSize)
	assert.Equal(t, int32(5), q.lastListLabelsByRepoArg.PageOffset)
}

func TestLabelService_GetLabel(t *testing.T) {
	t.Parallel()

	privateRepo := labelTestRepo(func(repo *db.Repository) {
		repo.IsPublic = false
		repo.UserID = pgtype.Int8{}
		repo.OrgID = pgtype.Int8{Int64: 9, Valid: true}
	})
	viewer := labelTestUser(2)
	queried := false

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
		getHighestTeamPermissionForRepoFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
		getLabelByIDFn: func(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error) {
			queried = true
			assert.Equal(t, privateRepo.ID, arg.RepositoryID)
			assert.Equal(t, int64(15), arg.ID)
			return db.Label{ID: 15, RepositoryID: arg.RepositoryID, Name: "bug", Color: "#d73a4a"}, nil
		},
	}
	svc := NewLabelService(q)

	label, err := svc.GetLabel(context.Background(), viewer, "alice", "demo", 15)
	require.NoError(t, err)
	assert.True(t, queried)
	assert.Equal(t, int64(15), label.ID)
	assert.Equal(t, "bug", label.Name)

	_, err = svc.GetLabel(context.Background(), viewer, "alice", "demo", 0)
	assert.Equal(t, 400, labelAPIStatus(t, err))
}

func TestLabelService_UpdateLabel_PartialPatch(t *testing.T) {
	t.Parallel()

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		getLabelByIDFn: func(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{ID: arg.ID, RepositoryID: arg.RepositoryID, Name: "bug", Color: "#d73a4a", Description: "old"}, nil
		},
	}
	svc := NewLabelService(q)

	updated, err := svc.UpdateLabel(context.Background(), labelTestUser(1), "alice", "demo", 99, UpdateLabelInput{Color: ptrStringLabel("abc123")})
	require.NoError(t, err)
	assert.Equal(t, "bug", q.lastUpdateLabelArg.Name)
	assert.Equal(t, "old", q.lastUpdateLabelArg.Description)
	assert.Equal(t, "#abc123", q.lastUpdateLabelArg.Color)
	assert.Equal(t, "#abc123", updated.Color)
}

func TestLabelService_DeleteLabel_SuccessAndErrors(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		deleted := false
		q := &mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return labelTestRepo(nil), nil
			},
			getLabelByIDFn: func(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error) {
				assert.Equal(t, int64(77), arg.ID)
				return db.Label{ID: arg.ID, RepositoryID: arg.RepositoryID, Name: "bug"}, nil
			},
			deleteLabelFn: func(ctx context.Context, arg db.DeleteLabelParams) error {
				assert.Equal(t, int64(77), arg.ID)
				deleted = true
				return nil
			},
		}
		svc := NewLabelService(q)

		err := svc.DeleteLabel(context.Background(), labelTestUser(1), "alice", "demo", 77)
		require.NoError(t, err)
		assert.True(t, deleted)
	})

	t.Run("not found", func(t *testing.T) {
		q := &mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return labelTestRepo(nil), nil
			},
			getLabelByIDFn: func(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error) {
				return db.Label{}, pgx.ErrNoRows
			},
		}
		svc := NewLabelService(q)

		err := svc.DeleteLabel(context.Background(), labelTestUser(1), "alice", "demo", 77)
		assert.Equal(t, 404, labelAPIStatus(t, err))
	})

	t.Run("delete failure", func(t *testing.T) {
		q := &mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return labelTestRepo(nil), nil
			},
			getLabelByIDFn: func(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error) {
				return db.Label{ID: arg.ID, RepositoryID: arg.RepositoryID, Name: "bug"}, nil
			},
			deleteLabelFn: func(ctx context.Context, arg db.DeleteLabelParams) error {
				return assert.AnError
			},
		}
		svc := NewLabelService(q)

		err := svc.DeleteLabel(context.Background(), labelTestUser(1), "alice", "demo", 77)
		assert.Equal(t, 500, labelAPIStatus(t, err))
	})
}

func TestLabelService_AddLabelsToIssue_Errors(t *testing.T) {
	t.Parallel()

	t.Run("unknown label", func(t *testing.T) {
		q := &mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return labelTestRepo(nil), nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return db.Issue{ID: 10, Number: 3, RepositoryID: arg.RepositoryID}, nil
			},
			listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
				return []db.Label{}, nil
			},
		}
		svc := NewLabelService(q)
		_, err := svc.AddLabelsToIssue(context.Background(), labelTestUser(1), "alice", "demo", 3, []string{"missing"})
		assert.Equal(t, 404, labelAPIStatus(t, err))
	})

	t.Run("duplicate issue label conflict", func(t *testing.T) {
		q := &mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return labelTestRepo(nil), nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return db.Issue{ID: 10, Number: 3, RepositoryID: arg.RepositoryID}, nil
			},
			listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
				return []db.Label{{ID: 7, RepositoryID: arg.RepositoryID, Name: "bug"}}, nil
			},
			addIssueLabelsFn: func(ctx context.Context, arg db.AddIssueLabelsParams) error {
				return &pgconn.PgError{Code: "23505"}
			},
		}
		svc := NewLabelService(q)
		_, err := svc.AddLabelsToIssue(context.Background(), labelTestUser(1), "alice", "demo", 3, []string{"bug"})
		assert.Equal(t, 409, labelAPIStatus(t, err))
	})
}

func TestLabelService_AddLabelsToIssue_UsesBulkFlowAndReturnsAllLabels(t *testing.T) {
	t.Parallel()

	getLabelByNameCalls := 0
	addIssueLabelCalls := 0

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 44, Number: arg.Number, RepositoryID: arg.RepositoryID}, nil
		},
		getLabelByNameFn: func(ctx context.Context, arg db.GetLabelByNameParams) (db.Label, error) {
			getLabelByNameCalls++
			return db.Label{ID: 7, RepositoryID: arg.RepositoryID, Name: arg.Name}, nil
		},
		addIssueLabelFn: func(ctx context.Context, arg db.AddIssueLabelParams) (db.IssueLabel, error) {
			addIssueLabelCalls++
			return db.IssueLabel{IssueID: arg.IssueID, LabelID: arg.LabelID}, nil
		},
		listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
			return []db.Label{
				{ID: 7, RepositoryID: arg.RepositoryID, Name: "bug"},
				{ID: 8, RepositoryID: arg.RepositoryID, Name: "docs"},
			}, nil
		},
		addIssueLabelsFn: func(ctx context.Context, arg db.AddIssueLabelsParams) error {
			assert.Equal(t, int64(44), arg.IssueID)
			assert.Equal(t, []int64{7, 8}, arg.LabelIds)
			return nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 101, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			all := make([]db.Label, 0, 101)
			for i := 1; i <= 101; i++ {
				all = append(all, db.Label{ID: int64(i), Name: "label"})
			}
			start := int(arg.PageOffset)
			if start >= len(all) {
				return []db.Label{}, nil
			}
			end := start + int(arg.PageSize)
			if end > len(all) {
				end = len(all)
			}
			return all[start:end], nil
		},
	}

	svc := NewLabelService(q)
	labels, err := svc.AddLabelsToIssue(context.Background(), labelTestUser(1), "alice", "demo", 44, []string{"bug", "docs"})
	require.NoError(t, err)
	assert.Len(t, labels, 101)
	assert.Equal(t, 0, getLabelByNameCalls)
	assert.Equal(t, 0, addIssueLabelCalls)
}

func TestLabelService_AddLabelsToIssue_DispatchesWorkflowRun(t *testing.T) {
	t.Parallel()

	repo := labelTestRepo(nil)
	actor := labelTestUser(1)
	wfRunSvc := &mockIssueWorkflowRunService{}
	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 44, Number: arg.Number, RepositoryID: arg.RepositoryID, Title: "triage", Body: "body", State: "open", AuthorID: actor.ID}, nil
		},
		listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: arg.RepositoryID, Name: "bug", Color: "#d73a4a"}}, nil
		},
		addIssueLabelsFn: func(ctx context.Context, arg db.AddIssueLabelsParams) error {
			return nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 1, nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return []db.ListIssueAssigneesRow{{ID: 9, Username: "bob"}}, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a"}}, nil
		},
	}

	svc := NewLabelService(q, WithLabelWorkflowRunService(wfRunSvc))
	labels, err := svc.AddLabelsToIssue(context.Background(), actor, "alice", "demo", 44, []string{"bug"})
	require.NoError(t, err)
	require.Len(t, labels, 1)

	require.Len(t, wfRunSvc.dispatchCalls, 1)
	call := wfRunSvc.dispatchCalls[0]
	assert.Equal(t, repo.ID, call.RepositoryID)
	assert.Equal(t, "issues", call.Event.Type)
	assert.Equal(t, "labeled", call.Event.Action)

	issueInput, ok := call.Event.Inputs["issue"].(webhooks.IssuePayload)
	require.True(t, ok)
	assert.Equal(t, "u-1", issueInput.Author.Login)
	require.Len(t, issueInput.Assignees, 1)
	assert.Equal(t, "bob", issueInput.Assignees[0].Login)
	require.Len(t, issueInput.Labels, 1)
	assert.Equal(t, "bug", issueInput.Labels[0].Name)
}

func TestLabelService_AddLabelsToIssue_WorkflowDispatchErrorIsNonFatal(t *testing.T) {
	t.Parallel()

	repo := labelTestRepo(nil)
	actor := labelTestUser(1)
	wfRunSvc := &mockIssueWorkflowRunService{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, fmt.Errorf("workflow dispatch failed")
		},
	}
	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 44, Number: arg.Number, RepositoryID: arg.RepositoryID, Title: "triage", Body: "body", State: "open", AuthorID: actor.ID}, nil
		},
		listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: arg.RepositoryID, Name: "bug", Color: "#d73a4a"}}, nil
		},
		addIssueLabelsFn: func(ctx context.Context, arg db.AddIssueLabelsParams) error {
			return nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 1, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a"}}, nil
		},
	}

	svc := NewLabelService(q, WithLabelWorkflowRunService(wfRunSvc))
	labels, err := svc.AddLabelsToIssue(context.Background(), actor, "alice", "demo", 44, []string{"bug"})
	require.NoError(t, err)
	require.Len(t, labels, 1)
}

func TestLabelService_RemoveIssueLabelByName_NotFound(t *testing.T) {
	t.Parallel()

	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		removeIssueLabelByNameFn: func(ctx context.Context, arg db.RemoveIssueLabelByNameParams) (int64, error) {
			assert.Equal(t, int64(4), arg.IssueNumber)
			assert.Equal(t, "bug", arg.LabelName)
			return 0, nil
		},
	}
	svc := NewLabelService(q)

	err := svc.RemoveIssueLabelByName(context.Background(), labelTestUser(1), "alice", "demo", 4, "bug")
	assert.Equal(t, 404, labelAPIStatus(t, err))
}

func TestLabelService_RemoveIssueLabelByName_DispatchesWorkflowRun(t *testing.T) {
	t.Parallel()

	repo := labelTestRepo(nil)
	actor := labelTestUser(1)
	wfRunSvc := &mockIssueWorkflowRunService{}
	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 44, Number: arg.Number, RepositoryID: arg.RepositoryID, Title: "triage", Body: "body", State: "open", AuthorID: actor.ID}, nil
		},
		removeIssueLabelByNameFn: func(ctx context.Context, arg db.RemoveIssueLabelByNameParams) (int64, error) {
			return 1, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 0, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{}, nil
		},
	}

	svc := NewLabelService(q, WithLabelWorkflowRunService(wfRunSvc))
	err := svc.RemoveIssueLabelByName(context.Background(), actor, "alice", "demo", 44, "bug")
	require.NoError(t, err)

	require.Len(t, wfRunSvc.dispatchCalls, 1)
	assert.Equal(t, "issues", wfRunSvc.dispatchCalls[0].Event.Type)
	assert.Equal(t, "unlabeled", wfRunSvc.dispatchCalls[0].Event.Action)
}

func TestLabelService_ListIssueLabels_Pagination(t *testing.T) {
	t.Parallel()

	privateRepo := labelTestRepo(func(repo *db.Repository) {
		repo.UserID = pgtype.Int8{}
		repo.OrgID = pgtype.Int8{Int64: 9, Valid: true}
	})
	q := &mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 88, Number: arg.Number, RepositoryID: arg.RepositoryID}, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 4, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{{ID: 1, Name: "bug", Color: "#d73a4a"}}, nil
		},
		getHighestTeamPermissionForRepoFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "write", nil
		},
	}

	svc := NewLabelService(q)
	labels, total, err := svc.ListIssueLabels(context.Background(), labelTestUser(3), "alice", "demo", 88, 3, 2)
	require.NoError(t, err)
	require.Len(t, labels, 1)
	assert.Equal(t, int64(4), total)
	assert.Equal(t, int32(2), q.lastListLabelsForIssueArg.PageSize)
	assert.Equal(t, int32(4), q.lastListLabelsForIssueArg.PageOffset)
}
