package cleanup

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWorkflowCacheCleaner_H_DefaultsNonPositiveInterval(t *testing.T) {
	t.Parallel()

	cleaner := NewWorkflowCacheCleaner(nil, 0)

	require.Equal(t, defaultWorkflowCacheCleanupInterval, cleaner.interval)
}
