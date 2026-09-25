package smitherscli

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	incur "github.com/smithersai/incur"
	"golang.org/x/term"
)

const defaultWorkspaceRemoteRoot = "/home/developer/workspace"
const defaultRemoteClaudeAuthDir = "/home/developer/.smithers"
const defaultRemoteClaudeAuthFile = "/home/developer/.smithers/claude-env.sh"
const defaultRemotePromptFile = "/home/developer/.smithers/issue-prompt.txt"
const defaultRemoteClaudeInstallLog = "/home/developer/.smithers/claude-install.log"
const defaultRemoteCodexAuthDir = "/home/developer/.codex"
const defaultRemoteCodexAuthFile = "/home/developer/.codex/auth.json"
const defaultRemoteWorkspaceUser = "developer"
const defaultRemoteLocalRoot = "/home/developer/.local"
const defaultRemoteLocalBinDir = "/home/developer/.local/bin"
const defaultRemoteDeveloperPath = "/home/developer/.local/bin:/usr/local/bin:/usr/bin:/bin"
const defaultClaudeCodePackage = "@anthropic-ai/claude-code"
const defaultWorkspaceSSHConnectTimeoutSeconds = 15
const defaultWorkspaceSSHPollInterval = 3 * time.Second
const defaultWorkspaceSSHPollTimeout = 120 * time.Second
const defaultWorkspaceRemoteCommandTimeout = 120 * time.Second
const defaultWorkspaceClaudeTimeout = 30 * time.Minute
const claudeCodeKeychainService = "Claude Code-credentials"

var workspaceRandRead = rand.Read
var workspaceTerminalGetSize = term.GetSize
var workspaceIsTerminal = term.IsTerminal
var workspaceMakeRaw = term.MakeRaw
var workspaceRestoreTerminal = term.Restore
var workspaceTerminalInput = func() io.Reader { return os.Stdin }
var workspaceTerminalWrite = func(ctx context.Context, conn *websocket.Conn, messageType websocket.MessageType, data []byte) error {
	return conn.Write(ctx, messageType, data)
}
var workspaceUserHomeDir = os.UserHomeDir
var waitForWorkspaceSSHInfoForCommand = waitForWorkspaceSSHInfo
var runWorkspaceTerminalForCommand = runWorkspaceTerminal
var workspaceJSONMarshal = json.Marshal
var workspaceRuntimeGOOS = runtime.GOOS
var workspaceExitErrorCode = func(err error) (int, bool) {
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		return 0, false
	}
	return exitErr.ExitCode(), true
}

