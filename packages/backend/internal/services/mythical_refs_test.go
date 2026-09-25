package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Only the stack service moves the mythical bookmark: the bookmark routes,
// pushes and landings refuse it before reading any protection rule.
func TestMythicalBookmarkIsOwnedByTheStackService(t *testing.T) {
	err := RequireBookmarkNotProtected(context.Background(), nil, 1, MythicalBookmark)
	require.ErrorIs(t, err, errMythicalBookmarkOwned)
}

func TestChangesetsNeverLandOnTheMythicalBookmark(t *testing.T) {
	err := (&ChangesetService{}).checkLandingPolicy(context.Background(), db.Repository{}, "o", "c", "x", MythicalBookmark)
	require.ErrorIs(t, err, errMythicalBookmarkOwned)
}
