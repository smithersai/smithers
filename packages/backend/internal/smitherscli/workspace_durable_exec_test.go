package smitherscli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

func TestWorkspaceExecReconnectDoesNotRepeatCommandOrOutput(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+home+":/bin/bash'\n"), 0700))
	calls := 0
	transport := func(ctx context.Context, script string) (string, error) {
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		calls++
		// Drop the launch acknowledgement, then truncate a read response. Both
		// represent real SSH loss after the guest has executed the request.
		if calls == 1 || calls == 3 {
			return string(out[:len(out)/2]), fmt.Errorf("SSH connection lost")
		}
		return string(out), err
	}
	var out, stderr bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	script := "echo once >> '" + filepath.Join(home, "calls") + "'; printf 'first\\n'; sleep .15; printf 'DONE\\n'; printf 'err\\n' >&2; exit 255"
	code, err := runDurableWorkspaceExec(ctx, "test-exec", script, transport, &out, &stderr, 10*time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, 255, code, "guest exit 255 is not a transport failure")
	require.Equal(t, "first\nDONE\n", out.String())
	require.Equal(t, "err\n", stderr.String())
	data, err := os.ReadFile(filepath.Join(home, "calls"))
	require.NoError(t, err)
	require.Equal(t, "once\n", string(data))
	require.Greater(t, calls, 3)
}

func TestWorkspaceExecDurableBinaryOutputAndReattach(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+home+":/bin/bash'\n"), 0700))
	transport := func(ctx context.Context, script string) (string, error) {
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	script := "printf '\\000\\377hello\\n'; printf problem >&2; exit 7"
	for range 2 {
		var out, stderr bytes.Buffer
		code, err := runDurableWorkspaceExec(context.Background(), "same-id", script, transport, &out, &stderr, time.Millisecond)
		require.NoError(t, err)
		require.Equal(t, 7, code)
		require.Equal(t, []byte{0, 255, 'h', 'e', 'l', 'l', 'o', '\n'}, out.Bytes())
		require.Equal(t, "problem", stderr.String())
	}
	var out bytes.Buffer
	_, err := runDurableWorkspaceExec(context.Background(), "same-id", "echo different", transport, &out, &out, time.Millisecond)
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "different command"), err)
	var conflict *WorkspaceExecConflictError
	require.True(t, errors.As(err, &conflict), err)
	require.Equal(t, "same-id", conflict.ID)
}

func TestWorkspaceExecRejectsConflictingCommandWhenStateDirectoryIsPartial(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+home+":/bin/bash'\n"), 0700))
	state := filepath.Join(home, ".local", "state", "smithers", "exec", "partial-id")
	require.NoError(t, os.MkdirAll(state, 0o700))
	transport := func(ctx context.Context, script string) (string, error) {
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out bytes.Buffer
	_, err := runDurableWorkspaceExec(ctx, "partial-id", "echo new", transport, &out, &out, time.Millisecond)
	var conflict *WorkspaceExecConflictError
	require.ErrorAs(t, err, &conflict)
}

func TestWorkspaceExecUsesLoginHomeWhenGuestHOMEIsUnwritable(t *testing.T) {
	home, inherited, bin := t.TempDir(), t.TempDir(), t.TempDir()
	require.NoError(t, os.Chmod(inherited, 0500))
	t.Cleanup(func() { _ = os.Chmod(inherited, 0700) })
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+home+":/bin/bash'\n"), 0700))
	transport := func(ctx context.Context, script string) (string, error) {
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + inherited, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var out, stderr bytes.Buffer
	code, err := runDurableWorkspaceExec(ctx, "login-home", "echo DONE", transport, &out, &stderr, time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, 0, code)
	require.Equal(t, "DONE\n", out.String())
	out.Reset()
	_, err = runDurableWorkspaceExec(ctx, "login-home", "echo DIFFERENT", transport, &out, &stderr, time.Millisecond)
	var conflict *WorkspaceExecConflictError
	require.ErrorAs(t, err, &conflict, "the login-home identity must survive an unwritable inherited HOME")
}

func TestWorkspaceExecUsesOneLoginHomeWhenGuestHOMEChanges(t *testing.T) {
	loginHome, firstHome, secondHome, thirdHome, bin := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+loginHome+":/bin/bash'\n"), 0700))
	phase, calls := 0, 0
	transport := func(ctx context.Context, script string) (string, error) {
		home := firstHome
		if phase == 0 && calls > 0 {
			home = secondHome
		} else if phase > 0 {
			home = thirdHome
		}
		calls++
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	var out, stderr bytes.Buffer
	code, err := runDurableWorkspaceExec(context.Background(), "stable-home", "printf first; sleep .2", transport, &out, &stderr, time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, 0, code)
	require.Equal(t, "first", out.String())

	phase = 1
	out.Reset()
	_, err = runDurableWorkspaceExec(context.Background(), "stable-home", "echo second", transport, &out, &stderr, time.Millisecond)
	var conflict *WorkspaceExecConflictError
	require.ErrorAs(t, err, &conflict)
}

