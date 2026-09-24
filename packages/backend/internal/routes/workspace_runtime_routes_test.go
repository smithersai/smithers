package routes

import (
	"context"
	"io"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

type countingRuntimeTerminal struct{ closes atomic.Int32 }

func (*countingRuntimeTerminal) Read([]byte) (int, error)        { return 0, io.EOF }
func (*countingRuntimeTerminal) Write(value []byte) (int, error) { return len(value), nil }
func (t *countingRuntimeTerminal) Close() error {
	t.closes.Add(1)
	return nil
}
func (*countingRuntimeTerminal) Resize(context.Context, uint16, uint16) error { return nil }

func TestRuntimeTerminalBackendClosesSharedTerminalOnce(t *testing.T) {
	terminal := &countingRuntimeTerminal{}
	client, session, err := newRuntimeTerminalBackend(terminal)
	require.NoError(t, err)
	require.NoError(t, session.Close())
	require.NoError(t, client.Close())
	require.EqualValues(t, 1, terminal.closes.Load())
}
