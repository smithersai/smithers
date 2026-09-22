package services

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func prepareRuntimeTestHelper(t *testing.T) {
	t.Helper()
	artifact := filepath.Join(t.TempDir(), "smithers-jj-export")
	require.NoError(t, os.WriteFile(artifact, []byte("packaged native helper"), 0755))
	t.Setenv(workspaceJJExportBinaryEnv, artifact)
}

func runtimeTestReceipt(t *testing.T, _ db.Workspace, _ string) string {
	t.Helper()
	body, err := os.ReadFile(os.Getenv(workspaceJJExportBinaryEnv))
	require.NoError(t, err)
	digest := sha256.Sum256(body)
	return fmt.Sprintf("%x\nok\n", digest)
}

func TestWorkspaceCodingRuntime_VerifiesPackagedHelperAndOwner(t *testing.T) {
	workspace := sampleDBWorkspace("8e597e64-7252-49f1-bb27-b97603589969")
	artifact := filepath.Join(t.TempDir(), "smithers-jj-export")
	body := []byte("packaged native helper")
	require.NoError(t, os.WriteFile(artifact, body, 0755))
	t.Setenv(workspaceJJExportBinaryEnv, artifact)
	digest := sha256.Sum256(body)
	want := fmt.Sprintf("%x\nok", digest)
	zero := int32(0)
	respond := want
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		require.Contains(t, request.Command, shellQuote(workspaceJJExportPath)+" --check-config")
		require.Contains(t, request.Command, workspace.ID)
		require.Contains(t, request.Command, "sha256sum "+shellQuote(workspaceJJExportPath))
		require.NotContains(t, request.Command, "python")
		return sandbox.ExecResult{StatusCode: &zero, Stdout: respond + "\n"}, nil
	}}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
	require.NoError(t, svc.ensureWorkspaceCodingRuntime(context.Background(), workspace))
	respond = strings.Repeat("0", 64) + "\nok"
	require.Error(t, svc.ensureWorkspaceCodingRuntime(context.Background(), workspace))
}

func TestWorkspaceCodingRuntime_RefusesAbsentHostBinary(t *testing.T) {
	workspace := sampleDBWorkspace("8e597e64-7252-49f1-bb27-b97603589969")
	t.Setenv(workspaceJJExportBinaryEnv, filepath.Join(t.TempDir(), "missing"))
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	require.Error(t, svc.ensureWorkspaceCodingRuntime(context.Background(), workspace))
}
