package services

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestGitHubProxy_Z_RetryAfterFloorAndEmptyPath(t *testing.T) {
	assert.Equal(t, 1, gitHubProxyRetryAfterSeconds(0))
	assert.Equal(t, 2, gitHubProxyRetryAfterSeconds(1500*time.Millisecond))
}
