package smitherscli

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

	incur "github.com/smithersai/incur"
)

const defaultWorkspaceCopyTimeout = 600 * time.Second

// workspaceCopyEndpoint is one side of `workspace cp`.
type workspaceCopyEndpoint struct {
	Remote      bool
	WorkspaceID string
	Path        string
}

// parseWorkspaceCopyEndpoint reads `<workspace-id>:<path>`, `ws:<path>` or
// `:<path>` as remote and everything else as local. A Windows drive letter
// (`C:\x`) is local.
func parseWorkspaceCopyEndpoint(raw string) workspaceCopyEndpoint {
	id, rest, ok := strings.Cut(raw, ":")
	if !ok || strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, ".") || len(id) == 1 {
		return workspaceCopyEndpoint{Path: raw}
	}
	if id == "ws" {
		id = ""
	}
	return workspaceCopyEndpoint{Remote: true, WorkspaceID: id, Path: rest}
}

func parseWorkspaceCopyArgs(src, dst string) (from, to workspaceCopyEndpoint, err error) {
	from, to = parseWorkspaceCopyEndpoint(src), parseWorkspaceCopyEndpoint(dst)
	if from.Remote == to.Remote {
		return from, to, fmt.Errorf("exactly one of src and dst must be remote (<workspace-id>:<path>)")
	}
	if strings.TrimSpace(from.Path) == "" || strings.TrimSpace(to.Path) == "" {
		return from, to, fmt.Errorf("src and dst paths are required")
	}
	return from, to, nil
}

// workspaceTarStats counts what crossed the wire.
type workspaceTarStats struct {
	Bytes int64 `json:"bytes"`
	Files int   `json:"files"`
}

// writeLocalTar streams the local file or directory at source into w as a tar
// archive whose top-level entry is named name.
func writeLocalTar(w io.Writer, source, name string) (workspaceTarStats, error) {
	stats := workspaceTarStats{}
	tw := tar.NewWriter(w)
	info, err := os.Lstat(source)
	if err != nil {
		return stats, err
	}
	add := func(fsPath, rel string, info os.FileInfo) error {
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			if link, err = os.Readlink(fsPath); err != nil {
				return err
			}
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		header.Name = rel
		if info.IsDir() {
			header.Name += "/"
		}
		header.Uname, header.Gname = "", ""
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(fsPath)
		if err != nil {
			return err
		}
		defer func() { _ = file.Close() }()
		n, err := io.Copy(tw, file)
		stats.Bytes += n
		stats.Files++
		return err
	}
	if !info.IsDir() {
		if err := add(source, name, info); err != nil {
			return stats, err
		}
		return stats, tw.Close()
	}
	err = filepath.Walk(source, func(fsPath string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, fsPath)
		if err != nil {
			return err
		}
		if rel == "." {
			rel = name
		} else {
			rel = path.Join(name, filepath.ToSlash(rel))
		}
		return add(fsPath, rel, info)
	})
	if err != nil {
		return stats, err
	}
	return stats, tw.Close()
}

// readLocalTar extracts a tar stream under dest. The stream comes from the
// workspace, which the user does not control, so every write goes through an
// os.Root on dest: neither a "../" entry name nor a symlink created earlier in
// the archive can place a file outside dest.
func readLocalTar(r io.Reader, dest string) (workspaceTarStats, error) {
	stats := workspaceTarStats{}
	abs, err := filepath.Abs(dest)
	if err != nil {
		return stats, err
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return stats, err
	}
	defer func() { _ = root.Close() }()
	tr := tar.NewReader(r)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return stats, nil
		}
		if err != nil {
			return stats, err
		}
		target := filepath.Join(abs, filepath.FromSlash(header.Name))
		if target != abs && !strings.HasPrefix(target, abs+string(filepath.Separator)) {
			return stats, fmt.Errorf("archive entry %q escapes %s", header.Name, dest)
		}
		name, err := filepath.Rel(abs, target)
		if err != nil {
			return stats, err
		}
		if err := extractTarEntry(root, name, header, tr, &stats); err != nil {
			return stats, fmt.Errorf("archive entry %q: %w", header.Name, err)
		}
	}
}

