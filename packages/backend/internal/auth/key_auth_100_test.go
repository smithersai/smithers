package auth

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKeyAuth_H_MustNonEmptyDomain(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "smithers.sh", keyAuthMustNonEmptyDomain("smithers.sh"))
	require.PanicsWithValue(t, "missing key auth domain after valid EIP-4361 suffix", func() {
		keyAuthMustNonEmptyDomain("   ")
	})
}
