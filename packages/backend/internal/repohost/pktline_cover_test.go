package repohost

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var errPktlineCovRead = errors.New("pktlinecov read failed")

type pktlineCovErrReader struct{}

func (pktlineCovErrReader) Read(_ []byte) (int, error) {
	return 0, errPktlineCovRead
}

func pktlineCovPacket(payload string) string {
	return fmt.Sprintf("%04x%s", len(payload)+4, payload)
}

func pktlineCovReadAll(t *testing.T, r io.Reader) string {
	t.Helper()

	b, err := io.ReadAll(r)
	require.NoError(t, err)
	return string(b)
}

func TestPktline_Cov_PeekReceivePackUpdateShortLengthSkipsAndPreservesStream(t *testing.T) {
	t.Parallel()

	const input = "0001"
	update, rebuilt, err := PeekReceivePackUpdate(strings.NewReader(input))
	require.NoError(t, err)
	assert.Empty(t, update.RefName)
	assert.Empty(t, update.NewOID)
	assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
}

func TestPktline_Cov_PeekReceivePackUpdateTruncatedPayloadErrorsAndPreservesStream(t *testing.T) {
	t.Parallel()

	const input = "0008abc"
	update, rebuilt, err := PeekReceivePackUpdate(strings.NewReader(input))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read pkt-line payload")
	assert.Empty(t, update.RefName)
	assert.Empty(t, update.NewOID)
	assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
}

func TestPktline_Cov_PeekReceivePackUpdateMalformedCommandReturnsEmptyAndPreservesStream(t *testing.T) {
	t.Parallel()

	input := pktlineCovPacket("oldoid newoid")
	update, rebuilt, err := PeekReceivePackUpdate(strings.NewReader(input))
	require.NoError(t, err)
	assert.Empty(t, update.RefName)
	assert.Empty(t, update.NewOID)
	assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
}

func TestPktline_Cov_PeekReceivePackUpdateLengthReadErrorReturnsEmpty(t *testing.T) {
	t.Parallel()

	update, rebuilt, err := PeekReceivePackUpdate(pktlineCovErrReader{})
	require.NoError(t, err)
	assert.Empty(t, update.RefName)
	assert.Empty(t, update.NewOID)
	rebuiltBytes, readErr := io.ReadAll(rebuilt)
	assert.Empty(t, rebuiltBytes)
	assert.ErrorIs(t, readErr, errPktlineCovRead)
}

// A stream that is nothing but flush packets used to make
// PeekReceivePackUpdate loop forever, teeing every 4-byte packet into memory.
// The peek must give up after a bounded prefix and still reproduce the
// original bytes verbatim.
func TestPktline_Cov_PeekReceivePackUpdateBoundsEndlessFlushPackets(t *testing.T) {
	t.Parallel()

	input := strings.Repeat("0000", maxUpdatePeekBytes/4+16)
	update, rebuilt, err := PeekReceivePackUpdate(strings.NewReader(input))
	require.NoError(t, err)
	assert.Empty(t, update.RefName)
	assert.Empty(t, update.NewOID)
	assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
}

// PeekReceivePackCommands must fail closed (it enforces protected-bookmark
// policy) when the command section exceeds the peek ceiling instead of
// buffering it all in memory. "0004" keepalive packets never terminate the
// command section, so an endless run of them exercises the bound.
func TestPktline_Cov_PeekReceivePackCommandsBoundsOversizedCommandSection(t *testing.T) {
	t.Parallel()

	input := strings.Repeat("0004", maxCommandSectionPeekBytes/4+16)
	commands, _, err := PeekReceivePackCommands(strings.NewReader(input))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "command section exceeds")
	assert.Empty(t, commands)
}
