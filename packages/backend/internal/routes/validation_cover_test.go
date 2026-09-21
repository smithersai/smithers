package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestValidation_Cov_RefAndContentPathEdges(t *testing.T) {
	t.Parallel()

	assert.Nil(t, validateRef(""))
	assert.Nil(t, validateRef("feature/main"))
	assert.Equal(t, "ref is too long", validateRef(strings.Repeat("x", maxRefLen+1)).Message)
	assert.Equal(t, "ref contains invalid characters", validateRef("main\x7f").Message)
	assert.Equal(t, "ref contains invalid characters", validateRef("main\nnext").Message)

	assert.Nil(t, validateContentPath(""))
	assert.Nil(t, validateContentPath("dir/file.txt"))
	assert.Equal(t, "path is too long", validateContentPath(strings.Repeat("p", maxContentPathLen+1)).Message)
	assert.Equal(t, "path contains invalid characters", validateContentPath("dir/\x00file").Message)
	assert.Equal(t, "path contains invalid characters", validateContentPath("dir\rfile").Message)
}
