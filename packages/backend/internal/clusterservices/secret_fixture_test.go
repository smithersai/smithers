package clusterservices

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockSecretInjectionQuerier struct {
	getRepoFn          func(ctx context.Context, id int64) (db.Repository, error)
	listSecretValuesFn func(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error)
	listVariablesFn    func(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error)
	listOrgSecretsFn   func(ctx context.Context, organizationID int64) ([]db.ListOrgSecretValuesRow, error)
	listOrgVariablesFn func(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error)
}

func (m *mockSecretInjectionQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, id)
	}
	return db.Repository{ID: id}, nil
}

func (m *mockSecretInjectionQuerier) ListSecretValues(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
	if m.listSecretValuesFn != nil {
		return m.listSecretValuesFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockSecretInjectionQuerier) ListVariables(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
	if m.listVariablesFn != nil {
		return m.listVariablesFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockSecretInjectionQuerier) ListOrgSecretValues(ctx context.Context, organizationID int64) ([]db.ListOrgSecretValuesRow, error) {
	if m.listOrgSecretsFn != nil {
		return m.listOrgSecretsFn(ctx, organizationID)
	}
	return nil, nil
}

func (m *mockSecretInjectionQuerier) ListOrgVariables(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error) {
	if m.listOrgVariablesFn != nil {
		return m.listOrgVariablesFn(ctx, organizationID)
	}
	return nil, nil
}
