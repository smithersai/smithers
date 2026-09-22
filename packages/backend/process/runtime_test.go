//go:build unix

package process

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestRuntime(t *testing.T, root string, options ...func(*Config)) *Runtime {
	t.Helper()
	config := Config{Root: root, MaxConcurrent: 2, OutputLimit: 64, TerminationGrace: 100 * time.Millisecond}
	for _, option := range options {
		option(&config)
	}
	runtime, err := New(config)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	return runtime
}

func TestRuntimePersistentLifecycleControlledEnvironmentAndFiles(t *testing.T) {
	dataRoot := t.TempDir()
	t.Setenv("SMITHERS_UNSAFE_INHERITED", "must-not-leak")
	runtime := newTestRuntime(t, dataRoot, func(config *Config) { config.OutputLimit = 512 })
	assert.Equal(t, workspaceapi.IsolationTrustedProcess, runtime.Isolation())
	capabilities := runtime.Capabilities()
	assert.True(t, capabilities.PersistentFiles)
	assert.True(t, capabilities.Terminal)
	assert.False(t, capabilities.ColdSnapshots)

	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "owner/repository/workspace"})
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.WorkspaceStopped, workspace.State)
	assert.NotEqual(t, workspace.Root, workspace.Home)
	_, err = runtime.ExecuteCommand(context.Background(), workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "true"}})
	require.ErrorIs(t, err, workspaceapi.ErrWorkspaceStopped)

	workspace, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	require.NoError(t, os.Mkdir(filepath.Join(workspace.Root, "src"), 0o700))
	require.NoError(t, runtime.WriteFile(context.Background(), workspace.ID, "src/main.txt", []byte("persistent"), 0o640))
	contents, err := runtime.ReadFile(context.Background(), workspace.ID, "src/main.txt")
	require.NoError(t, err)
	assert.Equal(t, "persistent", string(contents))
	entries, err := runtime.ListFiles(context.Background(), workspace.ID, "src")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "main.txt", entries[0].Name)
	assert.Equal(t, os.FileMode(0o640), entries[0].Mode.Perm())

	result, err := runtime.ExecuteCommand(context.Background(), workspace.ID, workspaceapi.Command{
		Args:        []string{"/bin/sh", "-c", `printf '%s\n%s\n%s\n' "$HOME" "${SMITHERS_UNSAFE_INHERITED-unset}" "$XDG_CONFIG_HOME"; i=0; while [ "$i" -lt 600 ]; do printf x; i=$((i+1)); done`},
		Environment: map[string]string{"HOME": "/untrusted/override"},
	})
	require.NoError(t, err)
	assert.Equal(t, 0, result.ExitCode)
	assert.Contains(t, result.Stdout, workspace.Home)
	assert.NotContains(t, result.Stdout, "must-not-leak")
	assert.True(t, result.OutputTruncated)

	outside := filepath.Join(dataRoot, "outside")
	require.NoError(t, os.WriteFile(outside, []byte("outside"), 0o600))
	require.NoError(t, os.Symlink(outside, filepath.Join(workspace.Root, "escape")))
	_, err = runtime.ReadFile(context.Background(), workspace.ID, "escape")
	require.Error(t, err)
	require.Error(t, runtime.WriteFile(context.Background(), workspace.ID, "escape", []byte("overwrite"), 0o600))
	outsideContents, err := os.ReadFile(outside)
	require.NoError(t, err)
	assert.Equal(t, "outside", string(outsideContents))
	require.NoError(t, os.Symlink(filepath.Join(workspace.Root, "src", "main.txt"), filepath.Join(workspace.Root, "inside-link")))
	require.Error(t, runtime.WriteFile(context.Background(), workspace.ID, "inside-link", []byte("overwrite"), 0o600))
	require.Error(t, runtime.RemoveFile(context.Background(), workspace.ID, "inside-link"))

	runtime.fileReadLimit = 4
	_, err = runtime.ReadFile(context.Background(), workspace.ID, "src/main.txt")
	require.ErrorContains(t, err, "exceeds read limit")
	runtime.fileReadLimit = 16 << 20

	require.NoError(t, runtime.StopWorkspace(context.Background(), workspace.ID))
	require.NoError(t, runtime.Close())
	reloaded, err := New(Config{Root: dataRoot})
	require.NoError(t, err)
	defer func() { require.NoError(t, reloaded.Close()) }()
	observed, err := reloaded.InspectWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
	contents, err = reloaded.ReadFile(context.Background(), workspace.ID, "src/main.txt")
	require.NoError(t, err)
	assert.Equal(t, "persistent", string(contents))
	require.NoError(t, reloaded.DeleteWorkspace(context.Background(), workspace.ID))
	_, err = reloaded.InspectWorkspace(context.Background(), workspace.ID)
	require.ErrorIs(t, err, workspaceapi.ErrWorkspaceNotFound)
}

