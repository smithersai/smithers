package alertregistry

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRegistry_Cov_LookupNilReceiver(t *testing.T) {
	t.Parallel()

	var reg *Registry
	assert.Nil(t, reg.Lookup("Smithers High Error Rate - prod"))
}
