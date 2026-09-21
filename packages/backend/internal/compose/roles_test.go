package compose

import "testing"

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
