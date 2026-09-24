package process

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const (
	managedHostStateDirectory = "managed-hosts"
	managedHostMetadataName   = "binding.json"
	defaultManagedHostTimeout = 30 * time.Second
)

type managedHostBinding struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// InspectManagedHost returns a live, authenticated Flow control connection.
// A bare listener or a process table entry is never sufficient readiness.
func (r *Runtime) InspectManagedHost(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	if err := validateManagedHostSpec(spec); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}

	r.mu.Lock()
	ws, err := r.runningWorkspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.ManagedHostConnection{}, err
	}
	service := ws.services[spec.Name]
	if service == nil {
		r.mu.Unlock()
		return workspaceapi.ManagedHostConnection{}, workspaceapi.ErrManagedHostNotRunning
	}
	select {
	case <-service.process.done:
		r.mu.Unlock()
		return workspaceapi.ManagedHostConnection{}, workspaceapi.ErrManagedHostNotRunning
	default:
	}
	if service.fingerprint != spec.Identity {
		r.mu.Unlock()
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("%w: live service configuration differs", workspaceapi.ErrManagedHostIdentityConflict)
	}
	address := service.spec.ReadyAddress
	r.mu.Unlock()

	connection, err := localManagedHostConnection(address)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("%w: %v", workspaceapi.ErrManagedHostIdentityConflict, err)
	}
	return probeManagedHost(ctx, spec, connection)
}

// StartManagedHost allocates a loopback address, gives the command builder the
// adapter-owned paths/address, and launches through StartService so
// process groups, cancellation, output bounds, stop, and workspace teardown
// retain one implementation.
func (r *Runtime) StartManagedHost(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	if err := validateManagedHostSpec(spec); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	if connection, err := r.InspectManagedHost(ctx, workspaceID, spec); err == nil {
		return connection, nil
	} else if !errors.Is(err, workspaceapi.ErrManagedHostNotRunning) {
		return workspaceapi.ManagedHostConnection{}, err
	}

	current, err := r.InspectWorkspace(ctx, workspaceID)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	if current.State != workspaceapi.WorkspaceRunning {
		return workspaceapi.ManagedHostConnection{}, workspaceapi.ErrWorkspaceStopped
	}
	stateDir, err := ensureManagedHostState(current.StateDir, spec)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	address, host, port, err := allocateManagedHostAddress(ctx)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	command, err := spec.Builder.BuildManagedHost(ctx, workspaceapi.ManagedHostPlacement{
		Workspace: current,
		StateDir:  stateDir,
		Host:      host,
		Port:      port,
		Address:   address,
	})
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("build managed host command: %w", err)
	}
	if len(command.Args) == 0 {
		return workspaceapi.ManagedHostConnection{}, errors.New("managed host command is required")
	}
	timeout := spec.ReadyTimeout
	if timeout <= 0 {
		timeout = defaultManagedHostTimeout
	}
	readyCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	service, err := r.StartService(readyCtx, workspaceID, workspaceapi.ServiceSpec{
		Name: spec.Name, Identity: spec.Identity, Command: command,
		ReadyAddress: address, ReadyTimeout: timeout,
	})
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	connection, err := localManagedHostConnection(service.Address)
	if err != nil {
		_ = r.StopService(context.Background(), workspaceID, spec.Name)
		return workspaceapi.ManagedHostConnection{}, err
	}
	verified, err := probeManagedHost(readyCtx, spec, connection)
	if err != nil {
		_ = r.StopService(context.Background(), workspaceID, spec.Name)
		return workspaceapi.ManagedHostConnection{}, err
	}
	return verified, nil
}

