package workspace_scripts

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDownloadReleaseUsesGuestProxy(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable")
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl unavailable")
	}
	for _, deny := range []bool{false, true} {
		t.Run(map[bool]string{false: "download", true: "refused"}[deny], func(t *testing.T) {
			var requests atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if deny {
					w.WriteHeader(403)
					return
				}
				switch r.URL.Path {
				case "/release":
					if r.Header.Get("User-Agent") != "smithers-workspace-bootstrap" {
						t.Error("missing release header")
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"assets":[{"name":"jj-x86_64-unknown-linux-musl.tar.gz","browser_download_url":"http://release.invalid/redirect"},{"name":"jj-aarch64-unknown-linux-musl.tar.gz","browser_download_url":"http://release.invalid/redirect"}]}`))
				case "/redirect":
					http.Redirect(w, r, "http://assets.invalid/archive", 302)
				case "/archive":
					_, _ = w.Write([]byte("release archive"))
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer proxy.Close()
			dir := t.TempDir()
			script := filepath.Join(dir, "download.cjs")
			archive := filepath.Join(dir, "release.tar.gz")
			if err := os.WriteFile(script, []byte(DownloadReleaseScript), 0600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("node", script)
			for _, v := range os.Environ() {
				key := strings.ToLower(strings.SplitN(v, "=", 2)[0])
				if !strings.Contains(key, "proxy") && !strings.HasPrefix(key, "smithers_download") && !strings.HasPrefix(key, "smithers_jj_") {
					cmd.Env = append(cmd.Env, v)
				}
			}
			cmd.Env = append(cmd.Env, "http_proxy="+proxy.URL, "HTTP_PROXY="+proxy.URL, "NO_PROXY=", "no_proxy=", "SMITHERS_DOWNLOAD_MODE=jj", "SMITHERS_JJ_RELEASE_API_URL=http://release.invalid/release", "SMITHERS_JJ_ARCHIVE="+archive)
			out, err := cmd.CombinedOutput()
			if (err != nil) != deny {
				t.Fatalf("deny=%v error=%v: %s", deny, err, out)
			}
			if requests.Load() == 0 {
				t.Fatal("download bypassed guest proxy")
			}
			if !deny {
				body, err := os.ReadFile(archive)
				if err != nil || string(body) != "release archive" {
					t.Fatalf("archive=%q err=%v", body, err)
				}
			}
		})
	}
}
