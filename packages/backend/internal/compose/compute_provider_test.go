package compose

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type observedComputeProvider struct {
	sandbox.Provider
	bound sandbox.APIRequestObserver
}

func (provider *observedComputeProvider) BindAPIRequestObserver(observer sandbox.APIRequestObserver) {
	provider.bound = observer
}

func TestBindComputeProviderTelemetryUsesProductMetrics(t *testing.T) {
	metrics := routes.NewSmithersMetrics()
	provider := &observedComputeProvider{}
	bindComputeProviderTelemetry(provider, metrics)
	if provider.bound != metrics {
		t.Fatalf("bound observer = %v, want product metrics", provider.bound)
	}
}

func TestBindComputeProviderTelemetryIgnoresProvidersWithoutBinder(t *testing.T) {
	var provider sandbox.Provider
	bindComputeProviderTelemetry(provider, routes.NewSmithersMetrics())
}
