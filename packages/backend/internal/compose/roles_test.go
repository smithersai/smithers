package compose

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestRoleWorkerAndListenerMatrix(t *testing.T) {
	cases := []struct {
		role                            Role
		serve, workers, cluster, hosted bool
	}{
		{"", true, true, false, false},
		{RoleLocal, true, true, false, false},
		{RoleHostedAPI, true, false, false, true},
		{RoleHostedWorker, false, true, true, true},
	}
	for _, tc := range cases {
		if !tc.role.valid() || tc.role.servesHTTP() != tc.serve || tc.role.workers() != tc.workers ||
			tc.role.clusterWorkers() != tc.cluster || tc.role.hosted() != tc.hosted {
			t.Fatalf("incorrect responsibilities for %q", tc.role)
		}
	}
	if Role("unknown").valid() {
		t.Fatal("unknown role was accepted")
	}
}

func TestRoleRequiresMatchingIdentityTopology(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		role       Role
		want       string
	}{
		{name: "local cannot use multitenant identity", mode: "multitenant", role: RoleLocal, want: `requires auth.mode="selfhost"`},
		{name: "hosted cannot use single owner identity", mode: "selfhost", role: RoleHostedAPI, want: `requires auth.mode="multitenant"`},
		{name: "worker cannot use single owner identity", mode: "selfhost", role: RoleHostedWorker, want: `requires auth.mode="multitenant"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SMITHERS_AUTH_MODE", tc.mode)
			err := RunWithOptions(context.Background(), nil, io.Discard, io.Discard, Options{Role: tc.role})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("role %q with auth.mode=%q returned %v, want %q", tc.role, tc.mode, err, tc.want)
			}
		})
	}
}
