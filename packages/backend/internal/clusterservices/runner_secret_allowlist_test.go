package clusterservices

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRunnerRejectsReservedSecretMarker(t *testing.T) {
	_, _, err := workflowTaskSecretAllowlist([]byte(`{"secret_names":["SMITHERS_SECRET_ENV_KEYS"]}`))
	require.Error(t, err)
}