func workspaceCommand() *incur.Cli {
	cmd := incur.New("workspace", incur.WithDescription("Manage cloud workspaces"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a workspace",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"name":     {Type: "string", Description: "Workspace name", Default: ""},
			"snapshot": stringSchema("Snapshot ID to restore from"),
			"repo":     stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			body := map[string]any{"name": stringValue(ctx.Options["name"])}
			if snapshot := stringValue(ctx.Options["snapshot"]); snapshot != "" {
				body["snapshot_id"] = snapshot
			}
			return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/workspaces", owner, repo), body, nil)
		},
	})
	cmd.Command("list", repoOnlyCommand("List workspaces", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workspaces", owner, repo), nil, nil)
	}))
	cmd.Command("view", workspaceIDCommand("View workspace details (status, SSH info, persistence)", func(owner, repo, id string, ctx *incur.CommandContext) (any, error) {
		ws, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workspaces/%s", owner, repo, url.PathEscape(id)), nil, nil)
		if err != nil {
			return nil, err
		}
		record := objectValue(ws)
		var sshInfo any
		if stringValue(record["status"]) == "running" {
			sshInfo, _ = APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workspaces/%s/ssh", owner, repo, url.PathEscape(id)), nil, nil)
		}
		out := map[string]any{}
		for key, value := range record {
			out[key] = value
		}
		out["ssh"] = workspaceSSHView(record, objectValue(sshInfo))
		out["uptime"] = workspaceUptime(record)
		if out["persistence"] == nil || out["persistence"] == "" {
			out["persistence"] = "persistent"
		}
		if out["snapshot_id"] == nil {
			out["snapshot_id"] = nil
		}
		if out["idle_timeout_seconds"] == nil {
			out["idle_timeout_seconds"] = 1800
		}
		return out, nil
	}))
	cmd.Command("delete", workspaceIDCommandWithOptions("Delete a workspace", map[string]*incur.JSONSchema{"yes": booleanSchema("Confirm deleting the workspace", false)}, func(owner, repo, id string, ctx *incur.CommandContext) (any, error) {
		if err := confirmDestructiveOperation(ctx.Options["yes"] == true, "delete workspace "+strconv.Quote(id)); err != nil {
			return nil, err
		}
		if _, err := APIRequest("DELETE", fmt.Sprintf("/api/repos/%s/%s/workspaces/%s", owner, repo, url.PathEscape(id)), nil, nil); err != nil {
			return nil, err
		}
		return map[string]any{"status": "deleted", "id": id}, nil
	}))
	cmd.Command("ssh", &incur.CommandDef{
		Description: "SSH into a workspace (creates one if none exists for the repo)",
		ArgsSchema:  objectSchema(nil, map[string]*incur.JSONSchema{"id": stringSchema("Workspace ID (auto-detected if omitted)")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, workspaceID, err := resolveWorkspaceID(ctx)
			if err != nil {
				return nil, err
			}
			sshInfo, err := waitForWorkspaceSSHInfoForCommand(owner, repo, workspaceID)
			if err != nil {
				return nil, err
			}
			sshCommand := getWorkspaceSSHCommand(sshInfo)
			if sshCommand == "" {
				out := map[string]any{"workspace_id": workspaceID}
				for key, value := range sshInfo {
					out[key] = value
				}
				return out, nil
			}
			if err := runSSHCommand(sshCommand); err != nil {
				return nil, err
			}
			return map[string]any{"connected": true, "workspace_id": workspaceID}, nil
		},
	})
	cmd.Command("cp", &incur.CommandDef{
		Description: "Copy files or directories between the local machine and a workspace",
		ArgsSchema: objectSchema([]string{"src", "dst"}, map[string]*incur.JSONSchema{
			"src": stringSchema("Local path or <workspace-id>:<path>"),
			"dst": stringSchema("Local path or <workspace-id>:<path>"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":    stringSchema("Repository (OWNER/REPO)"),
			"user":    {Type: "string", Description: "Guest user", Default: defaultRemoteWorkspaceUser},
			"timeout": numberSchema("Transfer timeout in seconds", 0),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			from, to, err := parseWorkspaceCopyArgs(stringValue(ctx.Args["src"]), stringValue(ctx.Args["dst"]))
			if err != nil {
				return nil, err
			}
			remote := from
			if to.Remote {
				remote = to
			}
			ctx.Args["id"] = remote.WorkspaceID
			owner, repo, workspaceID, err := resolveWorkspaceID(ctx)
			if err != nil {
				return nil, err
			}
			timeout := defaultWorkspaceCopyTimeout
			if seconds := intValue(ctx.Options["timeout"], 0); seconds > 0 {
				timeout = time.Duration(seconds) * time.Second
			}
			sshInfo, err := waitForWorkspaceSSHInfoAs(owner, repo, workspaceID, strings.TrimSpace(stringValue(ctx.Options["user"])))
			if err != nil {
				return nil, err
			}
			sshCommand := getWorkspaceSSHCommand(sshInfo)
			if sshCommand == "" {
				return nil, fmt.Errorf("workspace %s did not return an SSH command", workspaceID)
			}
			stats, err := runWorkspaceCopy(sshCommand, from, to, timeout)
			if err != nil {
				return nil, err
			}
			return map[string]any{"workspace_id": workspaceID, "bytes": stats.Bytes, "files": stats.Files}, nil
		},
	})
	cmd.Command("fork", workspaceIDCommandWithOptions("Fork a workspace", map[string]*incur.JSONSchema{
		"name": {Type: "string", Description: "Name for the forked workspace", Default: ""},
	}, func(owner, repo, id string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/workspaces/%s/fork", owner, repo, url.PathEscape(id)), map[string]any{"name": stringValue(ctx.Options["name"])}, nil)
	}))
	cmd.Command("snapshots", workspaceIDCommand("List workspace snapshots", func(owner, repo, id string, ctx *incur.CommandContext) (any, error) {
		return listWorkspaceSnapshots(owner, repo, id)
	}))
	cmd.Command("watch", workspaceIDCommand("Watch a workspace for real-time status updates", func(owner, repo, id string, ctx *incur.CommandContext) (any, error) {
		ws, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workspaces/%s", owner, repo, url.PathEscape(id)), nil, nil)
		if err != nil {
			return nil, err
		}
		record := objectValue(ws)
		name := stringValue(record["name"])
		if name != "" {
			fmt.Fprintf(os.Stderr, "Watching workspace %s (%s) (status: %s)...\n", stringValue(record["id"]), name, stringValue(record["status"]))
		} else {
			fmt.Fprintf(os.Stderr, "Watching workspace %s (status: %s)...\n", stringValue(record["id"]), stringValue(record["status"]))
		}
		events, err := streamWorkspaceEvents(owner, repo, id)
		if err != nil {
			return nil, err
		}
		out := map[string]any{}
		for key, value := range record {
			out[key] = value
		}
		out["events"] = events
		return out, nil
	}))
	cmd.Command("shell", &incur.CommandDef{
		Description: "Open an interactive terminal in a workspace via the WebSocket terminal endpoint",
		ArgsSchema:  objectSchema(nil, map[string]*incur.JSONSchema{"id": stringSchema("Workspace ID (auto-detected if omitted)")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
			"cols": numberSchema("Initial terminal columns (0 = detect)", 0),
			"rows": numberSchema("Initial terminal rows (0 = detect)", 0),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, workspaceID, err := resolveWorkspaceID(ctx)
			if err != nil {
				return nil, err
			}
			cols, rows := terminalSize(intValue(ctx.Options["cols"], 0), intValue(ctx.Options["rows"], 0))
			session, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/workspace/sessions", owner, repo), map[string]any{
				"cols":         cols,
				"rows":         rows,
				"workspace_id": workspaceID,
			}, nil)
			if err != nil {
				return nil, err
			}
			sessionID := stringValue(objectValue(session)["id"])
			if sessionID == "" {
				return nil, fmt.Errorf("workspace terminal session response did not include id")
			}
			err = runWorkspaceTerminalForCommand(owner, repo, sessionID, cols, rows)
			_, _ = APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/workspace/sessions/%s/destroy", owner, repo, url.PathEscape(sessionID)), nil, nil)
			return nil, err
		},
	})
	cmd.Command("exec", &incur.CommandDef{
		Description: "Run a non-interactive command on a workspace over SSH, streaming stdout/stderr through",
		ArgsSchema:  objectSchema(nil, map[string]*incur.JSONSchema{"id": stringSchema("Workspace ID (auto-detected if omitted)")}),
		OptionsSchema: objectSchema([]string{"command"}, map[string]*incur.JSONSchema{
			"repo":          stringSchema("Repository (OWNER/REPO)"),
			"command":       stringSchema("Remote command to run"),
			"timeout":       numberSchema("Timeout in seconds (default: 120)", 0),
			"seedAgentAuth": stringSchema("Comma-separated list of agent auth to seed before running the command (claude, codex)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, workspaceID, err := resolveWorkspaceID(ctx)
			if err != nil {
				return nil, err
			}
			command, timeout, err := normalizeWorkspaceExecOptions(
				stringValue(ctx.Options["command"]),
				intValue(ctx.Options["timeout"], 0),
			)
			if err != nil {
				return nil, err
			}
			sshInfo, err := waitForWorkspaceSSHInfoForCommand(owner, repo, workspaceID)
			if err != nil {
				return nil, err
			}
			sshCommand := getWorkspaceSSHCommand(sshInfo)
			if sshCommand == "" {
				return nil, fmt.Errorf("workspace %s did not return an SSH command", workspaceID)
			}
			agents := parseSeedAgentAuthList(stringValue(ctx.Options["seedAgentAuth"]))
			if err := seedWorkspaceAgentAuth(sshCommand, agents); err != nil {
				return nil, err
			}
			exitCode, err := runRemoteStreamedCommand(sshCommand, buildWorkspaceExecRemoteScript(command), timeout)
			if err != nil {
				return nil, err
			}
			if exitCode != 0 {
				return nil, incur.NewIncurError(incur.IncurErrorOptions{
					Code:     "WORKSPACE_EXEC_NONZERO_EXIT",
					Message:  fmt.Sprintf("remote command exited with code %d", exitCode),
					ExitCode: exitCode,
				})
			}
			return map[string]any{"workspace_id": workspaceID, "exit_code": exitCode}, nil
		},
	})
	cmd.Command("issue", &incur.CommandDef{
		Description: "Spin up a workspace for an issue, run Claude Code, then create a landing request",
		ArgsSchema:  objectSchema([]string{"number"}, map[string]*incur.JSONSchema{"number": stringSchema("Issue number to work on")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"target": {Type: "string", Description: "Target bookmark for the landing request", Default: "main"},
			"repo":   stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return runWorkspaceIssue(ctx)
		},
	})
	return cmd
}

func normalizeWorkspaceExecOptions(command string, timeoutSeconds int) (string, time.Duration, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", 0, fmt.Errorf("--command is required")
	}
	timeout := defaultWorkspaceRemoteCommandTimeout
	if timeoutSeconds > 0 {
		timeout = time.Duration(timeoutSeconds) * time.Second
	}
	return command, timeout, nil
}

func workspaceIDCommand(description string, handler func(owner, repo, id string, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	return workspaceIDCommandWithOptions(description, nil, handler)
}

func workspaceIDCommandWithOptions(description string, extra map[string]*incur.JSONSchema, handler func(owner, repo, id string, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	properties := map[string]*incur.JSONSchema{"repo": stringSchema("Repository (OWNER/REPO)")}
	for key, schema := range extra {
		properties[key] = schema
	}
	return &incur.CommandDef{
		Description:   description,
		ArgsSchema:    objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": stringSchema("Workspace ID")}),
		OptionsSchema: objectSchema(nil, properties),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return handler(owner, repo, stringValue(ctx.Args["id"]), ctx)
		},
	}
}

func getWorkspaceSSHCommand(sshInfo map[string]any) string {
	if command := strings.TrimSpace(stringValue(sshInfo["command"])); command != "" {
		return command
	}
	return strings.TrimSpace(stringValue(sshInfo["ssh_command"]))
}

func workspaceSSHView(ws, sshInfo map[string]any) any {
	if sshInfo != nil {
		command := getWorkspaceSSHCommand(sshInfo)
		if command == "" {
			if sshHost := stringValue(sshInfo["ssh_host"]); sshHost != "" {
				command = "ssh " + sshHost
			} else if sshHost := stringValue(ws["ssh_host"]); sshHost != "" {
				command = "ssh " + sshHost
			} else {
				command = "SSH details available"
			}
		}
		return map[string]any{
			"command":  command,
			"host":     firstNonEmptyAny(sshInfo["host"], sshInfo["ssh_host"], ws["ssh_host"]),
			"port":     firstNonEmptyAny(sshInfo["port"], 22),
			"username": sshInfo["username"],
		}
	}
	if sshHost := stringValue(ws["ssh_host"]); sshHost != "" {
		return map[string]any{"command": "ssh " + sshHost, "host": sshHost, "port": 22}
	}
	return nil
}

func workspaceUptime(ws map[string]any) any {
	if stringValue(ws["status"]) != "running" || stringValue(ws["created_at"]) == "" {
		return nil
	}
	startRaw := stringValue(ws["created_at"])
	if stringValue(ws["suspended_at"]) != "" && stringValue(ws["updated_at"]) != "" {
		startRaw = stringValue(ws["updated_at"])
	}
	start, err := time.Parse(time.RFC3339Nano, startRaw)
	if err != nil {
		return nil
	}
	diff := time.Since(start)
	hours := int(diff.Hours())
	minutes := int(diff.Minutes()) % 60
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}

func resolveWorkspaceID(ctx *incur.CommandContext) (owner, repo, workspaceID string, err error) {
	owner, repo, err = ResolveRepoRef(stringValue(ctx.Options["repo"]))
	if err != nil {
		return "", "", "", err
	}
	workspaceID = stringValue(ctx.Args["id"])
	if workspaceID != "" {
		return owner, repo, workspaceID, nil
	}
	workspaces, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workspaces", owner, repo), nil, nil)
	if err != nil {
		return "", "", "", err
	}
	for _, ws := range arrayValue(workspaces) {
		record := objectValue(ws)
		if stringValue(record["status"]) == "running" && stringValue(record["id"]) != "" {
			return owner, repo, stringValue(record["id"]), nil
		}
	}
	if values := arrayValue(workspaces); len(values) > 0 {
		if id := stringValue(objectValue(values[0])["id"]); id != "" {
			return owner, repo, id, nil
		}
	}
	created, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/workspaces", owner, repo), map[string]any{"name": ""}, nil)
	if err != nil {
		return "", "", "", err
	}
	workspaceID = stringValue(objectValue(created)["id"])
	if workspaceID == "" {
		return "", "", "", fmt.Errorf("created workspace response did not include id")
	}
	return owner, repo, workspaceID, nil
}

func waitForWorkspaceSSHInfo(owner, repo, workspaceID string) (map[string]any, error) {
	return waitForWorkspaceSSHInfoAs(owner, repo, workspaceID, "")
}

func waitForWorkspaceSSHInfoAs(owner, repo, workspaceID, user string) (map[string]any, error) {
	interval := parsePositiveDurationEnv("SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS", defaultWorkspaceSSHPollInterval)
	timeout := parsePositiveDurationEnv("SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS", defaultWorkspaceSSHPollTimeout)
	deadline := time.Now().Add(timeout)
	var lastErr error
	sshPath := fmt.Sprintf("/api/repos/%s/%s/workspaces/%s/ssh", owner, repo, url.PathEscape(workspaceID))
	if user != "" && user != defaultRemoteWorkspaceUser {
		sshPath += "?user=" + url.QueryEscape(user)
	}
	for time.Now().Before(deadline) || time.Now().Equal(deadline) {
		sshInfo, err := APIRequest("GET", sshPath, nil, nil)
		if err == nil {
			record := objectValue(sshInfo)
			if getWorkspaceSSHCommand(record) != "" {
				return record, nil
			}
			lastErr = fmt.Errorf("SSH connection info is not ready yet")
		} else if shouldRetryWorkspaceSSHError(err) {
			lastErr = err
		} else {
			return nil, err
		}
		if time.Now().Add(interval).After(deadline) {
			break
		}
		time.Sleep(interval)
	}
	detail := "SSH connection info was unavailable"
	if lastErr != nil {
		detail = lastErr.Error()
	}
	return nil, fmt.Errorf("workspace %s did not become SSH-ready within %s: %s", workspaceID, timeout, detail)
}

func shouldRetryWorkspaceSSHError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		switch apiErr.Status {
		case 404, 409, 423, 425, 429, 502, 503, 504:
			return true
		default:
			return false
		}
	}
	return true
}

func parsePositiveDurationEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return time.Duration(parsed) * time.Millisecond
}

func tokenizeShellWords(input string) []string {
	tokens := []string{}
	current := strings.Builder{}
	var quote rune
	escaped := false
	for _, char := range input {
		if escaped {
			current.WriteRune(char)
			escaped = false
			continue
		}
		if quote == 0 && char == '\\' {
			escaped = true
			continue
		}
		if quote != 0 && char == quote {
			quote = 0
			continue
		}
		if quote == 0 && (char == '\'' || char == '"') {
			quote = char
			continue
		}
		if quote == 0 && (char == ' ' || char == '\t' || char == '\n') {
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteRune(char)
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

func shellEscape(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func buildWorkspaceExecRemoteScript(command string) string {
	return "cd " + shellEscape(defaultWorkspaceRemoteRoot) + " && " + command
}

func workspaceKnownHostsFile() string {
	path := strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE"))
	if path == "" {
		path = filepath.Join(StateDir(), "ssh", "known_hosts")
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	return path
}

// validateWorkspaceSSHArgs accepts only the connection options the control
// plane needs. OpenSSH has many local execution/file-writing options, including
// config includes and loadable providers, so a denylist is not sufficient.
func validateWorkspaceSSHArgs(args []string) error {
	destination := false
	for i := 1; i < len(args); i++ {
		token := args[i]
		if strings.HasPrefix(token, "-o") {
			directive := strings.TrimPrefix(token, "-o")
			if directive == "" {
				i++
				if i >= len(args) {
					return fmt.Errorf("workspace ssh option requires a value")
				}
				directive = args[i]
			}
			parts := strings.FieldsFunc(strings.TrimSpace(directive), func(r rune) bool { return r == '=' || r == ' ' || r == '\t' })
			if len(parts) != 2 {
				return fmt.Errorf("invalid workspace ssh option")
			}
			switch strings.ToLower(parts[0]) {
			case "serveraliveinterval", "serveralivecountmax", "connecttimeout":
				if n, err := strconv.Atoi(parts[1]); err != nil || n < 0 {
					return fmt.Errorf("invalid workspace ssh timeout")
				}
			case "batchmode", "identitiesonly", "tcpkeepalive", "compression":
				if parts[1] != "yes" && parts[1] != "no" {
					return fmt.Errorf("invalid workspace ssh boolean option")
				}
			default:
				return fmt.Errorf("workspace ssh command may not set the ssh option %s", parts[0])
			}
			continue
		}
		if token == "-4" || token == "-6" || token == "-t" || token == "-tt" || token == "-T" {
			continue
		}
		if strings.HasPrefix(token, "-") {
			if len(token) < 2 || !strings.ContainsRune("pil", rune(token[1])) {
				return fmt.Errorf("unsupported workspace ssh flag")
			}
			value := token[2:]
			if value == "" {
				i++
				if i >= len(args) {
					return fmt.Errorf("workspace ssh flag requires a value")
				}
				value = args[i]
			}
			if value == "" || strings.ContainsAny(value, "\r\n\x00") {
				return fmt.Errorf("invalid workspace ssh argument")
			}
			if token[1] == 'p' {
				port, err := strconv.Atoi(value)
				if err != nil || port < 1 || port > 65535 {
					return fmt.Errorf("invalid workspace ssh port")
				}
			}
			if token[1] == 'l' && strings.ContainsAny(value, " ;|&$`\\\"'()<>\t") {
				return fmt.Errorf("invalid workspace ssh user")
			}
			continue
		}
		if destination || token == "" {
			return fmt.Errorf("workspace ssh requires one destination and no remote command")
		}
		for _, r := range token {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && !strings.ContainsRune("._-+@[]:", r) {
				return fmt.Errorf("invalid workspace ssh destination")
			}
		}
		destination = true
	}
	if !destination {
		return fmt.Errorf("workspace ssh destination is required")
	}
	return nil
}

func buildSSHInvocationArgs(sshCommand string, forceTTY bool) ([]string, error) {
	sshArgs := tokenizeShellWords(sshCommand)
	if len(sshArgs) == 0 {
		return nil, nil
	}
	executable := strings.ToLower(sshArgs[0])
	if executable != "ssh" && executable != "ssh.exe" {
		return nil, fmt.Errorf("workspace ssh command executable must be ssh, got %q", sshArgs[0])
	}
	if err := validateWorkspaceSSHArgs(sshArgs); err != nil {
		return nil, err
	}
	connectTimeout := defaultWorkspaceSSHConnectTimeoutSeconds
	if raw := strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_SSH_CONNECT_TIMEOUT_SECONDS")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			connectTimeout = parsed
		}
	}
	out := []string{sshArgs[0]}
	if forceTTY {
		out = append(out, "-tt")
	}
	out = append(out,
		"-o", "BatchMode=yes",
		"-o", fmt.Sprintf("ConnectTimeout=%d", connectTimeout),
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "UserKnownHostsFile="+workspaceKnownHostsFile(),
		"-o", "LogLevel=ERROR",
	)
	return append(out, sshArgs[1:]...), nil
}

func runSSHCommand(sshCommand string) error {
	args, err := buildSSHInvocationArgs(sshCommand, false)
	if err != nil {
		return err
	}
	if len(args) == 0 {
		return fmt.Errorf("workspace ssh command was empty")
	}
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return fmt.Errorf("SSH exited with code %d", exitErr.ExitCode())
		}
		return err
	}
	return nil
}

// listWorkspaceSnapshots returns the repository's snapshots taken from one
// workspace. The server lists snapshots per repository only.
func listWorkspaceSnapshots(owner, repo, workspaceID string) ([]any, error) {
	all, err := APIListAll(func(cursor string) string {
		path := fmt.Sprintf("/api/repos/%s/%s/workspace-snapshots?limit=100", owner, repo)
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		return path
	}, nil)
	if err != nil {
		return nil, err
	}
	snapshots := []any{}
	for _, item := range all {
		if stringValue(objectValue(item)["workspace_id"]) == workspaceID {
			snapshots = append(snapshots, item)
		}
	}
	return snapshots, nil
}

func streamWorkspaceEvents(owner, repo, workspaceID string) ([]map[string]any, error) {
	auth, err := RequireAuthToken(nil)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/api/repos/%s/%s/workspaces/%s/stream", owner, repo, url.PathEscape(workspaceID))
	resp, cancel, err := doAPI(apiCall{Method: http.MethodGet, URL: auth.APIURL + path, Path: path, Token: auth.Token, Accept: "text/event-stream", Stream: true})
	if err != nil {
		return nil, fmt.Errorf("Failed to connect to workspace stream: %w", err)
	}
	defer cancel()
	defer func() { _ = resp.Body.Close() }()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	events := []map[string]any{}
	eventType := ""
	eventID := ""
	data := ""
	flush := func() bool {
		if data == "" {
			return false
		}
		if eventType == "" {
			eventType = "status"
		}
		parsed := parseSSEData(data)
		event := map[string]any{"type": eventType, "data": parsed}
		if eventID != "" {
			event["id"] = eventID
		}
		events = append(events, event)
		statusData := objectValue(parsed)
		stop := false
		if status := stringValue(statusData["status"]); status != "" {
			fmt.Fprintln(os.Stderr, "Status: "+status)
			if status == "deleted" || status == "error" {
				stop = true
			}
		} else if action := stringValue(statusData["action"]); action != "" {
			message := stringValue(statusData["message"])
			if message != "" {
				fmt.Fprintln(os.Stderr, "Event: "+action+" - "+message)
			} else {
				fmt.Fprintln(os.Stderr, "Event: "+action)
			}
		} else {
			_, _ = fmt.Fprintln(os.Stdout, data)
		}
		eventType, eventID, data = "", "", ""
		return stop
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event: "))
		case strings.HasPrefix(line, "id: "):
			eventID = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
		case strings.HasPrefix(line, "data: "):
			data = strings.TrimPrefix(line, "data: ")
		case line == "" && data != "":
			if flush() {
				return events, nil
			}
		}
	}
	if flush() {
		return events, nil
	}
	return events, scanner.Err()
}

func terminalSize(colsOpt, rowsOpt int) (int, int) {
	cols, rows := colsOpt, rowsOpt
	if cols <= 0 || rows <= 0 {
		if width, height, err := workspaceTerminalGetSize(int(os.Stdout.Fd())); err == nil {
			if cols <= 0 {
				cols = width
			}
			if rows <= 0 {
				rows = height
			}
		}
	}
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 40
	}
	return cols, rows
}

