package repohostserver

import "testing"

func TestAuthTokenFromEnvPrefersSMITHERSPrefix(t *testing.T) {
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "new-token")
	t.Setenv("REPO_HOST_AUTH_TOKEN", "legacy-token")

	if got := authTokenFromEnv(); got != "new-token" {
		t.Fatalf("expected SMITHERS_REPO_HOST_AUTH_TOKEN to win, got %q", got)
	}
}

func TestAuthTokenFromEnvFallsBackToLegacyEnv(t *testing.T) {
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "")
	t.Setenv("REPO_HOST_AUTH_TOKEN", "legacy-token")

	if got := authTokenFromEnv(); got != "legacy-token" {
		t.Fatalf("expected legacy fallback, got %q", got)
	}
}

func TestParseRepoIDAcceptsURLPathEscapedValue(t *testing.T) {
	owner, repo, err := parseRepoID("alice%3Ademo")
	if err != nil {
		t.Fatalf("parseRepoID: %v", err)
	}
	if owner != "alice" || repo != "demo" {
		t.Fatalf("unexpected repo id: owner=%q repo=%q", owner, repo)
	}
}

func TestParseRepoIDRejectsInvalidEscape(t *testing.T) {
	if _, _, err := parseRepoID("alice%ZZdemo"); err == nil {
		t.Fatal("expected invalid escape to be rejected")
	}
}
