package repohostserver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

var streamGitCommandContext = exec.CommandContext

// gitRPCIdleTimeout bounds how long a git smart-HTTP RPC waits on a stalled
// peer. Every request-body read and response write arms a fresh connection
// deadline, so long transfers that keep moving bytes are unaffected while a
// wedged or malicious client is cut off after one idle interval instead of
// holding the repository lock and a git subprocess until TCP gives up.
// Variable so tests can shorten it.
var gitRPCIdleTimeout = 60 * time.Second

// idleDeadlineBody wraps a git RPC request body so each read arms a fresh
// connection read deadline. Deadline errors are deliberately ignored: writers
// that do not support deadlines (e.g. httptest recorders) degrade to the
// previous unbounded behavior instead of failing the request.
type idleDeadlineBody struct {
	rc *http.ResponseController
	r  io.Reader
}

func (b *idleDeadlineBody) Read(p []byte) (int, error) {
	_ = b.rc.SetReadDeadline(time.Now().Add(gitRPCIdleTimeout))
	return b.r.Read(p)
}

// idleDeadlineWriter is the response-side counterpart of idleDeadlineBody:
// each write arms a fresh connection write deadline so a client that stops
// draining a streamed packfile cannot pin the handler forever.
type idleDeadlineWriter struct {
	rc *http.ResponseController
	w  io.Writer
}

func (d *idleDeadlineWriter) Write(p []byte) (int, error) {
	_ = d.rc.SetWriteDeadline(time.Now().Add(gitRPCIdleTimeout))
	return d.w.Write(p)
}

// streamGitRPC runs a git smart-HTTP RPC and streams its stdout directly to dst
// using io.Copy with a 32 KB buffer so large packfiles are never accumulated in
// memory. The function returns once the git subprocess has exited.
func streamGitRPC(ctx context.Context, gitDir, command string, body io.Reader, dst io.Writer) error {
	cmd := streamGitCommandContext(ctx, "git", command, "--stateless-rpc", gitDir)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("open git stdin: %w", err)
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	// Pipe git stdout directly to dst; io.Copy uses a 32 KB internal buffer.
	pr, pw := io.Pipe()
	cmd.Stdout = pw

	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		return fmt.Errorf("start git %s: %w", command, err)
	}

	// Copy stdin in a goroutine so we can drain stdout concurrently.
	copyErrCh := make(chan error, 1)
	go func() {
		var copyErr error
		if body != nil {
			_, copyErr = io.Copy(stdin, body)
		}
		closeErr := stdin.Close()
		if copyErr == nil {
			copyErr = closeErr
		}
		copyErrCh <- copyErr
	}()

	// Drain git stdout into dst. We close the write end of the pipe once git
	// exits so that the io.Copy below terminates naturally.
	dstErrCh := make(chan error, 1)
	go func() {
		_, err := io.Copy(dst, pr)
		if err != nil {
			// The destination failed mid-stream (e.g. the HTTP client
			// disconnected). Close the read side so exec's internal stdout
			// copier is not left blocked writing into the pipe — otherwise
			// cmd.Wait() below never returns and the repository lock is held
			// until process restart.
			_ = pr.CloseWithError(err)
		}
		dstErrCh <- err
	}()

	waitErr := cmd.Wait()
	// Signal EOF to the drain goroutine.
	_ = pw.CloseWithError(waitErr)

	dstErr := <-dstErrCh
	copyErr := <-copyErrCh

	if copyErr != nil {
		return fmt.Errorf("stream request body to git %s: %w", command, copyErr)
	}
	if waitErr != nil {
		return fmt.Errorf("git-%s failed: %s", command, strings.TrimSpace(stderr.String()))
	}
	if dstErr != nil {
		return fmt.Errorf("stream git %s output: %w", command, dstErr)
	}
	return nil
}

// runGitRPCBuffered runs a git smart-HTTP RPC and accumulates the entire stdout
// into memory. Use this only when the caller needs the full response before it
// can send a reply (e.g. receive-pack, where jj ref import must happen first).
// For streaming responses prefer streamGitRPC.
func runGitRPCBuffered(ctx context.Context, gitDir, command string, body io.Reader) ([]byte, error) {
	var buf bytes.Buffer
	if err := streamGitRPC(ctx, gitDir, command, body, &buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// validGitObjectID reports whether s is a bare SHA-1 or SHA-256 object id.
//
// Every value listed here is handed straight back to git as a revision
// (`git log ^<oid>`) or as an update-ref target, so a ref whose stored value is
// not an object id must stop the push inspection rather than turn into argv. In
// run 11748 a jj panic (cli/src/cleanup_guard.rs, triggered by the runner
// image's git 2.39.5 being older than the 2.41 jj requires) left a ref holding
// the panic text, and it reached git as `git log '^thread ...panicked at...'`.
func validGitObjectID(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func listGitRefs(ctx context.Context, gitDir string) (map[string]string, error) {
	output, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "for-each-ref", "--format=%(refname)%00%(objectname)").Output()
	if err != nil {
		return nil, fmt.Errorf("list git refs: %w", err)
	}

	refs := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\x00", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("parse git ref listing: malformed line %q", line)
		}
		refName := strings.TrimSpace(parts[0])
		objectID := strings.TrimSpace(parts[1])
		if refName == "" || !validGitObjectID(objectID) {
			return nil, fmt.Errorf("parse git ref listing: malformed line %q", line)
		}
		refs[refName] = objectID
	}
	return refs, nil
}

// setGitDefaultBookmark updates the bare repository's HEAD symref. Git permits
// an unborn target, which is useful while configuring an empty repository; as
// soon as refs/heads/<bookmark> exists, upload-pack advertises both HEAD and
// symref=HEAD:refs/heads/<bookmark>.
func setGitDefaultBookmark(ctx context.Context, gitDir, bookmark string) error {
	ref := "refs/heads/" + bookmark
	output, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "symbolic-ref", "HEAD", ref).CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("set git HEAD to %s: %s", ref, detail)
	}
	return nil
}
