package smitherscli

import "testing"

func TestReleaseIgnoresAgentSummaryMode(t *testing.T) {
	old := testSeamsEnabled
	testSeamsEnabled = false
	t.Cleanup(func() { testSeamsEnabled = old })
	t.Setenv("SMITHERS_AGENT_TEST_MODE", "summary")
	if got := testSeamEnv("SMITHERS_AGENT_TEST_MODE"); got != "" {
		t.Fatalf("release read test-only mode %q", got)
	}
}
