// Package cli is the public entrypoint for the Smithers product CLI.
// Product commands call the configured shared backend; this package does not
// contain a workflow engine or a local product implementation.
package cli

import "github.com/smithersai/smithers/packages/backend/internal/smitherscli"

// Run executes the product CLI and returns its process exit code.
func Run(args []string) int { return smitherscli.Run(args) }
