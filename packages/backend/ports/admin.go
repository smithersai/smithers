package ports

import (
	"context"
	"net/http"
)

// AdminRoute is an operator endpoint for deployment-owned resources, such as a
// hosted sandbox fleet. The product mounts it at /api/admin/<Pattern> behind
// the authentication of its own admin routes: an admin user whose credential
// holds write:admin when Write is set and read:admin otherwise. Pattern uses
// chi syntax and must not collide with a product admin route.
type AdminRoute struct {
	Method  string
	Pattern string
	Write   bool
	Handler http.HandlerFunc
}

// AdminOperations records deployment operator mutations in the product audit
// log exactly as product admin mutations are recorded.
type AdminOperations interface {
	// Operation records an attempted admin.<target>.<action> row for the
	// acting admin, runs run, then records the outcome under the same
	// operation ID. run may add outcome details to metadata. It refuses a
	// context without an acting admin before recording or running anything.
	Operation(ctx context.Context, target, targetName, action string, metadata map[string]any, run func() error) error
}

// AdminRoutes builds a deployment's operator endpoints on the product's audit
// log. HTTP processes call it once while assembling the router.
type AdminRoutes func(AdminOperations) []AdminRoute
