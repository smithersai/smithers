package webhooks

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// linearCoverInner is a controllable inner Dispatcher used to verify delegation
// and error propagation in linearDispatcher.
type linearCoverInner struct {
	dispatchErr    error
	dispatchOrgErr error

	dispatchCalls    int
	dispatchOrgCalls int
	lastRepoID       int64
	lastOrgID        int64
	lastEventType    EventType
}

func (m *linearCoverInner) DispatchEvent(_ context.Context, repoID int64, eventType EventType, _ any) error {
	m.dispatchCalls++
	m.lastRepoID = repoID
	m.lastEventType = eventType
	return m.dispatchErr
}

func (m *linearCoverInner) DispatchOrgEvent(_ context.Context, orgID int64, eventType EventType, _ any) error {
	m.dispatchOrgCalls++
	m.lastOrgID = orgID
	m.lastEventType = eventType
	return m.dispatchOrgErr
}

// linearCoverSubscriber records Linear sync calls and signals via channels so
// the fire-and-forget goroutines can be observed deterministically.
type linearCoverSubscriber struct {
	issueCh   chan issueCoverCall
	commentCh chan commentCoverCall
}

type issueCoverCall struct {
	repoID int64
	event  IssueEventPayload
}

type commentCoverCall struct {
	repoID int64
	event  IssueCommentEventPayload
}

func newLinearCoverSubscriber() *linearCoverSubscriber {
	return &linearCoverSubscriber{
		issueCh:   make(chan issueCoverCall, 1),
		commentCh: make(chan commentCoverCall, 1),
	}
}

func (m *linearCoverSubscriber) HandleSmithersIssueEvent(_ context.Context, repoID int64, event IssueEventPayload) {
	m.issueCh <- issueCoverCall{repoID: repoID, event: event}
}

func (m *linearCoverSubscriber) HandleSmithersCommentEvent(_ context.Context, repoID int64, event IssueCommentEventPayload) {
	m.commentCh <- commentCoverCall{repoID: repoID, event: event}
}

// TestLinearDispatch_Cover_NewLinearDispatcher covers the constructor.
func TestLinearDispatch_Cover_NewLinearDispatcher(t *testing.T) {
	t.Parallel()

	inner := &linearCoverInner{}
	sub := newLinearCoverSubscriber()
	d := NewLinearDispatcher(inner, sub)
	require.NotNil(t, d)
}

// TestLinearDispatch_Cover_DispatchEvent_DelegatesError covers the branch where
// the inner dispatcher returns an error (no Linear sync should fire).
func TestLinearDispatch_Cover_DispatchEvent_DelegatesError(t *testing.T) {
	t.Parallel()

	inner := &linearCoverInner{dispatchErr: assert.AnError}
	sub := newLinearCoverSubscriber()
	d := NewLinearDispatcher(inner, sub)

	err := d.DispatchEvent(context.Background(), 5, EventTypeIssues, IssueEventPayload{Action: "opened"})
	require.ErrorIs(t, err, assert.AnError)
	assert.Equal(t, 1, inner.dispatchCalls)
}

// TestLinearDispatch_Cover_DispatchEvent_FiresIssueSync covers the issues event
// path with a matching payload type; the goroutine must invoke the subscriber.
func TestLinearDispatch_Cover_DispatchEvent_FiresIssueSync(t *testing.T) {
	t.Parallel()

	inner := &linearCoverInner{}
	sub := newLinearCoverSubscriber()
	d := NewLinearDispatcher(inner, sub)

	payload := IssueEventPayload{Action: "opened", Issue: IssuePayload{ID: 99, Number: 3}}
	err := d.DispatchEvent(context.Background(), 5, EventTypeIssues, payload)
	require.NoError(t, err)

	select {
	case got := <-sub.issueCh:
		assert.Equal(t, int64(5), got.repoID)
		assert.Equal(t, "opened", got.event.Action)
		assert.Equal(t, int64(99), got.event.Issue.ID)
	case <-time.After(2 * time.Second):
		t.Fatal("expected issue sync to fire")
	}
}

