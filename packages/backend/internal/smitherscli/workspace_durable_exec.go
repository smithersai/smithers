package smitherscli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// WorkspaceExecConflictError is returned when an exec ID is already bound to
// a different command. Callers can use errors.As to distinguish this durable
// identity conflict from transport and guest-command failures.
type WorkspaceExecConflictError struct {
	ID string
}

func (e *WorkspaceExecConflictError) Error() string {
	return fmt.Sprintf("exec id %s already belongs to a different command", e.ID)
}

// WorkspaceExecOutcomeLostError means the guest can no longer prove whether a
// detached command finished. The command may have partially run; callers must
// not retry it automatically. Reason is guest_restarted (the boot ID changed),
// runner_gone (no runner and no exit record), or state_gone (the guest lost
// the command's state after this client saw it).
type WorkspaceExecOutcomeLostError struct {
	ID     string
	Reason string
}

func (e *WorkspaceExecOutcomeLostError) Error() string {
	return fmt.Sprintf("exec_outcome_lost: %s for exec id %s; command may have partially run", e.Reason, e.ID)
}

// workspaceRuntimeProfilePath is the guest profile that loads the
// per-sandbox egress bundle (HTTP(S)_PROXY, NO_PROXY, and the MITM CA
// variables) and the workspace Git environment. The worker writes it on
// every egress guest; login shells source it. See
// sandbox.EgressProxyProfileGuestPath.
var workspaceRuntimeProfilePath = "/etc/profile.d/00-smithers-runtime.sh"

// workspaceExecLoginHome moves an unwritable inherited HOME, and every
// variable and PATH entry beneath it, onto the account's writable passwd home.
// The runner image bakes HOME=/workspace with XDG_*, NPM_CONFIG_*, GOPATH,
// CARGO_HOME and PATH entries under it for its own uid; workspace commands run
// as developer, who cannot write /workspace, so npm, go and cargo fail with
// EACCES. A login shell for developer lives in /home/developer. Runs after the
// runtime profile and before the command's --env overrides; $home is the
// passwd home computed for the state directory.
const workspaceExecLoginHome = `if [ -n "$HOME" ] && [ ! -w "$HOME" ] && [ -n "$home" ] && [ "$home" != "$HOME" ] && [ -w "$home" ]; then ` +
	`old_home=$HOME; for k in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do eval "v=\${$k}"; ` +
	`case "$v" in "$old_home"|"$old_home"/*) export "$k=$home${v#"$old_home"}";; esac; done; ` +
	`new_path=; set -f; saved_ifs=$IFS; IFS=:; for p in $PATH; do case "$p" in "$old_home"|"$old_home"/*) p="$home${p#"$old_home"}";; esac; new_path="${new_path:+$new_path:}$p"; done; IFS=$saved_ifs; set +f; ` +
	`export PATH="$new_path"; unset old_home k v p new_path saved_ifs; fi; `

