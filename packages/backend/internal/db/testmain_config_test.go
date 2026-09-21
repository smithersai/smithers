package db

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolveDBTestDatabaseURL_PrefersPackageEnv(t *testing.T) {
	getenv := func(key string) string {
		switch key {
		case "SMITHERS_TEST_DB_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/db_pkg?sslmode=disable"
		case "SMITHERS_TEST_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable"
		default:
			return ""
		}
	}

	got := resolveDBTestDatabaseURL(getenv)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/db_pkg?sslmode=disable", got)
}

func TestResolveDBTestDatabaseURL_FallsBackToSharedEnv(t *testing.T) {
	getenv := func(key string) string {
		switch key {
		case "SMITHERS_TEST_DB_DATABASE_URL":
			return ""
		case "SMITHERS_TEST_DATABASE_URL":
			return "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable"
		default:
			return ""
		}
	}

	got := resolveDBTestDatabaseURL(getenv)
	assert.Equal(t, "postgres://smithers:smithers@localhost:5432/shared?sslmode=disable", got)
}

func TestResolveDBTestDatabaseURL_UsesDefaultWhenUnset(t *testing.T) {
	getenv := func(_ string) string {
		return ""
	}

	got := resolveDBTestDatabaseURL(getenv)
	assert.Equal(t, defaultTestDatabaseURL, got)
}
