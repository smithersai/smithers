package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestPairLocalExec_Z_TimeoutProviderEnvAndEmptyEnv(t *testing.T) {
	oldShell := localExecShell
	localExecShell = "/definitely/missing/shell"
	t.Cleanup(func() { localExecShell = oldShell })

	_, err := (localExec{}).Execute(context.Background(), "", sandbox.ExecRequest{
		Command: "true",
	})
	require.Error(t, err)

	t.Setenv("SMITHERS_PAIR_ANTHROPIC_API_KEY", "anthropic-z")
	assert.Contains(t, providerEnv("claude"), "ANTHROPIC_API_KEY=anthropic-z")

	t.Setenv("SMITHERS_PAIR_OPENAI_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	assert.Equal(t, "", firstNonEmptyEnv("SMITHERS_PAIR_OPENAI_API_KEY", "OPENAI_API_KEY"))
}
