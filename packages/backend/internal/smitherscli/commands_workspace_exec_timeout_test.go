package smitherscli

import (
	"bytes"
	"io"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

// TestWorkspaceExecTimeoutFlag drives `workspace exec` through incur's real
// option parsing and records the client timeout the handler hands the runner.
func TestWorkspaceExecTimeoutFlag(t *testing.T) {
	oldWait := waitForWorkspaceSSHInfoForCommand
	oldRun := runWorkspaceExecForCommand
	t.Cleanup(func() {
		waitForWorkspaceSSHInfoForCommand = oldWait
		runWorkspaceExecForCommand = oldRun
	})
	waitForWorkspaceSSHInfoForCommand = func(string, string, string, string) (map[string]any, error) {
		return map[string]any{"command": "ssh ws@example"}, nil
	}

	cases := []struct {
		name string
		flag []string
		want time.Duration
	}{
		{name: "omitted uses the 120 second default", want: defaultWorkspaceRemoteCommandTimeout},
		{name: "explicit zero means no limit", flag: []string{"--timeout", "0"}, want: 0},
		{name: "explicit positive value", flag: []string{"--timeout", "7"}, want: 7 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got time.Duration
			called := false
			runWorkspaceExecForCommand = func(_, _, _ string, timeout time.Duration, _ io.Reader, _, _ io.Writer, _ func() (string, error)) (int, error) {
				called = true
				got = timeout
				return 0, nil
			}
			argv := append([]string{"exec", "ws-1", "--repo", "alice/demo", "--command", "true", "--json"}, tc.flag...)
			var stdout bytes.Buffer
			if err := workspaceCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
				t.Fatalf("workspace %v returned error: %v\n%s", argv, err, stdout.String())
			}
			if !called {
				t.Fatalf("workspace %v never ran the remote command", argv)
			}
			if got != tc.want {
				t.Fatalf("workspace %v timeout = %s, want %s", argv, got, tc.want)
			}
		})
	}
}
