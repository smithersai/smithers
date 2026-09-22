// Package localbootstrap prepares the durable, single-owner backend instance
// used by both the container and the native application's local mode.
package localbootstrap

import (
	"context"
	"crypto/rand"
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

	"github.com/smithersai/smithers/packages/backend/repository"
)

const DefaultDataRoot = "./data"

var secretNames = []string{
	"SMITHERS_AUTH_SESSION_SECRET",
	"SMITHERS_LFS_SIGNING_SECRET",
	"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY",
	"SMITHERS_REPO_HOST_AUTH_TOKEN",
	"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN",
	"SMITHERS_AUTH_BOOTSTRAP_TOKEN",
}

type secretFile struct {
	Version int               `json:"version"`
	Values  map[string]string `json:"values"`
}

// Runtime owns the local repository engine. The caller passes Client() to
// app.Config.Repository and closes this runtime after app.Run returns.
type Runtime struct{ repository *repository.Local }

func (r *Runtime) Client() *repository.Client         { return r.repository.Client() }
func (r *Runtime) Shutdown(ctx context.Context) error { return r.repository.Shutdown(ctx) }

// BootstrapToken is given only to the trusted native bridge or process
// operator to claim the first owner. It must not be served over HTTP.
func (r *Runtime) BootstrapToken() string { return os.Getenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN") }

// Prepare reopens durable secrets and storage under root, then starts the
// in-process repository engine. Explicit environment values take precedence;
// every missing secret is generated once and persisted with private mode.
func Prepare(root string) (*Runtime, error) {
	root, err := configure(root)
	if err != nil {
		return nil, err
	}
	cfg, err := repository.LoadConfig()
	if err != nil {
		return nil, fmt.Errorf("configure local repository: %w", err)
	}
	cfg.StoragePath = filepath.Join(root, "repositories")
	local, err := repository.OpenLocal(cfg)
	if err != nil {
		return nil, fmt.Errorf("open local repository: %w", err)
	}
	return &Runtime{repository: local}, nil
}

func configure(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		root = strings.TrimSpace(os.Getenv("SMITHERS_DATA_ROOT"))
	}
	if root == "" {
		root = DefaultDataRoot
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve local data root: %w", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create local data root: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("local data root must be a real directory")
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return "", fmt.Errorf("make local data root private: %w", err)
	}
	values, err := loadOrCreateSecrets(filepath.Join(root, "config"))
	if err != nil {
		return "", err
	}
	for _, name := range secretNames {
		if value, exists := os.LookupEnv(name); exists {
			if strings.TrimSpace(value) == "" {
				return "", fmt.Errorf("%s is set but empty", name)
			}
			continue
		}
		if err := os.Setenv(name, values[name]); err != nil {
			return "", err
		}
	}
	for name, value := range map[string]string{
		"SMITHERS_DATA_ROOT":         root,
		"SMITHERS_BLOB_DATA_DIR":     filepath.Join(root, "blobs"),
		"SMITHERS_REPO_STORAGE_PATH": filepath.Join(root, "repositories"),
	} {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			if err := os.Setenv(name, value); err != nil {
				return "", err
			}
		}
	}
	if err := configurePublicEndpoint(); err != nil {
		return "", err
	}
	if strings.TrimSpace(os.Getenv("SMITHERS_PUSH_HOOK_CALLBACK_URL")) == "" {
		address := strings.TrimSpace(os.Getenv("SMITHERS_SERVER_ADDR"))
		if address == "" {
			address = ":4000"
		}
		_, port, err := net.SplitHostPort(address)
		if err != nil || port == "" {
			return "", fmt.Errorf("invalid local server address %q", address)
		}
		if err := os.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_URL", "http://127.0.0.1:"+port+"/internal/repo-host/push-events"); err != nil {
			return "", err
		}
	}
	return root, nil
}

func configurePublicEndpoint() error {
	address := strings.TrimSpace(os.Getenv("SMITHERS_SERVER_ADDR"))
	if address == "" {
		if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
			portNumber, err := strconv.Atoi(port)
			if err != nil || portNumber < 1 || portNumber > 65535 {
				return fmt.Errorf("invalid PORT %q", port)
			}
			address = ":" + port
			if err := os.Setenv("SMITHERS_SERVER_ADDR", address); err != nil {
				return err
			}
		} else {
			address = ":4000"
		}
	}
	if strings.TrimSpace(os.Getenv("SMITHERS_PUBLIC_URL")) != "" {
		return nil
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return fmt.Errorf("invalid local server address %q", address)
	}
	if domain := strings.TrimSpace(os.Getenv("RAILWAY_PUBLIC_DOMAIN")); domain != "" {
		parsed, err := url.Parse("https://" + domain)
		if err != nil || parsed.Host != domain || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("invalid RAILWAY_PUBLIC_DOMAIN %q", domain)
		}
		return os.Setenv("SMITHERS_PUBLIC_URL", "https://"+domain)
	}
	return os.Setenv("SMITHERS_PUBLIC_URL", "http://127.0.0.1:"+port)
}

func loadOrCreateSecrets(configDir string) (map[string]string, error) {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, fmt.Errorf("create local config directory: %w", err)
	}
	info, err := os.Lstat(configDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("local config directory must be a real directory")
	}
	if err := os.Chmod(configDir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(configDir, "secrets.json")
	if values, err := readSecrets(path); err == nil {
		return values, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	values := make(map[string]string, len(secretNames))
	for _, name := range secretNames {
		if current, ok := os.LookupEnv(name); ok {
			if strings.TrimSpace(current) == "" {
				return nil, fmt.Errorf("%s is set but empty", name)
			}
			values[name] = current
			continue
		}
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			return nil, fmt.Errorf("generate %s: %w", name, err)
		}
		values[name] = hex.EncodeToString(bytes)
	}
	file, err := os.CreateTemp(configDir, ".secrets-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return nil, err
	}
	if err := json.NewEncoder(file).Encode(secretFile{Version: 1, Values: values}); err != nil {
		return nil, err
	}
	if err := file.Sync(); err != nil {
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	// Link publishes complete bytes without replacing a concurrent winner.
	if err := os.Link(file.Name(), path); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if dir, err := os.Open(configDir); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return readSecrets(path)
}

func readSecrets(path string) (map[string]string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("local secrets file must be a private regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var data secretFile
	decoder := json.NewDecoder(f)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&data); err != nil {
		return nil, fmt.Errorf("decode local secrets: %w", err)
	}
	if data.Version != 1 {
		return nil, fmt.Errorf("unsupported local secrets version %d", data.Version)
	}
	if len(data.Values) != len(secretNames) {
		return nil, errors.New("local secrets file is incomplete")
	}
	for _, name := range secretNames {
		if strings.TrimSpace(data.Values[name]) == "" {
			return nil, fmt.Errorf("local secrets file has no %s", name)
		}
	}
	return data.Values, nil
}
