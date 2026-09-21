package smitherscli

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadFileNormalBodySucceeds(t *testing.T) {
	body := "hello world"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "out.txt")
	if err := downloadFile(srv.URL, dest); err != nil {
		t.Fatalf("downloadFile returned error for normal body: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("reading downloaded file: %v", err)
	}
	if string(got) != body {
		t.Fatalf("downloaded content mismatch: got %q, want %q", string(got), body)
	}
}

func TestDownloadFileLimitWithinLimitSucceeds(t *testing.T) {
	body := strings.Repeat("a", 100)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "ok.bin")
	if err := downloadFileLimit(srv.URL, dest, 100); err != nil {
		t.Fatalf("expected success for body equal to limit, got: %v", err)
	}
}

func TestDownloadFileLimitExceedingLimitErrors(t *testing.T) {
	body := strings.Repeat("a", 101)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "big.bin")
	err := downloadFileLimit(srv.URL, dest, 100)
	if err == nil {
		t.Fatalf("expected error for body exceeding limit, got nil")
	}
	if !strings.Contains(err.Error(), "maximum allowed size") {
		t.Fatalf("expected size-limit error, got: %v", err)
	}
}
