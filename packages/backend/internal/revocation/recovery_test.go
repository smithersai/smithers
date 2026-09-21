package revocation

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestMissedNotificationBeforeLaterEvent(t *testing.T) {
	log := newFakeLog()
	log.rows = []db.RevocationEvent{{ID: 1, Kind: string(KindTokenRevoked), TokenHash: "earlier"}, {ID: 2, Kind: string(KindTokenRevoked), TokenHash: "later"}}
	bus := newBus(log)
	payload, _ := json.Marshal(Event{ID: 2, Kind: KindTokenRevoked, TokenHash: "later"})
	bus.deliverPayload(context.Background(), string(payload))
	if !bus.IsTokenRevoked("earlier") {
		t.Fatal("earlier durable revocation skipped after later notification advanced cursor")
	}
}
func TestDisabledEntryExpiresWhenNoNewEvents(t *testing.T) {
	bus := newBus(nil)
	bus.Retention = time.Nanosecond
	bus.Deliver(Event{ID: 1, Kind: KindUserDisabled, UserID: 7})
	time.Sleep(time.Millisecond)
	if bus.IsUserDisabled(7) {
		t.Fatal("disabled-user cache remains active past retention until another event arrives")
	}
}

func TestUserEnableClearsSuspensionAndIgnoresDelayedDisable(t *testing.T) {
	bus := newBus(nil)
	bus.Deliver(Event{ID: 2, Kind: KindUserEnabled, UserID: 7})
	bus.Deliver(Event{ID: 1, Kind: KindUserDisabled, UserID: 7})
	if bus.IsUserDisabled(7) {
		t.Fatal("old suspension overrode newer enable event")
	}
	bus.Deliver(Event{ID: 3, Kind: KindUserDisabled, UserID: 7})
	if !bus.IsUserDisabled(7) {
		t.Fatal("new suspension was ignored")
	}
	bus.Deliver(Event{ID: 4, Kind: KindUserEnabled, UserID: 7})
	if bus.IsUserDisabled(7) {
		t.Fatal("unsuspension did not clear cached deny")
	}
}

func TestDelayedSuspensionDoesNotCloseReenabledUserStream(t *testing.T) {
	bus := newBus(nil)
	bus.Deliver(Event{ID: 2, Kind: KindUserEnabled, UserID: 7})
	events := bus.Watch(t.Context(), Principal{UserID: 7})
	bus.Deliver(Event{ID: 1, Kind: KindUserDisabled, UserID: 7})
	select {
	case <-events:
		t.Fatal("delayed suspension revoked a newly authorized stream")
	default:
	}
	bus.Deliver(Event{ID: 3, Kind: KindUserDisabled, UserID: 7})
	select {
	case <-events:
	default:
		t.Fatal("new suspension did not revoke the stream")
	}
}
