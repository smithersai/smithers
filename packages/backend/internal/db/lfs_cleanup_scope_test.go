package db

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestExpiredLFSReservationCleanupIsRepositoryScoped(t *testing.T) {
	assert.Contains(t, listExpiredLFSUploadReservationsByOwner, "WHERE lur.repository_id = $1")
	assert.NotContains(t, listExpiredLFSUploadReservationsByOwner, "target_owner")
}
