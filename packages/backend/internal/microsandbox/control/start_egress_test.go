package control

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	msbworker "github.com/smithersai/smithers/packages/backend/internal/microsandbox/worker"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type startEgressRuntime struct {
	msbworker.Runtime
	policy *sandbox.EgressProxyPolicy
}

func (r *startEgressRuntime) StartWithEgress(_ context.Context, id string, policy *sandbox.EgressProxyPolicy) (sandbox.StartResult, error) {
	r.policy = policy
	return sandbox.StartResult{ID: id}, nil
}

func TestStartEgressBindingsRoundTripWithoutPersistence(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	state, err := msbworker.LoadState(statePath)
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_resume", msbworker.Allocation{Generation: 1, ObservedState: "stopped"}))
	runtime := &startEgressRuntime{}
	worker := msbworker.NewServer(msbworker.ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	worker.AuthorizeUntil(time.Now().Add(time.Minute), true)
	workerServer := httptest.NewServer(worker)
	defer workerServer.Close()
	store := &controllerTestStore{workerURL: workerServer.URL, placement: &Placement{
		SandboxID: "msb_resume", LocalID: "msb_resume", WorkerID: "worker-a", Generation: 1, ObservedState: "stopped", RequestSpec: json.RawMessage(`{}`),
	}}
	controller := httptest.NewServer(New(store, Config{APIKey: "api-key", AllowInsecureDev: true}))
	defer controller.Close()
	policy := &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{Name: "TOKEN", Value: "renewed-secret-sentinel", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}}}
	result, err := msb.NewClient(controller.URL, "api-key").StartSandbox(context.Background(), "msb_resume", sandbox.StartRequest{EgressProxy: policy})
	require.NoError(t, err)
	assert.Equal(t, "msb_resume", result.ID)
	assert.Equal(t, policy, runtime.policy)
	assert.JSONEq(t, `{}`, string(store.placement.RequestSpec))
	for _, body := range store.storedOperationBodies {
		assert.NotContains(t, string(body), "renewed-secret-sentinel")
	}
	persisted, err := os.ReadFile(statePath)
	require.NoError(t, err)
	assert.NotContains(t, string(persisted), "renewed-secret-sentinel")
}
