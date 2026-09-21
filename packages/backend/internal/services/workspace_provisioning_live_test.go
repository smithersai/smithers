package services

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestWorkspaceService_LiveFreshWorkspaceInstallsSmithersCLI(t *testing.T) {
	if strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_CLI_LIVE_E2E")) != "1" {
		t.Skip("set SMITHERS_WORKSPACE_CLI_LIVE_E2E=1 to create a live sandbox")
	}

	apiURL := strings.TrimSpace(os.Getenv("SMITHERS_MICROSANDBOX_CONTROL_URL"))
	apiKey := strings.TrimSpace(os.Getenv("SMITHERS_MICROSANDBOX_API_KEY"))
	require.NotEmpty(t, apiURL, "SMITHERS_MICROSANDBOX_CONTROL_URL is required")
	require.NotEmpty(t, apiKey, "SMITHERS_MICROSANDBOX_API_KEY is required")

	cliPath := strings.TrimSpace(os.Getenv(workspaceCLIBinaryEnv))
	require.NotEmpty(t, cliPath, workspaceCLIBinaryEnv+" is required for this live smoke")
	info, err := os.Stat(cliPath)
	require.NoError(t, err)
	require.NotZero(t, info.Size(), "live smoke needs a non-empty source CLI payload")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client := microsandbox.NewClient(apiURL, apiKey)
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 0, "container")
	require.NoError(t, err)
	require.Contains(t, req.Files, workspaceSmithersCLIB64Path)

	vm, err := client.CreateSandbox(ctx, req)
	require.NoError(t, err)
	require.NotEmpty(t, vm.ID)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cleanupCancel()
		_ = client.DeleteSandbox(cleanupCtx, vm.ID)
	})

	waitForLiveWorkspaceVM(t, ctx, client, vm.ID)

	timeoutMS := int64((45 * time.Second).Milliseconds())
	resp, err := client.Execute(ctx, vm.ID, sandbox.ExecRequest{
		Command:   `stat -c 'mode=%a size=%s path=%n' /usr/local/bin/smithers && test -s /usr/local/bin/smithers && test -x /usr/local/bin/smithers && /usr/local/bin/smithers --help | sed -n '1,12p'`,
		TimeoutMS: &timeoutMS,
	})
	require.NoError(t, err)
	require.NotNil(t, resp.StatusCode)
	require.EqualValues(t, 0, *resp.StatusCode, "stdout=%s stderr=%s", resp.Stdout, resp.Stderr)
	require.Contains(t, resp.Stdout, "mode=755")
	require.Contains(t, resp.Stdout, "path=/usr/local/bin/smithers")
	require.Contains(t, resp.Stdout, "Smithers CLI")
	require.Contains(t, resp.Stdout, "Usage: smithers")
}

func waitForLiveWorkspaceVM(t *testing.T, ctx context.Context, client *microsandbox.Client, vmID string) {
	t.Helper()

	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for {
		vm, err := client.InspectSandbox(ctx, vmID)
		if err == nil && vm.State == sandbox.StateRunning {
			return
		}

		select {
		case <-ctx.Done():
			if err != nil {
				t.Fatalf("workspace VM %s did not become running: %v", vmID, err)
			}
			t.Fatalf("workspace VM %s did not become running before timeout", vmID)
		case <-ticker.C:
		}
	}
}
