// Package app is the public composition boundary for the Smithers product
// backend. Deployments configure and launch this package instead of importing
// product handlers or domain services directly.
package app

import (
	"context"
	"io"
	"os"

	"github.com/smithersai/smithers/packages/backend/internal/compose"
)

// Config holds the process-level inputs of the shared backend. The product
// routes, services, jobs, and database are assembled by the common
// implementation. A deployment can pass its configuration file using Args.
type Config struct {
	Args   []string
	Stdout io.Writer
	Stderr io.Writer
}

// Run starts the same product assembly used by the Smithers executable and
// Plue. It returns when the context is cancelled and cleanup completes, or
// when startup or a worker fails.
func Run(ctx context.Context, cfg Config) error {
	stdout := cfg.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := cfg.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	return compose.Run(ctx, cfg.Args, stdout, stderr)
}
