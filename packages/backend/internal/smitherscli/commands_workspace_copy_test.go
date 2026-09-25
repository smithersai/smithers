package smitherscli

import (
	"archive/tar"
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

func TestWorkspaceCopyCommandUsesSelectedGuest(t *testing.T) {
	sshCommand := commandsWorkspaceRemoteInstallFakeSSH(t)
	var sshPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sshPath = r.URL.String()
		_, _ = w.Write([]byte(`{"ssh_command":` + fmt.Sprintf("%q", sshCommand) + `}`))
	}))
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)
	src := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(src, []byte("copy me"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := workspaceCommand().ServeWithOptions([]string{"cp", src, "ws-1:/tmp/file.txt", "--repo", "alice/demo", "--user", "root", "--json"}, incur.ServeOptions{Stdout: &out}); err != nil {
		t.Fatal(err)
	}
	if sshPath != "/api/repos/alice/demo/workspaces/ws-1/ssh?user=root" {
		t.Fatalf("SSH request = %q", sshPath)
	}
	if !strings.Contains(out.String(), `"files": 1`) {
		t.Fatalf("copy output = %q", out.String())
	}
}

func TestParseWorkspaceCopyArgs(t *testing.T) {
	t.Parallel()
	from, to, err := parseWorkspaceCopyArgs("./solution", "abc-123:/solution")
	if err != nil || from.Remote || from.Path != "./solution" || !to.Remote || to.WorkspaceID != "abc-123" || to.Path != "/solution" {
		t.Fatalf("upload = %#v %#v %v", from, to, err)
	}
	from, to, err = parseWorkspaceCopyArgs("ws:/logs/verifier/.", "out/")
	if err != nil || !from.Remote || from.WorkspaceID != "" || from.Path != "/logs/verifier/." || to.Remote {
		t.Fatalf("download ws: = %#v %#v %v", from, to, err)
	}
	from, _, err = parseWorkspaceCopyArgs(":/tmp/x", "/tmp/y")
	if err != nil || !from.Remote || from.WorkspaceID != "" {
		t.Fatalf("download : = %#v %v", from, err)
	}
	if _, _, err = parseWorkspaceCopyArgs("./a", "./b"); err == nil {
		t.Fatal("two local sides accepted")
	}
	if _, _, err = parseWorkspaceCopyArgs("ws:/a", "id:/b"); err == nil {
		t.Fatal("two remote sides accepted")
	}
	if _, _, err = parseWorkspaceCopyArgs("ws:", "./b"); err == nil {
		t.Fatal("empty remote path accepted")
	}
	if ep := parseWorkspaceCopyEndpoint(`C:\Users\x`); ep.Remote {
		t.Fatalf("drive letter treated as remote: %#v", ep)
	}
	if ep := parseWorkspaceCopyEndpoint("/abs:with:colons"); ep.Remote {
		t.Fatalf("absolute local path treated as remote: %#v", ep)
	}
}

func TestBuildWorkspaceCopyScripts(t *testing.T) {
	t.Parallel()
	guard := "command -v tar >/dev/null 2>&1 || { echo 'workspace image has no tar' >&2; exit 43; }; "
	if got := buildWorkspaceUploadScript("/solution/", "solution", false); got != guard+"mkdir -p '/solution' && tar -o -xf - -C '/solution'" {
		t.Fatalf("trailing slash upload = %q", got)
	}
	if got := buildWorkspaceUploadScript("/solution", ".", true); got != guard+"mkdir -p '/solution' && tar -o -xf - -C '/solution'" {
		t.Fatalf("contents upload = %q", got)
	}
	want := guard + "if [ -d '/x/b' ]; then tar -o -xf - -C '/x/b'; else mkdir -p '/x/' && t=$(mktemp -d '/x/.smithers-cp.XXXXXX') && tar -o -xf - -C \"$t\" && rm -rf '/x/b' && mv \"$t/\"'a' '/x/b'; rc=$?; rm -rf \"$t\"; exit $rc; fi"
	if got := buildWorkspaceUploadScript("/x/b", "a", false); got != want {
		t.Fatalf("rename upload = %q, want %q", got, want)
	}
	download := buildWorkspaceDownloadScript("/logs/verifier", false)
	if !strings.HasSuffix(download, "tar -cf - -C '/logs/' 'verifier'") || !strings.Contains(download, "test -e '/logs/verifier'") {
		t.Fatalf("download script = %q", download)
	}
	if got := buildWorkspaceDownloadScript("/logs/verifier/", true); !strings.HasSuffix(got, "tar -cf - -C '/logs/verifier' .") {
		t.Fatalf("contents download = %q", got)
	}
	if p, contents := splitContentsPath("/a/b/."); p != "/a/b" || !contents {
		t.Fatalf("splitContentsPath = %q %v", p, contents)
	}
	if p, contents := splitContentsPath("/."); p != "/." || contents {
		t.Fatalf("splitContentsPath root = %q %v", p, contents)
	}
	if err := workspaceCopyError(43, ""); err == nil || !strings.Contains(err.Error(), "no tar") {
		t.Fatalf("tar error = %v", err)
	}
	if err := workspaceCopyError(44, "/x: no such file"); err == nil || !strings.Contains(err.Error(), "/x: no such file") {
		t.Fatalf("not found error = %v", err)
	}
}

func TestLocalTarRoundTrip(t *testing.T) {
	t.Parallel()
	src := filepath.Join(t.TempDir(), "solution")
	if err := os.MkdirAll(filepath.Join(src, "files", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	big := bytes.Repeat([]byte("0123456789abcdef"), 1<<17) // 2 MiB
	if err := os.WriteFile(filepath.Join(src, "big.bin"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "solve.sh"), []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "files", "deep", "x.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("solve.sh", filepath.Join(src, "link")); err != nil {
		t.Fatal(err)
	}

	var archive bytes.Buffer
	stats, err := writeLocalTar(&archive, src, "solution")
	if err != nil || stats.Files != 3 || stats.Bytes != int64(len(big))+18+1 {
		t.Fatalf("writeLocalTar = %#v, %v", stats, err)
	}
	dest := t.TempDir()
	stats, err = readLocalTar(bytes.NewReader(archive.Bytes()), dest, "")
	if err != nil || stats.Files != 3 {
		t.Fatalf("readLocalTar = %#v, %v", stats, err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "solution", "big.bin"))
	if err != nil || !bytes.Equal(got, big) {
		t.Fatalf("big.bin round trip failed: %v", err)
	}
	info, err := os.Stat(filepath.Join(dest, "solution", "solve.sh"))
	if err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("solve.sh mode = %v, %v", info, err)
	}
	if target, err := os.Readlink(filepath.Join(dest, "solution", "link")); err != nil || target != "solve.sh" {
		t.Fatalf("symlink = %q, %v", target, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "solution", "files", "deep", "x.txt")); err != nil {
		t.Fatal(err)
	}

	// Contents mode: entries are "./..." and land directly in dest.
	archive.Reset()
	if _, err := writeLocalTar(&archive, src, "."); err != nil {
		t.Fatal(err)
	}
	dest = t.TempDir()
	if _, err := readLocalTar(bytes.NewReader(archive.Bytes()), dest, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "solve.sh")); err != nil {
		t.Fatalf("contents mode did not place solve.sh at top level: %v", err)
	}

	// A single file archives under its given name.
	archive.Reset()
	if stats, err := writeLocalTar(&archive, filepath.Join(src, "solve.sh"), "renamed.sh"); err != nil || stats.Files != 1 {
		t.Fatalf("single file = %#v, %v", stats, err)
	}
	dest = t.TempDir()
	if _, err := readLocalTar(bytes.NewReader(archive.Bytes()), dest, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "renamed.sh")); err != nil {
		t.Fatal(err)
	}

	// Path traversal is refused.
	var evil bytes.Buffer
	evilDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(evilDir, "f"), []byte("f"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := writeLocalTar(&evil, filepath.Join(evilDir, "f"), "../escape"); err != nil {
		t.Fatal(err)
	}
	if _, err := readLocalTar(bytes.NewReader(evil.Bytes()), t.TempDir(), ""); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("traversal accepted: %v", err)
	}
}

