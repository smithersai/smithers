package smitherscli

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	incur "github.com/smithersai/incur"
)

const defaultWorkspaceCreateWaitTimeout = 600 * time.Second
const defaultWorkspaceCreateWaitInterval = 3 * time.Second

var workspaceNetworkModes = []string{"proxy", "allowlist", "none"}

func workspaceExecCLIError(err error) error {
	var lost *WorkspaceExecOutcomeLostError
	if !errors.As(err, &lost) {
		return err
	}
	return incur.NewIncurError(incur.IncurErrorOptions{
		Code:     "WORKSPACE_EXEC_OUTCOME_LOST",
		Message:  lost.Error(),
		Hint:     "inspect the workspace before retrying; the command may have partially run",
		ExitCode: 125,
	})
}

// buildWorkspaceCreateBody turns parsed `workspace create` options into the API
// request body. Only fields the user set are sent, so the server keeps its
// defaults for everything else.
func buildWorkspaceCreateBody(options map[string]any) (map[string]any, error) {
	body := map[string]any{"name": stringValue(options["name"])}
	if snapshot := stringValue(options["snapshot"]); snapshot != "" {
		body["snapshot_id"] = snapshot
	}
	if image := strings.TrimSpace(stringValue(options["image"])); image != "" {
		body["image"] = image
	}
	if rawServices := stringSliceValue(options["service"]); len(rawServices) > 0 {
		services := make([]map[string]any, 0, len(rawServices))
		seen := make(map[string]struct{}, len(rawServices))
		for _, raw := range rawServices {
			name, command, ok := strings.Cut(strings.TrimSpace(raw), "=")
			name, command = strings.TrimSpace(name), strings.TrimSpace(command)
			if !ok || name == "" || command == "" || strings.ContainsAny(name, " /\\") {
				return nil, fmt.Errorf("--service must be NAME=COMMAND")
			}
			if _, exists := seen[name]; exists {
				return nil, fmt.Errorf("--service names must be unique")
			}
			seen[name] = struct{}{}
			// Keep the command as one shell script. Splitting on whitespace would
			// destroy quoted arguments and shell pipelines before the guest ever
			// sees them; the worker quotes the resulting argv when it builds the
			// detached service wrapper.
			services = append(services, map[string]any{"name": name, "mode": "service", "exec": []string{"/bin/sh", "-lc", command}})
		}
		body["services"] = services
	}
	resources := map[string]any{}
	for flag, field := range map[string]string{"cpus": "cpus", "memory": "memory_mb", "disk": "disk_mb"} {
		value, ok := options[flag]
		if !ok || value == nil {
			continue
		}
		n := intValue(value, 0)
		if n <= 0 {
			return nil, fmt.Errorf("--%s must be a positive integer", flag)
		}
		resources[field] = n
	}
	if len(resources) > 0 {
		body["resources"] = resources
	}
	allow := splitCommaList(stringSliceValue(options["allow"]))
	if single, ok := options["allow"].(string); ok && len(allow) == 0 {
		allow = splitCommaList([]string{single})
	}
	mode := strings.ToLower(strings.TrimSpace(stringValue(options["network"])))
	if mode == "" && len(allow) > 0 {
		mode = "allowlist"
	}
	if mode != "" {
		valid := false
		for _, candidate := range workspaceNetworkModes {
			if candidate == mode {
				valid = true
			}
		}
		if !valid {
			return nil, fmt.Errorf("--network must be one of %s", strings.Join(workspaceNetworkModes, ", "))
		}
		if len(allow) > 0 && mode != "allowlist" {
			return nil, fmt.Errorf("--allow requires --network allowlist")
		}
		network := map[string]any{"mode": mode}
		if len(allow) > 0 {
			network["allow"] = allow
		}
		body["network"] = network
	}
	if value, ok := options["idleTimeout"]; ok && value != nil {
		n := intValue(value, -1)
		if n < 0 {
			return nil, fmt.Errorf("--idle-timeout must be >= 0 (0 = never)")
		}
		body["idle_timeout_seconds"] = n
	}
	return body, nil
}

