package webhook

import (
	"context"
	"errors"
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSSRF_Cov_IsRestrictedIPNilUnspecifiedAndMulticast(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		ip   net.IP
	}{
		{name: "nil", ip: nil},
		{name: "unspecified_ipv4", ip: net.ParseIP("0.0.0.0")},
		{name: "unspecified_ipv6", ip: net.ParseIP("::")},
		{name: "multicast_ipv4", ip: net.ParseIP("224.0.0.1")},
		{name: "multicast_ipv6", ip: net.ParseIP("ff02::1")},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.True(t, IsRestrictedIP(tc.ip))
		})
	}
}

func TestSSRF_Cov_MustParseCIDRsPanicsForInvalidCIDR(t *testing.T) {
	t.Parallel()

	assert.PanicsWithValue(t, "invalid SSRF restricted CIDR: not-a-cidr", func() {
		mustParseCIDRs("192.0.2.0/24", "not-a-cidr")
	})
}

func TestSSRF_Cov_SafeDialContextReturnsSplitHostPortError(t *testing.T) {
	t.Parallel()

	guardedDial := safeDialContext(
		func(context.Context, string) ([]net.IPAddr, error) {
			t.Fatal("lookup should not run for an invalid address")
			return nil, nil
		},
		func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("dial should not run for an invalid address")
			return nil, nil
		},
	)

	conn, err := guardedDial(context.Background(), "tcp", "example.com")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "missing port in address")
	assert.Nil(t, conn)
}

func TestSSRF_Cov_SafeDialContextDialsDirectPublicIP(t *testing.T) {
	t.Parallel()

	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()

	called := false
	guardedDial := safeDialContext(
		func(context.Context, string) ([]net.IPAddr, error) {
			t.Fatal("lookup should not run for an IP literal")
			return nil, nil
		},
		func(_ context.Context, network, address string) (net.Conn, error) {
			called = true
			assert.Equal(t, "tcp", network)
			assert.Equal(t, "93.184.216.34:443", address)
			return c1, nil
		},
	)

	conn, err := guardedDial(context.Background(), "tcp", "93.184.216.34:443")

	require.NoError(t, err)
	assert.Same(t, c1, conn)
	assert.True(t, called)
}

func TestSSRF_Cov_SafeDialContextPropagatesLookupError(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("dns failed")
	guardedDial := safeDialContext(
		func(_ context.Context, host string) ([]net.IPAddr, error) {
			assert.Equal(t, "example.com", host)
			return nil, expectedErr
		},
		func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("dial should not run after lookup failure")
			return nil, nil
		},
	)

	conn, err := guardedDial(context.Background(), "tcp", "example.com:443")

	require.ErrorIs(t, err, expectedErr)
	assert.Nil(t, conn)
}

func TestSSRF_Cov_SafeDialContextRejectsEmptyLookupResult(t *testing.T) {
	t.Parallel()

	guardedDial := safeDialContext(
		func(_ context.Context, host string) ([]net.IPAddr, error) {
			assert.Equal(t, "empty.example", host)
			return nil, nil
		},
		func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("dial should not run without resolved addresses")
			return nil, nil
		},
	)

	conn, err := guardedDial(context.Background(), "tcp", "empty.example:443")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "did not resolve to any IP addresses")
	assert.Nil(t, conn)
}

func TestSSRF_Cov_SafeDialContextRejectsRestrictedResolvedIP(t *testing.T) {
	t.Parallel()

	guardedDial := safeDialContext(
		func(_ context.Context, host string) ([]net.IPAddr, error) {
			assert.Equal(t, "loopback.example", host)
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		},
		func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("dial should not run for a restricted resolved IP")
			return nil, nil
		},
	)

	conn, err := guardedDial(context.Background(), "tcp", "loopback.example:443")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "restricted IP 127.0.0.1")
	assert.Nil(t, conn)
}
