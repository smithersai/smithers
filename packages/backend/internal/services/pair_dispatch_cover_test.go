package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestPairDispatch_Cov_RunConfigurationAndTransportErrors(t *testing.T) {
	if _, err := (execDispatcher{}).Run(context.Background(), "prompt", pairAgentSnapshot{}); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("nil sandbox err = %v", err)
	}

	dispatcher := execDispatcher{sandbox: pairSandboxFunc(func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{}, errors.New("transport failed")
	}), vmID: "vm-1", workdir: "/work"}
	if _, err := dispatcher.Run(context.Background(), "prompt", pairAgentSnapshot{}); err == nil || !strings.Contains(err.Error(), "transport failed") {
		t.Fatalf("transport err = %v", err)
	}

	dispatcher = execDispatcher{sandbox: pairSandboxFunc(func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{Stdout: "===REPLY===\nok\n===OUTPUT===\nout\n===FILES===\n===STATUS===\n0\n===DOC==="}, nil
	}), local: true, workdir: "/work"}
	result, err := dispatcher.Run(context.Background(), "prompt", pairAgentSnapshot{})
	if err != nil || result.Reply != "ok" {
		t.Fatalf("local run = %+v, %v", result, err)
	}
}

func TestPairDispatch_Cov_ParseDefaultsInvalidBlocksAndSecrets(t *testing.T) {
	result := parsePairAgentOutput("plain output without markers", "stderr fallback")
	if result.Reply != "Updated the repo." || result.Output != "stderr fallback" {
		t.Fatalf("default parse = %+v", result)
	}

	stdout := strings.Join([]string{
		"===REPLY===",
		"token sk-abcdefghijklmnopqrstuvwxyz",
		"===OUTPUT===",
		"Bearer verysecrettokenvalue1234",
		"===FILES===",
		"safe.txt",
		"bad\tpath",
		"===FILE_CONTENTS===",
		"safe.txt\tnot-base64",
		"big.txt\t%%%",
		"===STATUS===",
		"not-a-number",
		"===DOC===",
		"not-base64",
	}, "\n")
	result = parsePairAgentOutput(stdout, "")
	if result.ExitCode != 0 || result.NewDoc != "" {
		t.Fatalf("invalid status/doc parse = %+v", result)
	}
	if strings.Contains(result.Reply, "sk-") || strings.Contains(result.Output, "verysecrettokenvalue1234") {
		t.Fatalf("secrets not redacted: %+v", result)
	}
	if len(result.ChangedFiles) != 2 || result.ChangedFiles[0] != "safe.txt" || result.ChangedFiles[1] != "bad\tpath" {
		t.Fatalf("changed files = %+v", result.ChangedFiles)
	}
	if len(result.ChangedFileContents) != 0 {
		t.Fatalf("invalid contents parsed: %#v", result.ChangedFileContents)
	}
}
