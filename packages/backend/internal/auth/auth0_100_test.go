package auth

import (
	"crypto/sha256"
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAuth0_H_StableInt64ID(t *testing.T) {
	t.Parallel()

	var zeroDigest [sha256.Size]byte
	assert.Equal(t, int64(1), stableInt64IDFromDigest(zeroDigest))

	var digest [sha256.Size]byte
	binary.BigEndian.PutUint64(digest[:8], 42)
	assert.Equal(t, int64(42), stableInt64IDFromDigest(digest))

	assert.Equal(t, stableInt64ID("github|octo"), stableInt64ID("  github|octo  "))
	assert.Positive(t, stableInt64ID("github|octo"))
}