// Each SSH request is a disposable control connection. Only a complete frame
// advances the output cursors; an ambiguous launch acknowledgement is retried
// with the same ID. The guest owns the process and its exit status.
func runDurableWorkspaceExec(ctx context.Context, id, script string, transport func(context.Context, string) (string, error), stdout, stderr io.Writer, interval time.Duration) (int, error) {
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(script)))
	// SSH requests may arrive with different HOME values (for example, an
	// image entrypoint can set HOME while the login shell uses /etc/passwd).
	// Bind the durable identity to the account's login home so every request
	// reaches the same state directory. HOME remains a fallback for minimal
	// images without getent.
	stateDir := "home=$(getent passwd \"$(id -u)\" 2>/dev/null | cut -d: -f6); [ -n \"$home\" ] || home=$HOME; base=\"$home/.local/state/smithers/exec\"; "
	// The detached child is forked from the SSH session shell. Keep its
	// process state (umask, environment, cwd, resource limits, and so on)
	// exactly as established by that session; the old connection-bound exec
	// inherited all of these values.
	//
	// The SSH exec channel runs the request with `sh -c`, not a login shell,
	// so it never sources the runtime profile. Source it here, before the
	// command's own --env overrides, as the login shell does; otherwise a
	// `--network proxy` guest has no proxy route or MITM CA and `npm ci` fails.
	profile := shellEscape(workspaceRuntimeProfilePath)
	runner := stateDir + "mkdir -p \"$base\" || exit; d=\"$base/\"" + shellEscape(id) + "; mkdir -p \"$d\" || exit; printf %s " + shellEscape(digest) + " >\"$d/digest.tmp\"; mv \"$d/digest.tmp\" \"$d/digest\"; " +
		"if [ -r " + profile + " ]; then . " + profile + " >/dev/null 2>&1; fi; " + workspaceExecLoginHome +
		"bash -c " + shellEscape(script) + " </dev/null >\"$d/out\" 2>\"$d/err\"; rc=$?; printf '%s\\n' \"$rc\" >\"$d/exit.tmp\"; mv \"$d/exit.tmp\" \"$d/exit\""
	var outOffset, errOffset int64
	attached := false
	for {
		if err := ctx.Err(); err != nil {
			return -1, fmt.Errorf("workspace exec timed out or was interrupted; exec id %s (guest command continues; reattach with --exec-id): %w", id, err)
		}
		// A reattach verifies the boot ID recorded at launch and the runner PID.
		// Once this client has seen the command, a missing state directory means
		// the guest lost it; relaunching would run the command a second time.
		attachedTest := "false"
		if attached {
			attachedTest = "true"
		}
		request := stateDir + "if [ -z \"$home\" ] || ! mkdir -p \"$base\" 2>/dev/null; then printf 'ERROR: guest exec state directory is not writable\\n'; exit 0; fi; d=\"$base/\"" + shellEscape(id) + "; " +
			"current_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || hostname 2>/dev/null); if [ -z \"$current_boot\" ]; then printf 'ERROR: guest boot identity is unavailable\\n'; exit 0; fi; created=0; lost_reason=; " +
			"if [ -d \"$d\" ]; then if [ ! -f \"$d/digest\" ] || [ \"$(cat \"$d/digest\")\" != " + shellEscape(digest) + " ]; then printf 'CONFLICT\\n'; exit 0; fi; " +
			"elif " + attachedTest + "; then lost_reason=state_gone; " +
			"else if ! mkdir \"$d\" 2>/dev/null; then printf 'CONFLICT\\n'; exit 0; fi; created=1; printf %s " + shellEscape(digest) + " >\"$d/digest.tmp\" && mv \"$d/digest.tmp\" \"$d/digest\"; printf '%s\\n' \"$current_boot\" >\"$d/boot_id.tmp\" && mv \"$d/boot_id.tmp\" \"$d/boot_id\"; fi; " +
			// The runner writes exit before it ends, so re-read exit after a failed
			// liveness probe; a command launched by an older client has no boot ID.
			"if [ \"$created\" = 0 ] && [ -z \"$lost_reason\" ] && [ ! -f \"$d/exit\" ]; then if [ -f \"$d/boot_id\" ] && [ \"$(cat \"$d/boot_id\")\" != \"$current_boot\" ]; then lost_reason=guest_restarted; elif [ ! -f \"$d/pid\" ] || ! kill -0 \"$(cat \"$d/pid\")\" 2>/dev/null; then [ -f \"$d/exit\" ] || lost_reason=runner_gone; fi; fi; " +
			"if [ \"$created\" = 1 ]; then if mkdir \"$d/.launch\" 2>/dev/null; then detach=; command -v setsid >/dev/null 2>&1 && detach=setsid; nohup $detach bash -c " + shellEscape(runner) + " </dev/null >/dev/null 2>&1 & pid=$!; printf '%s\\n' \"$pid\" >\"$d/pid.tmp\"; mv \"$d/pid.tmp\" \"$d/pid\"; rmdir \"$d/.launch\" 2>/dev/null || true; fi; fi; " +
			"if [ -f \"$d/digest\" ] && [ \"$(cat \"$d/digest\")\" != " + shellEscape(digest) + " ]; then printf 'CONFLICT\\n'; exit 0; fi; " +
			"printf 'SMITHERS_EXEC_V1\\n'; if [ -n \"$lost_reason\" ]; then printf 'lost:%s\\n' \"$lost_reason\"; elif [ -f \"$d/exit\" ]; then cat \"$d/exit\"; else printf 'running\\n'; fi; " +
			fmt.Sprintf("if [ -f \"$d/out\" ]; then tail -c +%d \"$d/out\" | head -c 65536 | base64 | tr -d '\\n'; fi; printf '\\n'; ", outOffset+1) +
			fmt.Sprintf("if [ -f \"$d/err\" ]; then tail -c +%d \"$d/err\" | head -c 65536 | base64 | tr -d '\\n'; fi; printf '\\nEND\\n'", errOffset+1)
		response, err := transport(ctx, request)
		if err == nil {
			if strings.HasPrefix(response, "ERROR:") {
				return -1, fmt.Errorf("%s", strings.TrimSpace(response))
			}
			if strings.TrimSpace(response) == "CONFLICT" {
				return -1, &WorkspaceExecConflictError{ID: id}
			}
			fields := strings.Split(response, "\n")
			if len(fields) != 6 || fields[0] != "SMITHERS_EXEC_V1" || fields[4] != "END" || fields[5] != "" {
				return -1, fmt.Errorf("invalid workspace exec response for %s", id)
			}
			attached = true
			out, decodeErr := base64.StdEncoding.DecodeString(fields[2])
			if decodeErr != nil {
				return -1, decodeErr
			}
			errOut, decodeErr := base64.StdEncoding.DecodeString(fields[3])
			if decodeErr != nil {
				return -1, decodeErr
			}
			n, writeErr := stdout.Write(out)
			outOffset += int64(n)
			if writeErr != nil {
				return -1, writeErr
			}
			if n != len(out) {
				return -1, io.ErrShortWrite
			}
			n, writeErr = stderr.Write(errOut)
			errOffset += int64(n)
			if writeErr != nil {
				return -1, writeErr
			}
			if n != len(errOut) {
				return -1, io.ErrShortWrite
			}
			if strings.HasPrefix(fields[1], "lost:") {
				reason := strings.TrimPrefix(fields[1], "lost:")
				if reason == "" {
					reason = "unknown"
				}
				return -1, &WorkspaceExecOutcomeLostError{ID: id, Reason: reason}
			}
			if fields[1] != "running" && len(out) < 65536 && len(errOut) < 65536 {
				code, parseErr := strconv.Atoi(fields[1])
				if parseErr != nil || code < 0 || code > 255 {
					return -1, fmt.Errorf("invalid guest exit status")
				}
				return code, nil
			}
			if len(out) == 65536 || len(errOut) == 65536 {
				continue
			}
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

func runWorkspaceResumableCommandIO(sshCommand, id, script string, timeout time.Duration, stdin io.Reader, stdout, stderr io.Writer, refresh func() (string, error)) (int, error) {
	// Interactive input cannot be replayed. Preserve its streaming contract.
	if stdin != nil {
		return runRemoteStreamedCommandIO(sshCommand, script, timeout, stdin, stdout, stderr)
	}
	if id == "" {
		id = uuid.NewString()
	}
	// IDs are path components, even though all shell arguments are quoted.
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return -1, fmt.Errorf("invalid exec id")
		}
	}
	if len(id) > 128 {
		return -1, fmt.Errorf("exec id is too long")
	}
	ctx := context.Background()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	lastRefresh := time.Now()
	transport := func(ctx context.Context, request string) (string, error) {
		if refresh != nil && time.Since(lastRefresh) > time.Minute {
			if command, err := refresh(); err == nil && command != "" {
				sshCommand = command
				lastRefresh = time.Now()
			}
		}
		budget := 20 * time.Second
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < budget {
			budget = time.Until(deadline)
			if budget <= 0 {
				return "", ctx.Err()
			}
		}
		var out, diagnostic bytes.Buffer
		code, err := runRemoteStreamedCommandIO(sshCommand, request, budget, nil, &out, &diagnostic)
		if err != nil {
			return "", err
		}
		if code != 0 {
			lastRefresh = time.Time{}
			return "", fmt.Errorf("SSH control connection exited %d: %s", code, diagnostic.String())
		}
		return out.String(), nil
	}
	return runDurableWorkspaceExec(ctx, id, script, transport, stdout, stderr, time.Second)
}