func runWorkspaceTerminal(owner, repo, sessionID string, cols, rows int) error {
	auth, err := RequireAuthToken(nil)
	if err != nil {
		return err
	}
	wsBase := strings.Replace(strings.Replace(auth.APIURL, "https:", "wss:", 1), "http:", "ws:", 1)
	wsURL := fmt.Sprintf("%s/api/repos/%s/%s/workspace/sessions/%s/terminal", wsBase, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(sessionID))
	header := http.Header{}
	header.Set("Authorization", "token "+auth.Token)
	header.Set("Origin", auth.APIURL)
	conn, _, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{HTTPHeader: header}) //nolint:bodyclose // websocket.Dial closes the handshake response body
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	if workspaceIsTerminal(int(os.Stdin.Fd())) {
		oldState, err := workspaceMakeRaw(int(os.Stdin.Fd()))
		if err == nil {
			defer func() { _ = workspaceRestoreTerminal(int(os.Stdin.Fd()), oldState) }()
		}
	}
	init, _ := json.Marshal(map[string]any{"type": "resize", "cols": cols, "rows": rows})
	_ = workspaceTerminalWrite(context.Background(), conn, websocket.MessageText, init)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 2)
	// Resolve the terminal seams (including the input reader, which reads the
	// global os.Stdin) on this goroutine BEFORE spawning the reader goroutine,
	// so the goroutine never touches os.Stdin / the mutable package vars
	// concurrently with a caller (or test) swapping them.
	termWrite := workspaceTerminalWrite
	input := workspaceTerminalInput()
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := input.Read(buf)
			if n > 0 {
				if err := termWrite(ctx, conn, websocket.MessageBinary, buf[:n]); err != nil {
					errCh <- err
					return
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					errCh <- nil
				} else {
					errCh <- readErr
				}
				return
			}
		}
	}()
	go func() {
		for {
			messageType, data, readErr := conn.Read(ctx)
			if readErr != nil {
				errCh <- nil
				return
			}
			if messageType == websocket.MessageBinary {
				_, _ = os.Stdout.Write(data)
				continue
			}
			var msg map[string]any
			if json.Unmarshal(data, &msg) == nil && msg["type"] == "status" {
				status := stringValue(msg["status"])
				if status == "stopped" || status == "failed" {
					errCh <- nil
					return
				}
				continue
			}
			_, _ = os.Stdout.Write(data)
		}
	}()
	err = <-errCh
	cancel()
	return err
}

