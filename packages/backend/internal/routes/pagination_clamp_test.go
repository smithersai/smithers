package routes

import (
	"math"
	"testing"
)

// A large cursor value makes cursorToOffset return an int64 that, narrowed with a
// plain int32(), wraps to a negative SQL OFFSET and 500s the query. clampOffsetInt32
// must clamp to MaxInt32 and floor negatives at 0.
func TestClampOffsetInt32(t *testing.T) {
	cases := []struct {
		in   int64
		want int32
	}{
		{0, 0},
		{100, 100},
		{math.MaxInt32, math.MaxInt32},
		{math.MaxInt32 + 1, math.MaxInt32},
		{math.MaxInt64, math.MaxInt32},
		{-1, 0},
	}
	for _, c := range cases {
		got := clampOffsetInt32(c.in)
		if got != c.want {
			t.Fatalf("clampOffsetInt32(%d) = %d, want %d", c.in, got, c.want)
		}
		if got < 0 {
			t.Fatalf("clampOffsetInt32(%d) returned a negative offset %d", c.in, got)
		}
	}
}
