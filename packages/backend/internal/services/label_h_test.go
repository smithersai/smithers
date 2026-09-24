package services

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type labelHQuerier struct {
	*mockLabelQuerier
	getUserByIDFn func(context.Context, int64) (db.User, error)
}

func (q *labelHQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if q.getUserByIDFn != nil {
		return q.getUserByIDFn(ctx, id)
	}
	return q.mockLabelQuerier.GetUserByID(ctx, id)
}

func labelHPrivateRepoFor(userID int64) db.Repository {
	repo := labelTestRepo(nil)
	repo.UserID = pgtype.Int8{Int64: userID, Valid: true}
	repo.OrgID = pgtype.Int8{}
	repo.IsPublic = false
	return repo
}

func TestLabel_H_CreateListGetUpdateDeleteErrors(t *testing.T) {
	ctx := context.Background()
	actor := labelTestUser(1)

	_, err := NewLabelService(&mockLabelQuerier{}).CreateLabel(ctx, actor, "alice", "demo", CreateLabelInput{Name: "", Color: "#d73a4a"})
	require.Equal(t, 422, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{}).CreateLabel(ctx, actor, "alice", "demo", CreateLabelInput{Name: "bug", Color: "#d73a4a"})
	require.Equal(t, 404, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return labelHPrivateRepoFor(2), nil
	}}).CreateLabel(ctx, actor, "alice", "demo", CreateLabelInput{Name: "bug", Color: "#d73a4a"})
	require.Equal(t, 403, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return labelTestRepo(nil), nil
	}}).CreateLabel(ctx, actor, "alice", "demo", CreateLabelInput{Name: "bug", Color: "#d73a4a", Description: "bad\x00text"})
	require.Equal(t, 422, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		createLabelFn: func(context.Context, db.CreateLabelParams) (db.Label, error) { return db.Label{}, assert.AnError },
	}).CreateLabel(ctx, actor, "alice", "demo", CreateLabelInput{Name: "bug", Color: "#d73a4a"})
	require.Equal(t, 500, labelAPIStatus(t, err))

	_, _, err = NewLabelService(&mockLabelQuerier{}).ListLabels(ctx, actor, "alice", "demo", 1, 10)
	require.Equal(t, 404, labelAPIStatus(t, err))

	_, _, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		countLabelsByRepoFn: func(context.Context, int64) (int64, error) { return 0, assert.AnError },
	}).ListLabels(ctx, actor, "alice", "demo", 1, 10)
	require.Equal(t, 500, labelAPIStatus(t, err))

	_, _, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		listLabelsByRepoFn: func(context.Context, db.ListLabelsByRepoParams) ([]db.Label, error) { return nil, assert.AnError },
	}).ListLabels(ctx, actor, "alice", "demo", 1, 10)
	require.Equal(t, 500, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{}).GetLabel(ctx, actor, "alice", "demo", 1)
	require.Equal(t, 404, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) { return db.Label{}, assert.AnError },
	}).GetLabel(ctx, actor, "alice", "demo", 1)
	require.Equal(t, 500, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{}).UpdateLabel(ctx, nil, "alice", "demo", 1, UpdateLabelInput{})
	require.Equal(t, 401, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{}).UpdateLabel(ctx, actor, "alice", "demo", 1, UpdateLabelInput{})
	require.Equal(t, 404, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelHPrivateRepoFor(2), nil
		},
	}).UpdateLabel(ctx, actor, "alice", "demo", 1, UpdateLabelInput{})
	require.Equal(t, 403, labelAPIStatus(t, err))

	for _, tc := range []struct {
		name string
		q    *mockLabelQuerier
		req  UpdateLabelInput
		want int
	}{
		{"load missing", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) { return db.Label{}, pgx.ErrNoRows }}, UpdateLabelInput{}, 404},
		{"load internal", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) { return db.Label{}, assert.AnError }}, UpdateLabelInput{}, 500},
		{"bad name", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{ID: 1, Name: "bug", Color: "#d73a4a"}, nil
		}}, UpdateLabelInput{Name: ptrStringLabel(strings.Repeat("x", 256))}, 422},
		{"bad color", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{ID: 1, Name: "bug", Color: "#d73a4a"}, nil
		}}, UpdateLabelInput{Color: ptrStringLabel("bad")}, 422},
		{"bad description", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{ID: 1, Name: "bug", Color: "#d73a4a"}, nil
		}}, UpdateLabelInput{Description: ptrStringLabel("bad\x00text")}, 422},
		{"update missing", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{ID: 1, Name: "bug", Color: "#d73a4a"}, nil
		}, updateLabelFn: func(context.Context, db.UpdateLabelParams) (db.Label, error) { return db.Label{}, pgx.ErrNoRows }}, UpdateLabelInput{}, 404},
		{"update conflict", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{ID: 1, Name: "bug", Color: "#d73a4a"}, nil
		}, updateLabelFn: func(context.Context, db.UpdateLabelParams) (db.Label, error) {
			return db.Label{}, &pgconn.PgError{Code: "23505"}
		}}, UpdateLabelInput{}, 409},
		{"update internal", &mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		}, getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{ID: 1, Name: "bug", Color: "#d73a4a"}, nil
		}, updateLabelFn: func(context.Context, db.UpdateLabelParams) (db.Label, error) { return db.Label{}, assert.AnError }}, UpdateLabelInput{}, 500},
	} {
		t.Run("update "+tc.name, func(t *testing.T) {
			_, err := NewLabelService(tc.q).UpdateLabel(ctx, actor, "alice", "demo", 1, tc.req)
			require.Equal(t, tc.want, labelAPIStatus(t, err))
		})
	}

	err = NewLabelService(&mockLabelQuerier{}).DeleteLabel(ctx, nil, "alice", "demo", 1)
	require.Equal(t, 401, labelAPIStatus(t, err))

	err = NewLabelService(&mockLabelQuerier{}).DeleteLabel(ctx, actor, "alice", "demo", 1)
	require.Equal(t, 404, labelAPIStatus(t, err))

	err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelHPrivateRepoFor(2), nil
		},
	}).DeleteLabel(ctx, actor, "alice", "demo", 1)
	require.Equal(t, 403, labelAPIStatus(t, err))

	err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) { return db.Label{}, assert.AnError },
	}).DeleteLabel(ctx, actor, "alice", "demo", 1)
	require.Equal(t, 500, labelAPIStatus(t, err))
}

