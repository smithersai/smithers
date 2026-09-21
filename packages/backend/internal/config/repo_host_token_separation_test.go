package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_RepoHostCallbackTokenIsDistinctAndHasNoFallback(t *testing.T) {
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "repo-host-control")
	t.Setenv("REPO_HOST_AUTH_TOKEN", "legacy-control")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "push-callback-only")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "repo-host-control", cfg.RepoHost.AuthToken)
	assert.Equal(t, "push-callback-only", cfg.RepoHost.PushHookCallbackToken)

	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "")
	cfg, err = Load("")
	require.NoError(t, err)
	assert.Empty(t, cfg.RepoHost.PushHookCallbackToken, "callback token must never fall back to the control token")
}

func TestLoad_NormalizesRepoHostCallbackToken(t *testing.T) {
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "  push-callback-only\n")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "push-callback-only", cfg.RepoHost.PushHookCallbackToken)
}
