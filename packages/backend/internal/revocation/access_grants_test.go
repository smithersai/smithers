package revocation

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type recordingAccessGrantRevoker struct {
	mu      sync.Mutex
	targets []string
	done    chan struct{}
}

func (r *recordingAccessGrantRevoker) RevokeAccessGrant(_ context.Context, target string) error {
	r.mu.Lock()
	r.targets = append(r.targets, target)
	if len(r.targets) == 2 {
		close(r.done)
	}
	r.mu.Unlock()
	return nil
}

func TestAccessGrantHandlerRevokesNamedSandboxesWithinBound(t *testing.T) {
	t.Parallel()
	revoker := &recordingAccessGrantRevoker{done: make(chan struct{})}
	handle := NewAccessGrantHandler(context.Background(), revoker)
	handle(Event{ID: 44, Kind: KindOrgMemberRemoved, SandboxIDs: []string{"vm-one", "vm-two", "vm-one", ""}})

	select {
	case <-revoker.done:
	case <-time.After(time.Second):
		t.Fatal("controller access grants were not revoked within the bound")
	}
	revoker.mu.Lock()
	defer revoker.mu.Unlock()
	sort.Strings(revoker.targets)
	require.Equal(t, []string{"vm-one", "vm-two"}, revoker.targets)
}
