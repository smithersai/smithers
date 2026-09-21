package services

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestDestroySession_PostgresPreservesBoundNativeExecution(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	q := db.New(pool)
	for _, mode := range []string{"running-gateway", "starting-gateway", "no-gateway", "stopped-gateway", "deleted-gateway", "different-vm", "active-session"} {
		t.Run(mode, func(t *testing.T) {
			owner, repoID := setupTestUserAndRepo(t, pool)
			workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repoID, UserID: owner, Name: uuid.NewString(), TargetBookmark: "main", Kind: "vm", Status: "running"})
			require.NoError(t, err)
			vmID := "session-fence-" + uuid.NewString()
			_, err = pool.Exec(ctx, "UPDATE workspaces SET vm_id=$2 WHERE id=$1", workspace.ID, vmID)
			require.NoError(t, err)
			createSession := func() db.WorkspaceSession {
				session, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{RepositoryID: repoID, UserID: owner, WorkspaceID: workspace.ID, Cols: 80, Rows: 24})
				require.NoError(t, err)
				session, err = q.MarkWorkspaceSessionRunning(ctx, session.ID)
				require.NoError(t, err)
				return session
			}
			terminal := createSession()
			if mode == "active-session" {
				createSession()
			} else if mode != "no-gateway" {
				gateway, err := q.CreateRepoGateway(ctx, db.CreateRepoGatewayParams{RepositoryID: repoID, UserID: owner,
					WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(workspace.ID), Valid: true}, Status: "pending"})
				require.NoError(t, err)
				status, boundVM := "running", vmID
				if mode == "starting-gateway" {
					status = "starting"
				}
				if mode == "stopped-gateway" {
					status = "stopped"
				}
				if mode == "different-vm" {
					boundVM = "previous-" + vmID
				}
				_, err = q.UpdateRepoGatewayExecutionInfo(ctx, db.UpdateRepoGatewayExecutionInfoParams{ID: gateway.ID, VmID: boundVM, Status: status})
				require.NoError(t, err)
				if mode == "deleted-gateway" {
					_, err = q.SoftDeleteRepoGateway(ctx, gateway.ID)
					require.NoError(t, err)
				}
			}
			suspended := 0
			client := &mockWorkspaceSandboxVMClient{suspendVMFn: func(_ context.Context, actualVM string) (sandbox.SuspendResult, error) {
				require.Equal(t, vmID, actualVM)
				suspended++
				return sandbox.SuspendResult{ID: actualVM}, nil
			}}
			// Use the actual service, SQL stop, and atomic workspace CAS. Only the
			// external provider and scheduling are fixture boundaries.
			service := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))
			require.NoError(t, service.DestroySession(ctx, terminal.ID, repoID, owner))
			stopped, err := q.GetWorkspaceSessionByRepo(ctx, db.GetWorkspaceSessionByRepoParams{ID: terminal.ID, RepositoryID: repoID})
			require.NoError(t, err)
			require.Equal(t, "stopped", stopped.Status, "the user's terminal stop remains durable")
			current, err := q.GetWorkspace(ctx, workspace.ID)
			require.NoError(t, err)
			blocked := mode == "running-gateway" || mode == "starting-gateway" || mode == "active-session"
			if blocked {
				require.Zero(t, suspended, "a real bound executor or active session must prevent provider suspension")
				require.Equal(t, "running", current.Status)
			} else {
				require.Equal(t, 1, suspended)
				require.Equal(t, "suspended", current.Status)
			}
		})
	}
}
