package smitherscli

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInsertJjhubCacheDeclaration(t *testing.T) {
	t.Parallel()
	declaration := jjhubCacheDeclaration("acme/app", "smithers_cachero_"+strings.Repeat("0", 40))

	created, err := insertJjhubCacheDeclaration("", declaration)
	require.NoError(t, err)
	assert.Equal(t, "import { Smithers } from \"@smthrs/targets\"\n\n"+declaration+"\n", created)

	source := "import { Smithers } from \"@smthrs/targets\"\nimport { other } from \"./other.ts\"\n\nexport const runtime = Smithers.Runtime.Node({ version: \">=22\" })\n"
	updated, err := insertJjhubCacheDeclaration(source, declaration)
	require.NoError(t, err)
	lines := strings.Split(updated, "\n")
	assert.Equal(t, "import { other } from \"./other.ts\"", lines[1])
	assert.Equal(t, "", lines[2])
	assert.Equal(t, declaration, lines[3])
	assert.Contains(t, updated, "export const runtime")
	assert.Equal(t, declaration, existingJjhubCacheDeclaration(updated))

	_, err = insertJjhubCacheDeclaration("export const x = 1\n", declaration)
	assert.Error(t, err, "a BUILD.ts without the targets import is left to the user")
	assert.Equal(t, "", existingJjhubCacheDeclaration(source))
}
