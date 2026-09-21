package services

import (
	"math"
	"testing"
)

// A large user page makes (page-1)*perPage exceed int32; a plain int32() wraps to a
// negative SQL OFFSET and 500s the query. ClampInt32 must clamp to MaxInt32 (never
// negative) and floor negatives at 0.
func TestClampInt32(t *testing.T) {
	cases := []struct {
		in   int
		want int32
	}{
		{0, 0},
		{30, 30},
		{math.MaxInt32, math.MaxInt32},
		{math.MaxInt32 + 1, math.MaxInt32},
		{3_000_000_000, math.MaxInt32}, // ~ page 1e8 * perPage 30 -> would wrap negative
		{-1, 0},
	}
	for _, c := range cases {
		if got := ClampInt32(c.in); got != c.want {
			t.Fatalf("ClampInt32(%d) = %d, want %d", c.in, got, c.want)
		}
		if got := ClampInt32(c.in); got < 0 {
			t.Fatalf("ClampInt32(%d) returned a negative offset %d", c.in, got)
		}
	}
}
