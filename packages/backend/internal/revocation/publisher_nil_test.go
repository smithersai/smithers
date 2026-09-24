package revocation

import (
	"context"
	"errors"
	"testing"
)

// A DBPublisher without a store must fail closed: reporting success would let
// callers believe a credential was revoked when nothing was recorded.
func TestDBPublisherWithoutStoreFailsClosed(t *testing.T) {
	event := Event{Kind: KindTokenRevoked, TokenHash: "h1"}
	for name, p := range map[string]*DBPublisher{
		"nil store":    NewDBPublisher(nil, nil),
		"nil receiver": nil,
	} {
		err := p.Publish(context.Background(), event)
		if !errors.Is(err, ErrPublisherNotConfigured) {
			t.Fatalf("%s: Publish error = %v, want ErrPublisherNotConfigured", name, err)
		}
	}
}