func TestLabel_H_IssueLabelErrorBranches(t *testing.T) {
	ctx := context.Background()
	actor := labelTestUser(1)

	_, err := NewLabelService(&mockLabelQuerier{}).AddLabelsToIssue(ctx, nil, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 401, labelAPIStatus(t, err))
	_, err = NewLabelService(&mockLabelQuerier{}).AddLabelsToIssue(ctx, actor, "alice", "demo", 0, []string{"bug"})
	require.Equal(t, 400, labelAPIStatus(t, err))
	_, err = NewLabelService(&mockLabelQuerier{}).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, nil)
	require.Equal(t, 422, labelAPIStatus(t, err))
	_, err = NewLabelService(&mockLabelQuerier{}).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{" "})
	require.Equal(t, 422, labelAPIStatus(t, err))

	baseQ := func() *mockLabelQuerier {
		return &mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return labelTestRepo(nil), nil
			},
			getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
				return db.Issue{ID: 10, Number: 1}, nil
			},
			listLabelsByNamesFn: func(context.Context, db.ListLabelsByNamesParams) ([]db.Label, error) {
				return []db.Label{{ID: 7, Name: "bug"}}, nil
			},
			countLabelsForIssueFn: func(context.Context, int64) (int64, error) { return 1, nil },
			listLabelsForIssueFn: func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) {
				return []db.Label{{ID: 7, Name: "bug"}}, nil
			},
		}
	}

	_, err = NewLabelService(&mockLabelQuerier{}).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 404, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return labelHPrivateRepoFor(2), nil
	}}).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 403, labelAPIStatus(t, err))

	q := baseQ()
	q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) { return db.Issue{}, pgx.ErrNoRows }
	_, err = NewLabelService(q).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 404, labelAPIStatus(t, err))

	q = baseQ()
	q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) { return db.Issue{}, assert.AnError }
	_, err = NewLabelService(q).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 500, labelAPIStatus(t, err))

	q = baseQ()
	q.listLabelsByNamesFn = func(context.Context, db.ListLabelsByNamesParams) ([]db.Label, error) { return nil, assert.AnError }
	_, err = NewLabelService(q).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 500, labelAPIStatus(t, err))

	q = baseQ()
	q.addIssueLabelsFn = func(context.Context, db.AddIssueLabelsParams) error { return assert.AnError }
	_, err = NewLabelService(q).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 500, labelAPIStatus(t, err))

	q = baseQ()
	q.countLabelsForIssueFn = func(context.Context, int64) (int64, error) { return 0, assert.AnError }
	_, err = NewLabelService(q).AddLabelsToIssue(ctx, actor, "alice", "demo", 1, []string{"bug"})
	require.Equal(t, 500, labelAPIStatus(t, err))

	_, _, err = NewLabelService(&mockLabelQuerier{}).ListIssueLabels(ctx, actor, "alice", "demo", 0, 1, 10)
	require.Equal(t, 400, labelAPIStatus(t, err))
	_, _, err = NewLabelService(&mockLabelQuerier{}).ListIssueLabels(ctx, actor, "alice", "demo", 1, 1, 10)
	require.Equal(t, 404, labelAPIStatus(t, err))

	q = baseQ()
	q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) { return db.Issue{}, assert.AnError }
	_, _, err = NewLabelService(q).ListIssueLabels(ctx, actor, "alice", "demo", 1, 1, 10)
	require.Equal(t, 500, labelAPIStatus(t, err))

	q = baseQ()
	q.countLabelsForIssueFn = func(context.Context, int64) (int64, error) { return 0, assert.AnError }
	_, _, err = NewLabelService(q).ListIssueLabels(ctx, actor, "alice", "demo", 1, 1, 10)
	require.Equal(t, 500, labelAPIStatus(t, err))

	q = baseQ()
	q.listLabelsForIssueFn = func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) { return nil, assert.AnError }
	_, _, err = NewLabelService(q).ListIssueLabels(ctx, actor, "alice", "demo", 1, 1, 10)
	require.Equal(t, 500, labelAPIStatus(t, err))
}

