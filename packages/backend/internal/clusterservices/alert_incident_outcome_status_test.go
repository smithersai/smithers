package clusterservices

import (
	"context"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Client-caused bad input to the remediation-outcome webhook must produce typed
// 4xx errors (so the route returns 400/404), not a generic 500.
func TestRecordRemediationOutcome_ClientErrorsAreTyped(t *testing.T) {
	svc := newTestAlertIncidentService(&fakeAlertIncidentQuerier{incidentByID: map[string]clusterdb.AlertIncident{}}, testAlertRegistry(t))

	var apiErr *pkgerrors.APIError

	// Invalid state -> 400 (previously fmt.Errorf -> route wrapped as 500).
	err := svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{IncidentID: "inc-1", State: "bogus"})
	require.True(t, errors.As(err, &apiErr), "invalid state must be a typed APIError, got %v", err)
	assert.Equal(t, 400, apiErr.Status)

	// Unknown incident (pgx.ErrNoRows) -> 404.
	err = svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{IncidentID: "missing", State: "failed"})
	require.True(t, errors.As(err, &apiErr), "unknown incident must be a typed APIError, got %v", err)
	assert.Equal(t, 404, apiErr.Status)
}