func splitCommaList(values []string) []string {
	out := []string{}
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

// waitForWorkspaceStatus polls the workspace until it is running or failed.
// A failed workspace is returned as a typed error carrying the server's
// failure code and message.
func waitForWorkspaceStatus(owner, repo, workspaceID string, timeout time.Duration) (map[string]any, error) {
	interval := parsePositiveDurationEnv("SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS", defaultWorkspaceCreateWaitInterval)
	deadline := time.Now().Add(timeout)
	var last map[string]any
	for {
		ws, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workspaces/%s", owner, repo, url.PathEscape(workspaceID)), nil, nil)
		if err != nil {
			return nil, err
		}
		last = objectValue(ws)
		switch stringValue(last["status"]) {
		case "running":
			return last, nil
		case "failed", "error":
			code := stringValue(last["failure_code"])
			if code == "" {
				code = "workspace_failed"
			}
			message := stringValue(last["failure_message"])
			if message == "" {
				message = "workspace provisioning failed"
			}
			// incur renders only the code and message, never a Hint, so the
			// cleanup command for the workspace left behind goes in the message.
			return last, incur.NewIncurError(incur.IncurErrorOptions{
				Code:     "WORKSPACE_" + strings.ToUpper(code),
				Message:  message + "; workspace " + workspaceID + " remains, remove it with `smithers workspace delete " + workspaceID + "`",
				ExitCode: 1,
			})
		}
		if time.Now().Add(interval).After(deadline) {
			return last, fmt.Errorf("workspace %s did not become running within %s (status: %s)", workspaceID, timeout, stringValue(last["status"]))
		}
		time.Sleep(interval)
	}
}

// workspaceSSHInfoPath returns the SSH info route, asking for a specific guest
// user when it is not the default one.
func workspaceSSHInfoPath(owner, repo, workspaceID, user string) string {
	p := fmt.Sprintf("/api/repos/%s/%s/workspaces/%s/ssh", owner, repo, url.PathEscape(workspaceID))
	user = strings.TrimSpace(user)
	if user != "" && user != defaultRemoteWorkspaceUser {
		p += "?user=" + url.QueryEscape(user)
	}
	return p
}

// buildWorkspaceExecScript is the remote script for `workspace exec`. The SSH
// login shell is /bin/sh (dash), so the command itself always runs under
// bash: multi-line scripts and `set -o pipefail` work. cwd is entered when it
// exists and otherwise falls back to the login user's home.
func buildWorkspaceExecScript(command, cwd string, env []string) string {
	if strings.TrimSpace(cwd) == "" {
		cwd = defaultWorkspaceRemoteRoot
	}
	script := "cd " + shellEscape(cwd) + " 2>/dev/null || cd ~; exec"
	if len(env) > 0 {
		script += " env"
		for _, pair := range env {
			script += " " + shellEscape(pair)
		}
	}
	return script + " /bin/bash -c " + shellEscape(command)
}

func parseWorkspaceExecEnv(values []string) ([]string, error) {
	out := []string{}
	for _, value := range values {
		key, _, ok := strings.Cut(value, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" || strings.ContainsAny(key, " \t\n") {
			return nil, fmt.Errorf("--env expects KEY=VALUE, got %q", value)
		}
		out = append(out, value)
	}
	return out, nil
}

// workspaceExecStdin returns the stdin to forward: a pipe or file is forwarded
// as is; a terminal is only forwarded when the user asked for it, so a bare
// `workspace exec` never blocks waiting for keyboard input.
func workspaceExecStdin(force bool) io.Reader {
	if !force {
		if info, err := os.Stdin.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			return nil
		}
	}
	if force || !workspaceIsTerminal(int(os.Stdin.Fd())) {
		return os.Stdin
	}
	return nil
}
