package smitherscli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"

	incur "github.com/smithersai/incur"
	"golang.org/x/term"
)

// adminOperation describes only HTTP plumbing. Authorization, validation of
// domain transitions, and lifecycle execution belong to the remote services.
type adminOperation struct {
	name, method, path, arg string
	query, body, required   []string
	destructive, observe    bool
	fixed                   map[string]any
}

func adminOperations() []adminOperation {
	return []adminOperation{
		{name: "status", method: "GET", path: "/api/admin/system/status"},
		{name: "analytics summary", method: "GET", path: "/api/admin/analytics/summary", query: []string{"range", "include-synthetic"}},
		{name: "sessions list", method: "GET", path: "/api/admin/agent-sessions", query: []string{"status", "include-synthetic", "limit"}},
		{name: "sessions cancel", method: "POST", path: "/api/admin/agent-sessions/{target}/cancel", arg: "id", body: []string{"reason"}, destructive: true},
		{name: "workspaces list", method: "GET", path: "/api/admin/workspaces", query: []string{"status", "kind", "owner", "include-synthetic", "limit"}},
		{name: "workspaces stop", method: "POST", path: "/api/admin/workspaces/{target}/stop", arg: "id", destructive: true},
		{name: "workspaces suspend", method: "POST", path: "/api/admin/workspaces/{target}/suspend", arg: "id", destructive: true},
		{name: "tokens list", method: "GET", path: "/api/admin/tokens", query: []string{"unused-days", "scope", "expiring-days", "limit"}},
		{name: "users set-synthetic", method: "PATCH", path: "/api/admin/users/{target}", arg: "username", body: []string{"value"}, required: []string{"value"}},
		{name: "audit list", method: "GET", path: "/api/admin/audit-logs", query: []string{"since"}, required: []string{"since"}},
		{name: "alerts channels list", method: "GET", path: "/api/v1/alerts/channels", observe: true},
		{name: "alerts channels add", method: "POST", path: "/api/v1/alerts/channels", body: []string{"type", "display-name", "target", "route"}, required: []string{"type", "display-name", "target", "route"}, observe: true},
		{name: "alerts channels remove", method: "DELETE", path: "/api/v1/alerts/channels/{target}", arg: "id", destructive: true, observe: true},
		{name: "alerts channels send-code", method: "POST", path: "/api/v1/alerts/channels/{target}/send-code", arg: "id", observe: true},
		{name: "alerts channels verify", method: "POST", path: "/api/v1/alerts/channels/{target}/verify", arg: "id", body: []string{"code"}, required: []string{"code"}, observe: true},
		{name: "alerts channels set-route", method: "PATCH", path: "/api/v1/alerts/channels/{target}", arg: "id", body: []string{"route"}, required: []string{"route"}, observe: true},
		{name: "alerts policies list", method: "GET", path: "/api/v1/alerts/policies", observe: true},
		{name: "alerts policies enable", method: "PATCH", path: "/api/v1/alerts/policies/{target}", arg: "name", fixed: map[string]any{"enabled": true}, observe: true},
		{name: "alerts policies disable", method: "PATCH", path: "/api/v1/alerts/policies/{target}", arg: "name", fixed: map[string]any{"enabled": false}, observe: true},
		{name: "deploys observe list", method: "GET", path: "/api/v1/deploys/observe", observe: true},
		{name: "deploys observe rollback", method: "POST", path: "/api/v1/deploys/observe/{target}/rollback", arg: "id", destructive: true, observe: true},
		{name: "deploys observe redeploy", method: "POST", path: "/api/v1/deploys/observe/{target}/redeploy", arg: "id", destructive: true, observe: true},
		{name: "deploys observe restart", method: "POST", path: "/api/v1/deploys/observe/{target}/restart", arg: "id", destructive: true, observe: true},
		{name: "deploys platform list", method: "GET", path: "/api/v1/deploys/platform", observe: true},
		{name: "deploys platform rollback", method: "POST", path: "/api/v1/deploys/platform/{target}/rollback", arg: "component", body: []string{"revision"}, required: []string{"revision"}, destructive: true, observe: true},
		{name: "deploys platform status", method: "GET", path: "/api/v1/deploys/platform/{target}/status", arg: "component", observe: true},
	}
}

func adminOption(name string) *incur.JSONSchema {
	switch name {
	case "include-synthetic":
		return booleanSchema("Include synthetic users and their resources", false)
	case "limit", "unused-days", "expiring-days":
		return numberSchema(name, nil)
	case "value":
		return &incur.JSONSchema{Type: "string", Description: "Whether the user is synthetic", Enum: []any{"true", "false"}}
	case "route":
		return &incur.JSONSchema{Type: "string", Description: "Alert routing severity", Enum: []any{"critical", "all"}}
	case "type":
		return &incur.JSONSchema{Type: "string", Description: "Notification channel type", Enum: []any{"email", "sms", "pagerduty", "webhook"}}
	default:
		return stringSchema(strings.ReplaceAll(name, "-", " "))
	}
}

