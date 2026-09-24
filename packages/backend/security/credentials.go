package security

import "github.com/smithersai/smithers/packages/backend/internal/credentialscan"

type CredentialFinding = credentialscan.CredentialFinding

func ScanForCredentialMaterial(text string) *CredentialFinding {
	return credentialscan.ScanForCredentialMaterial(text)
}
