package microsandbox

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDefaultRootfsSizeMBBySandboxKind(t *testing.T) {
	assert.EqualValues(t, 2*1024, DefaultRootfsSizeMB("container"))
	assert.EqualValues(t, 2*1024, DefaultRootfsSizeMB("agent"))
	assert.EqualValues(t, 2*1024, DefaultRootfsSizeMB(""))
	assert.EqualValues(t, 4*1024, DefaultRootfsSizeMB("vm"))
	assert.EqualValues(t, 8*1024, DefaultRootfsSizeMB("desktop"))
	assert.EqualValues(t, 8*1024, DefaultRootfsSizeMB(" DESKTOP "))
}
