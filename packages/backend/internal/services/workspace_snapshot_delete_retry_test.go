package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type snapshotDeleteRetryRuntime struct {
	workspaceapi.WorkspaceRuntime
	deleteErr error
	deleted   []string
}

func (*snapshotDeleteRetryRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{ColdSnapshots: true}
}

func (*snapshotDeleteRetryRuntime) CreateColdSnapshot(context.Context, string, workspaceapi.ColdSnapshotSpec) (workspaceapi.ColdSnapshot, error) {
	panic("unexpected snapshot creation")
}

func (*snapshotDeleteRetryRuntime) ForkColdSnapshot(context.Context, string, workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	panic("unexpected snapshot fork")
}

func (r *snapshotDeleteRetryRuntime) DeleteColdSnapshot(_ context.Context, id string) error {
	r.deleted = append(r.deleted, id)
	return r.deleteErr
}

func TestDeleteWorkspaceSnapshotRuntimeRetry(t *testing.T) {
	for _, test := range []struct {
		name       string
		deleteErr  error
		wantStatus int
		wantRow    bool
	}{
		{name: "deleted now", wantRow: true},
		{name: "already absent after prior delete", deleteErr: fmt.Errorf("provider retry: %w", workspaceapi.ErrWorkspaceNotFound), wantRow: true},
		{name: "provider denial", deleteErr: errors.New("snapshot deletion denied"), wantStatus: http.StatusInternalServerError},
		{name: "lookalike error is not absence", deleteErr: errors.New("workspace not found"), wantStatus: http.StatusInternalServerError},
	} {
		t.Run(test.name, func(t *testing.T) {
			deletedRows := 0
			q := &mockWorkspaceQuerier{
				getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
					require.Equal(t, "snapshot-product-id", arg.ID)
					return sampleDBWorkspaceSnapshot(arg.ID, "workspace-product-id", "checkpoint", "snapshot-provider-id"), nil
				},
				deleteWorkspaceSnapshotFn: func(_ context.Context, id string) error {
					require.Equal(t, "snapshot-product-id", id)
					deletedRows++
					return nil
				},
			}
			runtime := &snapshotDeleteRetryRuntime{deleteErr: test.deleteErr}
			service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
			err := service.DeleteWorkspaceSnapshot(context.Background(), "snapshot-product-id", 101, 1)
			if test.wantStatus == 0 {
				require.NoError(t, err)
			} else {
				require.Equal(t, test.wantStatus, apiStatus(t, err))
				require.ErrorContains(t, err, test.deleteErr.Error())
			}
			require.Equal(t, []string{"snapshot-provider-id"}, runtime.deleted)
			if test.wantRow {
				require.Equal(t, 1, deletedRows)
			} else {
				require.Zero(t, deletedRows, "provider failures must retain the durable row for retry")
			}
		})
	}
}
