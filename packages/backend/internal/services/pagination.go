package services

import "math"

// ClampInt32 converts x to int32, clamping out-of-range values instead of letting
// a large int wrap to a negative int32. Used for SQL OFFSET/LIMIT values derived
// from user-supplied page/cursor input: an unbounded page or cursor makes
// (page-1)*perPage exceed math.MaxInt32, and a plain int32() conversion wraps to a
// negative offset that 500s the query. Negative inputs clamp to 0; an absurdly
// large offset yields an empty final page instead of an error.
func ClampInt32(x int) int32 {
	if x < 0 {
		return 0
	}
	if x > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(x)
}
