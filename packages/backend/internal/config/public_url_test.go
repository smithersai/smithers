package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPublicOriginUsesServerURL(t *testing.T) {
	cfg := &Config{Server: ServerConfig{PublicURL: "https://owner.example.test/"}, Email: EmailConfig{BaseURL: "https://unrelated.example.test"}}
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
