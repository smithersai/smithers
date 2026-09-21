package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestCanaryCadenceAndStatus(t *testing.T) {
	for _, test := range []struct {
		name, suite, probe string
		age                time.Duration
		stale              bool
	}{
		{"backend tolerates a missed fifteen-minute run", "workflow", "auth", 30 * time.Minute, false},
		{"backend stopped reporting", "workflow", "auth", 46 * time.Minute, true},
		{"playwright tolerates suite execution", "playwright", "ui-health", 39 * time.Minute, false},
		{"playwright stopped reporting", "playwright", "ui-health", 41 * time.Minute, true},
		{"hourly VM probe is still fresh", "workflow", "workspace", 90 * time.Minute, false},
		{"hourly VM probe still running after a missed run", "workflow", "workspace", 155 * time.Minute, false},
		{"hourly VM probe stopped reporting", "workflow", "workspace", 161 * time.Minute, true},
		{"unknown suite retains conservative fallback", "custom", "probe", 16 * time.Minute, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := healthyStatusConfig()
			cfg.Canaries = &fakeStatusCanaryLister{results: []db.CanaryResult{{
				Suite: test.suite, TestName: test.probe, Status: "success", ReportedAt: statusTestNow.Add(-test.age),
			}}}
			status := NewAdminSystemStatusService(cfg).SystemStatus(context.Background())
			assert.Equal(t, test.stale, status.Canaries.Stale == 1)
			assert.Equal(t, test.stale, status.Status == "degraded")
			assert.Equal(t, 1, status.Canaries.Passing, "freshness does not rewrite the recorded outcome")
		})
	}
}
