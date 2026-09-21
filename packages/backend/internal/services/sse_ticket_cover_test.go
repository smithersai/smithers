package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestSSETicket_Cov_DefaultTTLAndEmptyTicket(t *testing.T) {
	var expires time.Time
	svc := NewSSETicketService(&mockSSETicketQuerier{
		createSSETicketFn: func(_ context.Context, arg db.CreateSSETicketParams) (db.SseTicket, error) {
			expires = arg.ExpiresAt
			return db.SseTicket{TicketHash: arg.TicketHash, UserID: arg.UserID, ExpiresAt: arg.ExpiresAt}, nil
		},
	})
	svc.TTL = -1
	_, err := svc.CreateTicket(context.Background(), 9, false, "", "")
	if err != nil {
		t.Fatalf("CreateTicket returned error: %v", err)
	}
	if time.Until(expires) < SSETicketTTL-5*time.Second {
		t.Fatalf("expires = %v, want default ttl", expires)
	}

	_, err = svc.ValidateTicket(context.Background(), "")
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("empty ticket err = %#v", err)
	}
}

func TestSSETicket_Cov_InternalValidationErrors(t *testing.T) {
	svc := NewSSETicketService(&mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{}, errors.New("consume failed")
		},
	})
	_, err := svc.ValidateTicket(context.Background(), "ticket")
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusInternalServerError {
		t.Fatalf("consume err = %#v", err)
	}

	svc = NewSSETicketService(&mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{UserID: 7}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("load failed")
		},
	})
	_, err = svc.ValidateTicket(context.Background(), "ticket")
	apiErr, ok = err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusInternalServerError {
		t.Fatalf("user load err = %#v", err)
	}

	svc = NewSSETicketService(&mockSSETicketQuerier{
		consumeSSETicketFn: func(context.Context, string) (db.SseTicket, error) {
			return db.SseTicket{UserID: 7}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
	})
	_, err = svc.ValidateTicket(context.Background(), "ticket")
	apiErr, ok = err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("user no rows err = %#v", err)
	}
}
