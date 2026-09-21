package webhook

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"
)

var restrictedCIDRs = mustParseCIDRs(
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"::1/128",
	"fc00::/7",
	"fe80::/10",
)

// IsRestrictedIP reports whether the address is in blocked ranges.
func IsRestrictedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}

	for _, blocked := range restrictedCIDRs {
		if blocked.Contains(ip) {
			return true
		}
	}

	return false
}

func mustParseCIDRs(rawCIDRs ...string) []*net.IPNet {
	parsed := make([]*net.IPNet, 0, len(rawCIDRs))
	for _, raw := range rawCIDRs {
		_, network, err := net.ParseCIDR(raw)
		if err != nil {
			panic("invalid SSRF restricted CIDR: " + raw)
		}
		parsed = append(parsed, network)
	}
	return parsed
}

type lookupIPAddrsFunc func(ctx context.Context, host string) ([]net.IPAddr, error)
type dialContextFunc func(ctx context.Context, network, address string) (net.Conn, error)

// SafeHTTPClient returns an HTTP client that blocks webhook requests to restricted addresses.
func SafeHTTPClient() *http.Client {
	baseTransport := http.DefaultTransport.(*http.Transport).Clone()
	// http.DefaultTransport.Proxy is ProxyFromEnvironment. If HTTP(S)_PROXY is set,
	// requests would dial the proxy host — which safeDialContext validates — and the
	// proxy would then connect onward to the real (attacker-controlled) target,
	// bypassing the dial-time restricted-IP guard entirely. Webhook deliveries must
	// dial the validated target directly, so disable env proxying on this client.
	baseTransport.Proxy = nil
	dialer := &net.Dialer{}
	baseTransport.DialContext = safeDialContext(net.DefaultResolver.LookupIPAddr, dialer.DialContext)

	return &http.Client{
		Timeout:   10 * time.Second,
		Transport: baseTransport,
	}
}

func safeDialContext(lookup lookupIPAddrsFunc, dial dialContextFunc) dialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}

		if ip := net.ParseIP(host); ip != nil {
			if IsRestrictedIP(ip) {
				return nil, fmt.Errorf("webhook target resolves to restricted IP %s", ip.String())
			}
			return dial(ctx, network, address)
		}

		resolvedIPs, err := lookup(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(resolvedIPs) == 0 {
			return nil, fmt.Errorf("webhook target did not resolve to any IP addresses")
		}

		for _, resolved := range resolvedIPs {
			if IsRestrictedIP(resolved.IP) {
				return nil, fmt.Errorf("webhook target resolves to restricted IP %s", resolved.IP.String())
			}
		}

		// Pin the validated IP: dialing by hostname would re-resolve DNS and
		// allow a rebinding attack (TOCTOU) to swap in a restricted address.
		return dial(ctx, network, net.JoinHostPort(resolvedIPs[0].IP.String(), port))
	}
}