func getClaudeAuthEnv() map[string]string {
	if token := strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")); token != "" {
		return map[string]string{"ANTHROPIC_AUTH_TOKEN": token}
	}
	if token, _ := LoadStoredToken(claudeSetupTokenStorageKey); strings.TrimSpace(token) != "" {
		token = strings.TrimSpace(token)
		return map[string]string{"ANTHROPIC_AUTH_TOKEN": token}
	}
	if token := loadClaudeOAuthAccessTokenFromKeychain(); token != "" {
		return map[string]string{"ANTHROPIC_AUTH_TOKEN": token}
	}
	if key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")); key != "" {
		return map[string]string{"ANTHROPIC_API_KEY": key}
	}
	return nil
}

type claudeCodeKeychainPayload struct {
	ClaudeAIOAuth struct {
		AccessToken string `json:"accessToken"`
		// ExpiresAt is epoch MILLISECONDS, as written by Claude Code. Zero means
		// the field was absent (older/other payload shapes) — treated as "no
		// expiry info", so the token is kept for backward compatibility.
		ExpiresAt int64 `json:"expiresAt"`
	} `json:"claudeAiOauth"`
}

// claudeKeychainAccessToken returns the keychain OAuth token only when it is
// present AND not known-expired, so getClaudeAuthEnv falls through to
// ANTHROPIC_API_KEY instead of seeding a dead token into the remote agent.
func claudeKeychainAccessToken(parsed claudeCodeKeychainPayload) string {
	token := strings.TrimSpace(parsed.ClaudeAIOAuth.AccessToken)
	if token == "" {
		return ""
	}
	if expiresAt := parsed.ClaudeAIOAuth.ExpiresAt; expiresAt > 0 && expiresAt <= time.Now().UnixMilli() {
		return ""
	}
	return token
}