func extractTarEntry(root *os.Root, name string, header *tar.Header, body io.Reader, stats *workspaceTarStats) error {
	switch header.Typeflag {
	case tar.TypeDir:
		return root.MkdirAll(name, os.FileMode(header.Mode)&0o777|0o700)
	case tar.TypeReg:
		if err := root.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			return err
		}
		file, err := root.OpenFile(name, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode)&0o777)
		if err != nil {
			return err
		}
		n, err := io.Copy(file, body)
		_ = file.Close()
		if err != nil {
			return err
		}
		stats.Bytes += n
		stats.Files++
	case tar.TypeSymlink:
		if err := root.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			return err
		}
		_ = root.Remove(name)
		return root.Symlink(header.Linkname, name)
	}
	return nil
}

// buildWorkspaceUploadScript receives a tar stream on stdin whose top-level
// entry is named from. tar -o makes the extracting user own the files instead
// of the archive's uid (root uploads would otherwise leave the sender's uid).
// It lands at dst with docker-cp semantics: into dst
// when dst is an existing directory or ends with "/", otherwise dst replaces
// whatever was there. contents=true means the archive holds "./..." entries
// that are unpacked directly inside dst.
func buildWorkspaceUploadScript(dst, from string, contents bool) string {
	clean := path.Clean(dst)
	parent, _ := path.Split(clean)
	if parent == "" {
		parent = "."
	}
	guard := "command -v tar >/dev/null 2>&1 || { echo 'workspace image has no tar' >&2; exit 43; }; "
	if contents || strings.HasSuffix(dst, "/") {
		return guard + "mkdir -p " + shellEscape(clean) + " && tar -o -xf - -C " + shellEscape(clean)
	}
	// Unpack into a scratch directory first: when from equals the basename of
	// dst, extracting straight into parent would create dst and then delete it.
	return guard + "if [ -d " + shellEscape(clean) + " ]; then tar -o -xf - -C " + shellEscape(clean) + "; " +
		"else mkdir -p " + shellEscape(parent) + " && t=$(mktemp -d " + shellEscape(path.Join(parent, ".smithers-cp.XXXXXX")) + ")" +
		" && tar -o -xf - -C \"$t\" && rm -rf " + shellEscape(clean) + " && mv \"$t/\"" + shellEscape(from) + " " + shellEscape(clean) + "; rc=$?; rm -rf \"$t\"; exit $rc; fi"
}

// buildWorkspaceDownloadScript streams the remote file or directory as a tar
// archive on stdout; contents=true streams the directory's entries as "./...".
func buildWorkspaceDownloadScript(remotePath string, contents bool) string {
	clean := path.Clean(remotePath)
	guard := "command -v tar >/dev/null 2>&1 || { echo 'workspace image has no tar' >&2; exit 43; }; " +
		"test -e " + shellEscape(clean) + " || { echo " + shellEscape(clean+": no such file or directory") + " >&2; exit 44; }; "
	if contents {
		return guard + "tar -cf - -C " + shellEscape(clean) + " ."
	}
	parent, name := path.Split(clean)
	if parent == "" {
		parent = "."
	}
	return guard + "tar -cf - -C " + shellEscape(parent) + " " + shellEscape(name)
}

// splitContentsPath strips a docker-cp style "/." suffix, which means "the
// directory's contents" rather than the directory itself.
func splitContentsPath(p string) (string, bool) {
	if strings.HasSuffix(p, "/.") && len(p) > 2 {
		return strings.TrimSuffix(p, "/."), true
	}
	return p, false
}

func workspaceCopyError(code int, stderr string) error {
	message := strings.TrimSpace(stderr)
	switch code {
	case 43:
		return incur.NewIncurError(incur.IncurErrorOptions{Code: "WORKSPACE_TAR_UNAVAILABLE", Message: "the workspace image has no tar; install tar to use workspace cp", ExitCode: code})
	case 44:
		if message == "" {
			message = "remote path not found"
		}
		return incur.NewIncurError(incur.IncurErrorOptions{Code: "WORKSPACE_PATH_NOT_FOUND", Message: message, ExitCode: code})
	}
	if message == "" {
		message = fmt.Sprintf("remote copy exited with code %d", code)
	}
	return incur.NewIncurError(incur.IncurErrorOptions{Code: "WORKSPACE_COPY_FAILED", Message: message, ExitCode: code})
}

