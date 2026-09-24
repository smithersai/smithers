package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/stretchr/testify/require"
)

type readRPCResolver struct {
	reads, starts int
	runtime       *readRPCRuntime
	err           error
}

func (r *readRPCResolver) ResolveFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	r.starts++
	return r.runtime, r.err
}
func (r *readRPCResolver) ResolveExistingFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	r.reads++
	return r.runtime, r.err
}

type readRPCRuntime struct {
	flowruntime.Runtime
	calls []string
}

func (r *readRPCRuntime) CallRPC(_ context.Context, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	r.calls = append(r.calls, procedure)
	return payload, nil
}

func TestCallRPCUsesExistingHostForReadsAndNeverFallsBack(t *testing.T) {
	runtime := &readRPCRuntime{}
	resolver := &readRPCResolver{runtime: runtime}
	service := &Service{resolver: resolver}
	for _, procedure := range []string{"List", "Projection.Snapshot"} {
		body := json.RawMessage(`{"_tag":"triggers"}`)
		answer, err := service.CallRPC(context.Background(), flowruntime.Target{}, procedure, body)
		require.NoError(t, err)
		require.Equal(t, body, answer)
	}
	require.Equal(t, 2, resolver.reads)
	require.Zero(t, resolver.starts)
	resolver.err = errors.New("host is stopped")
	_, err := service.CallRPC(context.Background(), flowruntime.Target{}, "List", nil)
	require.EqualError(t, err, "host is stopped")
	require.Zero(t, resolver.starts)
	require.Equal(t, []string{"List", "Projection.Snapshot"}, runtime.calls)
	resolver.err = nil
	_, err = service.CallRPC(context.Background(), flowruntime.Target{}, "Plan", json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Equal(t, 1, resolver.starts)
}

func TestReadRPCRefusesResolverWithoutReadContract(t *testing.T) {
	called := false
	service := &Service{resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		called = true
		return &readRPCRuntime{}, nil
	})}
	_, err := service.CallRPC(context.Background(), flowruntime.Target{}, "List", nil)
	require.ErrorContains(t, err, "read-only resolver")
	require.False(t, called)
}
