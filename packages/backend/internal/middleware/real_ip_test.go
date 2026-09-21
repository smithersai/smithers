package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRealIP(t *testing.T) {
	const socketAddr = "10.0.0.9:1234"

	tests := []struct {
		name       string
		hops       int
		xff        string
		trueClient string
		xRealIP    string
		want       string
	}{
		{
			name: "hops=0 ignores XFF",
			hops: 0,
			xff:  "6.6.6.6",
			want: socketAddr,
		},
		{
			name:       "hops=0 ignores True-Client-IP and X-Real-IP",
			hops:       0,
			trueClient: "6.6.6.6",
			xRealIP:    "7.7.7.7",
			want:       socketAddr,
		},
		{
			name: "hops=1 selects second-from-last",
			hops: 1,
			xff:  "203.0.113.7, 34.1.2.3",
			want: "203.0.113.7",
		},
		{
			name: "hops=1 ignores attacker-prepended entry",
			hops: 1,
			xff:  "6.6.6.6, 203.0.113.7, 34.1.2.3",
			want: "203.0.113.7",
		},
		{
			name: "hops=1 too few entries keeps socket addr",
			hops: 1,
			xff:  "34.1.2.3",
			want: socketAddr,
		},
		{
			name: "hops=1 invalid IP at selected slot keeps socket addr",
			hops: 1,
			xff:  "evil, 34.1.2.3",
			want: socketAddr,
		},
		{
			name: "hops=1 no XFF header keeps socket addr",
			hops: 1,
			xff:  "",
			want: socketAddr,
		},
		{
			name: "hops=1 IPv6 client entry",
			hops: 1,
			xff:  "2001:db8::1, 34.1.2.3",
			want: "2001:db8::1",
		},
		{
			name: "hops=2 selects third-from-last",
			hops: 2,
			xff:  "203.0.113.7, 10.0.0.5, 34.1.2.3",
			want: "203.0.113.7",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.RemoteAddr
			})
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = socketAddr
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			if tc.trueClient != "" {
				req.Header.Set("True-Client-IP", tc.trueClient)
			}
			if tc.xRealIP != "" {
				req.Header.Set("X-Real-IP", tc.xRealIP)
			}
			rec := httptest.NewRecorder()
			RealIP(tc.hops)(next).ServeHTTP(rec, req)
			if got != tc.want {
				t.Fatalf("RemoteAddr = %q, want %q", got, tc.want)
			}
		})
	}
}
