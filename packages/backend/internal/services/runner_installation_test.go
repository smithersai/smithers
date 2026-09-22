package services

import "context"

type mockRunnerInstallationResolver struct {
	resolveFn func(ctx context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error)
}

func (m *mockRunnerInstallationResolver) GetGitHubInstallationIDForRepositoryOwner(ctx context.Context, ownerUserID int64, ownerOrgID int64, owner, repo string) (int64, error) {
	if m.resolveFn != nil {
		return m.resolveFn(ctx, ownerUserID, ownerOrgID, owner, repo)
	}
	return 0, nil
}
