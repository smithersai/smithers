package smitherscli

import (
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func TestCommandsAgent_Z_SandboxBackendErrors(t *testing.T) {
	url := (&agentFServer{}).start(t)
	agentFSetConfig(t, url, "tok")
	agentFInstallJj(t)
	t.Setenv("AGENTF_ROOT", "")
	t.Setenv("AGENTF_REMOTES", "")
	t.Setenv("AGENTF_STATUS", "clean")

	if _, err := runLocalAgentPrompt(&incur.CommandContext{}, "prompt", "alice/demo", true); err == nil || !strings.Contains(err.Error(), "local jj repository") {
		t.Fatalf("runLocalAgentPrompt sandbox error = %v", err)
	}
	if _, err := agentSummary("prompt", "alice/demo", true); err == nil || !strings.Contains(err.Error(), "local jj repository") {
		t.Fatalf("agentSummary sandbox error = %v", err)
	}
}
