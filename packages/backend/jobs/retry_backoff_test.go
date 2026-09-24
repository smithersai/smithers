package jobs

import (
	"testing"
	"time"
)

func TestRetryBackoffDoublesPerAttemptUpToTheLimit(t *testing.T) {
	for _, tc := range []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 1, want: time.Second},
		{attempt: 2, want: 2 * time.Second},
		{attempt: 4, want: 8 * time.Second},
		{attempt: 7, want: time.Minute},
		{attempt: 10_000, want: time.Minute},
	} {
		for range 50 {
			got := RetryBackoff(time.Second, time.Minute, tc.attempt)
			if got > tc.want || got < tc.want-tc.want/5 {
				t.Fatalf("attempt %d: got %s, want within 20%% below %s", tc.attempt, got, tc.want)
			}
		}
	}
	if got := RetryBackoff(0, time.Minute, 3); got != 0 {
		t.Fatalf("zero base: got %s", got)
	}
}
