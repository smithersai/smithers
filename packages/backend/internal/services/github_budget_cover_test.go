package services

import (
	"testing"
	"time"
)

func TestGithubBudget_Cov_DefaultsNilAndRemaining(t *testing.T) {
	if allowed, retry := (*BudgetTracker)(nil).Allow(123); !allowed || retry != 0 {
		t.Fatalf("nil Allow = %v, %v", allowed, retry)
	}
	if remaining := (*BudgetTracker)(nil).Remaining(123); remaining != 0 {
		t.Fatalf("nil Remaining = %d", remaining)
	}

	tracker := NewBudgetTrackerWithLimits(0, 0)
	if tracker.capacity != GitHubInstallationHourlyBudget || tracker.window != time.Hour {
		t.Fatalf("defaults capacity=%d window=%v", tracker.capacity, tracker.window)
	}

	start := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	tracker = NewBudgetTrackerWithLimits(2, time.Minute)
	tracker.now = func() time.Time { return start }
	if remaining := tracker.Remaining(99); remaining != 2 {
		t.Fatalf("initial remaining = %d", remaining)
	}
	if ok, retry := tracker.Allow(99); !ok || retry != 0 {
		t.Fatalf("first allow = %v, %v", ok, retry)
	}
	if ok, retry := tracker.Allow(99); !ok || retry != 0 {
		t.Fatalf("second allow = %v, %v", ok, retry)
	}
	if ok, retry := tracker.Allow(99); ok || retry <= 0 {
		t.Fatalf("empty allow = %v, %v; want denied with retry", ok, retry)
	}
	tracker.now = func() time.Time { return start.Add(30 * time.Second) }
	if remaining := tracker.Remaining(99); remaining != 1 {
		t.Fatalf("refilled remaining = %d, want 1", remaining)
	}
	tracker.now = func() time.Time { return start.Add(10 * time.Minute) }
	if remaining := tracker.Remaining(99); remaining != 2 {
		t.Fatalf("capped remaining = %d, want 2", remaining)
	}
}

func TestGithubBudget_Cov_NewBudgetTrackerUsesDocumentedBudget(t *testing.T) {
	tracker := NewBudgetTracker()
	if tracker.capacity != GitHubInstallationHourlyBudget || tracker.window != time.Hour {
		t.Fatalf("tracker = capacity %d window %v", tracker.capacity, tracker.window)
	}
}
