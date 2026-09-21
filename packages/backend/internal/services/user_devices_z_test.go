package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type userDevicesZQuerier struct {
	deleteErr error
}

func (q userDevicesZQuerier) UpsertUserDevice(context.Context, db.UpsertUserDeviceParams) (db.UserDevice, error) {
	return db.UserDevice{}, nil
}

func (q userDevicesZQuerier) DeleteUserDevice(context.Context, db.DeleteUserDeviceParams) error {
	return q.deleteErr
}

func TestUserDevices_Z_DeleteDeviceValidationBranches(t *testing.T) {
	svc := NewUserDeviceService(userDevicesZQuerier{})

	err := svc.DeleteDevice(context.Background(), 0, "token")
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	err = svc.DeleteDevice(context.Background(), 1, " ")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	err = NewUserDeviceService(userDevicesZQuerier{deleteErr: errors.New("delete failed")}).
		DeleteDevice(context.Background(), 1, "token")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}