// Test-only replacements for the Claude keychain item and ~/.codex/auth.json.
// Production code never sets them.
var (
	testClaudeKeychainPayload string
	testCodexAuthJSON         string
)

func loadClaudeOAuthAccessTokenFromKeychain() string {
	if payload := strings.TrimSpace(testClaudeKeychainPayload); payload != "" {
		var parsed claudeCodeKeychainPayload
		if json.Unmarshal([]byte(payload), &parsed) == nil {
			return claudeKeychainAccessToken(parsed)
		}
		return ""
	}
	if workspaceRuntimeGOOS != "darwin" {
		return ""
	}
	out, err := exec.Command("security", "find-generic-password", "-s", claudeCodeKeychainService, "-w").Output()
	if err != nil {
		return ""
	}
	rawPassword := strings.TrimSpace(string(out))
	if rawPassword == "" {
		return ""
	}
	var parsed claudeCodeKeychainPayload
	if json.Unmarshal([]byte(rawPassword), &parsed) != nil {
		return ""
	}
	return claudeKeychainAccessToken(parsed)
}

func runWorkspaceIssue(ctx *incur.CommandContext) (any, error) {
	owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
	if err != nil {
		return nil, err
	}
	issueNumber, err := strconv.Atoi(stringValue(ctx.Args["number"]))
	if err != nil || issueNumber <= 0 {
		return nil, fmt.Errorf("invalid issue number")
	}
	issue, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/issues/%d", owner, repo, issueNumber), nil, nil)
	if err != nil {
		return nil, err
	}
	issueRecord := objectValue(issue)
	ws, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/workspaces", owner, repo), map[string]any{"name": fmt.Sprintf("issue-%d", issueNumber)}, nil)
	if err != nil {
		return nil, err
	}
	workspaceID := stringValue(objectValue(ws)["id"])
	sshInfo, err := waitForWorkspaceSSHInfoForCommand(owner, repo, workspaceID)
	if err != nil {
		return nil, err
	}
	sshCommand := getWorkspaceSSHCommand(sshInfo)
	if sshCommand == "" {
		return nil, fmt.Errorf("workspace %s did not return an SSH command", workspaceID)
	}
	if err := ensureWorkspaceClaudeAuth(sshCommand); err != nil {
		return nil, err
	}
	labels := []string{}
	for _, label := range arrayValue(issueRecord["labels"]) {
		if name := stringValue(objectValue(label)["name"]); name != "" {
			labels = append(labels, name)
		}
	}
	promptLines := []string{
		fmt.Sprintf("Fix issue #%d: %s", issueNumber, stringValue(issueRecord["title"])),
	}
	if len(labels) > 0 {
		promptLines = append(promptLines, "Labels: "+strings.Join(labels, ", "))
	}
	promptLines = append(promptLines, "", stringValue(issueRecord["body"]), "", "When done, commit your changes with jj. Do not create a landing request - that will be handled automatically after you exit.")
	prompt := strings.Join(promptLines, "\n")
	if err := runWorkspaceClaudeCommand(sshCommand, prompt); err != nil {
		return nil, err
	}
	target := stringValue(ctx.Options["target"])
	if target == "" {
		target = "main"
	}
	changeIDs, err := listWorkspaceChangeIDs(sshCommand, target)
	if err != nil {
		return nil, err
	}
	if len(changeIDs) == 0 {
		return map[string]any{"workspace_id": workspaceID, "issue": issueNumber, "status": "completed", "message": fmt.Sprintf("Claude Code session ended. No non-empty changes were detected relative to %s, so no landing request was created.", target)}, nil
	}
	landing, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/landings", owner, repo), map[string]any{
		"title":           fmt.Sprintf("fix: %s (#%d)", stringValue(issueRecord["title"]), issueNumber),
		"body":            fmt.Sprintf("Closes #%d\n\n%s", issueNumber, stringValue(issueRecord["body"])),
		"target_bookmark": target,
		"change_ids":      changeIDs,
	}, nil)
	if err != nil {
		return map[string]any{"workspace_id": workspaceID, "change_ids": changeIDs, "issue": issueNumber, "status": "completed", "message": "Claude Code session ended, but the landing request could not be created: " + err.Error()}, nil
	}
	return map[string]any{"workspace_id": workspaceID, "landing_request": objectValue(landing)["number"], "change_ids": changeIDs, "issue": issueNumber, "status": "completed"}, nil
}