func TestRuntimeCancellationTerminatesAndReapsProcessGroup(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "cancel"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, executeErr := runtime.ExecuteCommand(ctx, workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 30 & echo $! > child.pid; wait"}})
		result <- executeErr
	}()
	pidPath := filepath.Join(workspace.Root, "child.pid")
	require.Eventually(t, func() bool {
		contents, readErr := os.ReadFile(pidPath)
		return readErr == nil && strings.TrimSpace(string(contents)) != ""
	}, 2*time.Second, 10*time.Millisecond)
	pidBytes, err := os.ReadFile(pidPath)
	require.NoError(t, err)
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	require.NoError(t, err)
	cancel()
	require.ErrorIs(t, <-result, context.Canceled)
	require.Eventually(t, func() bool {
		err := syscall.Kill(pid, 0)
		return errors.Is(err, syscall.ESRCH)
	}, 2*time.Second, 10*time.Millisecond, "child process %d survived cancellation", pid)
}

func TestRuntimeSerializesStopAgainstRestart(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir(), func(config *Config) { config.TerminationGrace = 300 * time.Millisecond })
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "lifecycle"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	_, err = runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "stubborn", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "trap '' TERM; : > stubborn.ready; while :; do sleep 1; done"}},
	})
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		_, statErr := os.Stat(filepath.Join(workspace.Root, "stubborn.ready"))
		return statErr == nil
	}, time.Second, 5*time.Millisecond)

	stopped := make(chan error, 1)
	go func() { stopped <- runtime.StopWorkspace(context.Background(), workspace.ID) }()
	require.Eventually(t, func() bool {
		observed, inspectErr := runtime.InspectWorkspace(context.Background(), workspace.ID)
		return inspectErr == nil && observed.State == workspaceapi.WorkspaceStopping
	}, time.Second, 5*time.Millisecond)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.ErrorContains(t, err, "stop is in progress")
	require.NoError(t, <-stopped)
	observed, err := runtime.InspectWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
}

func TestRuntimeManagedServiceDistinguishesStopFromFailure(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "service-state"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)

	_, err = runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "stopped", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 30"}},
	})
	require.NoError(t, err)
	require.NoError(t, runtime.StopService(context.Background(), workspace.ID, "stopped"))
	stopped, err := runtime.InspectService(context.Background(), workspace.ID, "stopped")
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.ServiceStopped, stopped.State)

	_, err = runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "failed", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 0.05; exit 7"}},
	})
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		failed, inspectErr := runtime.InspectService(context.Background(), workspace.ID, "failed")
		return inspectErr == nil && failed.State == workspaceapi.ServiceFailed && failed.ExitCode == 7
	}, time.Second, 10*time.Millisecond)
}

func TestRuntimeServicePreviewAndTerminal(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "interactive"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)

	address := reserveTestAddress(t)
	service, err := runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "preview", Command: helperCommand("serve", map[string]string{"SMITHERS_TEST_ADDRESS": address}),
		ReadyAddress: address, ReadyTimeout: 2 * time.Second,
	})
	require.NoError(t, err)
	assert.Positive(t, service.PID)
	port, err := strconv.Atoi(strings.TrimPrefix(address, "127.0.0.1:"))
	require.NoError(t, err)
	target, err := runtime.PreviewTarget(context.Background(), workspace.ID, uint16(port))
	require.NoError(t, err)
	response, err := http.Get(target.URL + "/ready")
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Equal(t, "ready", string(body))
	observation, err := runtime.InspectService(context.Background(), workspace.ID, "preview")
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.ServiceRunning, observation.State)
	assert.Equal(t, service.PID, observation.PID)

	terminal, err := runtime.OpenWorkspaceTerminal(context.Background(), workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", `read value; printf 'reply:%s\n' "$value"`}})
	require.NoError(t, err)
	require.NoError(t, terminal.Resize(context.Background(), 100, 40))
	_, err = terminal.Write([]byte("hello\n"))
	require.NoError(t, err)
	read := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(terminal)
		var output strings.Builder
		for {
			line, readErr := reader.ReadString('\n')
			output.WriteString(line)
			if strings.Contains(output.String(), "reply:hello") || readErr != nil {
				read <- output.String()
				return
			}
		}
	}()
	select {
	case output := <-read:
		assert.Contains(t, output, "reply:hello")
	case <-time.After(2 * time.Second):
		t.Fatal("terminal did not return command output")
	}
	require.NoError(t, terminal.Close())
	require.NoError(t, runtime.StopService(context.Background(), workspace.ID, "preview"))
	require.Eventually(t, func() bool {
		connection, dialErr := net.DialTimeout("tcp", address, 20*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
		}
		return dialErr != nil
	}, 2*time.Second, 20*time.Millisecond)
}