func validateManagedHostSpec(spec workspaceapi.ManagedHostSpec) error {
	if strings.TrimSpace(spec.ID) == "" || len(spec.ID) > 512 || strings.IndexByte(spec.ID, 0) >= 0 {
		return errors.New("managed host binding id is required")
	}
	if strings.TrimSpace(spec.Name) == "" || strings.IndexByte(spec.Name, 0) >= 0 {
		return errors.New("managed host service name is required")
	}
	if strings.TrimSpace(spec.Identity) == "" || strings.IndexByte(spec.Identity, 0) >= 0 {
		return errors.New("managed host service identity is required")
	}
	if spec.Builder == nil || spec.Probe == nil {
		return errors.New("managed host builder and identity probe are required")
	}
	identity := spec.Expected
	if strings.TrimSpace(identity.Protocol) == "" || !lowerHex(identity.ArtifactDigest, 64) ||
		!lowerHex(identity.SourceRevision, 40) || identity.OwnerGeneration <= 0 {
		return errors.New("managed host expected identity is invalid")
	}
	return nil
}

func lowerHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func allocateManagedHostAddress(ctx context.Context) (address, host string, port uint16, err error) {
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return "", "", 0, fmt.Errorf("allocate managed host address: %w", err)
	}
	address = listener.Addr().String()
	if closeErr := listener.Close(); closeErr != nil {
		return "", "", 0, fmt.Errorf("release managed host address: %w", closeErr)
	}
	host, rawPort, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		return "", "", 0, errors.New("allocated managed host address is not IPv4 loopback")
	}
	parsed, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil || parsed == 0 {
		return "", "", 0, errors.New("allocated managed host port is invalid")
	}
	return address, host, uint16(parsed), nil
}

func ensureManagedHostState(workspaceState string, spec workspaceapi.ManagedHostSpec) (string, error) {
	directory := filepath.Join(workspaceState, managedHostStateDirectory, workspaceDirectoryName(spec.ID))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("create managed host state: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return "", fmt.Errorf("protect managed host state: %w", err)
	}
	metadataPath := filepath.Join(directory, managedHostMetadataName)
	contents, err := os.ReadFile(metadataPath)
	if err == nil {
		var binding managedHostBinding
		if json.Unmarshal(contents, &binding) != nil || binding.ID != spec.ID {
			return "", errors.New("managed host state belongs to another binding")
		}
		if binding.Name == spec.Name {
			return directory, nil
		}
		// The binding ID owns the state. A renamed service (a host upgrade
		// that changed the catalog service name) keeps it and records the name.
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read managed host state identity: %w", err)
	}
	contents, err = json.Marshal(managedHostBinding{ID: spec.ID, Name: spec.Name})
	if err != nil {
		return "", fmt.Errorf("encode managed host state identity: %w", err)
	}
	temporary := metadataPath + ".tmp"
	if err := os.WriteFile(temporary, append(contents, '\n'), 0o600); err != nil {
		return "", fmt.Errorf("write managed host state identity: %w", err)
	}
	if err := os.Rename(temporary, metadataPath); err != nil {
		_ = os.Remove(temporary)
		return "", fmt.Errorf("commit managed host state identity: %w", err)
	}
	return directory, nil
}

func localManagedHostConnection(address string) (workspaceapi.ManagedHostConnection, error) {
	host, rawPort, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil || host != "127.0.0.1" {
		return workspaceapi.ManagedHostConnection{}, errors.New("managed host address is not IPv4 loopback")
	}
	if port, parseErr := strconv.ParseUint(rawPort, 10, 16); parseErr != nil || port == 0 {
		return workspaceapi.ManagedHostConnection{}, errors.New("managed host address has an invalid port")
	}
	endpoint := (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, rawPort)}).String()
	return workspaceapi.ManagedHostConnection{Endpoint: endpoint}, nil
}

func probeManagedHost(ctx context.Context, spec workspaceapi.ManagedHostSpec, connection workspaceapi.ManagedHostConnection) (workspaceapi.ManagedHostConnection, error) {
	timeout := spec.ReadyTimeout
	if timeout <= 0 {
		timeout = defaultManagedHostTimeout
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	observed, err := spec.Probe.ProbeManagedHost(probeCtx, connection)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("probe managed host identity: %w", err)
	}
	if observed != spec.Expected {
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("%w: protocol, artifact, source revision, or owner generation differs", workspaceapi.ErrManagedHostIdentityConflict)
	}
	return connection, nil
}

var _ workspaceapi.WorkspaceManagedHosts = (*Runtime)(nil)
