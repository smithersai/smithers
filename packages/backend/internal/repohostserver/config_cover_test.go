package repohostserver

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConfig_Cov_LoadConfigWithExplicitFFILibraryPath(t *testing.T) {
	configCovClearEnv(t)
	storagePath := filepath.Join(t.TempDir(), "repos")
	ffiPath := filepath.Join(t.TempDir(), "libsmithers_ffi.test")
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", " "+storagePath+" ")
	t.Setenv("SMITHERS_REPO_HOST_ADDR", " 127.0.0.1:9090 ")
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", " primary-token ")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_URL", " https://example.test/push ")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "callback-token")
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", " "+ffiPath+" ")
	t.Setenv("SMITHERS_CLOUD_TRACE_PROJECT_ID", " trace-project ")
	t.Setenv("SMITHERS_TRACE_SAMPLE_RATE", "0.25")
	t.Setenv("SMITHERS_OTEL_EXPORTER", "otlp")
	t.Setenv("SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}
	if cfg.StoragePath != storagePath {
		t.Fatalf("StoragePath = %q, want %q", cfg.StoragePath, storagePath)
	}
	if cfg.ListenAddr != "127.0.0.1:9090" {
		t.Fatalf("ListenAddr = %q", cfg.ListenAddr)
	}
	if cfg.AuthToken != "primary-token" {
		t.Fatalf("AuthToken = %q", cfg.AuthToken)
	}
	if cfg.PushHookCallbackURL != "https://example.test/push" {
		t.Fatalf("PushHookCallbackURL = %q", cfg.PushHookCallbackURL)
	}
	if cfg.PushHookCallbackToken != "callback-token" {
		t.Fatalf("PushHookCallbackToken = %q", cfg.PushHookCallbackToken)
	}
	if cfg.FFILibraryPath != ffiPath {
		t.Fatalf("FFILibraryPath = %q, want %q", cfg.FFILibraryPath, ffiPath)
	}
	if cfg.Observability.CloudTraceProjectID != "trace-project" {
		t.Fatalf("CloudTraceProjectID = %q", cfg.Observability.CloudTraceProjectID)
	}
	if cfg.Observability.TraceSampleRate != 0.25 {
		t.Fatalf("TraceSampleRate = %v", cfg.Observability.TraceSampleRate)
	}
	if cfg.Observability.OTelExporter != "otlp" {
		t.Fatalf("OTelExporter = %q", cfg.Observability.OTelExporter)
	}
	if cfg.Observability.OTLPEndpoint != "http://collector:4318" {
		t.Fatalf("OTLPEndpoint = %q", cfg.Observability.OTLPEndpoint)
	}
	if info, err := os.Stat(storagePath); err != nil || !info.IsDir() {
		t.Fatalf("storage path was not created as a directory, info=%v err=%v", info, err)
	}
}

func TestConfig_Cov_LoadConfigFallsBackToLegacyAuthToken(t *testing.T) {
	configCovClearEnv(t)
	storagePath := filepath.Join(t.TempDir(), "repos")
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", storagePath)
	t.Setenv("REPO_HOST_AUTH_TOKEN", "legacy-token")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "callback-token")
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", "/tmp/no-real-load-required")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}
	if cfg.AuthToken != "legacy-token" {
		t.Fatalf("AuthToken = %q, want legacy-token", cfg.AuthToken)
	}
	if cfg.ListenAddr != defaultListenAddr {
		t.Fatalf("ListenAddr = %q, want default %q", cfg.ListenAddr, defaultListenAddr)
	}
	if cfg.PushHookCallbackURL != defaultPushHookURL {
		t.Fatalf("PushHookCallbackURL = %q, want default %q", cfg.PushHookCallbackURL, defaultPushHookURL)
	}
}

