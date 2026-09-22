package hostedadapter

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// PrivateRollout binds the legacy hosted rollout controls to the deployment
// database. The caller owns the pool and must migrate its private schema.
type PrivateRollout struct {
	Pool *pgxpool.Pool
}

func (r PrivateRollout) ConfigureRepositoryProvisioningEnforcement(ctx context.Context, enable bool) (bool, error) {
	return services.ConfigureRepositoryProvisioningEnforcement(ctx, r.Pool, enable)
}

func (r PrivateRollout) ConfigureLegacyMutationFences(ctx context.Context, enable bool) (ports.HostedMutationFences, error) {
	state, err := services.ConfigureLegacyMutationFences(ctx, r.Pool, enable)
	if err != nil {
		return ports.HostedMutationFences{}, err
	}
	return ports.HostedMutationFences{
		RepositoryStorageEnforced: state.RepositoryStorageEnforced,
		ReleaseDeletionEnabled:    state.ReleaseDeletionEnabled,
	}, nil
}

func (r PrivateRollout) IsLegacyFinalKeyPurgeAllowed(ctx context.Context) (bool, error) {
	return deploymentdb.New(r.Pool).IsLegacyFinalKeyPurgeAllowed(ctx)
}
