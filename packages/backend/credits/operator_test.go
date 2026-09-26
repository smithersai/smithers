package credits

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseAndFormatUSD(t *testing.T) {
	for in, want := range map[string]int64{"25": 25 * NanosPerUSD, "0.50": 50 * NanosPerCent, "0.000000001": 1} {
		got, err := ParseUSD(in)
		require.NoError(t, err, in)
		require.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "0", "-1", "abc", "0x19", "1/4", "0.0000000001", "1e30", "99999999999"} {
		_, err := ParseUSD(bad)
		require.Error(t, err, bad)
	}
	require.Equal(t, "25", FormatUSD(25*NanosPerUSD))
	require.Equal(t, "0.5", FormatUSD(50*NanosPerCent))
	require.Equal(t, "-0.000000001", FormatUSD(-1))
	require.Equal(t, "0", FormatUSD(0))
}

func TestOperatorCommandGrantsIdempotentlyByKey(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	_, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (41, 'Alice', 'alice')`)
	require.NoError(t, err)
	var out bytes.Buffer
	run := func(args ...string) error { out.Reset(); return l.OperatorCommand(ctx, args, &out, io.Discard) }
	require.NoError(t, run("grant", "-owner", "user:Alice", "-usd", "25", "-key", "2026-10"))
	require.Equal(t, "user:Alice balance 25 USD\n", out.String())
	require.NoError(t, run("grant", "-owner", "user:alice", "-usd", "25", "-key", "2026-10"), "a repeated grant is a no-op")
	require.NoError(t, run("balance", "-owner", "user:alice"))
	require.Equal(t, "user:alice balance 25 USD\n", out.String())
	require.ErrorIs(t, run("grant", "-owner", "user:alice", "-usd", "30", "-key", "2026-10"), ErrConflict)
	require.Error(t, run("grant", "-owner", "user:alice", "-usd", "5"), "a grant needs a key")
	require.Error(t, run("grant", "-owner", "user:nobody", "-usd", "5", "-key", "k"))
	require.Error(t, run("grant", "-owner", "team:alice", "-usd", "5", "-key", "k"))
	require.Error(t, run("spend", "-owner", "user:alice"))
	require.Error(t, run("grant", "-owner", "user:alice", "-usd", "5", "-key", "old", "-expires", "2020-01-01T00:00:00Z"))
}