// commandsWorkspaceRemoteInstallFakeSSH installs an ssh shim that echoes its
// stdin to stdout, writes a marker to stderr, and exits with the code named in
// the remote script (last argument), so stdin forwarding and separate capture
// can be asserted without a real workspace.
func commandsWorkspaceRemoteInstallFakeSSH(t *testing.T) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
printf 'err-marker\n' >&2
if [ -n "${FAKE_SSH_TAR_FILE:-}" ]; then cat "$FAKE_SSH_TAR_FILE"; exit 0; fi
if [ ! -t 0 ]; then cat; fi
case "$last" in
  *exit-9*) exit 9 ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(binDir, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SMITHERS_WORKSPACE_KNOWN_HOSTS_FILE", filepath.Join(t.TempDir(), "known_hosts"))
	return "ssh msb_test+developer:token@ssh.example.test"
}

func TestRunRemoteStreamedCommandIO_ForwardsStdinAndCapturesSeparately(t *testing.T) {
	sshCommand := commandsWorkspaceRemoteInstallFakeSSH(t)
	var stdout, stderr bytes.Buffer
	code, err := runRemoteStreamedCommandIO(sshCommand, "cat > /tmp/x", 5*time.Second, strings.NewReader("payload-in"), &stdout, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("exec = (%d, %v)", code, err)
	}
	if stdout.String() != "payload-in" || strings.TrimSpace(stderr.String()) != "err-marker" {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	stdout.Reset()
	code, err = runRemoteStreamedCommandIO(sshCommand, "exit-9", 5*time.Second, nil, &stdout, &stderr)
	if err != nil || code != 9 || stdout.Len() != 0 {
		t.Fatalf("nil stdin exec = (%d, %v) stdout=%q", code, err, stdout.String())
	}
}

func TestRunWorkspaceCopy_StreamsTarBothWays(t *testing.T) {
	sshCommand := commandsWorkspaceRemoteInstallFakeSSH(t)
	src := filepath.Join(t.TempDir(), "tests")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("z"), 3<<20)
	if err := os.WriteFile(filepath.Join(src, "blob.bin"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	// Upload: the shim echoes the tar stream back, so the byte count proves the
	// whole archive crossed the pipe.
	stats, err := runWorkspaceCopy(sshCommand, workspaceCopyEndpoint{Path: src}, workspaceCopyEndpoint{Remote: true, Path: "/tests"}, 10*time.Second)
	if err != nil || stats.Files != 1 || stats.Bytes != int64(len(payload)) {
		t.Fatalf("upload = %#v, %v", stats, err)
	}
	// Download: the shim streams a prepared archive on stdout; the local side
	// extracts it, honouring rename and contents modes.
	var archive bytes.Buffer
	if _, err := writeLocalTar(&archive, src, "tests"); err != nil {
		t.Fatal(err)
	}
	tarFile := filepath.Join(t.TempDir(), "remote.tar")
	if err := os.WriteFile(tarFile, archive.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_SSH_TAR_FILE", tarFile)
	dest := filepath.Join(t.TempDir(), "renamed")
	got, err := runWorkspaceCopy(sshCommand, workspaceCopyEndpoint{Remote: true, Path: "/tests"}, workspaceCopyEndpoint{Path: dest}, 10*time.Second)
	if err != nil || got.Files != 1 {
		t.Fatalf("download = %#v, %v", got, err)
	}
	if data, err := os.ReadFile(filepath.Join(dest, "blob.bin")); err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("download rename content mismatch: %v", err)
	}
	into := t.TempDir()
	if _, err := runWorkspaceCopy(sshCommand, workspaceCopyEndpoint{Remote: true, Path: "/tests"}, workspaceCopyEndpoint{Path: into}, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(into, "tests", "blob.bin")); err != nil {
		t.Fatalf("download into existing dir: %v", err)
	}
	archive.Reset()
	if _, err := writeLocalTar(&archive, src, "."); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tarFile, archive.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	contents := filepath.Join(t.TempDir(), "verifier-out")
	if _, err := runWorkspaceCopy(sshCommand, workspaceCopyEndpoint{Remote: true, Path: "/logs/verifier/."}, workspaceCopyEndpoint{Path: contents}, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(contents, "blob.bin")); err != nil {
		t.Fatalf("contents download: %v", err)
	}
	t.Setenv("FAKE_SSH_TAR_FILE", "")
	// Upload in contents mode archives "./..." entries.
	if stats, err := runWorkspaceCopy(sshCommand, workspaceCopyEndpoint{Path: src + "/."}, workspaceCopyEndpoint{Remote: true, Path: "/tests"}, 10*time.Second); err != nil || stats.Files != 1 {
		t.Fatalf("contents upload = %#v, %v", stats, err)
	}
	// Missing local source is a clear error before any SSH call.
	if _, err := runWorkspaceCopy(sshCommand, workspaceCopyEndpoint{Path: filepath.Join(src, "nope")}, workspaceCopyEndpoint{Remote: true, Path: "/x"}, time.Second); err == nil {
		t.Fatal("missing source accepted")
	}
}

// A compromised workspace controls the tar stream a download extracts. A
// symlink entry must not let a later entry write outside the destination.
func TestRunWorkspaceCopy_DownloadRefusesWritesThroughEscapingSymlinks(t *testing.T) {
	sshCommand := commandsWorkspaceRemoteInstallFakeSSH(t)
	type entry struct{ name, link, body string }
	// Layout: <base>/outside is the victim; downloads land in <base>/into/dest.
	cases := map[string]func(outside string) []entry{
		"absolute directory link": func(outside string) []entry {
			return []entry{{name: "tests/evil", link: outside}, {name: "tests/evil/pwned.txt", body: "pwned"}}
		},
		"relative directory link": func(outside string) []entry {
			return []entry{{name: "tests/up", link: "../../../outside"}, {name: "tests/up/pwned.txt", body: "pwned"}}
		},
		"file link overwritten": func(outside string) []entry {
			return []entry{{name: "tests/leaf", link: filepath.Join(outside, "pwned.txt")}, {name: "tests/leaf", body: "pwned"}}
		},
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			outside := filepath.Join(base, "outside")
			into := filepath.Join(base, "into", "dest")
			if err := os.MkdirAll(outside, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(into, 0o755); err != nil {
				t.Fatal(err)
			}
			var archive bytes.Buffer
			tw := tar.NewWriter(&archive)
			for _, e := range build(outside) {
				header := &tar.Header{Name: e.name, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(e.body))}
				if e.link != "" {
					header = &tar.Header{Name: e.name, Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: e.link}
				}
				if err := tw.WriteHeader(header); err != nil {
					t.Fatal(err)
				}
				if _, err := tw.Write([]byte(e.body)); err != nil {
					t.Fatal(err)
				}
			}
			if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			tarFile := filepath.Join(base, "remote.tar")
			if err := os.WriteFile(tarFile, archive.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FAKE_SSH_TAR_FILE", tarFile)
			_, err := runWorkspaceCopy(sshCommand, workspaceCopyEndpoint{Remote: true, Path: "/tests"}, workspaceCopyEndpoint{Path: into}, 10*time.Second)
			if err == nil {
				t.Fatal("download through an escaping symlink succeeded")
			}
			if _, statErr := os.Lstat(filepath.Join(outside, "pwned.txt")); !os.IsNotExist(statErr) {
				t.Fatalf("archive wrote outside the destination: %v (copy err %v)", statErr, err)
			}
		})
	}
}

func tarOf(t *testing.T, headers ...*tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, h := range headers {
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := tw.Write(make([]byte, h.Size)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestReadLocalTarRefusesEntriesOutsideTheRequestedRoot(t *testing.T) {
	dest := t.TempDir()
	archive := tarOf(t,
		&tar.Header{Name: "foo/a", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
		&tar.Header{Name: "sibling", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
	)
	if _, err := readLocalTar(bytes.NewReader(archive), dest, "foo"); err == nil || !strings.Contains(err.Error(), "outside the requested") {
		t.Fatalf("sibling entry accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "sibling")); !os.IsNotExist(err) {
		t.Fatalf("sibling written: %v", err)
	}
}

func TestReadLocalTarExtractsConfinedHardLinks(t *testing.T) {
	dest := t.TempDir()
	archive := tarOf(t,
		&tar.Header{Name: "foo/a", Typeflag: tar.TypeReg, Mode: 0o644, Size: 3},
		&tar.Header{Name: "foo/b", Typeflag: tar.TypeLink, Linkname: "foo/a"},
	)
	stats, err := readLocalTar(bytes.NewReader(archive), dest, "foo")
	if err != nil {
		t.Fatal(err)
	}
	if stats.Files != 2 {
		t.Fatalf("files = %d, want 2", stats.Files)
	}
	a, _ := os.Stat(filepath.Join(dest, "foo", "a"))
	b, err := os.Stat(filepath.Join(dest, "foo", "b"))
	if err != nil || !os.SameFile(a, b) {
		t.Fatalf("hard link not extracted: %v", err)
	}
	escape := tarOf(t, &tar.Header{Name: "foo/c", Typeflag: tar.TypeLink, Linkname: "../outside"})
	if _, err := readLocalTar(bytes.NewReader(escape), t.TempDir(), "foo"); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("escaping hard link accepted: %v", err)
	}
}

func TestReadLocalTarRefusesHardLinksToFilesOutsideTheRoot(t *testing.T) {
	dest := t.TempDir()
	if err := os.WriteFile(filepath.Join(dest, "victim"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	archive := tarOf(t,
		&tar.Header{Name: "foo/x", Typeflag: tar.TypeLink, Linkname: "victim"},
		&tar.Header{Name: "foo/x", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
	)
	if _, err := readLocalTar(bytes.NewReader(archive), dest, "foo"); err == nil || !strings.Contains(err.Error(), "outside the requested") {
		t.Fatalf("link to local file accepted: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "victim")); string(got) != "keep" {
		t.Fatalf("victim changed: %q", got)
	}
}

func TestReadLocalTarAcceptsCurrentDirectoryArchives(t *testing.T) {
	dest := t.TempDir()
	archive := tarOf(t, &tar.Header{Name: "./file", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1})
	if _, err := readLocalTar(bytes.NewReader(archive), dest, "."); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "file")); err != nil {
		t.Fatal(err)
	}
}

func TestReadLocalTarNeverWritesThroughAPlantedSymlink(t *testing.T) {
	dest := t.TempDir()
	if err := os.WriteFile(filepath.Join(dest, "victim"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	archive := tarOf(t,
		&tar.Header{Name: "foo/up", Typeflag: tar.TypeSymlink, Linkname: ".."},
		&tar.Header{Name: "foo/x", Typeflag: tar.TypeLink, Linkname: "foo/up/victim"},
		&tar.Header{Name: "foo/x", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
	)
	if _, err := readLocalTar(bytes.NewReader(archive), dest, "foo"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("write through symlink accepted: %v", err)
	}
	direct := tarOf(t,
		&tar.Header{Name: "foo/up", Typeflag: tar.TypeSymlink, Linkname: ".."},
		&tar.Header{Name: "foo/up/victim", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
	)
	if _, err := readLocalTar(bytes.NewReader(direct), dest, "foo"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("write through symlink parent accepted: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "victim")); string(got) != "keep" {
		t.Fatalf("victim changed: %q", got)
	}
}

func TestReadLocalTarNeverPlacesASymlinkThroughAPlantedSymlink(t *testing.T) {
	dest := t.TempDir()
	if err := os.WriteFile(filepath.Join(dest, "victim"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	archive := tarOf(t,
		&tar.Header{Name: "foo/payload", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
		&tar.Header{Name: "foo/up", Typeflag: tar.TypeSymlink, Linkname: ".."},
		&tar.Header{Name: "foo/up/victim", Typeflag: tar.TypeSymlink, Linkname: "foo/payload"},
	)
	if _, err := readLocalTar(bytes.NewReader(archive), dest, "foo"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlink through symlink accepted: %v", err)
	}
	info, err := os.Lstat(filepath.Join(dest, "victim"))
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("victim replaced: %v", err)
	}
}
