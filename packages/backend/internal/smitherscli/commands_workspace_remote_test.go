package smitherscli

import (
	"reflect"
	"testing"
)

func TestBuildWorkspaceCreateBodyIgnoresEmptyAllowArray(t *testing.T) {
	// The arg parser hands an empty []any for an unset repeatable flag; it must
	// not be read as the single host "[]".
	body, err := buildWorkspaceCreateBody(map[string]any{"name": "w", "network": "proxy", "allow": []any{}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := body["network"].(map[string]any)["allow"]; ok {
		t.Fatalf("empty allow array leaked into the body: %v", body)
	}
}

func TestBuildWorkspaceCreateBody(t *testing.T) {
	t.Parallel()
	body, err := buildWorkspaceCreateBody(map[string]any{"name": "trial-1"})
	if err != nil || !reflect.DeepEqual(body, map[string]any{"name": "trial-1"}) {
		t.Fatalf("minimal body = %#v, %v", body, err)
	}

	body, err = buildWorkspaceCreateBody(map[string]any{
		"name":        "trial-2",
		"image":       " docker.io/library/python:3.13-slim ",
		"cpus":        2,
		"memory":      4096.0,
		"allow":       []string{"pypi.org,files.pythonhosted.org", "*.github.com"},
		"idleTimeout": 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"name":                 "trial-2",
		"image":                "docker.io/library/python:3.13-slim",
		"resources":            map[string]any{"cpus": 2, "memory_mb": 4096},
		"network":              map[string]any{"mode": "allowlist", "allow": []string{"pypi.org", "files.pythonhosted.org", "*.github.com"}},
		"idle_timeout_seconds": 0,
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("full body = %#v, want %#v", body, want)
	}

	body, err = buildWorkspaceCreateBody(map[string]any{"name": "", "network": "none", "disk": 10240})
	if err != nil || !reflect.DeepEqual(body["network"], map[string]any{"mode": "none"}) || !reflect.DeepEqual(body["resources"], map[string]any{"disk_mb": 10240}) {
		t.Fatalf("network none body = %#v, %v", body, err)
	}

	body, err = buildWorkspaceCreateBody(map[string]any{
		"name":    "services",
		"service": []string{"event-feed=python /opt/event-feed.py", "redis=redis-server --port 6379"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(body["services"], []map[string]any{
		{"name": "event-feed", "mode": "service", "exec": []string{"/bin/sh", "-lc", "python /opt/event-feed.py"}},
		{"name": "redis", "mode": "service", "exec": []string{"/bin/sh", "-lc", "redis-server --port 6379"}},
	}) {
		t.Fatalf("services body = %#v", body)
	}

	for name, options := range map[string]map[string]any{
		"bad network":          {"network": "wide-open"},
		"allow without mode":   {"network": "none", "allow": []string{"a.example"}},
		"zero cpus":            {"cpus": 0},
		"negative idle":        {"idleTimeout": -5},
		"non-numeric memory":   {"memory": "lots"},
		"comma only allowlist": {"allow": []string{", ,"}, "network": "proxy"},
	} {
		if _, err := buildWorkspaceCreateBody(options); err == nil && name != "comma only allowlist" {
			t.Fatalf("%s: expected error", name)
		}
	}
}

func TestParseWorkspaceExecEnv(t *testing.T) {
	t.Parallel()
	env, err := parseWorkspaceExecEnv([]string{"A=1", "B=x=y", "C="})
	if err != nil || !reflect.DeepEqual(env, []string{"A=1", "B=x=y", "C="}) {
		t.Fatalf("env = %#v, %v", env, err)
	}
	for _, bad := range []string{"NOEQ", "=v", "A B=1"} {
		if _, err := parseWorkspaceExecEnv([]string{bad}); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestWorkspaceSSHInfoPath(t *testing.T) {
	t.Parallel()
	if got := workspaceSSHInfoPath("o", "r", "ws 1", ""); got != "/api/repos/o/r/workspaces/ws%201/ssh" {
		t.Fatalf("default user path = %q", got)
	}
	if got := workspaceSSHInfoPath("o", "r", "ws", "developer"); got != "/api/repos/o/r/workspaces/ws/ssh" {
		t.Fatalf("developer path = %q", got)
	}
	if got := workspaceSSHInfoPath("o", "r", "ws", "root"); got != "/api/repos/o/r/workspaces/ws/ssh?user=root" {
		t.Fatalf("root path = %q", got)
	}
}
