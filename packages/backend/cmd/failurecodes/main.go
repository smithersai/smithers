// Command failurecodes renders Smithers' canonical failure-code registry.
//
// Run it in the same change that adds, removes, or reclassifies a code:
//
//	go run ./packages/backend/cmd/failurecodes > docs/api/failure-codes.json
package main

import (
	"fmt"
	"os"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func main() {
	payload, err := pkgerrors.MarshalDocument()
	if err != nil {
		fmt.Fprintln(os.Stderr, "failurecodes:", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(payload); err != nil {
		fmt.Fprintln(os.Stderr, "failurecodes:", err)
		os.Exit(1)
	}
}
