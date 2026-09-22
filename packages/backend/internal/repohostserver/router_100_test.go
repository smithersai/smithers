package repohostserver

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

type routerHLoadableFFI struct {
	*mockFFI
	loadErr error
}

func (f routerHLoadableFFI) Load() error {
	return f.loadErr
}

func TestRouter_H_NewUsesLoadedFFIClient(t *testing.T) {
	original := newRawFFIClient
	var gotPath string
	newRawFFIClient = func(path string) loadableFFIClient {
		gotPath = path
		return routerHLoadableFFI{mockFFI: &mockFFI{}}
	}
	t.Cleanup(func() { newRawFFIClient = original })

	cfg := Config{
		StoragePath:         t.TempDir(),
		AuthToken:           testAuthToken,
		FFILibraryPath:      filepath.Join(t.TempDir(), "libsmithers_ffi.test"),
		ListenAddr:          "127.0.0.1:0",
		PushHookCallbackURL: "",
	}
	srv, err := New(cfg)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if srv == nil {
		t.Fatal("New returned nil server")
	}
	if gotPath != cfg.FFILibraryPath {
		t.Fatalf("FFI path = %q, want %q", gotPath, cfg.FFILibraryPath)
	}
}

func TestRouter_H_NewWithFFIReportsMetricsError(t *testing.T) {
	original := newMetricsForServer
	wantErr := errors.New("metrics failed")
	newMetricsForServer = func() (*Metrics, error) {
		return nil, wantErr
	}
	t.Cleanup(func() { newMetricsForServer = original })

	_, err := NewWithFFI(Config{AuthToken: "test-token"}, &mockFFI{})
	if !errors.Is(err, wantErr) {
		t.Fatalf("NewWithFFI error = %v, want %v", err, wantErr)
	}
}

func TestRouter_H_CopyDirReportsRelError(t *testing.T) {
	original := copyDirRel
	copyDirRel = func(basepath, targpath string) (string, error) {
		return "", errors.New("rel failed")
	}
	t.Cleanup(func() { copyDirRel = original })

	err := copyDir(t.TempDir(), filepath.Join(t.TempDir(), "dst"))
	if err == nil {
		t.Fatal("expected rel error")
	}
	if !strings.Contains(err.Error(), "rel failed") {
		t.Fatalf("unexpected error: %v", err)
	}
}
