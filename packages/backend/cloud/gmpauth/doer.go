// Package gmpauth provides the optional Google credential adapter for hosted
// Managed Prometheus queries. The product query client stays provider-neutral.
package gmpauth

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// NewDoer obtains application-default credentials for the monitoring scope.
// The caller injects the returned client through app.Config.MetricsDoer.
func NewDoer(ctx context.Context, timeout time.Duration) (services.GMPDoer, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	source, err := google.DefaultTokenSource(ctx, services.MonitoringReadScope)
	if err != nil {
		return nil, fmt.Errorf("google application default credentials: %w", err)
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &oauth2.Transport{
			Source: source,
			Base:   observability.NewHTTPTransport(http.DefaultTransport),
		},
	}, nil
}