func TestConfig_Cov_LoadConfigRejectsMissingAuthToken(t *testing.T) {
	configCovClearEnv(t)
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", filepath.Join(t.TempDir(), "repos"))
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", "/tmp/no-real-load-required")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected missing auth token error")
	}
	if !strings.Contains(err.Error(), "SMITHERS_REPO_HOST_AUTH_TOKEN must be set") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfig_Cov_LoadConfigRejectsMissingPushCallbackToken(t *testing.T) {
	configCovClearEnv(t)
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", filepath.Join(t.TempDir(), "repos"))
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "control-token")
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", "/tmp/no-real-load-required")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_URL", "http://localhost:3000/internal/repo-host/push-events")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "SMITHERS_PUSH_HOOK_CALLBACK_TOKEN must be set") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfig_Cov_LoadConfigRejectsInvalidTraceSampleRate(t *testing.T) {
	configCovClearEnv(t)
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "token")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "callback-token")
	t.Setenv("SMITHERS_TRACE_SAMPLE_RATE", "not-a-number")
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", "/tmp/no-real-load-required")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected invalid trace sample rate error")
	}
	if !strings.Contains(err.Error(), "SMITHERS_TRACE_SAMPLE_RATE must be a number between 0 and 1") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfig_Cov_LoadConfigReportsStorageCreateError(t *testing.T) {
	configCovClearEnv(t)
	parentFile := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(parentFile, []byte("x"), 0o644); err != nil {
		t.Fatalf("write parent file: %v", err)
	}
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "token")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "callback-token")
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", filepath.Join(parentFile, "repos"))
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", "/tmp/no-real-load-required")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected storage create error")
	}
	if !strings.Contains(err.Error(), "create repo storage path") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfig_Cov_LoadConfigDetectsFFILibraryPath(t *testing.T) {
	configCovClearEnv(t)
	t.Chdir(t.TempDir())
	libPath := configCovCreateDetectedFFILibrary(t)
	storagePath := filepath.Join(t.TempDir(), "repos")
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "token")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "callback-token")
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", storagePath)

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}
	if cfg.FFILibraryPath != libPath {
		t.Fatalf("FFILibraryPath = %q, want %q", cfg.FFILibraryPath, libPath)
	}
	if cfg.Observability.TraceSampleRate != defaultTraceSampleRate {
		t.Fatalf("TraceSampleRate = %v, want %v", cfg.Observability.TraceSampleRate, defaultTraceSampleRate)
	}
}

func TestConfig_Cov_LoadConfigReportsDetectFFILibraryPathError(t *testing.T) {
	configCovClearEnv(t)
	t.Chdir(t.TempDir())
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "token")
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "callback-token")
	t.Setenv("SMITHERS_REPO_STORAGE_PATH", filepath.Join(t.TempDir(), "repos"))

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected FFI detection error")
	}
	if !strings.Contains(err.Error(), "SMITHERS_FFI_LIBRARY_PATH must be set") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfig_Cov_DetectFFILibraryPathReportsMissingLibrary(t *testing.T) {
	configCovClearEnv(t)
	t.Chdir(t.TempDir())

	_, err := detectFFILibraryPath()
	if err == nil {
		t.Fatal("expected missing FFI library error")
	}
	if !strings.Contains(err.Error(), "SMITHERS_FFI_LIBRARY_PATH must be set") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfig_Cov_DetectFFILibraryPathFindsTargetDebugLibrary(t *testing.T) {
	configCovClearEnv(t)
	t.Chdir(t.TempDir())
	libPath := configCovCreateDetectedFFILibrary(t)

	got, err := detectFFILibraryPath()
	if err != nil {
		t.Fatalf("detectFFILibraryPath returned error: %v", err)
	}
	if got != libPath {
		t.Fatalf("detectFFILibraryPath = %q, want %q", got, libPath)
	}
}

func TestConfig_Cov_FFILibraryExtMatchesRuntime(t *testing.T) {
	got := ffiLibraryExt()
	switch runtime.GOOS {
	case "darwin":
		if got != "dylib" {
			t.Fatalf("ffiLibraryExt = %q, want dylib", got)
		}
	case "windows":
		if got != "dll" {
			t.Fatalf("ffiLibraryExt = %q, want dll", got)
		}
	default:
		if got != "so" {
			t.Fatalf("ffiLibraryExt = %q, want so", got)
		}
	}
}

func configCovClearEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"SMITHERS_REPO_STORAGE_PATH",
		"SMITHERS_REPO_HOST_ADDR",
		"SMITHERS_REPO_HOST_AUTH_TOKEN",
		"REPO_HOST_AUTH_TOKEN",
		"SMITHERS_PUSH_HOOK_CALLBACK_URL",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN",
		"SMITHERS_FFI_LIBRARY_PATH",
		"SMITHERS_CLOUD_TRACE_PROJECT_ID",
		"SMITHERS_TRACE_SAMPLE_RATE",
		"SMITHERS_OTEL_EXPORTER",
		"SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT",
	} {
		t.Setenv(key, "")
	}
}

func configCovCreateDetectedFFILibrary(t *testing.T) string {
	t.Helper()
	libPath := filepath.Join("target", "debug", "libsmithers_ffi."+ffiLibraryExt())
	if err := os.MkdirAll(filepath.Dir(libPath), 0o755); err != nil {
		t.Fatalf("mkdir fake FFI dir: %v", err)
	}
	if err := os.WriteFile(libPath, []byte("fake"), 0o644); err != nil {
		t.Fatalf("write fake FFI library: %v", err)
	}
	abs, err := filepath.Abs(libPath)
	if err != nil {
		t.Fatalf("abs fake FFI path: %v", err)
	}
	return filepath.Clean(abs)
}
