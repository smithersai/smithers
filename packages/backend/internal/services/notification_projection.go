package services

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// NotificationFact is a versioned accepted lifecycle fact. Sequence is scoped
// to its recipient's journal; ID is the stable UUID, not a notification ID.
// Deleted facts expose no old body. Baseline facts are imported current state,
// never a claim that historical creation/read transitions were observed.
type NotificationFact struct {
	StreamID       string                `json:"stream_id"`
	ID             string                `json:"id"`
	Sequence       int64                 `json:"sequence"`
	SchemaVersion  int16                 `json:"schema_version"`
	Type           string                `json:"type"`
	NotificationID int64                 `json:"notification_id"`
	RecordedAt     time.Time             `json:"recorded_at"`
	Notification   *NotificationResponse `json:"notification,omitempty"`
}

// NotificationProjection is a derived view. Its cursor can have gaps when
// facts were hidden by current repository permissions. Raw journal rebuild
// verification checks gap-free coverage separately before comparing rows.
type NotificationProjection struct {
	StreamID      string                         `json:"stream_id"`
	Cursor        int64                          `json:"cursor"`
	Notifications map[int64]NotificationResponse `json:"notifications"`
}

func validateNotificationFact(fact NotificationFact) error {
	recipient, err := strconv.ParseInt(strings.TrimPrefix(fact.StreamID, "notifications:"), 10, 64)
	if err != nil || recipient <= 0 || !strings.HasPrefix(fact.StreamID, "notifications:") {
		return fmt.Errorf("invalid notification stream identity")
	}
	if fact.SchemaVersion != 1 {
		return fmt.Errorf("unsupported notification fact version %d", fact.SchemaVersion)
	}
	if _, err := uuid.Parse(fact.ID); err != nil {
		return fmt.Errorf("invalid notification fact id: %w", err)
	}
	if fact.Sequence <= 0 || fact.NotificationID <= 0 || fact.RecordedAt.IsZero() {
		return fmt.Errorf("invalid notification fact identity or timestamp")
	}
	switch fact.Type {
	case "notification.deleted":
		if fact.Notification != nil {
			return fmt.Errorf("deleted notification fact must omit post-image")
		}
		return nil
	case "notification.baseline", "notification.created", "notification.read", "notification.unread", "notification.updated":
	default:
		return fmt.Errorf("unsupported notification fact type %q", fact.Type)
	}
	if fact.Notification == nil || fact.Notification.ID != fact.NotificationID {
		return fmt.Errorf("notification post-image identity mismatch")
	}
	if fact.Notification.CreatedAt.IsZero() || fact.Notification.UpdatedAt.IsZero() {
		return fmt.Errorf("notification post-image timestamps missing")
	}
	switch fact.Notification.Status {
	case "read", "unread", "pinned":
	default:
		return fmt.Errorf("invalid notification post-image status")
	}
	if fact.Type == "notification.read" && fact.Notification.Status != "read" {
		return fmt.Errorf("read fact has non-read post-image")
	}
	if fact.Type == "notification.unread" && fact.Notification.Status != "unread" {
		return fmt.Errorf("unread fact has non-unread post-image")
	}
	return nil
}

func applyNotificationFact(state *NotificationProjection, fact NotificationFact) {
	if fact.Sequence <= state.Cursor {
		return
	} // at-least-once delivery of stable facts
	if fact.Type == "notification.deleted" {
		delete(state.Notifications, fact.NotificationID)
	} else {
		value := *fact.Notification
		if value.ReadAt != nil {
			readAt := *value.ReadAt
			value.ReadAt = &readAt
		}
		state.Notifications[fact.NotificationID] = value
	}
	state.Cursor = fact.Sequence
	state.StreamID = fact.StreamID
}

// ApplyNotificationFact is pure: it returns a new map and never mutates state.
// Full post-images make updates replayable even when an earlier event was
// invisible to this caller. Authorization is an explicit external input.
func ApplyNotificationFact(state NotificationProjection, fact NotificationFact) (NotificationProjection, error) {
	if err := validateNotificationFact(fact); err != nil {
		return state, err
	}
	if state.StreamID != "" && fact.StreamID != state.StreamID {
		return state, fmt.Errorf("notification stream identity mismatch")
	}
	if fact.Sequence <= state.Cursor {
		return state, nil
	}
	next := NotificationProjection{StreamID: state.StreamID, Cursor: state.Cursor, Notifications: make(map[int64]NotificationResponse, len(state.Notifications)+1)}
	for id, value := range state.Notifications {
		next.Notifications[id] = value
	}
	applyNotificationFact(&next, fact)
	return next, nil
}

// RebuildNotificationProjection reconstructs an unfiltered journal in linear
// time. Gap-free sequence coverage proves no accepted fact was omitted; the
// resulting map is compared with notification rows from the same DB snapshot.
func RebuildNotificationProjection(facts []NotificationFact) (NotificationProjection, error) {
	state := NotificationProjection{Notifications: make(map[int64]NotificationResponse)}
	for _, fact := range facts {
		if err := validateNotificationFact(fact); err != nil {
			return NotificationProjection{}, err
		}
		if state.StreamID != "" && fact.StreamID != state.StreamID {
			return NotificationProjection{}, fmt.Errorf("notification stream identity mismatch")
		}
		if fact.Sequence != state.Cursor+1 {
			return NotificationProjection{}, fmt.Errorf("notification journal gap: after %d got %d", state.Cursor, fact.Sequence)
		}
		applyNotificationFact(&state, fact)
	}
	return state, nil
}
