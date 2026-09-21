package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type variableCovQuerier struct {
	*mockVariableQuerier

	createOrgVariableFn func(ctx context.Context, arg db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error)
	listOrgVariablesFn  func(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error)
	deleteOrgVariableFn func(ctx context.Context, arg db.DeleteOrgVariableParams) error
}

func (q *variableCovQuerier) CreateOrUpdateOrgVariable(ctx context.Context, arg db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error) {
	if q.createOrgVariableFn != nil {
		return q.createOrgVariableFn(ctx, arg)
	}
	now := time.Now().UTC().Truncate(time.Second)
	return db.OrganizationVariable{OrganizationID: arg.OrganizationID, Name: arg.Name, Value: arg.Value, CreatedAt: now, UpdatedAt: now}, nil
}

func (q *variableCovQuerier) ListOrgVariables(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error) {
	if q.listOrgVariablesFn != nil {
		return q.listOrgVariablesFn(ctx, organizationID)
	}
	return nil, nil
}

func (q *variableCovQuerier) DeleteOrgVariable(ctx context.Context, arg db.DeleteOrgVariableParams) error {
	if q.deleteOrgVariableFn != nil {
		return q.deleteOrgVariableFn(ctx, arg)
	}
	return nil
}

func TestVariable_Cov_OrganizationVariables(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7, Username: "owner"}

	t.Run("sets lists and deletes org variables", func(t *testing.T) {
		now := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
		var created db.CreateOrUpdateOrgVariableParams
		var deleted db.DeleteOrgVariableParams
		q := &variableCovQuerier{
			mockVariableQuerier: &mockVariableQuerier{
				getOrgFn: func(_ context.Context, lowerName string) (db.Organization, error) {
					require.Equal(t, "acme", lowerName)
					return db.Organization{ID: 44, Name: "Acme", LowerName: lowerName}, nil
				},
				getOrgMemberFn: func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
					require.Equal(t, int64(44), arg.OrganizationID)
					require.Equal(t, actor.ID, arg.UserID)
					return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: " owner "}, nil
				},
			},
			createOrgVariableFn: func(_ context.Context, arg db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error) {
				created = arg
				return db.OrganizationVariable{OrganizationID: arg.OrganizationID, Name: arg.Name, Value: arg.Value, CreatedAt: now, UpdatedAt: now.Add(time.Hour)}, nil
			},
			listOrgVariablesFn: func(_ context.Context, organizationID int64) ([]db.OrganizationVariable, error) {
				require.Equal(t, int64(44), organizationID)
				return []db.OrganizationVariable{
					{OrganizationID: organizationID, Name: "REGION", Value: "iad", CreatedAt: now, UpdatedAt: now},
					{OrganizationID: organizationID, Name: "TIER", Value: "prod", CreatedAt: now, UpdatedAt: now.Add(time.Minute)},
				}, nil
			},
			deleteOrgVariableFn: func(_ context.Context, arg db.DeleteOrgVariableParams) error {
				deleted = arg
				return nil
			},
		}
		svc := NewVariableService(q)

		resp, err := svc.SetOrgVariable(ctx, actor, " Acme ", " API_URL ", "https://api.example")
		require.NoError(t, err)
		assert.Equal(t, db.CreateOrUpdateOrgVariableParams{OrganizationID: 44, Name: "API_URL", Value: "https://api.example"}, created)
		assert.Equal(t, "API_URL", resp.Name)
		assert.Equal(t, "2026-07-06T12:00:00Z", resp.CreatedAt)

		listed, err := svc.ListOrgVariables(ctx, actor, "ACME")
		require.NoError(t, err)
		require.Len(t, listed, 2)
		assert.Equal(t, "REGION", listed[0].Name)
		assert.Equal(t, "prod", listed[1].Value)

		require.NoError(t, svc.DeleteOrgVariable(ctx, actor, "acme", " TIER "))
		assert.Equal(t, db.DeleteOrgVariableParams{OrganizationID: 44, Name: "TIER"}, deleted)
	})

	t.Run("admin bypasses org membership lookup", func(t *testing.T) {
		memberLookupCalled := false
		q := &variableCovQuerier{
			mockVariableQuerier: &mockVariableQuerier{
				getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
					memberLookupCalled = true
					return db.OrgMember{}, nil
				},
			},
		}
		svc := NewVariableService(q)

		_, err := svc.SetOrgVariable(ctx, &db.User{ID: 1, IsAdmin: true}, "acme", "TOKEN", "secret")
		require.NoError(t, err)
		assert.False(t, memberLookupCalled)
	})

	t.Run("maps org access and storage errors", func(t *testing.T) {
		svc := NewVariableService(&variableCovQuerier{mockVariableQuerier: &mockVariableQuerier{}})
		_, err := svc.SetOrgVariable(ctx, nil, "acme", "TOKEN", "secret")
		assert.Equal(t, 401, apiStatus(t, err))

		err = svc.DeleteOrgVariable(ctx, nil, "acme", "TOKEN")
		assert.Equal(t, 401, apiStatus(t, err))

		svc = NewVariableService(&variableCovQuerier{mockVariableQuerier: &mockVariableQuerier{
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{Role: "member"}, nil
			},
		}})
		_, err = svc.ListOrgVariables(ctx, actor, "acme")
		assert.Equal(t, 403, apiStatus(t, err))

		svc = NewVariableService(&variableCovQuerier{mockVariableQuerier: &mockVariableQuerier{
			getOrgFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{}, pgx.ErrNoRows
			},
		}})
		_, err = svc.SetOrgVariable(ctx, actor, "missing", "TOKEN", "secret")
		assert.Equal(t, 404, apiStatus(t, err))

		svc = NewVariableService(&variableCovQuerier{
			mockVariableQuerier: &mockVariableQuerier{},
			listOrgVariablesFn: func(context.Context, int64) ([]db.OrganizationVariable, error) {
				return nil, errors.New("list failed")
			},
		})
		_, err = svc.ListOrgVariables(ctx, actor, "acme")
		assert.Equal(t, 500, apiStatus(t, err))

		svc = NewVariableService(&variableCovQuerier{
			mockVariableQuerier: &mockVariableQuerier{},
			deleteOrgVariableFn: func(context.Context, db.DeleteOrgVariableParams) error {
				return errors.New("delete failed")
			},
		})
		err = svc.DeleteOrgVariable(ctx, actor, "acme", "TOKEN")
		assert.Equal(t, 500, apiStatus(t, err))
	})
}

