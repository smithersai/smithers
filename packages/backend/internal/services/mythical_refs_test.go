package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// Only the stack service moves the mythical bookmark: the bookmark routes,
// pushes and landings refuse it before reading any protection rule.
func TestMythicalBookmarkIsOwnedByTheStackService(t *testing.T) {
	err := RequireBookmarkNotProtected(context.Background(), nil, 1, MythicalBookmark)
	require.ErrorIs(t, err, errMythicalBookmarkOwned)
}
