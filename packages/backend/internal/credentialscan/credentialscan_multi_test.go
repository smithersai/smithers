package credentialscan

import "testing"

func TestScanChecksEveryAssignmentOnALine(t *testing.T) {
	for _, line := range []string{
		`{"api_key": "your-api-key-goes-here", "client_secret": "Xk9pQ2vL7mN4rT8wZ1yB3c"}`,
		`token: ${GITHUB_TOKEN_VALUE}, password: "Xk9pQ2vL7mN4rT8wZ1yB3c"`,
	} {
		finding := ScanForCredentialMaterial(line)
		if finding == nil || finding.Rule != "credential_assignment" {
			t.Fatalf("ScanForCredentialMaterial(%q) = %+v, want credential_assignment", line, finding)
		}
	}
	if finding := ScanForCredentialMaterial(`{"api_key": "your-api-key-goes-here", "token": "${TOKEN_VALUE_HERE}"}`); finding != nil {
		t.Fatalf("placeholders only: got %+v", finding)
	}
}

func TestScanMatchesOpenAIServiceAccountAndAdminKeys(t *testing.T) {
	for _, key := range []string{
		"sk-svcacct-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab",
		"sk-admin-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab",
		"sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab",
	} {
		finding := ScanForCredentialMaterial("OPENAI " + key)
		if finding == nil || finding.Rule != "openai_api_key" {
			t.Fatalf("ScanForCredentialMaterial(%q) = %+v, want openai_api_key", key, finding)
		}
	}
}