func TestVariable_Cov_RepoVariablePermissionsAndErrors(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7, Username: "alice"}

	t.Run("lists private org repo variables with team read access", func(t *testing.T) {
		now := time.Date(2026, 7, 6, 13, 0, 0, 0, time.UTC)
		q := &mockVariableQuerier{
			getRepoFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				assert.Equal(t, "acme", arg.Owner)
				assert.Equal(t, "demo", arg.LowerName)
				return db.Repository{ID: 33, Name: "demo", IsPublic: false, OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
			},
			teamPermFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
				return "read", nil
			},
			listVariablesFn: func(_ context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
				require.Equal(t, int64(33), repositoryID)
				return []db.RepositoryVariable{{RepositoryID: repositoryID, Name: "REGION", Value: "iad", CreatedAt: now, UpdatedAt: now}}, nil
			},
		}
		variables, err := NewVariableService(q).ListVariables(ctx, actor, "Acme", "Demo")
		require.NoError(t, err)
		require.Len(t, variables, 1)
		assert.Equal(t, "REGION", variables[0].Name)
		assert.Equal(t, "iad", variables[0].Value)
	})

	t.Run("collaborator write access can set a private repo variable", func(t *testing.T) {
		var created db.CreateOrUpdateVariableParams
		q := &mockVariableQuerier{
			getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 34, Name: "demo", IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
			},
			collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return "write", nil
			},
			createOrUpdateFn: func(_ context.Context, arg db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error) {
				created = arg
				now := time.Now().UTC()
				return db.RepositoryVariable{RepositoryID: arg.RepositoryID, Name: arg.Name, Value: arg.Value, CreatedAt: now, UpdatedAt: now}, nil
			},
		}

		resp, err := NewVariableService(q).SetVariable(ctx, actor, "alice", "demo", " ENV ", "prod")
		require.NoError(t, err)
		assert.Equal(t, db.CreateOrUpdateVariableParams{RepositoryID: 34, Name: "ENV", Value: "prod"}, created)
		assert.Equal(t, "ENV", resp.Name)
	})

	t.Run("permission and query failures are mapped", func(t *testing.T) {
		privateRepo := db.Repository{ID: 35, Name: "private", IsPublic: false, UserID: pgtype.Int8{Int64: 99, Valid: true}}
		svc := NewVariableService(&mockVariableQuerier{
			getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return privateRepo, nil
			},
		})
		_, err := svc.GetVariable(ctx, nil, "alice", "private", "TOKEN")
		assert.Equal(t, 403, apiStatus(t, err))

		svc = NewVariableService(&mockVariableQuerier{
			getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 36, Name: "demo", UserID: pgtype.Int8{Int64: actor.ID, Valid: true}}, nil
			},
			createOrUpdateFn: func(context.Context, db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error) {
				return db.RepositoryVariable{}, errors.New("insert failed")
			},
			deleteVariableFn: func(context.Context, db.DeleteVariableParams) error {
				return errors.New("delete failed")
			},
			getByNameFn: func(context.Context, db.GetVariableByNameParams) (db.RepositoryVariable, error) {
				return db.RepositoryVariable{}, errors.New("select failed")
			},
			listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
				return nil, errors.New("list failed")
			},
		})

		_, err = svc.SetVariable(ctx, actor, "alice", "demo", "TOKEN", "secret")
		assert.Equal(t, 500, apiStatus(t, err))
		err = svc.DeleteVariable(ctx, actor, "alice", "demo", "TOKEN")
		assert.Equal(t, 500, apiStatus(t, err))
		_, err = svc.GetVariable(ctx, actor, "alice", "demo", "TOKEN")
		assert.Equal(t, 500, apiStatus(t, err))
		_, err = svc.ListVariables(ctx, actor, "alice", "demo")
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("permission resolver propagates backing query errors", func(t *testing.T) {
		svc := NewVariableService(&mockVariableQuerier{
			getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 37, IsPublic: false, OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
			},
			isOrgOwnerFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, errors.New("permission query failed")
			},
		})
		_, err := svc.ListVariables(ctx, actor, "acme", "demo")
		assert.Equal(t, 500, apiStatus(t, err))
	})
}
