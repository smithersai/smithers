package webhook

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIsRestrictedIP(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		ip         string
		restricted bool
	}{
		{name: "public_ipv4", ip: "93.184.216.34", restricted: false},
		{name: "private_10", ip: "10.1.2.3", restricted: true},
		{name: "private_172", ip: "172.16.5.4", restricted: true},
		{name: "private_172_upper_bound", ip: "172.31.255.255", restricted: true},
		{name: "private_172_outside_range", ip: "172.32.0.1", restricted: false},
		{name: "private_192", ip: "192.168.1.1", restricted: true},
		{name: "loopback_ipv4", ip: "127.0.0.1", restricted: true},
		{name: "link_local_and_metadata_ipv4", ip: "169.254.169.254", restricted: true},
		{name: "public_ipv6", ip: "2606:2800:220:1:248:1893:25c8:1946", restricted: false},
		{name: "loopback_ipv6", ip: "::1", restricted: true},
		{name: "ula_fc00", ip: "fc00::1", restricted: true},
		{name: "ula_fd00", ip: "fd12:3456:789a::1", restricted: true},
		{name: "link_local_ipv6", ip: "fe80::1", restricted: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			parsed := net.ParseIP(tc.ip)
			require.NotNil(t, parsed)
			assert.Equal(t, tc.restricted, IsRestrictedIP(parsed))
		})
	}
}

func TestSafeHTTPClient_BlocksRestricted(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req, reqErr := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
	require.NoError(t, reqErr)
	resp, err := SafeHTTPClient().Do(req)
	require.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "restricted IP")
}

func TestSafeHTTPClient_AllowsPublic(t *testing.T) {
	t.Parallel()

	lookup := func(ctx context.Context, host string) ([]net.IPAddr, error) {
		require.Equal(t, "example.com", host)
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	}

	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()

	called := false
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		called = true
		require.Equal(t, "tcp", network)
		// The guarded dialer must connect to the exact IP that passed
		// validation, not re-resolve the hostname (DNS-rebinding TOCTOU).
		require.Equal(t, "93.184.216.34:443", address)
		return c1, nil
	}

	guardedDial := safeDialContext(lookup, dial)
	conn, err := guardedDial(context.Background(), "tcp", "example.com:443")
	require.NoError(t, err)
	require.NotNil(t, conn)
	assert.True(t, called)
}
