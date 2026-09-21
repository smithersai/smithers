package migrate

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfig_Cov_LoadAtlasEnvUsesDatabaseURLFallback(t *testing.T) {
	t.Setenv("SMITHERS_ATLAS_URL", " \t ")
	t.Setenv("SMITHERS_DATABASE_URL", " postgres://fallback:fallback@localhost:5432/app?sslmode=disable ")
	t.Setenv("SMITHERS_ATLAS_DEV_URL", " postgres://dev:dev@localhost:5432/app_dev?sslmode=disable ")

	env, err := LoadAtlasEnv()
	require.NoError(t, err)
	assert.Equal(t, "postgres://fallback:fallback@localhost:5432/app?sslmode=disable", env.URL)
	assert.Equal(t, "postgres://dev:dev@localhost:5432/app_dev?sslmode=disable", env.DevURL)
}

func TestConfig_Cov_LoadAtlasEnvRequiresDevURL(t *testing.T) {
	t.Setenv("SMITHERS_ATLAS_URL", "postgres://app:app@localhost:5432/app?sslmode=disable")
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("SMITHERS_ATLAS_DEV_URL", " \n\t ")

	_, err := LoadAtlasEnv()
	require.Error(t, err)
	assert.EqualError(t, err, "SMITHERS_ATLAS_DEV_URL is required")
}
