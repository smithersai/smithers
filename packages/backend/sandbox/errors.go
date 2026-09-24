package sandbox

import "errors"

// ErrNotFound identifies a missing compute resource across provider adapters.
var ErrNotFound = errors.New("sandbox placement not found")
