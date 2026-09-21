package migrate

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadAtlasEnv_ValidConfig(t *testing.T) {
	t.Setenv("SMITHERS_ATLAS_URL", "postgres://smithers:smithers@localhost:5432/smithers?sslmode=disable")
	t.Setenv("SMITHERS_ATLAS_DEV_URL", "postgres://smithers:smithers@localhost:5432/smithers_dev?sslmode=disable")

	env, err := LoadAtlasEnv()
	require.NoError(t, err)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/smithers?sslmode=disable", env.URL)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/smithers_dev?sslmode=disable", env.DevURL)
}

func TestLoadAtlasEnv_MissingURL(t *testing.T) {
	t.Setenv("SMITHERS_ATLAS_URL", "")
	t.Setenv("SMITHERS_ATLAS_DEV_URL", "postgres://smithers:smithers@localhost:5432/smithers_dev?sslmode=disable")

	_, err := LoadAtlasEnv()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SMITHERS_ATLAS_URL")
}
