package compose

import "github.com/smithersai/smithers/packages/backend/sandbox"

// bindComputeProviderTelemetry reports a deployment provider's API requests
// through the product metrics registry that serves /metrics.
func bindComputeProviderTelemetry(provider sandbox.Provider, observer sandbox.APIRequestObserver) {
	if binder, ok := provider.(sandbox.APIRequestObserverBinder); ok && observer != nil {
		binder.BindAPIRequestObserver(observer)
	}
}
