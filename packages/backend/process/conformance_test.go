package process

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/smithersai/smithers/packages/backend/workspaceconformance"
)

func TestRuntimeWorkspaceConformance(t *testing.T) {
	runtime, err := New(Config{Root: t.TempDir(), MaxConcurrent: 2})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })

	workspaceconformance.RunCore(t, workspaceconformance.CoreHarness{
		Runtime: runtime,
		Context: func(operationID string) context.Context {
			return workspaceapi.WithOperation(context.Background(), workspaceapi.Operation{
				TenantID: "one-owner", PrincipalID: "one-owner", OperationID: operationID,
			})
		},
		Spec:          workspaceapi.WorkspaceSpec{ID: "process-conformance"},
		CreateStates:  []workspaceapi.WorkspaceState{workspaceapi.WorkspaceStopped},
		Command:       workspaceapi.Command{Args: []string{"/bin/sh", "-c", "printf conformance-ok"}},
		WantStdout:    "conformance-ok",
		FilePath:      "nested/fixture.txt",
		FileContent:   []byte("persistent fixture\n"),
		FileMode:      0o640,
		WantIsolation: workspaceapi.IsolationTrustedProcess,
		WantCapabilities: workspaceapi.WorkspaceCapabilities{
			PersistentFiles:  true,
			Execution:        true,
			ManagedServices:  true,
			ManagedHTTPHosts: true,
			SourceRevision:   true,
			Terminal:         true,
			LoopbackPreview:  true,
			FileOperations:   true,
			ColdSnapshots:    false,
		},
	})
}