func registerAdminOperations(cmd *incur.Cli) {
	for _, op := range adminOperations() {
		options := map[string]*incur.JSONSchema{}
		for _, flag := range append(append([]string{}, op.query...), op.body...) {
			options[flag] = adminOption(flag)
		}
		if op.destructive {
			options["yes"] = booleanSchema("Confirm this destructive operation", false)
		}
		def := &incur.CommandDef{Format: incur.FormatJSON, Description: strings.ReplaceAll(op.name, " ", " · "), OptionsSchema: objectSchema(op.required, options)}
		if op.arg != "" {
			def.ArgsSchema = objectSchema([]string{op.arg}, map[string]*incur.JSONSchema{op.arg: stringSchema("Exact target " + op.arg)})
		}
		def.Handler = func(ctx *incur.CommandContext) (any, error) { return executeAdminOperation(ctx, op) }
		cmd.Command(op.name, def)
	}
}

var adminIsTerminal = term.IsTerminal

func confirmDestructiveOperation(yes bool, description string) error {
	if yes {
		return nil
	}
	if !adminIsTerminal(int(os.Stdin.Fd())) {
		return fmt.Errorf("%s requires --yes when stdin is not a TTY", description)
	}
	fmt.Fprintf(os.Stderr, "Confirm %s? [y/N] ", description)
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return fmt.Errorf("confirmation cancelled: %w", err)
	}
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes":
		return nil
	}
	return fmt.Errorf("operation cancelled")
}

func executeAdminOperation(ctx *incur.CommandContext, op adminOperation) (any, error) {
	target := stringValue(ctx.Args[op.arg])
	if op.arg != "" && (strings.TrimSpace(target) == "" || target == "." || target == ".." || strings.ContainsAny(target, "/\\\r\n")) {
		return nil, fmt.Errorf("%s must be a single nonempty target ID or name", op.arg)
	}
	path := strings.ReplaceAll(op.path, "{target}", url.PathEscape(target))
	query := url.Values{}
	for _, key := range op.query {
		if value, ok := ctx.Options[key]; ok && value != nil && stringValue(value) != "" {
			query.Set(strings.ReplaceAll(key, "-", "_"), stringValue(value))
		}
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	var body map[string]any
	if len(op.body) > 0 || op.fixed != nil {
		body = map[string]any{}
		for key, value := range op.fixed {
			body[key] = value
		}
		for _, key := range op.body {
			if value, ok := ctx.Options[key]; ok && value != nil && stringValue(value) != "" {
				body[strings.ReplaceAll(key, "-", "_")] = value
			}
		}
	}
	if op.name == "users set-synthetic" {
		value, err := strconv.ParseBool(stringValue(ctx.Options["value"]))
		if err != nil {
			return nil, fmt.Errorf("--value must be true or false")
		}
		body = map[string]any{"synthetic": value}
	}
	if op.destructive {
		description := op.name
		if target != "" {
			description += " " + strconv.Quote(target)
		}
		if err := confirmDestructiveOperation(ctx.Options["yes"] == true, description); err != nil {
			return nil, err
		}
	}
	var payload any
	if body != nil {
		payload = body
	}
	var result any
	var err error
	if op.observe {
		if op.name == "alerts channels add" {
			target = stringValue(body["display_name"])
		}
		result, err = ObserveRequest(op.method, path, payload, target)
	} else {
		result, err = APIRequest(op.method, path, payload, nil)
	}
	if err != nil {
		return nil, err
	}
	if !ctx.FormatExplicit && adminIsTerminal(int(os.Stdout.Fd())) {
		return formatAdminResult(result), nil
	}
	return result, nil
}

func formatAdminResult(result any) string {
	if result == nil {
		return "Completed"
	}
	records, ok := result.([]any)
	if !ok {
		if obj, yes := result.(map[string]any); yes {
			keys := make([]string, 0, len(obj))
			for key := range obj {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			rows := [][]string{}
			for _, key := range keys {
				value, _ := json.Marshal(obj[key])
				rows = append(rows, []string{key, string(value)})
			}
			return formatTable([]string{"Field", "Value"}, rows)
		} else {
			return stringValue(result)
		}
	}
	if len(records) == 0 {
		return "No results"
	}
	keysSet := map[string]bool{}
	for _, record := range records {
		for key := range objectValue(record) {
			keysSet[key] = true
		}
	}
	keys := []string{}
	for key := range keysSet {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rows := [][]string{}
	for _, record := range records {
		row := []string{}
		for _, key := range keys {
			value, _ := json.Marshal(objectValue(record)[key])
			row = append(row, string(value))
		}
		rows = append(rows, row)
	}
	return formatTable(keys, rows)
}