// TestLinearDispatch_Cover_DispatchEvent_IssueTypeMismatch covers the else
// branch when the issues event payload is not an IssueEventPayload.
func TestLinearDispatch_Cover_DispatchEvent_IssueTypeMismatch(t *testing.T) {
	t.Parallel()

	inner := &linearCoverInner{}
	sub := newLinearCoverSubscriber()
	d := NewLinearDispatcher(inner, sub)

	err := d.DispatchEvent(context.Background(), 5, EventTypeIssues, map[string]string{"action": "opened"})
	require.NoError(t, err)

	select {
	case <-sub.issueCh:
		t.Fatal("issue sync should not fire on type mismatch")
	case <-time.After(200 * time.Millisecond):
		// expected: no call
	}
}

// TestLinearDispatch_Cover_DispatchEvent_FiresCommentSync covers the
// issue_comment event path with a matching payload type.
func TestLinearDispatch_Cover_DispatchEvent_FiresCommentSync(t *testing.T) {
	t.Parallel()

	inner := &linearCoverInner{}
	sub := newLinearCoverSubscriber()
	d := NewLinearDispatcher(inner, sub)

	payload := IssueCommentEventPayload{Action: "created", Comment: IssueCommentPayload{ID: 7, Body: "hi"}}
	err := d.DispatchEvent(context.Background(), 11, EventTypeIssueComment, payload)
	require.NoError(t, err)

	select {
	case got := <-sub.commentCh:
		assert.Equal(t, int64(11), got.repoID)
		assert.Equal(t, "created", got.event.Action)
		assert.Equal(t, int64(7), got.event.Comment.ID)
	case <-time.After(2 * time.Second):
		t.Fatal("expected comment sync to fire")
	}
}

// TestLinearDispatch_Cover_DispatchEvent_CommentTypeMismatch covers the else
// branch when the issue_comment event payload is the wrong type.
func TestLinearDispatch_Cover_DispatchEvent_CommentTypeMismatch(t *testing.T) {
	t.Parallel()

	inner := &linearCoverInner{}
	sub := newLinearCoverSubscriber()
	d := NewLinearDispatcher(inner, sub)

	err := d.DispatchEvent(context.Background(), 11, EventTypeIssueComment, map[string]string{"action": "created"})
	require.NoError(t, err)

	select {
	case <-sub.commentCh:
		t.Fatal("comment sync should not fire on type mismatch")
	case <-time.After(200 * time.Millisecond):
		// expected: no call
	}
}

// TestLinearDispatch_Cover_DispatchEvent_OtherEventNoSync covers the default
// switch path for an event type that does not trigger Linear sync.
func TestLinearDispatch_Cover_DispatchEvent_OtherEventNoSync(t *testing.T) {
	t.Parallel()

	inner := &linearCoverInner{}
	sub := newLinearCoverSubscriber()
	d := NewLinearDispatcher(inner, sub)

	err := d.DispatchEvent(context.Background(), 5, EventTypePush, map[string]string{"ref": "refs/heads/main"})
	require.NoError(t, err)
	assert.Equal(t, 1, inner.dispatchCalls)
	assert.Equal(t, EventTypePush, inner.lastEventType)

	select {
	case <-sub.issueCh:
		t.Fatal("no sync should fire for push")
	case <-sub.commentCh:
		t.Fatal("no sync should fire for push")
	case <-time.After(200 * time.Millisecond):
		// expected: no call
	}
}

// TestLinearDispatch_Cover_DispatchOrgEvent covers the org delegation path,
// including error propagation.
func TestLinearDispatch_Cover_DispatchOrgEvent(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		inner := &linearCoverInner{}
		sub := newLinearCoverSubscriber()
		d := NewLinearDispatcher(inner, sub)

		err := d.DispatchOrgEvent(context.Background(), 33, EventTypeOrganization, map[string]string{"a": "b"})
		require.NoError(t, err)
		assert.Equal(t, 1, inner.dispatchOrgCalls)
		assert.Equal(t, int64(33), inner.lastOrgID)
		assert.Equal(t, EventTypeOrganization, inner.lastEventType)
	})

	t.Run("error", func(t *testing.T) {
		inner := &linearCoverInner{dispatchOrgErr: assert.AnError}
		sub := newLinearCoverSubscriber()
		d := NewLinearDispatcher(inner, sub)

		err := d.DispatchOrgEvent(context.Background(), 33, EventTypeOrganization, map[string]string{"a": "b"})
		require.ErrorIs(t, err, assert.AnError)
		assert.Equal(t, 1, inner.dispatchOrgCalls)
	})
}
