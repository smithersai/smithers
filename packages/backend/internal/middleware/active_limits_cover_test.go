package middleware

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestActiveLimits_Cov_MaxAndFormatEdges(t *testing.T) {
	t.Parallel()

	ac := NewActiveCounter("cover_edges", 7, nil)

	assert.Equal(t, 7, ac.Max())
	assert.Equal(t, "0", activeLimitFormatUserID(0))
	assert.Equal(t, "-42", activeLimitFormatUserID(-42))
}