func buildWorkspaceBootstrapScript() string {
	return strings.Join([]string{
		"if ! command -v jj >/dev/null 2>&1; then",
		`  echo "jj is not installed and node bootstrap is unavailable in this workspace." >&2`,
		"  exit 1",
		"fi",
		"cd " + shellEscape(defaultWorkspaceRemoteRoot),
		"if [ ! -d .jj ]; then",
		"  jj git init >/dev/null 2>&1",
		"fi",
	}, "\n")
}

func buildWorkspaceNodeBootstrapScript() string {
	return strings.Join([]string{
		"install -d -o " + shellEscape(defaultRemoteWorkspaceUser) + " -g " + shellEscape(defaultRemoteWorkspaceUser) + " -m 700 " + shellEscape(defaultRemoteClaudeAuthDir),
		"install -d -o " + shellEscape(defaultRemoteWorkspaceUser) + " -g " + shellEscape(defaultRemoteWorkspaceUser) + " -m 755 " + shellEscape(defaultRemoteLocalRoot),
		"install -d -o " + shellEscape(defaultRemoteWorkspaceUser) + " -g " + shellEscape(defaultRemoteWorkspaceUser) + " -m 755 " + shellEscape(defaultRemoteLocalBinDir),
		"if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then",
		`  echo "Node.js and npm must be on PATH in the workspace image to install Claude Code." >&2`,
		"  exit 1",
		"fi",
	}, "\n")
}

// getCodexAuthContent mirrors getClaudeAuthEnv: it resolves local Codex CLI
// credentials to seed onto a workspace. Codex stores its credentials as a
// JSON file (~/.codex/auth.json) rather than shell-exported env vars, so its
// result shape differs from getClaudeAuthEnv, but the precedence mirrors it
// (explicit local credentials file first, then a locally-set API key).
func getCodexAuthContent() (string, bool) {
	if raw := readLocalCodexAuthFile(); raw != "" {
		return raw, true
	}
	if key := strings.TrimSpace(os.Getenv("OPENAI_API_KEY")); key != "" {
		payload, err := workspaceJSONMarshal(map[string]any{"OPENAI_API_KEY": key})
		if err != nil {
			return "", false
		}
		return string(payload), true
	}
	return "", false
}

func readLocalCodexAuthFile() string {
	if raw := strings.TrimSpace(testCodexAuthJSON); raw != "" {
		return raw
	}
	home, err := workspaceUserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// buildCodexAuthSeedRemoteScript mirrors buildClaudeAuthSeedRemoteScript's
// structure/quoting: it installs the remote ~/.codex directory and writes the
// resolved local auth.json content into ~/.codex/auth.json with mode 0600.
func buildCodexAuthSeedRemoteScript(authContent string) string {
	return strings.Join([]string{
		"set -euo pipefail",
		"install -d -o " + shellEscape(defaultRemoteWorkspaceUser) + " -g " + shellEscape(defaultRemoteWorkspaceUser) + " -m 700 " + shellEscape(defaultRemoteCodexAuthDir),
		"printf '%s' " + shellEscape(authContent) + " > " + shellEscape(defaultRemoteCodexAuthFile),
		"chown " + shellEscape(defaultRemoteWorkspaceUser) + ":" + shellEscape(defaultRemoteWorkspaceUser) + " " + shellEscape(defaultRemoteCodexAuthFile),
		"chmod 600 " + shellEscape(defaultRemoteCodexAuthFile),
	}, "\n")
}

// parseSeedAgentAuthList parses a comma-separated --seed-agent-auth value
// (e.g. "claude,codex") into a normalized, de-duplicated list.
func parseSeedAgentAuthList(raw string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		agent := strings.ToLower(strings.TrimSpace(part))
		if agent == "" || seen[agent] {
			continue
		}
		seen[agent] = true
		out = append(out, agent)
	}
	return out
}

// seedWorkspaceAgentAuth seeds local agent credentials onto a workspace for
// each requested agent (claude, codex) before running a command there.
func seedWorkspaceAgentAuth(sshCommand string, agents []string) error {
	for _, agent := range agents {
		switch agent {
		case "claude":
			authEnv := getClaudeAuthEnv()
			if len(authEnv) == 0 {
				return fmt.Errorf("Claude Code auth is not available locally (set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY, or run `smithers auth claude login`)")
			}
			if err := runRemoteProvisionCommand(sshCommand, buildClaudeAuthSeedRemoteScript(authEnv), "claude auth seed"); err != nil {
				return err
			}
		case "codex":
			authContent, ok := getCodexAuthContent()
			if !ok {
				return fmt.Errorf("Codex auth is not available locally (set OPENAI_API_KEY, or log in with the Codex CLI to populate ~/.codex/auth.json)")
			}
			if err := runRemoteProvisionCommand(sshCommand, buildCodexAuthSeedRemoteScript(authContent), "codex auth seed"); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unknown --seed-agent-auth value %q (expected claude, codex)", agent)
		}
	}
	return nil
}

func buildClaudeAuthSeedRemoteScript(authEnv map[string]string) string {
	exports := make([]string, 0, len(authEnv))
	for key, value := range authEnv {
		exports = append(exports, "export "+key+"="+shellEscape(value))
	}
	sortStrings(exports)
	quotedExports := make([]string, 0, len(exports))
	for _, line := range exports {
		quotedExports = append(quotedExports, shellEscape(line))
	}
	return strings.Join([]string{
		"set -euo pipefail",
		"install -d -o " + shellEscape(defaultRemoteWorkspaceUser) + " -g " + shellEscape(defaultRemoteWorkspaceUser) + " -m 700 " + shellEscape(defaultRemoteClaudeAuthDir),
		"printf '%s\\n' " + strings.Join(quotedExports, " ") + " > " + shellEscape(defaultRemoteClaudeAuthFile),
		"chown " + shellEscape(defaultRemoteWorkspaceUser) + ":" + shellEscape(defaultRemoteWorkspaceUser) + " " + shellEscape(defaultRemoteClaudeAuthFile),
		"chmod 600 " + shellEscape(defaultRemoteClaudeAuthFile),
	}, "\n")
}

