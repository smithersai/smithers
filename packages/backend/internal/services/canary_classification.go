package services

import (
	"strings"
	"time"
)

// CanaryStaleAfter is the fallback for an unrecognized canary suite.
const CanaryStaleAfter = 15 * time.Minute

// CanaryFreshnessWindow follows the production cadence. Both the listing and
// status aggregate use it. Deep probes run hourly and may take 40 minutes;
// allow a missed run plus execution time before declaring them stale.
func CanaryFreshnessWindow(suite, testName string) time.Duration {
	switch strings.TrimSpace(suite) {
	case "playwright":
		return 40 * time.Minute
	case "workflow":
		switch strings.TrimSpace(testName) {
		case "workspace", "lsp", "agent-session", "revocation", "orphan-sweep":
			return 160 * time.Minute
		default:
			return 45 * time.Minute
		}
	default:
		return CanaryStaleAfter
	}
}

// ClassifyCanaryStatus maps canary_results.status onto the admin API
// vocabulary. The column is CHECK-constrained to 'success' or 'failure';
// anything else is reported as unknown rather than guessed at, and every
// admin surface classifies through this one function.
func ClassifyCanaryStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success":
		return "passing"
	case "failure":
		return "failing"
	default:
		return "unknown"
	}
}

// CanaryIsStale reports whether a result reported at reportedAt has gone
// unrefreshed for longer than window as of now.
func CanaryIsStale(reportedAt, now time.Time, window time.Duration) bool {
	return now.Sub(reportedAt) > window
}
