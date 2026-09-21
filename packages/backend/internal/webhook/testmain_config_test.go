package webhook

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolveWebhookTestDatabaseURL_PrefersPackageEnv(t *testing.T) {
	getenv := func(key string) string {
		switch key {
		case "SMITHERS_TEST_WEBHOOK_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/webhook_pkg?sslmode=disable"
		case "SMITHERS_TEST_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable"
		default:
			return ""
		}
	}

	got := resolveWebhookTestDatabaseURL(getenv)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/webhook_pkg?sslmode=disable", got)
}

func TestResolveWebhookTestDatabaseURL_FallsBackToSharedEnv(t *testing.T) {
	getenv := func(key string) string {
		switch key {
		case "SMITHERS_TEST_WEBHOOK_DATABASE_URL":
			return ""
		case "SMITHERS_TEST_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable"
		default:
			return ""
		}
	}

	got := resolveWebhookTestDatabaseURL(getenv)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable", got)
}

func TestResolveWebhookTestDatabaseURL_UsesDefaultWhenUnset(t *testing.T) {
	getenv := func(_ string) string {
		return ""
	}

	got := resolveWebhookTestDatabaseURL(getenv)
	assert.Equal(t, defaultWebhookTestDatabaseURL, got)
}