func buildClaudeRemoteScript(prompt string) string {
	promptEncoded := base64.StdEncoding.EncodeToString([]byte(prompt))
	claudeInstallScript := strings.Join([]string{
		"set -euo pipefail",
		"export PATH=" + shellEscape(defaultRemoteDeveloperPath),
		"export NPM_CONFIG_PREFIX=" + shellEscape(defaultRemoteLocalRoot),
		"npm install -g " + shellEscape(defaultClaudeCodePackage) + " >" + shellEscape(defaultRemoteClaudeInstallLog) + " 2>&1",
	}, "\n")
	developerScript := strings.Join([]string{
		"set -euo pipefail",
		"export PATH=" + shellEscape(defaultRemoteDeveloperPath) + ":$PATH",
		`export TERM="${TERM:-dumb}"`,
		`export CI="${CI:-1}"`,
		"if ! command -v claude >/dev/null 2>&1; then",
		`  echo "Claude Code CLI was installed, but its binary is still not on PATH." >&2`,
		"  exit 1",
		"fi",
		"if [ -f " + shellEscape(defaultRemoteClaudeAuthFile) + " ]; then",
		"  . " + shellEscape(defaultRemoteClaudeAuthFile),
		"fi",
		`if [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then`,
		`  echo "Claude Code auth is not configured in the workspace. Run smithers auth claude login, or set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY locally and rerun smithers workspace issue." >&2`,
		"  exit 1",
		"fi",
		"prompt=\"$(cat " + shellEscape(defaultRemotePromptFile) + ")\"",
		"cd " + shellEscape(defaultWorkspaceRemoteRoot),
		`exec </dev/null claude -p --dangerously-skip-permissions --no-session-persistence --output-format json "$prompt"`,
	}, "\n")
	return strings.Join([]string{
		"set -euo pipefail",
		buildWorkspaceBootstrapScript(),
		buildWorkspaceNodeBootstrapScript(),
		"chown -R " + shellEscape(defaultRemoteWorkspaceUser) + ":" + shellEscape(defaultRemoteWorkspaceUser) + " " + shellEscape(defaultWorkspaceRemoteRoot),
		"chown -R " + shellEscape(defaultRemoteWorkspaceUser) + ":" + shellEscape(defaultRemoteWorkspaceUser) + " " + shellEscape(defaultRemoteClaudeAuthDir),
		"if [ ! -x " + shellEscape(defaultRemoteLocalBinDir+"/claude") + " ]; then",
		"  if command -v runuser >/dev/null 2>&1; then",
		"    runuser -u " + shellEscape(defaultRemoteWorkspaceUser) + " -- env -i HOME=" + shellEscape("/home/developer") + " USER=" + shellEscape(defaultRemoteWorkspaceUser) + " LOGNAME=" + shellEscape(defaultRemoteWorkspaceUser) + " PATH=" + shellEscape(defaultRemoteDeveloperPath) + " TERM=" + shellEscape("dumb") + " CI=" + shellEscape("1") + " bash -lc " + shellEscape(claudeInstallScript),
		"  else",
		"    su - " + shellEscape(defaultRemoteWorkspaceUser) + " -c " + shellEscape(claudeInstallScript),
		"  fi",
		"fi",
		"node -e " + shellEscape(`process.stdout.write(Buffer.from(process.argv[1], "base64").toString("utf8"));`) + " " + shellEscape(promptEncoded) + " > " + shellEscape(defaultRemotePromptFile),
		"chown -R " + shellEscape(defaultRemoteWorkspaceUser) + ":" + shellEscape(defaultRemoteWorkspaceUser) + " " + shellEscape(defaultRemoteLocalRoot),
		"chown " + shellEscape(defaultRemoteWorkspaceUser) + ":" + shellEscape(defaultRemoteWorkspaceUser) + " " + shellEscape(defaultRemotePromptFile),
		"chmod 600 " + shellEscape(defaultRemotePromptFile),
		"if command -v runuser >/dev/null 2>&1; then",
		"  exec runuser -u " + shellEscape(defaultRemoteWorkspaceUser) + " -- env -i HOME=" + shellEscape("/home/developer") + " USER=" + shellEscape(defaultRemoteWorkspaceUser) + " LOGNAME=" + shellEscape(defaultRemoteWorkspaceUser) + " PATH=" + shellEscape(defaultRemoteDeveloperPath) + " TERM=" + shellEscape("dumb") + " CI=" + shellEscape("1") + " bash -lc " + shellEscape(developerScript),
		"fi",
		"exec su - " + shellEscape(defaultRemoteWorkspaceUser) + " -c " + shellEscape(developerScript),
	}, "\n")
}

func buildClaudeDiagnosticsRemoteScript() string {
	developerEnvProbe := strings.Join([]string{
		"set +e",
		`printf "PATH=%s\n" "$PATH"`,
		"command -v node || true",
		"node --version || true",
		"command -v npm || true",
		"npm --version || true",
		"command -v claude || true",
		"claude --version || true",
	}, "\n")
	return strings.Join([]string{
		"set +e",
		`echo "claude_processes:"`,
		"ps -eo pid=,ppid=,stat=,wchan=,etime=,time=,comm=,args= | grep -E '[c]laude|[r]unuser|[s]u -' || true",
		`echo "\nworkspace_files:"`,
		"ls -ld " + shellEscape(defaultRemoteLocalRoot) + " " + shellEscape(defaultRemoteLocalBinDir) + " " + shellEscape(defaultRemoteClaudeAuthDir) + " " + shellEscape(defaultRemotePromptFile) + " " + shellEscape(defaultRemoteClaudeAuthFile) + " 2>/dev/null || true",
		"ls -l " + shellEscape(defaultRemoteLocalBinDir+"/node") + " " + shellEscape(defaultRemoteLocalBinDir+"/npm") + " " + shellEscape(defaultRemoteLocalBinDir+"/claude") + " 2>/dev/null || true",
		`echo "\ndeveloper_env:"`,
		"if command -v runuser >/dev/null 2>&1; then",
		"  runuser -u " + shellEscape(defaultRemoteWorkspaceUser) + " -- env -i HOME=" + shellEscape("/home/developer") + " USER=" + shellEscape(defaultRemoteWorkspaceUser) + " LOGNAME=" + shellEscape(defaultRemoteWorkspaceUser) + " PATH=" + shellEscape(defaultRemoteDeveloperPath) + " TERM=" + shellEscape("dumb") + " CI=" + shellEscape("1") + " bash -lc " + shellEscape(developerEnvProbe) + " || true",
		"else",
		"  su - " + shellEscape(defaultRemoteWorkspaceUser) + " -c " + shellEscape(developerEnvProbe) + " || true",
		"fi",
		`echo "\nclaude_install_log:"`,
		"tail -n 80 " + shellEscape(defaultRemoteClaudeInstallLog) + " 2>/dev/null || true",
	}, "\n")
}

