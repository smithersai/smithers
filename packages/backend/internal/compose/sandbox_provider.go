package compose

import (
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	msbprovider "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// buildSandboxProvider constructs the single sandbox implementation at the
// composition boundary. Product services receive only the Plue-owned interface.
func buildSandboxProvider(cfg config.SandboxConfig, observer sandbox.APIRequestObserver) (sandbox.Provider, error) {
	tlsConfig, err := msbprovider.LoadClientTLSConfig(msbprovider.TLSFiles{
		CertFile:   cfg.MicrosandboxClientCert,
		KeyFile:    cfg.MicrosandboxClientKey,
		CAFile:     cfg.MicrosandboxCA,
		ServerName: cfg.MicrosandboxServerName,
	})
	if err != nil {
		return nil, fmt.Errorf("configure Microsandbox controller mTLS: %w", err)
	}
	options := []msbprovider.ClientOption{
		msbprovider.WithAPIRequestObserver(observer),
		msbprovider.WithDefaultImage(cfg.MicrosandboxDefaultImage),
	}
	if tlsConfig != nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.TLSClientConfig = tlsConfig
		options = append(options, msbprovider.WithHTTPClient(&http.Client{
			Transport: otelhttp.NewTransport(transport),
			Timeout:   35 * time.Minute,
		}))
	}
	return msbprovider.NewClient(cfg.MicrosandboxControlURL, cfg.MicrosandboxAPIKey, options...), nil
}
