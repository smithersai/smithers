package admission_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/stretchr/testify/require"
)

type gatewayUsage struct {
	admission.Usage
	conn admission.DBTX
}

func (u gatewayUsage) CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error) {
	product, err := u.Usage.CountActiveSandboxesForUser(ctx, userID)
	if err != nil {
		return 0, err
	}
	var private int
	err = u.conn.QueryRow(ctx, `SELECT count(*) FROM private_gateway_reservations WHERE user_id=$1`, userID).Scan(&private)
	return product + private, err
}

func (u gatewayUsage) CountOtherActiveSandboxesForWorkspaceResume(ctx context.Context, request admission.ResumeRequest) (admission.ResumeCount, error) {
	product, err := u.Usage.CountOtherActiveSandboxesForWorkspaceResume(ctx, request)
	if err != nil {
		return product, err
	}
	var private int32
	err = u.conn.QueryRow(ctx, `SELECT count(*) FROM private_gateway_reservations WHERE user_id=$1`, request.UserID).Scan(&private)
	product.Others += private
	return product, err
}

func TestMeteredResumePreservesPrivateReservationsAndExactVMIdentity(t *testing.T) {
	pool := database(t)
	owner := user(t, pool)
	repo := repository(t, pool, owner)
	workspaceID := uuid.NewString()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE TABLE private_gateway_reservations (user_id bigint)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspaces (id, repository_id, user_id, vm_id, status)
		VALUES ($1, $2, $3, 'owned-vm', 'running')`, workspaceID, repo, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO private_gateway_reservations VALUES ($1)`, owner)
	require.NoError(t, err)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: func(conn admission.DBTX) (admission.Usage, error) {
		product, err := admission.ProductUsage(conn)
		return gatewayUsage{product, conn}, err
	}})
	require.NoError(t, err)
	entitlement, err := policy.SandboxEntitlement(ctx, owner)
	require.NoError(t, err)
	require.Equal(t, int64(2), entitlement.ConcurrentInUse)
	require.Error(t, policy.AuthorizeCountedSandboxResume(ctx, owner, workspaceID, "owned-vm"), "private gateway still consumes the only free-plan slot")
	_, err = pool.Exec(ctx, `DELETE FROM private_gateway_reservations WHERE user_id=$1`, owner)
	require.NoError(t, err)
	require.NoError(t, policy.AuthorizeCountedSandboxResume(ctx, owner, workspaceID, "owned-vm"))
	require.Error(t, policy.AuthorizeCountedSandboxResume(ctx, owner, workspaceID, "different-vm"), "a stale caller cannot discount the current VM")
}
