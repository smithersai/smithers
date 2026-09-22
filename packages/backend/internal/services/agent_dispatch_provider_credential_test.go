package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// An agent VM with no usable AI-provider credential can only 401 on every model
// call. Production shipped exactly that — ANTHROPIC_API_KEY was the
// operator-seeded "placeholder-pending-h1-credential-seed" — and the dispatch
// reported success anyway: the VM booted, the model call failed, and nothing
// surfaced. No assistant message, no transcript entry, no run failure; the
// session sat "active" until the caller gave up (the deep canary aborted at
// 302s). Refuse with a message a user can read instead.
func TestRequireProviderCredential_RefusesWhenNoneIsUsable(t *testing.T) {
	t.Parallel()

	dispatch := &agentDispatch{
		svc:  &AgentService{dispatchQ: &mockAgentDispatchQuerier{}},
		ctx:  context.Background(),
		run:  db.WorkflowRun{ID: 10},
		step: db.WorkflowStep{ID: 20},
		task: db.WorkflowTask{ID: 30},
		agentServiceSpec: sandbox.ServiceSpec{Env: map[string]string{
			"ANTHROPIC_API_KEY": "placeholder-pending-h1-credential-seed",
			"OPENAI_API_KEY":    "",
			"HOME":              "/root",
		}},
	}

	err := dispatch.requireProviderCredential()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no AI-provider credential is configured")
	assert.Contains(t, err.Error(), "CEREBRAS_API_KEY")
	assert.True(t, dispatch.infraFailedMarked,
		"the run must be marked failed, not left running with a VM that cannot think")
}

func TestRequireProviderCredential_AcceptsAPlatformCredential(t *testing.T) {
	t.Parallel()

	dispatch := &agentDispatch{
		svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{}},
		ctx: context.Background(),
		agentServiceSpec: sandbox.ServiceSpec{Env: map[string]string{
			"ANTHROPIC_API_KEY": "placeholder-pending-h1-credential-seed",
			"CEREBRAS_API_KEY":  "csk-real",
		}},
	}

	require.NoError(t, dispatch.requireProviderCredential())
	assert.False(t, dispatch.infraFailedMarked)
}

// A repository secret is a legitimate credential source: injectSecrets runs
// before this guard, so a repo that supplies its own key must still dispatch.
func TestRequireProviderCredential_AcceptsARepositorySecret(t *testing.T) {
	t.Parallel()

	dispatch := &agentDispatch{
		svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{}},
		ctx: context.Background(),
		agentServiceSpec: sandbox.ServiceSpec{Env: map[string]string{
			"ANTHROPIC_AUTH_TOKEN": "smithers_subscription_token",
		}},
	}

	require.NoError(t, dispatch.requireProviderCredential())
}

func TestRequireProviderCredential_UsesCodingHostSeatForFlowDispatch(t *testing.T) {
	t.Parallel()
	dispatch := &agentDispatch{
		svc: &AgentService{
			flowDispatcher: &recordingAgentFlowDispatcher{},
			workspaces:     stubAgentWorkspaceBackend{},
		},
		input: DispatchAgentRunInput{RepoOwner: "owner", RepoName: "repo"},
	}
	require.NoError(t, dispatch.requireProviderCredential())
}
