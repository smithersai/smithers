package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestVariable_Z_RemainingResolveBranches(t *testing.T) {
	ctx := context.Background()
	actor := variableHUser(1)
	svc := NewVariableService(&variableHQuerier{})

	_, err := svc.GetVariable(ctx, actor, "", "demo", "KEY")
	require.Equal(t, 400, variableHStatus(t, err))

	_, err = svc.ListVariables(ctx, actor, "alice", "")
	require.Equal(t, 400, variableHStatus(t, err))

	err = svc.DeleteVariable(ctx, actor, "", "demo", "KEY")
	require.Equal(t, 400, variableHStatus(t, err))

	privateRepo := variableHRepo()
	privateRepo.UserID = pgtype.Int8{Int64: 99, Valid: true}
	err = NewVariableService(&variableHQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
	}).DeleteVariable(ctx, actor, "alice", "demo", "KEY")
	require.Equal(t, 403, variableHStatus(t, err))

	_, err = svc.ListOrgVariables(ctx, actor, "")
	require.Equal(t, 400, variableHStatus(t, err))

	err = svc.DeleteOrgVariable(ctx, actor, "", "KEY")
	require.Equal(t, 400, variableHStatus(t, err))

	err = NewVariableService(&variableHQuerier{
		getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{Role: "member"}, nil
		},
	}).DeleteOrgVariable(ctx, variableHUser(2), "acme", "KEY")
	require.Equal(t, 403, variableHStatus(t, err))
}
