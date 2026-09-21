package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type userDevicesCovQuerier struct {
	upsertArg db.UpsertUserDeviceParams
	deleteArg db.DeleteUserDeviceParams
	upsertErr error
	deleteErr error
}

func (q *userDevicesCovQuerier) UpsertUserDevice(_ context.Context, arg db.UpsertUserDeviceParams) (db.UserDevice, error) {
	q.upsertArg = arg
	if q.upsertErr != nil {
		return db.UserDevice{}, q.upsertErr
	}
	now := time.Now().UTC()
	return db.UserDevice{ID: 10, UserID: arg.UserID, ApnsToken: arg.ApnsToken, Platform: arg.Platform, CreatedAt: now, LastSeenAt: now}, nil
}

func (q *userDevicesCovQuerier) DeleteUserDevice(_ context.Context, arg db.DeleteUserDeviceParams) error {
	q.deleteArg = arg
	return q.deleteErr
}

func TestUserDevices_Cov_RegisterDefaultsAndValidation(t *testing.T) {
	q := &userDevicesCovQuerier{}
	resp, err := NewUserDeviceService(q).RegisterDevice(context.Background(), 5, RegisterUserDeviceRequest{APNSToken: " token "})
	if err != nil {
		t.Fatalf("RegisterDevice returned error: %v", err)
	}
	if resp.Platform != UserDevicePlatformIOS || q.upsertArg.ApnsToken != "token" {
		t.Fatalf("resp=%+v arg=%+v", resp, q.upsertArg)
	}

	for _, req := range []RegisterUserDeviceRequest{
		{APNSToken: ""},
		{APNSToken: "x", Platform: "web"},
		{APNSToken: strings.Repeat("a", maxDeviceTokenLen+1)},
		{APNSToken: "bad token"},
		{APNSToken: "tok\nen"},
		{APNSToken: "token!"},
	} {
		_, err := NewUserDeviceService(q).RegisterDevice(context.Background(), 5, req)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusBadRequest {
			t.Fatalf("req=%+v err=%#v, want bad request", req, err)
		}
	}

	// FCM-style tokens (colon, dash, underscore, dot) are accepted.
	fcmToken := "dGVzdA:APA91b-Fak3_T0k.en"
	if _, err := NewUserDeviceService(q).RegisterDevice(context.Background(), 5, RegisterUserDeviceRequest{APNSToken: fcmToken, Platform: "android"}); err != nil {
		t.Fatalf("RegisterDevice rejected valid FCM-style token: %v", err)
	}
	_, err = NewUserDeviceService(q).RegisterDevice(context.Background(), 0, RegisterUserDeviceRequest{APNSToken: "x"})
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("err=%#v, want unauthorized", err)
	}
}

func TestUserDevices_Cov_DeleteAndStoreErrors(t *testing.T) {
	q := &userDevicesCovQuerier{}
	err := NewUserDeviceService(q).DeleteDevice(context.Background(), 7, " token ")
	if err != nil || q.deleteArg.ApnsToken != "token" || q.deleteArg.UserID != 7 {
		t.Fatalf("DeleteDevice err=%v arg=%+v", err, q.deleteArg)
	}

	q.upsertErr = errors.New("db down")
	_, err = NewUserDeviceService(q).RegisterDevice(context.Background(), 7, RegisterUserDeviceRequest{APNSToken: "x", Platform: "android"})
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusInternalServerError {
		t.Fatalf("register err=%#v, want internal", err)
	}

	q.deleteErr = errors.New("db down")
	err = NewUserDeviceService(q).DeleteDevice(context.Background(), 7, "x")
	apiErr, ok = err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusInternalServerError {
		t.Fatalf("delete err=%#v, want internal", err)
	}
}
