package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestPairDispatch_Z_RemoteRequiresVMID(t *testing.T) {
	dispatcher := execDispatcher{
		sandbox: pairSandboxFunc(func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			t.Fatal("sandbox should not run without vm id")
			return sandbox.ExecResult{}, nil
		}),
	}
	_, err := dispatcher.Run(context.Background(), "prompt", pairAgentSnapshot{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "shared model not configured")
}
