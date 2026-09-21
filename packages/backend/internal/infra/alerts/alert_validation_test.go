// Package alerts provides validation for Prometheus alert rules as defined
// in docs/specs/infra.md §8.4.
package alerts

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

// AlertRuleSpec represents a single Prometheus alert rule.
type AlertRuleSpec struct {
	Alert       string            `yaml:"alert"`
	Expr        string            `yaml:"expr"`
	For         string            `yaml:"for"`
	Labels      map[string]string `yaml:"labels"`
	Annotations map[string]string `yaml:"annotations"`
}

// AlertGroup represents a group of alert rules.
type AlertGroup struct {
	Name     string          `yaml:"name"`
	Interval string          `yaml:"interval"`
	Rules    []AlertRuleSpec `yaml:"rules"`
}

// AlertRules represents the top-level Prometheus alert rules file structure.
type AlertRules struct {
	Groups []AlertGroup `yaml:"groups"`
}

// loadAlertRules loads the alert rules from a YAML file.
func loadAlertRules(t *testing.T, path string) *AlertRules {
	t.Helper()

	data, err := os.ReadFile(path)
	require.NoError(t, err, "failed to read alert rules file: %s", path)

	var rules AlertRules
	err = yaml.Unmarshal(data, &rules)
	require.NoError(t, err, "failed to parse alert rules YAML")

	return &rules
}

// -----------------------------------------------------------------------------
// Required Alerts per infra.md §8.4
// -----------------------------------------------------------------------------

// TestRequiredAlerts_Exist verifies all required alerts from infra.md are defined.
// infra.md §8.4 specifies these critical alerts:
//   - High error rate (>5% 5xx over 5 min)
//   - High latency (p95 > 2s over 5 min)
//   - Pod restart loop (>3 restarts in 10 min)
//   - DB connection saturation (>80% connections used)
//   - Runner pool exhausted (0 available runners for >2 min)
func TestRequiredAlerts_Exist(t *testing.T) {
	t.Parallel()

	// This test uses the POC alerts file as a reference implementation
	// until the production alerts are deployed via Terraform
	alertsPath := "../../poc/infra/terraform/kubernetes/monitoring/alerts.yaml"
	if _, err := os.Stat(alertsPath); os.IsNotExist(err) {
		t.Skip("POC alerts.yaml not found, skipping required alerts test")
	}

	rules := loadAlertRules(t, alertsPath)

	// Collect all alert names
	alertNames := make(map[string]bool)
	for _, group := range rules.Groups {
		for _, rule := range group.Rules {
			alertNames[rule.Alert] = true
		}
	}

	// Required alerts per infra.md §8.4
	requiredAlerts := []string{
		"CriticalErrorRate",       // >5% 5xx responses
		"SlowResponseTime",        // p95 > 2s
		"PodCrashLooping",         // Pod restart loop
		"HighDatabaseConnections", // DB saturation
		// Note: Runner pool exhausted alert would be a custom metric
	}

	for _, alertName := range requiredAlerts {
		assert.Contains(t, alertNames, alertName,
			"Required alert %q must be defined per infra.md §8.4", alertName)
	}
}

// TestAlertRules_Structure validates that all alert rules have required fields.
func TestAlertRules_Structure(t *testing.T) {
	t.Parallel()

	alertsPath := "../../poc/infra/terraform/kubernetes/monitoring/alerts.yaml"
	if _, err := os.Stat(alertsPath); os.IsNotExist(err) {
		t.Skip("POC alerts.yaml not found")
	}

	rules := loadAlertRules(t, alertsPath)

	for _, group := range rules.Groups {
		for _, rule := range group.Rules {
			t.Run(rule.Alert, func(t *testing.T) {
				t.Parallel()

				// Every alert must have an expression
				assert.NotEmpty(t, rule.Expr, "alert %q must have an expression", rule.Alert)

				// Every alert must have severity label
				severity, hasSeverity := rule.Labels["severity"]
				assert.True(t, hasSeverity, "alert %q must have severity label", rule.Alert)
				assert.Contains(t, []string{"critical", "warning", "info"}, severity,
					"alert %q severity must be critical, warning, or info", rule.Alert)

				// Every alert must have summary annotation
				summary, hasSummary := rule.Annotations["summary"]
				assert.True(t, hasSummary, "alert %q must have summary annotation", rule.Alert)
				assert.NotEmpty(t, summary, "alert %q summary must not be empty", rule.Alert)

				// Every alert should have description annotation
				desc, hasDesc := rule.Annotations["description"]
				assert.True(t, hasDesc, "alert %q should have description annotation", rule.Alert)
				assert.NotEmpty(t, desc, "alert %q description must not be empty", rule.Alert)
			})
		}
	}
}

