package webhooks

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolveDispatcherTestDatabaseURL_PrefersPackageEnv(t *testing.T) {
	getenv := func(key string) string {
		switch key {
		case "SMITHERS_TEST_WEBHOOKS_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/webhooks_pkg?sslmode=disable"
		case "SMITHERS_TEST_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable"
		default:
			return ""
		}
	}

	got := resolveDispatcherTestDatabaseURL(getenv)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/webhooks_pkg?sslmode=disable", got)
}

func TestResolveDispatcherTestDatabaseURL_FallsBackToSharedEnv(t *testing.T) {
	getenv := func(key string) string {
		switch key {
		case "SMITHERS_TEST_WEBHOOKS_DATABASE_URL":
			return ""
		case "SMITHERS_TEST_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable"
		default:
			return ""
		}
	}

	got := resolveDispatcherTestDatabaseURL(getenv)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable", got)
}

func TestResolveDispatcherTestDatabaseURL_UsesDefaultWhenUnset(t *testing.T) {
	getenv := func(_ string) string {
		return ""
	}

	got := resolveDispatcherTestDatabaseURL(getenv)
	assert.Equal(t, defaultDispatcherTestDatabaseURL, got)
}
