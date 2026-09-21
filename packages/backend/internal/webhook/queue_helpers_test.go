package webhook

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestToResponseStatus_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for status := -50; status <= 650; status++ {
		caseCount++

		got := toResponseStatus(status)
		if status <= 0 {
			assert.Falsef(t, got.Valid, "status=%d", status)
			assert.Zerof(t, got.Int32, "status=%d", status)
			continue
		}

		assert.Truef(t, got.Valid, "status=%d", status)
		assert.Equalf(t, int32(status), got.Int32, "status=%d", status)
	}

	assert.Equal(t, 701, caseCount)
}
