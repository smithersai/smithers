package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type operationAuditFake struct{ rows []db.InsertAuditLogParams }

func (f *operationAuditFake) InsertAuditLog(_ context.Context, p db.InsertAuditLogParams) error {
	f.rows = append(f.rows, p)
	return nil
}

// Deployment operations record what run learned (such as pruned host IDs) in
// the outcome row, and nothing runs without an acting admin.
func TestAdminOperationLogRecordsRunDetails(t *testing.T) {
	f := &operationAuditFake{}
	log := NewAdminOperationLog(f)
	ran := false
	err := log.Operation(context.Background(), "sandbox_host", "", "prune", nil, func() error { ran = true; return nil })
	var api *pkgerrors.APIError
	require.ErrorAs(t, err, &api)
	require.Equal(t, 401, api.Status)
	require.False(t, ran)
	require.Empty(t, f.rows)

	metadata := map[string]any{"older_than_hours": 24}
	require.NoError(t, log.Operation(manageTestContext(), "sandbox_host", "", "prune", metadata, func() error {
		metadata["host_ids"] = []string{"worker-a"}
		return nil
	}))
	require.Len(t, f.rows, 2)
	require.Equal(t, "admin.sandbox_host.prune", f.rows[0].EventType)
	require.EqualValues(t, 99, f.rows[0].ActorID.Int64)
	var attempted, completed map[string]any
	require.NoError(t, json.Unmarshal(f.rows[0].Metadata, &attempted))
	require.NoError(t, json.Unmarshal(f.rows[1].Metadata, &completed))
	require.Equal(t, "attempted", attempted["outcome"])
	require.NotContains(t, attempted, "host_ids")
	require.Equal(t, "succeeded", completed["outcome"])
	require.Equal(t, []any{"worker-a"}, completed["host_ids"])
	require.Equal(t, attempted["operation_id"], completed["operation_id"])
}
