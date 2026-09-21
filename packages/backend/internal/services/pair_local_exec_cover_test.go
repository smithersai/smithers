package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestPairLocalExec_Cov_ProviderEnvAndFirstNonEmpty(t *testing.T) {
	t.Setenv("SMITHERS_PAIR_OPENAI_API_KEY", "override-openai")
	t.Setenv("OPENAI_API_KEY", "plain-openai")
	t.Setenv("SMITHERS_PAIR_GEMINI_API_KEY", "gemini-key")
	t.Setenv("SMITHERS_PAIR_KIMI_API_KEY", "kimi-key")

	if got := firstNonEmptyEnv("MISSING", "OPENAI_API_KEY"); got != "plain-openai" {
		t.Fatalf("firstNonEmptyEnv = %q", got)
	}

	codex := strings.Join(providerEnv("codex"), "\n")
	if !strings.Contains(codex, "OPENAI_API_KEY=override-openai") {
		t.Fatalf("codex env = %q", codex)
	}
	gemini := strings.Join(providerEnv("gemini"), "\n")
	if !strings.Contains(gemini, "GEMINI_API_KEY=gemini-key") || !strings.Contains(gemini, "GEMINI_CLI_TRUST_WORKSPACE=true") {
		t.Fatalf("gemini env = %q", gemini)
	}
	kimi := strings.Join(providerEnv("kimi"), "\n")
	if !strings.Contains(kimi, "KIMI_API_KEY=kimi-key") || !strings.Contains(kimi, "MOONSHOT_API_KEY=kimi-key") {
		t.Fatalf("kimi env = %q", kimi)
	}
	if env := providerEnv("unknown"); len(env) != 0 {
		t.Fatalf("unknown provider env = %v", env)
	}
}

func TestPairLocalExec_Cov_ExecAwaitSuccessExitAndTimeout(t *testing.T) {
	resp, err := (localExec{}).Execute(context.Background(), "ignored", sandbox.ExecRequest{Command: "printf out; printf err >&2"})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if resp.Stdout != "out" || resp.Stderr != "err" || resp.StatusCode == nil || *resp.StatusCode != 0 {
		t.Fatalf("resp = %+v", resp)
	}

	resp, err = (localExec{}).Execute(context.Background(), "", sandbox.ExecRequest{Command: "printf fail; exit 7"})
	if err != nil {
		t.Fatalf("exit error should be captured in response, got %v", err)
	}
	if resp.StatusCode == nil || *resp.StatusCode != 7 || resp.Stdout != "fail" {
		t.Fatalf("nonzero resp = %+v", resp)
	}

	timeout := int64(1)
	resp, err = (localExec{}).Execute(context.Background(), "", sandbox.ExecRequest{Command: "sleep 1", TimeoutMS: &timeout})
	if err != nil {
		t.Fatalf("timeout exit should be captured in response, got %v", err)
	}
	if resp.StatusCode == nil || *resp.StatusCode == 0 {
		t.Fatalf("timeout resp = %+v, want nonzero status", resp)
	}
	_ = time.Millisecond
}
