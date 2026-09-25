package services

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// EvaluateIfExpression evaluates a workflow "if" condition expression.
// Supported:
//   - "" (empty) -> true
//   - "always()" -> true
//   - conjunctions joined by &&
//   - `trigger.type == "value"` -> equality comparison
//   - `trigger.type != "value"` -> inequality comparison
//   - `inputs.field == "value"` -> equality comparison
//   - `inputs.field != "value"` -> inequality comparison
//   - `contains(inputs.field, "value")` -> array membership or scalar equality
//   - `!contains(inputs.field, "value")` -> negated contains
//
// Returns error for unsupported expressions.
func EvaluateIfExpression(expr string, event TriggerEvent, needsResults map[string]string) (bool, error) {
	expr = strings.TrimSpace(expr)

	// Empty condition defaults to true
	if expr == "" {
		return true, nil
	}

	// always() function returns true
	if expr == "always()" {
		return true, nil
	}

	parts := strings.Split(expr, "&&")
	if len(parts) > 1 {
		for _, part := range parts {
			ok, err := evaluateIfAtom(part, event, needsResults)
			if err != nil {
				return false, err
			}
			if !ok {
				return false, nil
			}
		}
		return true, nil
	}

	return evaluateIfAtom(expr, event, needsResults)
}

// ValidateIfExpression validates every atom in a workflow condition without
// evaluating its values. This prevents short-circuiting from hiding an
// unsupported atom until after a workflow run has already been created.
func ValidateIfExpression(expr string) error {
	for _, part := range strings.Split(strings.TrimSpace(expr), "&&") {
		part = strings.TrimSpace(part)
		if part == "" || part == "always()" || part == "success()" || part == "failure()" || part == "cancelled()" {
			continue
		}
		if regexp.MustCompile(`^needs\.[a-zA-Z0-9_-]+\.result\s*(==|!=)\s*"[^"]*"$`).MatchString(part) {
			continue
		}
		if regexp.MustCompile(`^inputs\.[a-zA-Z0-9_]+\s*(==|!=)\s*"[^"]*"$`).MatchString(part) {
			continue
		}
		if regexp.MustCompile(`^(!)?contains\(inputs\.[a-zA-Z0-9_]+,\s*"[^"]*"\)$`).MatchString(part) {
			continue
		}
		if regexp.MustCompile(`^trigger\.type\s*(==|!=)\s*"[^"]*"$`).MatchString(part) {
			continue
		}
		return fmt.Errorf("unsupported if expression: %s", part)
	}
	return nil
}

func IfExpressionReferencesNeeds(expr string) bool {
	expr = strings.TrimSpace(expr)
	if strings.Contains(expr, "needs.") {
		return true
	}
	if strings.Contains(expr, "success()") ||
		strings.Contains(expr, "failure()") ||
		strings.Contains(expr, "cancelled()") {
		return true
	}
	return false
}

// DependentJobShouldRun applies the implicit success() guard to a job whose
// needs have all settled. An explicit status check decides by itself.
func DependentJobShouldRun(ifExpr string, event TriggerEvent, needsResults map[string]string) (bool, error) {
	allSucceeded := !anyNeedsStatus(needsResults, func(result string) bool { return result != "success" })
	if strings.TrimSpace(ifExpr) == "" || (!allSucceeded && !strings.Contains(ifExpr, "always()") && !IfExpressionReferencesNeeds(ifExpr)) {
		return allSucceeded, nil
	}
	return EvaluateIfExpression(ifExpr, event, needsResults)
}

func evaluateIfAtom(expr string, event TriggerEvent, needsResults map[string]string) (bool, error) {
	expr = strings.TrimSpace(expr)

	if expr == "" || expr == "always()" {
		return true, nil
	}

	switch expr {
	case "success()":
		if len(needsResults) == 0 {
			return true, nil
		}
		for _, result := range needsResults {
			if result != "success" {
				return false, nil
			}
		}
		return true, nil
	case "failure()":
		return anyNeedsStatus(needsResults, func(result string) bool {
			return result == "failure"
		}), nil
	case "cancelled()":
		return anyNeedsStatus(needsResults, func(result string) bool {
			return result == "cancelled"
		}), nil
	}

	// Parse needs.JOB.result comparisons
	// Pattern: needs.JOB.result == "value" or needs.JOB.result != "value"
	needsRe := regexp.MustCompile(`^needs\.([a-zA-Z0-9_-]+)\.result\s*(==|!=)\s*"([^"]*)"$`)
	needsMatches := needsRe.FindStringSubmatch(expr)
	if needsMatches != nil {
		jobName := needsMatches[1]
		op := needsMatches[2]
		value := needsMatches[3]

		result, ok := needsResults[jobName]
		if !ok {
			return false, nil
		}
		if op == "==" {
			return result == value, nil
		}
		return result != value, nil
	}

	inputRe := regexp.MustCompile(`^inputs\.([a-zA-Z0-9_]+)\s*(==|!=)\s*"([^"]*)"$`)
	inputMatches := inputRe.FindStringSubmatch(expr)
	if inputMatches != nil {
		field := inputMatches[1]
		op := inputMatches[2]
		value := inputMatches[3]

		inputValue, ok := event.Inputs[field]
		if !ok {
			return false, nil
		}
		match := stringifyInput(inputValue) == value
		if op == "==" {
			return match, nil
		}
		return !match, nil
	}

	containsRe := regexp.MustCompile(`^(!)?contains\(inputs\.([a-zA-Z0-9_]+),\s*"([^"]*)"\)$`)
	containsMatches := containsRe.FindStringSubmatch(expr)
	if containsMatches != nil {
		negated := containsMatches[1] == "!"
		field := containsMatches[2]
		value := containsMatches[3]

		inputValue, ok := event.Inputs[field]
		if !ok {
			return false, nil
		}

		match := inputContains(inputValue, value)
		if negated {
			return !match, nil
		}
		return match, nil
	}

	// Parse trigger.type comparisons
	// Pattern: trigger.type == "value" or trigger.type != "value"
	re := regexp.MustCompile(`^trigger\.type\s*(==|!=)\s*"([^"]*)"$`)
	matches := re.FindStringSubmatch(expr)
	if matches != nil {
		op := matches[1]
		value := matches[2]

		if op == "==" {
			return event.Type == value, nil
		}
		return event.Type != value, nil
	}

	// Unsupported expression
	return false, fmt.Errorf("unsupported if expression: %s", expr)
}

func anyNeedsStatus(needsResults map[string]string, matchFn func(result string) bool) bool {
	for _, result := range needsResults {
		if matchFn(result) {
			return true
		}
	}

	return false
}

func stringifyInput(value interface{}) string {
	switch v := value.(type) {
	case string:
		return v
	default:
		return fmt.Sprint(v)
	}
}

func inputContains(value interface{}, target string) bool {
	switch v := value.(type) {
	case []string:
		return slices.Contains(v, target)
	case []interface{}:
		for _, item := range v {
			if stringifyInput(item) == target {
				return true
			}
		}
		return false
	default:
		return stringifyInput(v) == target
	}
}
