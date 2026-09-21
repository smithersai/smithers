package pairauth

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPairauth_Cov_LevelSatisfiesRejectsUnknownWantedLevel(t *testing.T) {
	t.Parallel()

	for _, grant := range []Level{LevelView, LevelEdit, ""} {
		t.Run(string(grant), func(t *testing.T) {
			t.Parallel()
			assert.False(t, LevelSatisfies(grant, Level("admin")))
		})
	}
}