func TestWorkspaceExecPreservesSSHProcessState(t *testing.T) {
	home := t.TempDir()
	workdir := t.TempDir()
	realWorkdir, err := filepath.EvalSymlinks(workdir)
	require.NoError(t, err)
	transport := func(ctx context.Context, script string) (string, error) {
		// The connection-bound SSH path runs the command in this shell process.
		// These values model state established by the guest login/session setup;
		// the detached runner must inherit them instead of installing its own
		// umask or changing the working directory.
		cmd := exec.CommandContext(ctx, "bash", "-c", "umask 022; ulimit -n 1234; "+script)
		cmd.Dir = workdir
		cmd.Env = append(os.Environ(), "SMITHERS_SESSION_ENV=present")
		for i, value := range cmd.Env {
			if strings.HasPrefix(value, "HOME=") {
				cmd.Env[i] = "HOME=" + home
				break
			}
		}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	var out, stderr bytes.Buffer
	code, err := runDurableWorkspaceExec(context.Background(), "session-state", "mode=; : > state-file; mode=$(ls -l state-file | cut -c1-10); printf 'umask=%s cwd=%s env=%s nofile=%s mode=%s\\n' \"$(umask)\" \"$PWD\" \"$SMITHERS_SESSION_ENV\" \"$(ulimit -n)\" \"$mode\"", transport, &out, &stderr, time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, 0, code)
	require.Equal(t, "umask=0022 cwd="+realWorkdir+" env=present nofile=1234 mode=-rw-r--r--\n", out.String())
}

func TestWorkspaceExecReportsGuestRestartBeforeReattaching(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+home+":/bin/bash'\n"), 0700))
	calls := 0
	transport := func(ctx context.Context, script string) (string, error) {
		calls++
		if calls == 2 {
			state := filepath.Join(home, ".local", "state", "smithers", "exec", "restarted")
			require.NoError(t, os.WriteFile(filepath.Join(state, "boot_id"), []byte("different-boot\n"), 0600))
		}
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	var out, stderr bytes.Buffer
	_, err := runDurableWorkspaceExec(context.Background(), "restarted", "sleep 10; echo DONE", transport, &out, &stderr, time.Millisecond)
	var lost *WorkspaceExecOutcomeLostError
	require.ErrorAs(t, err, &lost)
	require.Equal(t, "guest_restarted", lost.Reason)
	require.Contains(t, err.Error(), "command may have partially run")
	require.Less(t, calls, 10, "reattach must fail instead of polling until the timeout")
}

func TestWorkspaceExecReportsVanishedRunnerWithoutRelaunching(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+home+":/bin/bash'\n"), 0700))
	calls := 0
	transport := func(ctx context.Context, script string) (string, error) {
		calls++
		if calls == 2 {
			state := filepath.Join(home, ".local", "state", "smithers", "exec", "vanished")
			pidBytes, readErr := os.ReadFile(filepath.Join(state, "pid"))
			require.NoError(t, readErr)
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
			require.NoError(t, parseErr)
			_ = syscall.Kill(pid, syscall.SIGKILL)
			require.NoError(t, os.Remove(filepath.Join(state, "pid")))
		}
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	var out, stderr bytes.Buffer
	_, err := runDurableWorkspaceExec(context.Background(), "vanished", "sleep 10; echo DONE", transport, &out, &stderr, time.Millisecond)
	var lost *WorkspaceExecOutcomeLostError
	require.ErrorAs(t, err, &lost)
	require.Equal(t, "runner_gone", lost.Reason)
	require.Contains(t, err.Error(), "command may have partially run")
	require.Equal(t, 2, calls, "a vanished runner must not be relaunched")
}

func TestWorkspaceExecOutcomeLostGetsTypedCLIExit(t *testing.T) {
	err := workspaceExecCLIError(&WorkspaceExecOutcomeLostError{ID: "lost-id", Reason: "guest_restarted"})
	var incurErr *incur.IncurError
	require.ErrorAs(t, err, &incurErr)
	require.Equal(t, "WORKSPACE_EXEC_OUTCOME_LOST", incurErr.Code)
	require.Equal(t, 125, incurErr.ExitCode)
	require.Contains(t, incurErr.Message, "guest_restarted")
}

func TestWorkspaceExecReportsWipedStateWithoutRelaunching(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+home+":/bin/bash'\n"), 0700))
	state := filepath.Join(home, ".local", "state", "smithers", "exec", "wiped")
	calls := 0
	transport := func(ctx context.Context, script string) (string, error) {
		calls++
		if calls == 2 {
			// A guest rebuilt from its image loses the runner and its state.
			pidBytes, readErr := os.ReadFile(filepath.Join(state, "pid"))
			require.NoError(t, readErr)
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
			require.NoError(t, parseErr)
			_ = syscall.Kill(pid, syscall.SIGKILL)
			require.NoError(t, os.RemoveAll(state))
		}
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	var out, stderr bytes.Buffer
	_, err := runDurableWorkspaceExec(context.Background(), "wiped", "sleep 10; echo DONE", transport, &out, &stderr, time.Millisecond)
	var lost *WorkspaceExecOutcomeLostError
	require.ErrorAs(t, err, &lost)
	require.Equal(t, "state_gone", lost.Reason)
	require.Equal(t, 2, calls)
	_, statErr := os.Stat(state)
	require.True(t, os.IsNotExist(statErr), "an attached exec must not relaunch into a wiped guest")
}

