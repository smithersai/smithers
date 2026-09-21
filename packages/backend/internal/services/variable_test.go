package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockVariableQuerier struct {
	getRepoFn        func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	getOrgFn         func(ctx context.Context, lowerName string) (db.Organization, error)
	getOrgMemberFn   func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	isOrgOwnerFn     func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	teamPermFn       func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn     func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	createOrUpdateFn func(ctx context.Context, arg db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error)
	getByNameFn      func(ctx context.Context, arg db.GetVariableByNameParams) (db.RepositoryVariable, error)
	listVariablesFn  func(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error)
	deleteVariableFn func(ctx context.Context, arg db.DeleteVariableParams) error
	listOrgVarsFn    func(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error)
}

func (m *mockVariableQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, arg)
	}
	return db.Repository{ID: 1, UserID: pgtype.Int8{Int64: 1, Valid: true}, IsPublic: true}, nil
}

func (m *mockVariableQuerier) GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error) {
	if m.getOrgFn != nil {
		return m.getOrgFn(ctx, lowerName)
	}
	return db.Organization{ID: 1, Name: lowerName, LowerName: lowerName}, nil
}

func (m *mockVariableQuerier) GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	if m.getOrgMemberFn != nil {
		return m.getOrgMemberFn(ctx, arg)
	}
	return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: "owner"}, nil
}

func (m *mockVariableQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerFn != nil {
		return m.isOrgOwnerFn(ctx, arg)
	}
	return false, nil
}

func (m *mockVariableQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.teamPermFn != nil {
		return m.teamPermFn(ctx, arg)
	}
	return "", nil
}

func (m *mockVariableQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collabPermFn != nil {
		return m.collabPermFn(ctx, arg)
	}
	return "", nil
}

func (m *mockVariableQuerier) CreateOrUpdateVariable(ctx context.Context, arg db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error) {
	if m.createOrUpdateFn != nil {
		return m.createOrUpdateFn(ctx, arg)
	}
	now := time.Now()
	return db.RepositoryVariable{Name: arg.Name, Value: arg.Value, CreatedAt: now, UpdatedAt: now}, nil
}

func (m *mockVariableQuerier) GetVariableByName(ctx context.Context, arg db.GetVariableByNameParams) (db.RepositoryVariable, error) {
	if m.getByNameFn != nil {
		return m.getByNameFn(ctx, arg)
	}
	return db.RepositoryVariable{}, pgx.ErrNoRows
}

func (m *mockVariableQuerier) ListVariables(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
	if m.listVariablesFn != nil {
		return m.listVariablesFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockVariableQuerier) DeleteVariable(ctx context.Context, arg db.DeleteVariableParams) error {
	if m.deleteVariableFn != nil {
		return m.deleteVariableFn(ctx, arg)
	}
	return nil
}

func (m *mockVariableQuerier) CreateOrUpdateOrgVariable(ctx context.Context, arg db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error) {
	now := time.Now()
	return db.OrganizationVariable{Name: arg.Name, Value: arg.Value, CreatedAt: now, UpdatedAt: now}, nil
}

func (m *mockVariableQuerier) GetOrgVariableByName(ctx context.Context, arg db.GetOrgVariableByNameParams) (db.OrganizationVariable, error) {
	return db.OrganizationVariable{}, pgx.ErrNoRows
}

func (m *mockVariableQuerier) ListOrgVariables(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error) {
	if m.listOrgVarsFn != nil {
		return m.listOrgVarsFn(ctx, organizationID)
	}
	return nil, nil
}

func (m *mockVariableQuerier) DeleteOrgVariable(ctx context.Context, arg db.DeleteOrgVariableParams) error {
	return nil
}

func TestVariableService_SetVariable_NilActor(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	_, err := svc.SetVariable(context.Background(), nil, "alice", "demo", "KEY", "val")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 401, apiErr.Status)
}

