package services

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// The RESUME path's refusal is covered in workspace_capacity_test.go, which
// also owns noCapacityRefusal(): byte-for-byte what the controller answers
// when the worker pool has no room. These tests cover the CREATE path, which
// answered the same condition with a 500 and plue's internals in the sentence.

// TestCreateIntoFullPoolAnswers503 is the bug this change exists for. Creating
// a box into a full pool used to answer:
//
//	HTTP 500
//	{"code":"no_capacity","message":"create sandbox: microsandbox api returned
//	 status 503 (no_capacity): no healthy Microsandbox worker has sufficient
//	 capacity"}
//
// — a server-error status for a condition that is not an error, and plue's own
// internals quoted back at whoever opened the box.
func TestCreateIntoFullPoolAnswers503(t *testing.T) {
	for _, action := range []string{
		"create sandbox",
		"create sandbox from snapshot",
		"create sandbox for empty-source fork",
		"resume sandbox",
		"",
	} {
		t.Run("action="+action, func(t *testing.T) {
			err := workspaceProvisioningError(action, fmt.Errorf("provision box: %w", noCapacityRefusal()))

			assert.Equal(t, http.StatusServiceUnavailable, err.Status,
				"a full pool is the pool being busy, not plue being broken")
			assert.Equal(t, pkgerrors.CodeNoCapacity, err.Code)
			assert.Equal(t, pkgerrors.FaultInfra, err.Fault,
				"nothing about a full pool is the caller's fault")
			assert.Positive(t, err.RetryAfter, "a full pool clears itself; say when to come back")

			assert.Equal(t, workspaceNoCapacityMessage, err.Message)
			for _, leak := range []string{
				"Microsandbox", "microsandbox", "api returned status",
				"create sandbox", "resume sandbox", "worker",
			} {
				assert.NotContains(t, err.Message, leak,
					"the sentence a person reads must not name plue's internals")
			}
		})
	}
}

// The resume path got this treatment first (commit fba36ebee88f). Create and
// resume must not drift apart again: same code, same fault, same sentence.
func TestCapacityRefusalMatchesTheResumePath(t *testing.T) {
	create := workspaceProvisioningError("create sandbox", noCapacityRefusal())
	resume := pkgerrors.NoCapacity(workspaceNoCapacityMessage)

	assert.Equal(t, resume.Status, create.Status)
	assert.Equal(t, resume.Code, create.Code)
	assert.Equal(t, resume.Fault, create.Fault)
	assert.Equal(t, resume.RetryAfter, create.RetryAfter)
	assert.Equal(t, resume.Message, create.Message)
}

// An APIError the pool already refused (raised upstream by ensureWorkspaceRunning
// and re-wrapped on the way out) must not be re-labeled a provisioning failure.
func TestCapacityRefusalSurvivesRewrapping(t *testing.T) {
	wrapped := fmt.Errorf("open box: %w", pkgerrors.NoCapacity(workspaceNoCapacityMessage))
	err := workspaceProvisioningError("create sandbox", wrapped)

	assert.Equal(t, http.StatusServiceUnavailable, err.Status)
	assert.Equal(t, pkgerrors.CodeNoCapacity, err.Code)
	assert.Equal(t, pkgerrors.FaultInfra, err.Fault)
}

// Everything that is NOT a capacity refusal keeps answering 500 with the
// action-prefixed cause. Narrowing the capacity case must not quietly reclassify
// the rest of provisioning.
func TestNonCapacityProvisioningStillAnswers500(t *testing.T) {
	t.Run("an unclassified cause", func(t *testing.T) {
		err := workspaceProvisioningError("store sandbox info", errors.New("connection refused"))
		assert.Equal(t, http.StatusInternalServerError, err.Status)
		assert.Equal(t, pkgerrors.CodeProvisioningFailed, err.Code)
		assert.Equal(t, pkgerrors.FaultBug, err.Fault)
		assert.Equal(t, "store sandbox info: connection refused", err.Message)
	})

	t.Run("a controller code plue keeps", func(t *testing.T) {
		err := workspaceProvisioningError("create sandbox", refusedWorkspaceSandbox())
		assert.Equal(t, http.StatusInternalServerError, err.Status,
			"failing to BUILD a box is a 500 whatever the controller called it")
		assert.Equal(t, pkgerrors.CodeEgressProxyUnavailable, err.Code)
		assert.Equal(t, pkgerrors.FaultInfra, err.Fault)
	})

	t.Run("a controller code that blames its caller", func(t *testing.T) {
		err := workspaceProvisioningError("create sandbox", &sandbox.StatusError{
			StatusCode: http.StatusConflict,
			Code:       "stale_generation",
			Message:    "placement generation is stale",
		})
		assert.Equal(t, http.StatusInternalServerError, err.Status)
		assert.Equal(t, pkgerrors.CodeStaleGeneration, err.Code)
		assert.Equal(t, pkgerrors.FaultBug, err.Fault,
			"plue drove that request, not the person who asked for a box")
	})
}

// A code plue has never registered must not be persisted or served as itself:
// a client cannot branch on a verdict nobody documented.
func TestUnregisteredControllerCodeIsNotPassedThrough(t *testing.T) {
	details := workspaceFailureDetailsFor(&sandbox.StatusError{
		StatusCode: http.StatusServiceUnavailable,
		Code:       "pool_exhausted",
		Message:    "invented by a future controller",
	})

	assert.Equal(t, workspaceProvisioningFailureCode, details.Code)
	entry, ok := pkgerrors.Lookup(details.Code)
	require.True(t, ok, "whatever gets persisted must be a registry member")
	assert.Equal(t, pkgerrors.FaultBug, entry.Fault)
}
