package services

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// localExec implements PairSandbox by running the agent command on the host via
// /bin/sh -c, instead of inside a sandbox provider VM. It is selected when
// SMITHERS_PAIR_LOCAL_AGENTS=true so real subscription CLIs (codex, claude, …)
// run directly on the operator's machine with their inherited credentials.
//
// The command string produced by buildPairAgentCommand uses POSIX shell
// features (;, >, pipes, `test -f`), so it must be run through a shell — the
// same way sandbox provider's Execute executes the command remotely.
type localExec struct {
	provider string
}

var localExecShell = "/bin/sh"

// Execute satisfies PairSandbox. vmID is ignored for the local path (it is
// always "" for execDispatcher{local:true}).
func (l localExec) Execute(ctx context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	// Honor the request timeout (matches the sandbox provider TimeoutMS contract).
	if req.TimeoutMS != nil && *req.TimeoutMS > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*req.TimeoutMS)*time.Millisecond)
		defer cancel()
	}

	cmd := exec.CommandContext(ctx, localExecShell, "-c", req.Command)
	// Local agents run with the host's inherited environment plus the
	// per-provider credentials, so a subscription CLI authenticates the same
	// way it would in an interactive shell.
	cmd.Env = append(os.Environ(), providerEnv(l.provider)...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	resp := sandbox.ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if cmd.ProcessState != nil {
		code := int32(cmd.ProcessState.ExitCode())
		resp.StatusCode = &code
	}
	// The command emits the Pair protocol and then exits with the agent's status.
	// If it exits non-zero, the captured stdout/stderr still carries the protocol
	// output; let execDispatcher parse it and turn the status into a Pair run
	// failure. Only a spawn / timeout / transport failure (not an ExitError) is
	// surfaced here, like the sandbox provider client on an HTTP failure.
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			return resp, nil
		}
		return resp, runErr
	}
	return resp, nil
}

// providerEnv returns the credential environment variables to add for a given
// provider when running locally. Only the API-key style of authentication is
// wired here; subscription-CLI auth relies on the inherited HOME/config dirs
// already present in os.Environ().
//
// CONFIRMED mapping (from smithers Account.ts / agent config-dir tests):
//   - claude  -> ANTHROPIC_API_KEY
//   - codex   -> OPENAI_API_KEY
//   - gemini  -> GEMINI_API_KEY
//   - kimi    -> KIMI_API_KEY (+ MOONSHOT_API_KEY for compat)
//
// Each value is only added when the corresponding SMITHERS_PAIR_*_API_KEY (or
// the conventional bare env var) is set, so an unset key leaves the inherited
// environment untouched and subscription auth keeps working.
func providerEnv(provider string) []string {
	var env []string
	add := func(name, value string) {
		if value != "" {
			env = append(env, name+"="+value)
		}
	}
	switch provider {
	case "claude":
		add("ANTHROPIC_API_KEY", firstNonEmptyEnv("SMITHERS_PAIR_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"))
	case "", "codex":
		add("OPENAI_API_KEY", firstNonEmptyEnv("SMITHERS_PAIR_OPENAI_API_KEY", "OPENAI_API_KEY"))
	case "gemini":
		add("GEMINI_API_KEY", firstNonEmptyEnv("SMITHERS_PAIR_GEMINI_API_KEY", "GEMINI_API_KEY"))
		// Headless gemini refuses to run tools in an "untrusted" folder unless
		// this is set (the pair workspace is not interactively trusted).
		env = append(env, "GEMINI_CLI_TRUST_WORKSPACE=true")
	case "kimi":
		// kimi-cli (Moonshot). KIMI_API_KEY is the CONFIRMED env var; also export
		// MOONSHOT_API_KEY for compatibility. Honors a SMITHERS_PAIR_* override or
		// the conventional bare env var.
		key := firstNonEmptyEnv(
			"SMITHERS_PAIR_KIMI_API_KEY", "KIMI_API_KEY",
			"SMITHERS_PAIR_MOONSHOT_API_KEY", "MOONSHOT_API_KEY",
		)
		add("KIMI_API_KEY", key)
		add("MOONSHOT_API_KEY", key)
	}
	return env
}

func firstNonEmptyEnv(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}