func TestVariableService_SetVariable_EmptyName(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	actor := &db.User{ID: 1}
	_, err := svc.SetVariable(context.Background(), actor, "alice", "demo", "", "val")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestVariableService_SetVariable_NameTooLong(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	actor := &db.User{ID: 1}
	longName := make([]byte, 256)
	for i := range longName {
		longName[i] = 'A'
	}
	_, err := svc.SetVariable(context.Background(), actor, "alice", "demo", string(longName), "val")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestVariableService_SetVariable_Success(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	actor := &db.User{ID: 1}
	resp, err := svc.SetVariable(context.Background(), actor, "alice", "demo", "ENV", "production")
	require.NoError(t, err)
	assert.Equal(t, "ENV", resp.Name)
	assert.Equal(t, "production", resp.Value)
}

func TestVariableService_SetVariable_ValueTooLarge(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	actor := &db.User{ID: 1}
	oversized := strings.Repeat("x", maxVariableValueBytes+1)
	_, err := svc.SetVariable(context.Background(), actor, "alice", "demo", "KEY", oversized)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestVariableService_SetVariable_QuotaExceeded(t *testing.T) {
	t.Parallel()

	rows := make([]db.RepositoryVariable, maxVariablesPerRepo)
	for i := range rows {
		rows[i] = db.RepositoryVariable{Name: fmt.Sprintf("EXISTING_%d", i)}
	}
	svc := NewVariableService(&mockVariableQuerier{
		listVariablesFn: func(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
			return rows, nil
		},
	})
	actor := &db.User{ID: 1}
	_, err := svc.SetVariable(context.Background(), actor, "alice", "demo", "NEW_NAME", "val")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
}

func TestVariableService_SetVariable_QuotaAllowsUpdateOfExistingName(t *testing.T) {
	t.Parallel()

	rows := make([]db.RepositoryVariable, maxVariablesPerRepo)
	for i := range rows {
		rows[i] = db.RepositoryVariable{Name: fmt.Sprintf("EXISTING_%d", i)}
	}
	rows[0] = db.RepositoryVariable{Name: "TARGET_NAME"}
	svc := NewVariableService(&mockVariableQuerier{
		listVariablesFn: func(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
			return rows, nil
		},
	})
	actor := &db.User{ID: 1}
	resp, err := svc.SetVariable(context.Background(), actor, "alice", "demo", "TARGET_NAME", "val")
	require.NoError(t, err)
	assert.Equal(t, "TARGET_NAME", resp.Name)
}

func TestVariableService_SetOrgVariable_ValueTooLarge(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	actor := &db.User{ID: 1}
	oversized := strings.Repeat("x", maxVariableValueBytes+1)
	_, err := svc.SetOrgVariable(context.Background(), actor, "acme", "KEY", oversized)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestVariableService_SetOrgVariable_QuotaExceeded(t *testing.T) {
	t.Parallel()

	rows := make([]db.OrganizationVariable, maxVariablesPerOrg)
	for i := range rows {
		rows[i] = db.OrganizationVariable{Name: fmt.Sprintf("EXISTING_%d", i)}
	}
	svc := NewVariableService(&mockVariableQuerier{
		listOrgVarsFn: func(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error) {
			return rows, nil
		},
	})
	actor := &db.User{ID: 1}
	_, err := svc.SetOrgVariable(context.Background(), actor, "acme", "NEW_NAME", "val")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
}

func TestVariableService_GetVariable_EmptyName(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	_, err := svc.GetVariable(context.Background(), nil, "alice", "demo", "")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 400, apiErr.Status)
}

func TestVariableService_GetVariable_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{
		getByNameFn: func(ctx context.Context, arg db.GetVariableByNameParams) (db.RepositoryVariable, error) {
			return db.RepositoryVariable{}, pgx.ErrNoRows
		},
	})
	_, err := svc.GetVariable(context.Background(), nil, "alice", "demo", "MISSING")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
}

func TestVariableService_DeleteVariable_NilActor(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	err := svc.DeleteVariable(context.Background(), nil, "alice", "demo", "KEY")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 401, apiErr.Status)
}

func TestVariableService_DeleteVariable_EmptyName(t *testing.T) {
	t.Parallel()

	svc := NewVariableService(&mockVariableQuerier{})
	actor := &db.User{ID: 1}
	err := svc.DeleteVariable(context.Background(), actor, "alice", "demo", "")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 400, apiErr.Status)
}
