package smitherscli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkflowWatchExitCodeReflectsRunOutcome(t *testing.T) {
	t.Cleanup(func() { pendingProcessExitCode = 0 })
	for status, want := range map[string]int{"success": 0, "completed": 0, "failure": 1, "failed": 1, "cancelled": 1} {
		for _, command := range []string{"run", "workflow"} {
			t.Run(command+"/"+status, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					_, _ = fmt.Fprintf(w, `{"id":42,"status":%q}`, status)
				}))
				defer server.Close()
				commandsIssueWikiWorkflowCovSetConfig(t, server.URL)
				if code := Run([]string{command, "watch", "42", "--repo", "alice/demo", "--json"}); code != want {
					t.Fatalf("%s watch of %s run exited %d, want %d", command, status, code, want)
				}
			})
		}
	}
}
