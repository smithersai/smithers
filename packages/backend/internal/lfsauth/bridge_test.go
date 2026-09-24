package lfsauth

import (
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
	"time"
)

func TestBridgeIssuesStandardEndpointAndRejectsUntrustedConfig(t *testing.T) {
	bridge, err := NewBridge(BridgeConfig{
		Secret:        "shared-test-secret",
		PublicBaseURL: "https://plue.test/root/",
		TokenTTL:      2 * time.Minute,
	})
	require.NoError(t, err)
	response, claims, err := bridge.Issue(Grant{RepositoryID: 42, Owner: "Alice", Repository: "Demo", Operation: OperationUpload, Principal: PrincipalDeployKey})
	require.NoError(t, err)
	assert.Equal(t, "https://plue.test/root/api/repos/alice/demo/lfs", response.Href)
	assert.Equal(t, int64(120), response.ExpiresIn)
	assert.Equal(t, OperationUpload, claims.Operation)
	require.Contains(t, response.Header, "Authorization")
	fields := strings.Fields(response.Header["Authorization"])
	require.Len(t, fields, 2)
	_, err = bridge.Manager().Verify(fields[1])
	require.NoError(t, err)

	for _, base := range []string{"", "ssh://plue.test", "https://user@plue.test", "https://plue.test?host=evil", "https://plue.test#evil"} {
		_, err := NewBridge(BridgeConfig{Secret: "secret", PublicBaseURL: base})
		require.Error(t, err, base)
	}
	_, err = NewBridge(BridgeConfig{PublicBaseURL: "https://plue.test"})
	require.Error(t, err)
}