// The guest SSH exec channel runs the request with `sh -c`, not a login
// shell, so nothing sources the runtime profile the worker writes for
// `--network proxy` guests. The detached runner must source it itself, or
// `npm ci` inside `smithers workspace exec` has no proxy route or MITM CA.
func TestWorkspaceExecSourcesGuestRuntimeProfile(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(t.TempDir(), "00-smithers-runtime.sh")
	require.NoError(t, os.WriteFile(profile, []byte(
		"export HTTPS_PROXY='http://host:3128' https_proxy='http://host:3128' NO_PROXY='localhost' NODE_EXTRA_CA_CERTS='/etc/smithers/egress-ca.pem'\n"+
			"export SMITHERS_PROFILE_OVERRIDE=profile\n"), 0o644))
	previous := workspaceRuntimeProfilePath
	workspaceRuntimeProfilePath = profile
	t.Cleanup(func() { workspaceRuntimeProfilePath = previous })
	transport := func(ctx context.Context, script string) (string, error) {
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	var out, stderr bytes.Buffer
	// The exec script's own env (from --env) is applied after the profile, as
	// it was after the login shell's profile.
	script := buildWorkspaceExecScript("printf '%s|%s|%s|%s|%s\\n' \"$HTTPS_PROXY\" \"$https_proxy\" \"$NO_PROXY\" \"$NODE_EXTRA_CA_CERTS\" \"$SMITHERS_PROFILE_OVERRIDE\"", home, []string{"SMITHERS_PROFILE_OVERRIDE=flag"})
	code, err := runDurableWorkspaceExec(context.Background(), "runtime-profile", script, transport, &out, &stderr, time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, 0, code, stderr.String())
	require.Equal(t, "http://host:3128|http://host:3128|localhost|/etc/smithers/egress-ca.pem|flag\n", out.String())
}

// The worker writes the runtime profile at this path on every egress guest,
// container and NixOS alike (internal/microsandbox/worker/runtime.go).
func TestWorkspaceExecRuntimeProfileIsGuestEgressProfile(t *testing.T) {
	require.Equal(t, sandbox.EgressProxyProfileGuestPath, workspaceRuntimeProfilePath)
}

// The runner image bakes HOME=/workspace plus XDG_*, NPM_CONFIG_* and PATH
// entries beneath it for its own uid, but workspace commands run as
// `developer`, who cannot write /workspace. On 2026-09-24 `npm ci` inside
// `smithers workspace exec` failed with EACCES on /workspace/.cache/npm. A
// login shell for developer lives in the passwd home, so the exec rebases every
// HOME-derived variable there, as the product's own developer commands do.
func TestWorkspaceExecRebasesUnwritableHomeOntoLoginHome(t *testing.T) {
	login := t.TempDir()
	baked := filepath.Join(t.TempDir(), "workspace")
	require.NoError(t, os.MkdirAll(filepath.Join(baked, ".local/npm/bin"), 0o755))
	require.NoError(t, os.Chmod(baked, 0o555))
	t.Cleanup(func() { _ = os.Chmod(baked, 0o755) })
	bin := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(bin, "getent"), []byte("#!/bin/sh\necho 'developer:x:1001:1001::"+login+":/bin/bash'\n"), 0o700))
	previous := workspaceRuntimeProfilePath
	workspaceRuntimeProfilePath = filepath.Join(t.TempDir(), "missing-profile.sh")
	t.Cleanup(func() { workspaceRuntimeProfilePath = previous })
	transport := func(ctx context.Context, script string) (string, error) {
		cmd := exec.CommandContext(ctx, "bash", "-c", script)
		cmd.Env = []string{
			"HOME=" + baked,
			"XDG_CACHE_HOME=" + baked + "/.cache",
			"NPM_CONFIG_CACHE=" + baked + "/.cache/npm",
			"GOROOT=/usr/local/go",
			"BAKED_SIBLING=" + baked + "-other",
			"PATH=" + bin + ":" + baked + "/.local/npm/bin:" + os.Getenv("PATH"),
		}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	var out, stderr bytes.Buffer
	script := buildWorkspaceExecScript(`printf '%s\n' "$HOME" "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE" "$GOROOT" "$BAKED_SIBLING" "$KEEP"; case ":$PATH:" in *":`+login+`/.local/npm/bin:"*) echo path-rebased;; esac`, login, []string{"KEEP=" + baked + "/explicit"})
	code, err := runDurableWorkspaceExec(context.Background(), "rebase-home", script, transport, &out, &stderr, time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, 0, code, stderr.String())
	require.Equal(t, strings.Join([]string{
		login, login + "/.cache", login + "/.cache/npm", "/usr/local/go", baked + "-other",
		baked + "/explicit", "path-rebased", "",
	}, "\n"), out.String())
}
