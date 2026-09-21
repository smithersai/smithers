package sseauth

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSSETicketManager_IssueAndValidate(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC)
	manager := NewSSETicketManager("session-secret")
	manager.now = func() time.Time { return now }

	ticket, expiresAt, err := manager.Issue(SSETicketSubject{
		UserID:    42,
		TokenHash: "token-hash-42",
	})
	require.NoError(t, err)
	assert.Equal(t, now.Add(sseTicketTTL), expiresAt)

	got, err := manager.ValidateAndConsume(ticket)
	require.NoError(t, err)
	assert.Equal(t, SSETicketSubject{
		UserID:    42,
		TokenHash: "token-hash-42",
	}, got)
}

func TestSSETicketManager_IssueAndValidateSessionTicket(t *testing.T) {
	t.Parallel()

	manager := NewSSETicketManager("session-secret")

	ticket, _, err := manager.Issue(SSETicketSubject{UserID: 7})
	require.NoError(t, err)

	got, err := manager.ValidateAndConsume(ticket)
	require.NoError(t, err)
	assert.Equal(t, SSETicketSubject{UserID: 7}, got)
}

func TestSSETicketManager_RejectsReplay(t *testing.T) {
	t.Parallel()

	manager := NewSSETicketManager("session-secret")
	ticket, _, err := manager.Issue(SSETicketSubject{UserID: 7, TokenHash: "token-hash-7"})
	require.NoError(t, err)

	_, err = manager.ValidateAndConsume(ticket)
	require.NoError(t, err)

	_, err = manager.ValidateAndConsume(ticket)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrSSETicketReplay)
}

func TestSSETicketManager_RejectsExpiredTicket(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC)
	manager := NewSSETicketManager("session-secret")
	manager.now = func() time.Time { return now }

	ticket, _, err := manager.Issue(SSETicketSubject{UserID: 7, TokenHash: "token-hash-7"})
	require.NoError(t, err)

	manager.now = func() time.Time { return now.Add(sseTicketTTL + time.Second) }

	_, err = manager.ValidateAndConsume(ticket)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrSSETicketExpired)
}

func TestSSETicketManager_LimitsActiveTicketsPerUser(t *testing.T) {
	t.Parallel()

	manager := NewSSETicketManager("session-secret")

	for i := 0; i < maxSSETicketsPerUser; i++ {
		_, _, err := manager.Issue(SSETicketSubject{UserID: 9, TokenHash: "token-hash-9"})
		require.NoError(t, err)
	}

	_, _, err := manager.Issue(SSETicketSubject{UserID: 9, TokenHash: "token-hash-9"})
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrSSETicketLimit))
}
