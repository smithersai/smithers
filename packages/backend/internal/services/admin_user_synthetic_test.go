package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func (m *mockAdminUserQuerier) AdminSetUserSynthetic(ctx context.Context, p db.AdminSetUserSyntheticParams) (db.User, error) {
	if m.setSyntheticFn != nil {
		return m.setSyntheticFn(ctx, p)
	}
	return db.User{}, nil
}

func TestAdminUserService_SetSyntheticRequiresActorAndTransaction(t *testing.T) {
	q := &mockAdminUserQuerier{setSyntheticFn: func(context.Context, db.AdminSetUserSyntheticParams) (db.User, error) {
		t.Fatal("must not write without an audited transaction")
		return db.User{}, nil
	}}
	for _, tc := range []struct {
		name, username string
		ctx            context.Context
		status         int
	}{
		{"blank", " ", adminAuditTestContext(), 400},
		{"missing actor", "alice", context.Background(), 500},
		{"missing transaction", "alice", adminAuditTestContext(), 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewAdminUserService(q).SetSynthetic(tc.ctx, tc.username, true)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			require.Equal(t, tc.status, apiErr.Status)
		})
	}
}

func TestAdminUserService_SetSyntheticAtomicAudit(t *testing.T) {
	pool := setupTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	q := db.New(pool)
	actor, err := q.CreateUser(ctx, db.CreateUserParams{Username: "synthetic-audit-admin", LowerUsername: "synthetic-audit-admin"})
	require.NoError(t, err)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "Synthetic-Audit-Target", LowerUsername: "synthetic-audit-target"})
	require.NoError(t, err)
	auditActor := AdminAuditActor{UserID: actor.ID, Username: actor.Username, IPAddress: "203.0.113.44"}
	svc := NewAdminUserService(q) // The atomic path does not depend on the best-effort auditor.
	for _, value := range []bool{true, false} {
		result, err := svc.SetSynthetic(ContextWithAdminAuditActor(ctx, auditActor), " Synthetic-Audit-Target ", value)
		require.NoError(t, err)
		require.Equal(t, value, result.Synthetic)
		persisted, err := q.GetUserByLowerUsername(ctx, user.LowerUsername)
		require.NoError(t, err)
		require.Equal(t, value, persisted.IsSynthetic)
		var event, actorName, targetType, targetName, action, ip string
		var actorID, targetID int64
		var metadata []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT event_type,actor_id,actor_name,target_type,target_id,target_name,action,metadata,ip_address FROM audit_log WHERE target_id=$1 ORDER BY id DESC LIMIT 1`, user.ID).Scan(&event, &actorID, &actorName, &targetType, &targetID, &targetName, &action, &metadata, &ip))
		require.Equal(t, "admin.user.set_synthetic", event)
		require.Equal(t, actor.ID, actorID)
		require.Equal(t, actor.Username, actorName)
		require.Equal(t, "user", targetType)
		require.Equal(t, user.ID, targetID)
		require.Equal(t, user.Username, targetName)
		require.Equal(t, "set_synthetic", action)
		require.Equal(t, auditActor.IPAddress, ip)
		wantMetadata, err := json.Marshal(map[string]bool{"synthetic": value})
		require.NoError(t, err)
		require.JSONEq(t, string(wantMetadata), string(metadata))
	}
	// An invalid actor foreign key fails the audit INSERT after the user UPDATE.
	// Independent pool reads must see neither an updated flag nor another audit row.
	badActor := auditActor
	badActor.UserID = -1
	_, err = svc.SetSynthetic(ContextWithAdminAuditActor(ctx, badActor), user.Username, true)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 500, apiErr.Status)
	require.Contains(t, err.Error(), "audit")
	persisted, err := q.GetUserByLowerUsername(ctx, user.LowerUsername)
	require.NoError(t, err)
	require.False(t, persisted.IsSynthetic)
	var auditCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE target_id=$1 AND event_type='admin.user.set_synthetic'`, user.ID).Scan(&auditCount))
	require.Equal(t, 2, auditCount)
	_, err = svc.SetSynthetic(ContextWithAdminAuditActor(ctx, auditActor), "missing-synthetic-user", true)
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 404, apiErr.Status)
	// Keep the explicit compatibility choice: IDs remain JSON numbers.
	data, err := json.Marshal(AdminSyntheticUserProfile{UserProfile: mapUserProfile(user), Synthetic: false})
	require.NoError(t, err)
	require.False(t, strings.Contains(string(data), `"id":"`))
}
