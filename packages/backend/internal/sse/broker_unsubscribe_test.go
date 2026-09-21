package sse

import "testing"

// Unsubscribe must close the subscriber channel so the HTTP handler's range loop
// terminates — even when an event is still buffered. The previous select-guard
// received the buffered event (draining it) and skipped the close, leaking the
// channel and the SSE goroutine.
func TestBrokerUnsubscribeClosesChannelWithBufferedEvent(t *testing.T) {
	b := NewBroker(nil)
	s := &subscriber{ch: make(chan Event, subscriberBufSize), userID: 7}
	b.subscribers["room"] = []*subscriber{s}
	b.userCounts[7] = 1
	sub := &Subscription{broker: b, channels: []string{"room"}, sub: s}

	// Buffer an event: the buggy guard would consume this and return without closing.
	s.ch <- Event{}

	b.Unsubscribe(sub)

	// Drain any buffered events, then confirm the channel is closed (not merely empty).
	closed := false
	for i := 0; i < subscriberBufSize+2; i++ {
		select {
		case _, ok := <-s.ch:
			if !ok {
				closed = true
			}
		default:
		}
		if closed {
			break
		}
	}
	if !closed {
		t.Fatal("Unsubscribe left the subscriber channel open when an event was buffered (goroutine leak)")
	}
}
