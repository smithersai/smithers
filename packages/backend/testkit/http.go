package testkit

import (
	"context"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/controlstore"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"net/http"
)

// AuthContext supplies handler-unit-test identity. Deployment authentication tests
// must pass actual credentials through app.Instance.Bindings.Access instead.
func AuthContext(ctx context.Context, user *controlstore.User, token bool, scopes string) context.Context {
	return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: user, IsTokenAuth: token, Scopes: middleware.ParseTokenScopes(scopes)})
}
func UserContext(ctx context.Context, user *controlstore.User) context.Context {
	return context.WithValue(ctx, middleware.UserContextKey, user)
}

type HTTPMetrics interface {
	MustRegister(...prometheus.Collector)
	Handler() http.Handler
}

func Metrics() HTTPMetrics { return routes.NewSmithersMetrics() }
