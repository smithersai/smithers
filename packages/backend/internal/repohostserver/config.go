package repohostserver

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

const (
	defaultStoragePath     = "./data/repos"
	defaultListenAddr      = "0.0.0.0:8080"
	defaultPushHookURL     = "http://localhost:3000/internal/repo-host/push-events"
	defaultTraceSampleRate = 0.01
)

type Config struct {
	StoragePath           string
	ListenAddr            string
	AuthToken             string
	PushHookCallbackURL   string
	PushHookCallbackToken string
	FFILibraryPath        string
	Observability         config.ObservabilityConfig
}

func LoadConfig() (Config, error) {
	cfg := Config{
		StoragePath:           envOrDefault("SMITHERS_REPO_STORAGE_PATH", defaultStoragePath),
		ListenAddr:            envOrDefault("SMITHERS_REPO_HOST_ADDR", defaultListenAddr),
		AuthToken:             authTokenFromEnv(),
		PushHookCallbackURL:   strings.TrimSpace(os.Getenv("SMITHERS_PUSH_HOOK_CALLBACK_URL")),
		PushHookCallbackToken: strings.TrimSpace(os.Getenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN")),
		FFILibraryPath:        strings.TrimSpace(os.Getenv("SMITHERS_FFI_LIBRARY_PATH")),
	}

	observability, err := observabilityFromEnv()
	if err != nil {
		return Config{}, err
	}
	cfg.Observability = observability

	if cfg.AuthToken == "" {
		return Config{}, errors.New("SMITHERS_REPO_HOST_AUTH_TOKEN must be set")
	}
	if cfg.PushHookCallbackURL == "" && cfg.PushHookCallbackToken != "" {
		cfg.PushHookCallbackURL = defaultPushHookURL
	}
	if cfg.PushHookCallbackURL != "" && cfg.PushHookCallbackToken == "" {
		return Config{}, errors.New("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN must be set when push hooks are enabled")
	}
	if cfg.FFILibraryPath == "" {
		detected, err := detectFFILibraryPath()
		if err != nil {
			return Config{}, err
		}
		cfg.FFILibraryPath = detected
	}
	if err := os.MkdirAll(cfg.StoragePath, 0o755); err != nil {
		return Config{}, fmt.Errorf("create repo storage path: %w", err)
	}
	return cfg, nil
}

func (c Config) RepoPath(owner, repo string) string {
	return filepath.Join(c.StoragePath, owner, repo)
}

// wikiRepoSuffix and docsRepoSuffix are appended to a repo name to derive the
// on-disk path of its auxiliary wiki/docs stores. A user-chosen repo name
// ending in one of these would collide with another repo's derived store
// (e.g. a repo literally named "X.wiki" resolves to the same directory as
// repo "X"'s wiki store), so validateOwnerRepo rejects such names.
const (
	wikiRepoSuffix = ".wiki"
	docsRepoSuffix = ".docs"
)

func (c Config) WikiRepoPath(owner, repo string) string {
	return filepath.Join(c.StoragePath, owner, repo+wikiRepoSuffix)
}

func (c Config) DocsRepoPath(owner, repo string) string {
	return filepath.Join(c.StoragePath, owner, repo+docsRepoSuffix)
}

func (c Config) GitBackendPath(owner, repo string) string {
	return filepath.Join(c.RepoPath(owner, repo), ".jj", "repo", "store", "git")
}

func validatePathComponent(value string) bool {
	if value == "" || strings.HasPrefix(value, ".") {
		return false
	}
	if strings.ContainsAny(value, "/\\") {
		return false
	}
	for _, ch := range value {
		switch {
		case ch >= 'a' && ch <= 'z':
		case ch >= 'A' && ch <= 'Z':
		case ch >= '0' && ch <= '9':
		case ch == '-' || ch == '_' || ch == '.':
		default:
			return false
		}
	}
	return true
}

func parseRepoID(repoID string) (string, string, error) {
	trimmed := strings.TrimSpace(repoID)
	if trimmed == "" {
		return "", "", badRequest("repository id is required")
	}
	decoded, err := url.PathUnescape(trimmed)
	if err != nil {
		return "", "", badRequest("repository id must be url-encoded owner:repo")
	}
	trimmed = decoded

	parts := strings.Split(trimmed, ":")
	if len(parts) != 2 {
		return "", "", badRequest("repository id must be owner:repo")
	}
	if err := validateOwnerRepo(parts[0], parts[1]); err != nil {
		return "", "", err
	}
	return parts[0], parts[1], nil
}

func validateOwnerRepo(owner, repo string) error {
	if !validatePathComponent(owner) {
		return badRequest("invalid owner name")
	}
	if !validatePathComponent(repo) {
		return badRequest("invalid repo name")
	}
	if hasReservedRepoSuffix(repo) {
		return badRequest("invalid repo name")
	}
	return nil
}

// hasReservedRepoSuffix reports whether a repo name would collide with the
// on-disk store the repo-host derives for another repo's wiki or docs. The
// comparison is case-insensitive because the derived path (repo+".wiki") and a
// repo path can collide on case-insensitive filesystems (e.g. macOS): a repo
// named "X.WIKI" and repo "X"'s wiki store both resolve to the same directory.
func hasReservedRepoSuffix(repo string) bool {
	lower := strings.ToLower(repo)
	return strings.HasSuffix(lower, wikiRepoSuffix) || strings.HasSuffix(lower, docsRepoSuffix)
}

func validateFileSubpath(path string) error {
	trimmed := strings.TrimSpace(strings.TrimPrefix(path, "/"))
	if trimmed == "" {
		return badRequest("path is required")
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == "." || part == ".." {
			return badRequest("invalid path")
		}
	}
	return nil
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// observabilityFromEnv reads OpenTelemetry configuration from the same env
// vars the API server uses. Tracing is off by default; set
// SMITHERS_OTEL_EXPORTER=otlp plus SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT to send
// traces to the self-hosted collector.
func observabilityFromEnv() (config.ObservabilityConfig, error) {
	sampleRate := defaultTraceSampleRate
	if raw := strings.TrimSpace(os.Getenv("SMITHERS_TRACE_SAMPLE_RATE")); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return config.ObservabilityConfig{}, fmt.Errorf("SMITHERS_TRACE_SAMPLE_RATE must be a number between 0 and 1: %w", err)
		}
		if math.IsNaN(parsed) || parsed < 0 || parsed > 1 {
			return config.ObservabilityConfig{}, fmt.Errorf("SMITHERS_TRACE_SAMPLE_RATE must be a number between 0 and 1: got %q", raw)
		}
		sampleRate = parsed
	}
	return config.ObservabilityConfig{
		OTelExporter:    envOrDefault("SMITHERS_OTEL_EXPORTER", "none"),
		OTLPEndpoint:    strings.TrimSpace(os.Getenv("SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT")),
		TraceSampleRate: sampleRate,
	}, nil
}

func authTokenFromEnv() string {
	if value := strings.TrimSpace(os.Getenv("SMITHERS_REPO_HOST_AUTH_TOKEN")); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv("REPO_HOST_AUTH_TOKEN"))
}

func detectFFILibraryPath() (string, error) {
	libName := "libsmithers_ffi." + ffiLibraryExt()
	var candidates []string

	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "target", "debug", libName),
			filepath.Join(cwd, "target", "release", libName),
		)
	}

	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, libName),
			filepath.Join(exeDir, "..", libName),
			filepath.Join(exeDir, "..", "target", "debug", libName),
			filepath.Join(exeDir, "..", "target", "release", libName),
		)
	}

	for _, candidate := range candidates {
		candidate = filepath.Clean(candidate)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("SMITHERS_FFI_LIBRARY_PATH must be set or %s must exist in target/debug or target/release", libName)
}

func ffiLibraryExt() string {
	return ffiLibraryExtForOS(runtime.GOOS)
}

func ffiLibraryExtForOS(goos string) string {
	switch goos {
	case "darwin":
		return "dylib"
	case "windows":
		return "dll"
	default:
		return "so"
	}
}
