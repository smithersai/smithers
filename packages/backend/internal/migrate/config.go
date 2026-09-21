package migrate

import (
	"fmt"
	"os"
	"strings"
)

// AtlasEnv contains connection settings required for Atlas commands.
type AtlasEnv struct {
	URL    string
	DevURL string
}

// LoadAtlasEnv reads Atlas runtime configuration from environment variables.
func LoadAtlasEnv() (AtlasEnv, error) {
	url := strings.TrimSpace(os.Getenv("SMITHERS_ATLAS_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("SMITHERS_DATABASE_URL"))
	}
	if url == "" {
		return AtlasEnv{}, fmt.Errorf("SMITHERS_ATLAS_URL is required")
	}

	devURL := strings.TrimSpace(os.Getenv("SMITHERS_ATLAS_DEV_URL"))
	if devURL == "" {
		return AtlasEnv{}, fmt.Errorf("SMITHERS_ATLAS_DEV_URL is required")
	}

	return AtlasEnv{
		URL:    url,
		DevURL: devURL,
	}, nil
}