func TestLabel_H_RemoveIssueLabelAndDispatchBranches(t *testing.T) {
	ctx := context.Background()
	actor := labelTestUser(1)

	err := NewLabelService(&mockLabelQuerier{}).RemoveIssueLabelByName(ctx, nil, "alice", "demo", 1, "bug")
	require.Equal(t, 401, labelAPIStatus(t, err))
	err = NewLabelService(&mockLabelQuerier{}).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 0, "bug")
	require.Equal(t, 400, labelAPIStatus(t, err))
	err = NewLabelService(&mockLabelQuerier{}).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, " ")
	require.Equal(t, 400, labelAPIStatus(t, err))
	err = NewLabelService(&mockLabelQuerier{}).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.Equal(t, 404, labelAPIStatus(t, err))
	err = NewLabelService(&mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return labelHPrivateRepoFor(2), nil
	}}).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.Equal(t, 403, labelAPIStatus(t, err))

	baseQ := func() *mockLabelQuerier {
		return &mockLabelQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return labelTestRepo(nil), nil
			},
			getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
				return db.Issue{ID: 10, Number: 1, AuthorID: 99}, nil
			},
			removeIssueLabelByNameFn: func(context.Context, db.RemoveIssueLabelByNameParams) (int64, error) { return 1, nil },
			countLabelsForIssueFn:    func(context.Context, int64) (int64, error) { return 0, nil },
			listLabelsForIssueFn:     func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) { return nil, nil },
		}
	}

	q := baseQ()
	q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) { return db.Issue{}, pgx.ErrNoRows }
	err = NewLabelService(q).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.Equal(t, 404, labelAPIStatus(t, err))

	q = baseQ()
	q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) { return db.Issue{}, assert.AnError }
	err = NewLabelService(q).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.Equal(t, 500, labelAPIStatus(t, err))

	q = baseQ()
	q.removeIssueLabelByNameFn = func(context.Context, db.RemoveIssueLabelByNameParams) (int64, error) { return 0, assert.AnError }
	err = NewLabelService(q).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.Equal(t, 500, labelAPIStatus(t, err))

	q = baseQ()
	q.countLabelsForIssueFn = func(context.Context, int64) (int64, error) { return 0, assert.AnError }
	err = NewLabelService(q).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.Equal(t, 500, labelAPIStatus(t, err))

	wf := &mockIssueWorkflowRunService{}
	err = NewLabelService(&labelHQuerier{
		mockLabelQuerier: baseQ(),
		getUserByIDFn:    func(context.Context, int64) (db.User, error) { return db.User{}, assert.AnError },
	}, WithLabelWorkflowRunService(wf)).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.NoError(t, err)
	require.Len(t, wf.dispatchCalls, 1)

	q = baseQ()
	q.listIssueAssigneesFn = func(context.Context, int64) ([]db.ListIssueAssigneesRow, error) { return nil, assert.AnError }
	err = NewLabelService(q, WithLabelWorkflowRunService(&mockIssueWorkflowRunService{})).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.NoError(t, err)
}

func TestLabel_H_HelperBranches(t *testing.T) {
	ctx := context.Background()
	svc := NewLabelService(&mockLabelQuerier{})

	_, err := validateLabelName("bad\x00name")
	require.Equal(t, 422, labelAPIStatus(t, err))

	_, err = svc.resolveRepoByOwnerAndName(ctx, "", "repo")
	require.Equal(t, 400, labelAPIStatus(t, err))
	_, err = svc.resolveRepoByOwnerAndName(ctx, "owner", "")
	require.Equal(t, 400, labelAPIStatus(t, err))
	_, err = NewLabelService(&mockLabelQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return db.Repository{}, assert.AnError
	}}).resolveRepoByOwnerAndName(ctx, "owner", "repo")
	require.Equal(t, 500, labelAPIStatus(t, err))

	privateRepo := labelHPrivateRepoFor(2)
	err = NewLabelService(&mockLabelQuerier{getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "", assert.AnError
	}}).requireReadAccess(ctx, privateRepo, labelTestUser(1))
	require.Equal(t, 500, labelAPIStatus(t, err))

	err = NewLabelService(&mockLabelQuerier{}).requireWriteAccess(ctx, privateRepo, nil)
	require.Equal(t, 401, labelAPIStatus(t, err))
	err = NewLabelService(&mockLabelQuerier{getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "", assert.AnError
	}}).requireWriteAccess(ctx, privateRepo, labelTestUser(1))
	require.Equal(t, 500, labelAPIStatus(t, err))
}
