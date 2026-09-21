package sseauth

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSseTicket_H_IssuePropagatesRandomTicketIDFailure(t *testing.T) {
	sentinel := errors.New("random ticket id failed")
	originalReadRandom := readRandomTicketID
	readRandomTicketID = func([]byte) (int, error) {
		return 0, sentinel
	}
	t.Cleanup(func() {
		readRandomTicketID = originalReadRandom
	})

	m := NewSSETicketManager("h-random-failure")
	token, expiresAt, err := m.Issue(SSETicketSubject{UserID: 1})

	require.ErrorIs(t, err, sentinel)
	assert.Empty(t, token)
	assert.True(t, expiresAt.IsZero())
	assert.Empty(t, m.activeByUser)
}

func TestSseTicket_H_MustHelpersPanicOnError(t *testing.T) {
	t.Parallel()

	bytesErr := errors.New("must bytes failed")
	if got := sseTicketHRecoverPanic(func() {
		mustBytes(nil, bytesErr)
	}); got != bytesErr {
		t.Fatalf("mustBytes panic = %v, want %v", got, bytesErr)
	}

	noErrErr := errors.New("must no err failed")
	if got := sseTicketHRecoverPanic(func() {
		mustNoErr(noErrErr)
	}); got != noErrErr {
		t.Fatalf("mustNoErr panic = %v, want %v", got, noErrErr)
	}
}

func sseTicketHRecoverPanic(fn func()) (got any) {
	defer func() {
		got = recover()
	}()
	fn()
	return nil
}
