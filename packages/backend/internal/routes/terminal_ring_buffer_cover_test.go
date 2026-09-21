package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTerminalRingBuffer_Cov_DefaultCapacityAndOverwrite(t *testing.T) {
	t.Parallel()

	defaultBuf := newTerminalRingBuffer(0)
	require.Len(t, defaultBuf.buf, 512*1024)
	data, offset, truncated := defaultBuf.Snapshot()
	assert.Empty(t, data)
	assert.Zero(t, offset)
	assert.False(t, truncated)

	ring := newTerminalRingBuffer(5)
	ring.Append([]byte("abc"))
	ring.Append([]byte("def"))

	data, offset, truncated = ring.Snapshot()
	assert.Equal(t, "bcdef", string(data))
	assert.Equal(t, uint64(1), offset)
	assert.True(t, truncated)

	ring.Append([]byte("123456789"))
	data, offset, truncated = ring.Snapshot()
	assert.Equal(t, "56789", string(data))
	assert.Equal(t, uint64(10), offset)
	assert.True(t, truncated)
}
