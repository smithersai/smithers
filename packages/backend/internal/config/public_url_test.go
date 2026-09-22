package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPublicOriginUsesServerURL(t *testing.T) {
	cfg := &Config{Server: ServerConfig{PublicURL: "https://owner.example.test/"}}
	assert.Equal(t, "https://owner.example.test", PublicOrigin(cfg))
	cfg.Server.PublicURL = ""
	assert.Empty(t, PublicOrigin(cfg))
}

func TestPublicURLLoadsFromCanonicalEnvironment(t *testing.T) {
	t.Setenv("SMITHERS_PUBLIC_URL", "https://smithers.example.test")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, "https://smithers.example.test", cfg.Server.PublicURL)
}

func TestCanonicalOriginRequiresAnExactOrigin(t *testing.T) {
	t.Parallel()

	for raw, want := range map[string]string{
		"HTTPS://APP.EXAMPLE:8443/": "https://app.example:8443",
		"tauri://localhost":         "tauri://localhost",
		"http://127.0.0.1:4000":     "http://127.0.0.1:4000",
	} {
		got, err := CanonicalOrigin(raw)
		require.NoError(t, err)
		assert.Equal(t, want, got)
	}

	for _, raw := range []string{
		"https://app.example/login",
		"https://user@app.example",
		"https://app.example?next=/",
		"app.example",
	} {
		_, err := CanonicalOrigin(raw)
		assert.Error(t, err, raw)
	}
}
