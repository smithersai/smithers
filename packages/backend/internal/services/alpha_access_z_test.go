package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAlphaAccess_Z_UniqueWhitelistCandidatesDedupesNormalizedValues(t *testing.T) {
	candidates := uniqueWhitelistCandidates([]whitelistCandidate{
		{kind: WhitelistIdentityUsername, value: " Alice "},
		{kind: WhitelistIdentityUsername, value: "alice"},
		{kind: WhitelistIdentityEmail, value: "not-an-email"},
	})

	assert.Equal(t, []whitelistCandidate{
		{kind: WhitelistIdentityUsername, value: " Alice "},
		{kind: WhitelistIdentityEmail, value: "not-an-email"},
	}, candidates)
}
