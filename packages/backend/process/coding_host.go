package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// CodingHostConfig is the narrow local launch strategy for the canonical
// bundled TypeScript host. Packaging provides Executable; this adapter neither
// downloads a private artifact nor runs a privileged guest bootstrap script.
type CodingHostConfig struct {
	Executable          string
	GatewayID           string
	ImplementationModel string
	Credential          string
	OwnerGeneration     uint64
	ArtifactDigest      string
	Project             string
	Environment         map[string]string
	ReadyTimeout        time.Duration
}

// StartCodingHost starts flows/coding/serve.ts's bundled executable directly
// against the persistent workspace and its separate state directory.
func (r *Runtime) StartCodingHost(ctx context.Context, workspaceID string, config CodingHostConfig) (workspaceapi.Service, error) {
	executable := strings.TrimSpace(config.Executable)
	if executable == "" {
		return workspaceapi.Service{}, errors.New("coding host executable is required")
	}
	if !filepath.IsAbs(executable) {
		return workspaceapi.Service{}, errors.New("coding host executable must be an absolute path")
	}
	if config.OwnerGeneration == 0 {
		return workspaceapi.Service{}, errors.New("coding host owner generation must be positive")
	}
	workspace, err := r.InspectWorkspace(ctx, workspaceID)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return workspaceapi.Service{}, fmt.Errorf("reserve coding host port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return workspaceapi.Service{}, fmt.Errorf("release coding host port: %w", err)
	}
	environment := make(map[string]string, len(config.Environment)+4)
	for name, value := range config.Environment {
		environment[name] = value
	}
	environment["SMITHERS_GATEWAY_ID"] = strings.TrimSpace(config.GatewayID)
	environment["SMITHERS_CODING_IMPLEMENT_MODEL"] = strings.TrimSpace(config.ImplementationModel)
	if config.Credential != "" {
		environment["SMITHERS_API_KEY"] = config.Credential
	}
	environment["SMITHERS_OWNER_GENERATION"] = strconv.FormatUint(config.OwnerGeneration, 10)
	if config.ArtifactDigest != "" {
		environment["SMITHERS_FLOW_ARTIFACT_SHA256"] = config.ArtifactDigest
	}
	if config.Project != "" {
		environment["SMITHERS_CODING_PROJECT"] = config.Project
	}
	identityInput := append([]string{executable, strings.TrimSpace(config.GatewayID), strings.TrimSpace(config.ImplementationModel), config.Project}, flattenEnvironment(environment)...)
	identityDigest := sha256.Sum256([]byte(strings.Join(identityInput, "\x00")))
	return r.StartService(ctx, workspaceID, workspaceapi.ServiceSpec{
		Name: "coding-host", Identity: "coding-host:" + hex.EncodeToString(identityDigest[:]),
		Command: workspaceapi.Command{Args: []string{executable, "serve", "--root", workspace.Root, "--state-dir", workspace.StateDir,
			"--host", "127.0.0.1", "--port", strconv.Itoa(port), "--listen"}, Environment: environment},
		ReadyPort: uint16(port), ReadyTimeout: config.ReadyTimeout,
	})
}
