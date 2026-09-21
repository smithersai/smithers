package services

import (
	"errors"
	"net/http"
	"testing"
)

import pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"

func TestDispatchAgentRun_RefusesByDefault(t *testing.T) {
	t.Parallel()
	// A zero-value service is the production configuration.
	d := &agentDispatch{svc: &AgentService{}, ctx: t.Context()}

	err := d.refuseRetiredAgentLoop()
	if err == nil {
		t.Fatal("expected the dispatch to refuse")
	}
	var apiErr *pkgerrors.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected a typed APIError, got %T", err)
	}
	if apiErr.Code != pkgerrors.CodeAgentLoopRetired {
		t.Fatalf("unexpected code: %q", apiErr.Code)
	}
	if apiErr.Status != http.StatusNotImplemented {
		t.Fatalf("unexpected status: %d", apiErr.Status)
	}
	if !d.infraFailedMarked {
		t.Fatal("the refusal must mark the run's infrastructure failed so the session shows it")
	}
}

func TestDispatchAgentRun_GuestEntrypointIsPerService(t *testing.T) {
	t.Parallel()
	// The flag lives on the service, so one test assuming an entrypoint
	// cannot change what another test's service does.
	assuming := &agentDispatch{svc: &AgentService{guestEntrypointAssumed: true}, ctx: t.Context()}
	if err := assuming.refuseRetiredAgentLoop(); err != nil {
		t.Fatalf("a service that assumes an entrypoint must pass the step: %v", err)
	}
	if assuming.infraFailedMarked {
		t.Fatal("passing the step must not mark the run failed")
	}

	refusing := &agentDispatch{svc: &AgentService{}, ctx: t.Context()}
	if err := refusing.refuseRetiredAgentLoop(); err == nil {
		t.Fatal("a second service must still refuse")
	}
}

// newTestDispatchService gives its fixtures a guest entrypoint; this proves
// that is the only reason those fixtures get past the refusal.
func TestDispatchAgentRun_TestFixtureAssumesAnEntrypoint(t *testing.T) {
	t.Parallel()
	if !newTestDispatchService(&mockAgentDispatchQuerier{}, nil).guestEntrypointAssumed {
		t.Fatal("the dispatch fixture must assume a guest entrypoint, or every pipeline test is testing the refusal")
	}
}
