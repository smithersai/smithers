package operations

import "github.com/smithersai/smithers/packages/backend/internal/services"

// IsUsableProviderCredential rejects the same blank, placeholder and template
// values rejected by product model execution.
func IsUsableProviderCredential(value string) bool {
	return services.IsUsableProviderCredential(value)
}