func TestStartCodingHostInvokesBundledHostDirectlyAndDeduplicates(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "coding-host.json")
	wrapper := filepath.Join(t.TempDir(), "smithers-coding-host")
	script := "#!/bin/sh\nexec \"$SMITHERS_TEST_BINARY\" -test.run='^TestProcessHelper$' -- \"$@\"\n"
	require.NoError(t, os.WriteFile(wrapper, []byte(script), 0o700))
	runtime := newTestRuntime(t, t.TempDir(), func(config *Config) {
		config.Environment = map[string]string{"SMITHERS_TEST_BINARY": os.Args[0]}
	})
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "coding"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	config := CodingHostConfig{Executable: wrapper, GatewayID: "12345678-1234-1234-1234-123456789abc",
		ImplementationModel: "openai:gpt-5", Credential: "private", OwnerGeneration: 7, ArtifactDigest: strings.Repeat("a", 64), Environment: map[string]string{
			"SMITHERS_TEST_HELPER": "coding", "SMITHERS_TEST_MARKER": marker,
		}, ReadyTimeout: 2 * time.Second}
	first, err := runtime.StartCodingHost(context.Background(), workspace.ID, config)
	require.NoError(t, err)
	second, err := runtime.StartCodingHost(context.Background(), workspace.ID, config)
	require.NoError(t, err)
	assert.Equal(t, first, second)

	var receipt struct {
		Args            []string `json:"args"`
		Home            string   `json:"home"`
		Gateway         string   `json:"gateway"`
		Model           string   `json:"model"`
		OwnerGeneration string   `json:"ownerGeneration"`
		ArtifactDigest  string   `json:"artifactDigest"`
		HasAPIKey       bool     `json:"hasApiKey"`
	}
	contents, err := os.ReadFile(marker)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(contents, &receipt))
	assert.Equal(t, workspace.Home, receipt.Home)
	assert.Equal(t, config.GatewayID, receipt.Gateway)
	assert.Equal(t, config.ImplementationModel, receipt.Model)
	assert.Equal(t, "7", receipt.OwnerGeneration)
	assert.Equal(t, config.ArtifactDigest, receipt.ArtifactDigest)
	assert.True(t, receipt.HasAPIKey)
	assert.Equal(t, "serve", receipt.Args[0])
	assert.Equal(t, workspace.Root, argumentValue(receipt.Args, "--root"))
	assert.Equal(t, workspace.StateDir, argumentValue(receipt.Args, "--state-dir"))
	assert.Equal(t, "127.0.0.1", argumentValue(receipt.Args, "--host"))
	assert.NotEmpty(t, argumentValue(receipt.Args, "--port"))
	assert.Contains(t, receipt.Args, "--listen")
}

func helperCommand(mode string, environment map[string]string) workspaceapi.Command {
	copy := make(map[string]string, len(environment)+1)
	for name, value := range environment {
		copy[name] = value
	}
	copy["SMITHERS_TEST_HELPER"] = mode
	return workspaceapi.Command{Args: []string{os.Args[0], "-test.run=^TestProcessHelper$", "--"}, Environment: copy}
}

func reserveTestAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	return address
}

func portFromAddress(t *testing.T, address string) int {
	t.Helper()
	_, rawPort, err := net.SplitHostPort(address)
	require.NoError(t, err)
	port, err := strconv.Atoi(rawPort)
	require.NoError(t, err)
	return port
}

func argumentValue(args []string, name string) string {
	for index := range args {
		if args[index] == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

func TestProcessHelper(t *testing.T) {
	mode := os.Getenv("SMITHERS_TEST_HELPER")
	if mode == "" {
		return
	}
	var address string
	switch mode {
	case "serve":
		address = os.Getenv("SMITHERS_TEST_ADDRESS")
	case "coding":
		args := flagArguments(os.Args)
		port := argumentValue(args, "--port")
		address = net.JoinHostPort(argumentValue(args, "--host"), port)
		receipt := map[string]any{"args": args, "home": os.Getenv("HOME"), "gateway": os.Getenv("SMITHERS_GATEWAY_ID"),
			"model": os.Getenv("SMITHERS_CODING_IMPLEMENT_MODEL"), "ownerGeneration": os.Getenv("SMITHERS_OWNER_GENERATION"),
			"artifactDigest": os.Getenv("SMITHERS_FLOW_ARTIFACT_SHA256"), "hasApiKey": os.Getenv("SMITHERS_API_KEY") != ""}
		contents, err := json.Marshal(receipt)
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(os.Getenv("SMITHERS_TEST_MARKER"), contents, 0o600); err != nil {
			panic(err)
		}
	default:
		panic(fmt.Sprintf("unknown helper mode %q", mode))
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		panic(err)
	}
	handler := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write([]byte("ready")) })
	if err := http.Serve(listener, handler); err != nil {
		panic(err)
	}
}

func flagArguments(args []string) []string {
	for index, value := range args {
		if value == "--" {
			return args[index+1:]
		}
	}
	return nil
}