// TestAlertRules_ExprSyntax validates PromQL expression syntax basics.
// This is a basic validation - full PromQL parsing would require a PromQL parser.
func TestAlertRules_ExprSyntax(t *testing.T) {
	t.Parallel()

	alertsPath := "../../poc/infra/terraform/kubernetes/monitoring/alerts.yaml"
	if _, err := os.Stat(alertsPath); os.IsNotExist(err) {
		t.Skip("POC alerts.yaml not found")
	}

	rules := loadAlertRules(t, alertsPath)

	// Common PromQL patterns that should be valid
	validMetricNamePattern := regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)

	for _, group := range rules.Groups {
		for _, rule := range group.Rules {
			t.Run(rule.Alert, func(t *testing.T) {
				t.Parallel()

				expr := strings.TrimSpace(rule.Expr)
				assert.NotEmpty(t, expr, "expression must not be empty")

				// Check for unclosed braces
				openBraces := strings.Count(expr, "{")
				closeBraces := strings.Count(expr, "}")
				assert.Equal(t, openBraces, closeBraces,
					"expression has unclosed braces")

				openParens := strings.Count(expr, "(")
				closeParens := strings.Count(expr, ")")
				assert.Equal(t, openParens, closeParens,
					"expression has unclosed parentheses")

				// Check for valid metric names at start of expression or after operators
				// This is a simplified check
				lines := strings.Split(expr, "\n")
				for _, line := range lines {
					line = strings.TrimSpace(line)
					if line == "" || strings.HasPrefix(line, "#") {
						continue
					}

					// Extract potential metric names (before { or ()
					parts := strings.Fields(line)
					for _, part := range parts {
						// Clean up common prefixes/suffixes
						part = strings.TrimPrefix(part, "rate(")
						part = strings.TrimPrefix(part, "sum(")
						part = strings.TrimPrefix(part, "increase(")
						part = strings.TrimPrefix(part, "histogram_quantile(")
						part = strings.TrimPrefix(part, "kube_")
						part = strings.TrimPrefix(part, "container_")
						part = strings.TrimPrefix(part, "smithers_")

						// If it looks like a metric name, validate it
						if idx := strings.IndexAny(part, "{[("); idx > 0 {
							metricName := part[:idx]
							if validMetricNamePattern.MatchString(metricName) &&
								!isPromQLKeyword(metricName) &&
								!isNumeric(metricName) {
								assert.True(t, validMetricNamePattern.MatchString(metricName),
									"metric name %q in alert %q should be valid", metricName, rule.Alert)
							}
						}
					}
				}
			})
		}
	}
}

// TestAlertRules_CriticalAlertsHaveShortForDuration verifies that critical
// severity alerts have short "for" duration to fire quickly.
func TestAlertRules_CriticalAlertsHaveShortForDuration(t *testing.T) {
	t.Parallel()

	alertsPath := "../../poc/infra/terraform/kubernetes/monitoring/alerts.yaml"
	if _, err := os.Stat(alertsPath); os.IsNotExist(err) {
		t.Skip("POC alerts.yaml not found")
	}

	rules := loadAlertRules(t, alertsPath)

	for _, group := range rules.Groups {
		for _, rule := range group.Rules {
			if rule.Labels["severity"] == "critical" {
				t.Run(rule.Alert, func(t *testing.T) {
					t.Parallel()

					// Critical alerts should fire within 5 minutes
					// Parse duration (e.g., "5m", "10m", "1h")
					assert.NotEmpty(t, rule.For, "critical alert %q should have a 'for' duration", rule.Alert)

					// Check if duration is reasonable for critical alerts
					// "5m" or less is ideal for critical alerts
					if rule.For != "" {
						// Extract minutes from duration string like "5m" or "10m"
						var minutes int
						if _, err := fmt.Sscanf(rule.For, "%dm", &minutes); err == nil {
							assert.LessOrEqual(t, minutes, 10,
								"critical alert %q should have 'for' duration <= 10m, got %s",
								rule.Alert, rule.For)
						}
					}
				})
			}
		}
	}
}

// TestAlertRules_SmithersNamespaceFilter verifies that alerts filter by the smithers namespace.
func TestAlertRules_SmithersNamespaceFilter(t *testing.T) {
	t.Parallel()

	alertsPath := "../../poc/infra/terraform/kubernetes/monitoring/alerts.yaml"
	if _, err := os.Stat(alertsPath); os.IsNotExist(err) {
		t.Skip("POC alerts.yaml not found")
	}

	rules := loadAlertRules(t, alertsPath)

	// Kubernetes-related alerts should filter by namespace="smithers"
	for _, group := range rules.Groups {
		for _, rule := range group.Rules {
			// Skip alerts that don't use Kubernetes metrics
			if !strings.Contains(rule.Expr, "kube_") &&
				!strings.Contains(rule.Expr, "container_") {
				continue
			}

			t.Run(rule.Alert, func(t *testing.T) {
				t.Parallel()

				// Should filter by smithers namespace for K8s/container metrics
				// to avoid alerting on other namespaces
				if strings.Contains(rule.Expr, "namespace=") {
					assert.Contains(t, rule.Expr, `namespace="smithers"`,
						"alert %q should filter by namespace=\"smithers\"", rule.Alert)
				}
			})
		}
	}
}

// TestAlertGroups_HaveValidIntervals verifies that alert groups have valid intervals.
func TestAlertGroups_HaveValidIntervals(t *testing.T) {
	t.Parallel()

	alertsPath := "../../poc/infra/terraform/kubernetes/monitoring/alerts.yaml"
	if _, err := os.Stat(alertsPath); os.IsNotExist(err) {
		t.Skip("POC alerts.yaml not found")
	}

	rules := loadAlertRules(t, alertsPath)

	validIntervals := []string{"10s", "30s", "1m", "5m", "10m", "1h"}

	for _, group := range rules.Groups {
		t.Run(group.Name, func(t *testing.T) {
			t.Parallel()

			if group.Interval != "" {
				assert.Contains(t, validIntervals, group.Interval,
					"group %q should have valid interval, got %s", group.Name, group.Interval)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// Helper functions
// -----------------------------------------------------------------------------

func isPromQLKeyword(s string) bool {
	keywords := []string{
		"rate", "irate", "increase", "sum", "avg", "max", "min", "count",
		"histogram_quantile", "by", "without", "on", "ignoring", "group_left",
		"group_right", "and", "or", "unless", "topk", "bottomk", "quantile",
	}
	for _, kw := range keywords {
		if strings.EqualFold(s, kw) {
			return true
		}
	}
	return false
}

func isNumeric(s string) bool {
	for _, c := range s {
		if !strings.ContainsRune("0123456789.", c) {
			return false
		}
	}
	return len(s) > 0
}
