package clusterservices

import (
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/microsandbox/control"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func clusterAPIErrorOf(t *testing.T, err error) *pkgerrors.APIError {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected APIError, got %T: %v", err, err)
	return apiErr
}

// TestLostHostLeaseIsNotTheOperatorsFault splits a verdict that used to be one
// error.
//
// DrainHost refused with ErrHostNotDrainable for two unrelated conditions: the
// host is in a state with nothing to drain, and the controller's lease on the
// host has expired. Both answered 409 "host is not ready with a live lease" —
// a 4xx, fault=user, telling an operator their request conflicted with the
// host's state when in fact plue had silently lost the machine.
func TestLostHostLeaseIsNotTheOperatorsFault(t *testing.T) {
	f := &manageFake{}
	svc := NewAdminManageService(f, f, f, f)
	ctx := manageTestContext()

	f.err = control.ErrHostLeaseLost
	_, err := svc.DrainSandboxHost(ctx, "host-1")
	lease := clusterAPIErrorOf(t, err)
	assert.Equal(t, pkgerrors.CodeHostLeaseLost, lease.Code)
	assert.Equal(t, pkgerrors.FaultInfra, lease.Fault,
		"plue lost the host; the operator's request was fine")
	assert.Equal(t, http.StatusServiceUnavailable, lease.Status)

	// The genuine state conflict keeps its 409 and keeps blaming the request.
	f.err = control.ErrHostNotDrainable
	_, err = svc.DrainSandboxHost(ctx, "host-1")
	state := clusterAPIErrorOf(t, err)
	assert.Equal(t, pkgerrors.CodeConflict, state.Code)
	assert.Equal(t, pkgerrors.FaultUser, state.Fault)
	assert.Equal(t, http.StatusConflict, state.Status)
}