// runWorkspaceCopy performs one `workspace cp` transfer over SSH.
func runWorkspaceCopy(sshCommand string, from, to workspaceCopyEndpoint, timeout time.Duration) (workspaceTarStats, error) {
	if from.Remote {
		return runWorkspaceDownload(sshCommand, from.Path, to.Path, timeout)
	}
	return runWorkspaceUpload(sshCommand, from.Path, to.Path, timeout)
}

func runWorkspaceDownload(sshCommand, remotePath, localPath string, timeout time.Duration) (workspaceTarStats, error) {
	remotePath, contents := splitContentsPath(remotePath)
	_, name := path.Split(path.Clean(remotePath))
	dest, rename := localPath, ""
	if info, err := os.Stat(localPath); contents || strings.HasSuffix(localPath, "/") || (err == nil && info.IsDir()) {
		dest = localPath
	} else {
		dest, rename = filepath.Dir(localPath), filepath.Base(localPath)
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return workspaceTarStats{}, err
	}
	reader, writer := io.Pipe()
	var stats workspaceTarStats
	var extractErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		stats, extractErr = readLocalTar(reader, dest)
		_, _ = io.Copy(io.Discard, reader)
	}()
	var stderr bytes.Buffer
	code, err := runRemoteStreamedCommandIO(sshCommand, buildWorkspaceDownloadScript(remotePath, contents), timeout, nil, writer, &stderr)
	_ = writer.Close()
	<-done
	if err != nil {
		return stats, err
	}
	if code != 0 {
		return stats, workspaceCopyError(code, stderr.String())
	}
	if extractErr != nil {
		return stats, extractErr
	}
	if rename != "" && rename != name {
		target := filepath.Join(dest, rename)
		_ = os.RemoveAll(target)
		if err := os.Rename(filepath.Join(dest, name), target); err != nil {
			return stats, err
		}
	}
	return stats, nil
}

func runWorkspaceUpload(sshCommand, localPath, remotePath string, timeout time.Duration) (workspaceTarStats, error) {
	localPath, contents := splitContentsPath(localPath)
	info, err := os.Lstat(localPath)
	if err != nil {
		return workspaceTarStats{}, err
	}
	if contents && !info.IsDir() {
		return workspaceTarStats{}, fmt.Errorf("%s/. requires a directory", localPath)
	}
	name := filepath.Base(filepath.Clean(localPath))
	if contents {
		name = "."
	}
	reader, writer := io.Pipe()
	var stats workspaceTarStats
	var packErr error
	go func() {
		stats, packErr = writeLocalTar(writer, localPath, name)
		_ = writer.CloseWithError(packErr)
	}()
	var stdout, stderr bytes.Buffer
	code, err := runRemoteStreamedCommandIO(sshCommand, buildWorkspaceUploadScript(remotePath, name, contents), timeout, reader, &stdout, &stderr)
	_ = reader.Close()
	if err != nil {
		return stats, err
	}
	if packErr != nil {
		return stats, packErr
	}
	if code != 0 {
		return stats, workspaceCopyError(code, stderr.String())
	}
	return stats, nil
}

// runRemoteStreamedCommandIO runs a single remote command over BatchMode SSH,
// streaming output to stdout/stderr as it runs (unlike runRemoteShellCommand,
// which buffers into strings.Builder and dumps output only after the command
// exits). It shares the SSH-invocation building block (buildSSHInvocationArgs)
// with runRemoteCaptureCommand/runRemoteInteractiveCommand, but skips their
// marker-based session-script framing (needed there to strip PS1 prompts out
// of an interactive shell) since a single non-interactive remote command can
// propagate its exit code directly through ssh's own exit status. A nil stdin
// means /dev/null.
func runRemoteStreamedCommandIO(sshCommand, script string, timeout time.Duration, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	sshArgs, err := buildSSHInvocationArgs(sshCommand, false)
	if err != nil {
		return -1, err
	}
	if len(sshArgs) == 0 {
		return -1, fmt.Errorf("workspace ssh command was empty")
	}
	args := append(append([]string{}, sshArgs...), script)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var expire <-chan time.Time
	if timeout > 0 {
		expire = time.After(timeout)
	}
	select {
	case err := <-done:
		if err == nil {
			return 0, nil
		}
		if code, ok := workspaceExitErrorCode(err); ok {
			return code, nil
		}
		return -1, err
	case <-expire:
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done
		seconds := int((timeout + time.Second - 1) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		return -1, fmt.Errorf("workspace exec timed out after %ds", seconds)
	}
}
