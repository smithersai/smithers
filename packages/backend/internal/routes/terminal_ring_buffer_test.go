package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRingBufferOverflowDropsOldest(t *testing.T) {
	ring := newTerminalRingBuffer(5)
	ring.Append([]byte("abc"))
	ring.Append([]byte("defg"))

	got, offset, truncated := ring.Snapshot()
	assert.Equal(t, []byte("cdefg"), got)
	assert.Equal(t, uint64(2), offset)
	assert.True(t, truncated)
}

// TestRingBufferSingleWriteExceedsCapacity covers the branch where one Append is
// at least as large as the whole buffer: only the trailing `cap` bytes survive,
// the offset advances past everything dropped, and truncated flips. This path
// (terminal_ring_buffer.go len(p) >= len(buf)) had no direct coverage.
func TestRingBufferSingleWriteExceedsCapacity(t *testing.T) {
	ring := newTerminalRingBuffer(4)
	ring.Append([]byte("ab")) // size=2, offset=0
	ring.Append([]byte("abcdefgh"))

	got, offset, truncated := ring.Snapshot()
	assert.Equal(t, []byte("efgh"), got)
	// 2 already buffered + 8 written - 4 retained = 6 bytes dropped from the stream.
	assert.Equal(t, uint64(6), offset)
	assert.True(t, truncated)
}

// TestRingBufferEmptyAndZeroCapAppends covers the guard clauses: appending
// nothing, and a buffer of zero capacity, must be no-ops that never panic.
func TestRingBufferEmptyAndZeroCapAppends(t *testing.T) {
	ring := newTerminalRingBuffer(4)
	ring.Append(nil)
	ring.Append([]byte{})
	got, offset, truncated := ring.Snapshot()
	assert.Equal(t, []byte{}, got)
	assert.Equal(t, uint64(0), offset)
	assert.False(t, truncated)

	// newTerminalRingBuffer clamps non-positive capacity to the default, so to
	// exercise the len(buf)==0 guard we construct one directly.
	zero := &terminalRingBuffer{}
	zero.Append([]byte("data"))
	got, offset, truncated = zero.Snapshot()
	assert.Equal(t, []byte{}, got)
	assert.Equal(t, uint64(0), offset)
	assert.False(t, truncated)
}