func buildChangeIDListRemoteScript(target string) string {
	target = strings.ReplaceAll(strings.ReplaceAll(target, `\`, `\\`), `"`, `\"`)
	revset := fmt.Sprintf(`(::@ ~ ::present(bookmarks(exact:"%s"))) ~ empty()`, target)
	return strings.Join([]string{
		"set -euo pipefail",
		buildWorkspaceBootstrapScript(),
		"jj log -r " + shellEscape(revset) + " --reversed --no-graph -T " + shellEscape("change_id ++ \"\\n\""),
	}, "\n")
}

func runWorkspaceClaudeCommand(sshCommand, prompt string) error {
	if err := runRemoteInteractiveCommand(sshCommand, buildClaudeRemoteScript(prompt), "claude"); err != nil {
		detail := err.Error()
		diagnostics, diagnosticErr := runRemoteCaptureCommand(sshCommand, buildClaudeDiagnosticsRemoteScript(), "claude diagnostics")
		if diagnosticErr != nil {
			return fmt.Errorf("%s\n\nWorkspace diagnostics failed: %s", detail, diagnosticErr.Error())
		}
		diagnostics = strings.TrimSpace(diagnostics)
		if diagnostics != "" {
			return fmt.Errorf("%s\n\nWorkspace diagnostics:\n%s", detail, diagnostics)
		}
		return err
	}
	return nil
}

func ensureWorkspaceClaudeAuth(sshCommand string) error {
	authEnv := getClaudeAuthEnv()
	if len(authEnv) > 0 {
		return runRemoteProvisionCommand(sshCommand, buildClaudeAuthSeedRemoteScript(authEnv), "claude auth bootstrap")
	}
	stdout, err := runRemoteCaptureCommand(sshCommand, "if [ -f "+shellEscape(defaultRemoteClaudeAuthFile)+" ]; then printf ready; fi", "claude auth check")
	if err != nil {
		return err
	}
	if strings.TrimSpace(stdout) == "ready" {
		return nil
	}
	return fmt.Errorf("Claude Code auth is not configured. Run `smithers auth claude login`, or set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY locally and rerun `smithers workspace issue`.")
}

func listWorkspaceChangeIDs(sshCommand, target string) ([]string, error) {
	out, err := runRemoteCaptureCommand(sshCommand, buildChangeIDListRemoteScript(target), "jj log")
	if err != nil {
		return nil, err
	}
	lines := []string{}
	for _, line := range strings.Split(out, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines, nil
}

func randomMarkerID() string {
	var raw [16]byte
	if _, err := workspaceRandRead(raw[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(raw[:])
}

func buildRemoteShellSessionScript(beginMarker, endMarker, script string) string {
	return strings.Join([]string{
		"stty -echo",
		"exec 2>&1",
		"export PROMPT_COMMAND=",
		"export PS1='__SMITHERS_PROMPT__ '",
		"printf '" + beginMarker + "\\n'",
		"(",
		script,
		")",
		"__smithers_status=$?",
		"printf '\\n" + endMarker + ":%s\\n' \"$__smithers_status\"",
		`exit "$__smithers_status"`,
	}, "\n") + "\n"
}

func stripANSI(value string) string {
	ansiPattern := regexp.MustCompile("\x1b\\][^\x07]*(?:\x07|\x1b\\\\)|\x1b\\[[0-?]*[ -/]*[@-~]")
	clean := ansiPattern.ReplaceAllString(value, "")
	return strings.ReplaceAll(clean, "\r", "")
}

func extractRemoteShellOutput(rawOutput, beginMarker, endMarker string) (int, string) {
	normalized := stripANSI(rawOutput)
	beginPattern := beginMarker + "\n"
	beginIndex := strings.Index(normalized, beginPattern)
	if beginIndex == -1 {
		return -1, strings.TrimSpace(normalized)
	}
	afterBegin := normalized[beginIndex+len(beginPattern):]
	endPattern := regexp.MustCompile(`(?:^|\n)` + regexp.QuoteMeta(endMarker) + `:(\d+)\n?`)
	match := endPattern.FindStringSubmatchIndex(afterBegin)
	if match == nil {
		return -1, strings.TrimSpace(afterBegin)
	}
	exitCode := -1
	if len(match) >= 4 {
		if parsed, err := strconv.Atoi(afterBegin[match[2]:match[3]]); err == nil {
			exitCode = parsed
		}
	}
	output := afterBegin[:match[0]]
	output = strings.TrimLeft(output, "\n")
	output = strings.TrimRight(output, "\n")
	return exitCode, output
}

func remoteShellTimeout(name string, fallback time.Duration) time.Duration {
	return parsePositiveDurationEnv(name, fallback)
}

func runRemoteShellCommand(sshCommand, script, label string, streamOutputToStderr bool, timeout time.Duration) (string, error) {
	markerID := randomMarkerID()
	beginMarker := "__SMITHERS_BEGIN_" + markerID + "__"
	endMarker := "__SMITHERS_END_" + markerID + "__"
	sshArgs, sshErr := buildSSHInvocationArgs(sshCommand, true)
	if sshErr != nil {
		return "", sshErr
	}
	if len(sshArgs) == 0 {
		return "", fmt.Errorf("workspace ssh command was empty")
	}
	sessionScript := buildRemoteShellSessionScript(beginMarker, endMarker, script)
	cmd := exec.Command(sshArgs[0], sshArgs[1:]...)
	cmd.Stdin = strings.NewReader(sessionScript)
	var stdout strings.Builder
	var stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	var err error
	timedOut := false
	select {
	case err = <-done:
	case <-time.After(timeout):
		timedOut = true
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		err = <-done
	}
	rawStdout := stdout.String()
	rawStderr := stderr.String()
	if timedOut {
		seconds := int((timeout + time.Second - 1) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		return "", fmt.Errorf("%s timed out after %ds", label, seconds)
	}
	exitCode := 0
	if err != nil {
		if code, ok := workspaceExitErrorCode(err); ok {
			exitCode = code
		} else {
			return "", err
		}
	}
	shellExitCode, output := extractRemoteShellOutput(rawStdout, beginMarker, endMarker)
	if shellExitCode >= 0 {
		exitCode = shellExitCode
	} else if strings.TrimSpace(output) == "" {
		output = strings.TrimSpace(rawStdout)
	}
	if streamOutputToStderr && strings.TrimSpace(output) != "" {
		fmt.Fprintln(os.Stderr, output)
	}
	if exitCode != 0 {
		detail := strings.TrimSpace(output)
		if detail == "" {
			detail = strings.TrimSpace(rawStderr)
		}
		if detail == "" {
			detail = fmt.Sprintf("%s exited with code %d", label, exitCode)
		}
		return "", fmt.Errorf("%s", detail)
	}
	return output, nil
}

func runRemoteCaptureCommand(sshCommand, script, label string) (string, error) {
	return runRemoteShellCommand(sshCommand, script, label, false, remoteShellTimeout("SMITHERS_WORKSPACE_REMOTE_COMMAND_TIMEOUT_MS", defaultWorkspaceRemoteCommandTimeout))
}

func runRemoteProvisionCommand(sshCommand, script, label string) error {
	_, err := runRemoteCaptureCommand(sshCommand, script, label)
	return err
}

func runRemoteInteractiveCommand(sshCommand, script, label string) error {
	_, err := runRemoteShellCommand(sshCommand, script, label, true, remoteShellTimeout("SMITHERS_WORKSPACE_CLAUDE_TIMEOUT_MS", defaultWorkspaceClaudeTimeout))
	return err
}

// runRemoteStreamedCommand runs a single remote command over BatchMode SSH,
// streaming stdout/stderr straight through to this process's stdout/stderr as
// it runs (unlike runRemoteShellCommand, which buffers into strings.Builder
// and dumps output only after the command exits). It is a thin wrapper
// around the same SSH-invocation building block (buildSSHInvocationArgs) that
// runRemoteCaptureCommand/runRemoteInteractiveCommand use, but skips their
// marker-based session-script framing (needed there to strip PS1 prompts out
// of an interactive shell) since a single non-interactive remote command can
// propagate its exit code directly through ssh's own exit status.
func runRemoteStreamedCommand(sshCommand, script string, timeout time.Duration) (int, error) {
	sshArgs, err := buildSSHInvocationArgs(sshCommand, false)
	if err != nil {
		return -1, err
	}
	if len(sshArgs) == 0 {
		return -1, fmt.Errorf("workspace ssh command was empty")
	}
	args := append(append([]string{}, sshArgs...), script)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin = nil
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			return 0, nil
		}
		if code, ok := workspaceExitErrorCode(err); ok {
			return code, nil
		}
		return -1, err
	case <-time.After(timeout):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done
		seconds := int((timeout + time.Second - 1) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		return -1, fmt.Errorf("workspace exec timed out after %ds", seconds)
	}
}

func sortStrings(values []string) {
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
}
