package testdb

import (
	"testing"
	"time"
)

func TestDatabaseNamesCarryTheirAge(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	name, err := databaseName(now)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := databaseCreated(name)
	if !ok || !created.Equal(now) {
		t.Fatalf("%s: created = %v ok=%v", name, created, ok)
	}
	for _, other := range []string{"smithers_test_0123abcd", "smithers_test_x_y", "smithers_chat_1_2", "postgres"} {
		if _, ok := databaseCreated(other); ok {
			t.Fatalf("%s parsed as a dated test database", other)
		}
	}
}
