package guest

import (
	"context"
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- cappedBuffer -------------------------------------------------------------

func TestCappedBuffer_TruncatesAtCap(t *testing.T) {
	b := &cappedBuffer{max: 4}

	if n, err := b.Write([]byte("ab")); n != 2 || err != nil {
		t.Fatalf("Write = (%d, %v), want (2, nil)", n, err)
	}
	if b.truncated {
		t.Fatal("truncated before cap was reached")
	}

	// Crosses the cap: reports full consumption so the writer keeps draining,
	// but retains only up to max bytes.
	if n, err := b.Write([]byte("cdef")); n != 4 || err != nil {
		t.Fatalf("Write = (%d, %v), want (4, nil)", n, err)
	}
	if got := b.buf.String(); got != "abcd" {
		t.Fatalf("buffered = %q, want %q", got, "abcd")
	}
	if !b.truncated {
		t.Fatal("truncated = false after crossing the cap")
	}

	// Past the cap: nothing more is retained.
	if n, err := b.Write([]byte("gh")); n != 2 || err != nil {
		t.Fatalf("Write = (%d, %v), want (2, nil)", n, err)
	}
	if got := b.buf.String(); got != "abcd" {
		t.Fatalf("buffered = %q, want %q", got, "abcd")
	}
}

// --- handleExec caps and cancellation ------------------------------------------

// Issue: Exec buffered unbounded command output in memory (VM OOM). The
// handler must cap each stream and flag the truncation.
func TestHandleExec_TruncatesOversizedOutput(t *testing.T) {
	h := NewHandler(time.Hour)
	resp, err := h.handleExec(context.Background(), &ExecRequest{
		// One byte over the per-stream cap.
		Command: []string{"sh", "-c", "head -c 8388609 /dev/zero | tr '\\000' 'a'"},
	})
	if err != nil {
		t.Fatalf("handleExec: %v", err)
	}
	if len(resp.Stdout) != maxExecOutputBytes {
		t.Fatalf("len(Stdout) = %d, want %d", len(resp.Stdout), maxExecOutputBytes)
	}
	if !resp.StdoutTruncated {
		t.Fatal("StdoutTruncated = false, want true")
	}
	if resp.StderrTruncated {
		t.Fatal("StderrTruncated = true, want false")
	}
}

// Issue: Exec kept running after the caller was gone. A request-supplied
// timeout must kill the command (and its process group) promptly.
func TestHandleExec_TimeoutKillsCommand(t *testing.T) {
	h := NewHandler(time.Hour)
	start := time.Now()
	_, err := h.handleExec(context.Background(), &ExecRequest{
		Command:    []string{"sleep", "30"},
		TimeoutSec: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "exec canceled") {
		t.Fatalf("err = %v, want exec canceled", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("exec took %v to be killed, want ~1s", elapsed)
	}
}

// Context cancellation (connection closed, host gone) must also kill the
// command instead of letting it run to completion.
func TestHandleExec_ContextCancelKillsCommand(t *testing.T) {
	h := NewHandler(time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := h.handleExec(ctx, &ExecRequest{Command: []string{"sleep", "30"}})
	if err == nil || !strings.Contains(err.Error(), "exec canceled") {
		t.Fatalf("err = %v, want exec canceled", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("exec took %v to be killed, want ~100ms", elapsed)
	}
}

// --- handleReadFile cap ---------------------------------------------------------

// Issue: ReadFile buffered unbounded files into memory. Files over the cap
// must be rejected instead of buffered and marshaled.
func TestHandleReadFile_RejectsOversizedFile(t *testing.T) {
	h := NewHandler(time.Hour)
	path := filepath.Join(t.TempDir(), "huge")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Sparse file one byte over the cap; reads as zeros without writing 32 MiB.
	if err := f.Truncate(maxReadFileBytes + 1); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	_, err = h.handleReadFile(&ReadFileRequest{Path: path})
	if err == nil || !strings.Contains(err.Error(), "read limit") {
		t.Fatalf("err = %v, want read limit error", err)
	}
}

// --- handleTailJournal caps -----------------------------------------------------

// Issue: TailJournal passed a caller-controlled line count straight to
// journalctl and buffered unbounded output. The line count must be clamped.
func TestHandleTailJournal_ClampsLineCount(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "journalctl.args")
	handlerCovSetPathWithCommands(t, map[string]string{
		"journalctl": `printf '%s\n' "$@" > "$LIMITS_JOURNALCTL_ARGS"
printf 'line-1\nline-2\n'
`,
	})
	t.Setenv("LIMITS_JOURNALCTL_ARGS", argsFile)

	h := NewHandler(time.Hour)
	resp, err := h.handleTailJournal(context.Background(), &TailJournalRequest{
		Unit:  "limits.service",
		Lines: 1 << 30,
	})
	if err != nil {
		t.Fatalf("handleTailJournal: %v", err)
	}
	if len(resp.Lines) != 2 {
		t.Fatalf("Lines = %v, want 2 entries", resp.Lines)
	}

	args := handlerCovReadTrimmed(t, argsFile)
	if !strings.Contains("\n"+args+"\n", "\n5000\n") {
		t.Fatalf("journalctl args %q missing clamped -n 5000", args)
	}
}

// Oversized journal output must be cut at the byte cap and flagged, with the
// possibly-mangled final line dropped.
func TestHandleTailJournal_TruncatesOversizedOutput(t *testing.T) {
	handlerCovSetPathWithCommands(t, map[string]string{
		// Exactly the cap as one giant line, plus a marker line that lands
		// past the cap. PATH is restricted to the shim dir, so restore the
		// system dirs for head/tr.
		"journalctl": `PATH=/usr/bin:/bin
head -c 4194304 /dev/zero | tr '\000' 'a'
printf '\nfinal-line\n'
`,
	})

	h := NewHandler(time.Hour)
	resp, err := h.handleTailJournal(context.Background(), &TailJournalRequest{
		Unit: "limits.service",
	})
	if err != nil {
		t.Fatalf("handleTailJournal: %v", err)
	}
	if !resp.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	for _, line := range resp.Lines {
		if line == "final-line" {
			t.Fatal("final-line survived truncation, expected it to be cut")
		}
	}
}

// --- persistent unit file permissions --------------------------------------------

// Issue: unit files carrying Environment= secrets were written world-readable
// (0644). They must be root-only.
func TestHandleCreatePersistentUnit_UnitFileNotWorldReadable(t *testing.T) {
	unitDir := handlerHWithSystemdUnitPath(t)
	handlerHInstallSystemctl(t)

	h := NewHandler(time.Hour)
	_, err := h.handleCreatePersistentUnit(context.Background(), &CreatePersistentUnitRequest{
		Name: "limits-perms",
		Exec: []string{"/bin/true"},
		Env:  map[string]string{"SMITHERS_AGENT_TOKEN": "secret"},
	})
	if err != nil {
		t.Fatalf("handleCreatePersistentUnit: %v", err)
	}

	info, err := os.Stat(filepath.Join(unitDir, "limits-perms.service"))
	if err != nil {
		t.Fatalf("stat unit file: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("unit file mode = %o, want 0600", got)
	}
}

// --- wire framing under a stalling peer -------------------------------------------

// Issue: a peer could claim a 64 MiB frame, send nothing, and pin the buffer
// and goroutine forever. With a body deadline the read must fail once the
// peer stalls.
func TestReadMessageConn_StalledBodyTimesOut(t *testing.T) {
	hostConn, guestConn := net.Pipe()
	defer hostConn.Close()
	defer guestConn.Close()

	go func() {
		var prefix [4]byte
		binary.BigEndian.PutUint32(prefix[:], maxMessageSize)
		_, _ = hostConn.Write(prefix[:])
		// Stall: never deliver the body.
	}()

	var msg Request
	start := time.Now()
	err := ReadMessageConn(guestConn, &msg, 100*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "read message payload") {
		t.Fatalf("err = %v, want read message payload timeout", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("stalled read took %v to fail, want ~100ms", elapsed)
	}
}

// --- client authentication ----------------------------------------------------------

// The host client must present the configured control-plane token before the
// Hello probe, since a token-enforcing guest rejects everything else first.
func TestClient_SetAuthToken_AuthenticatesBeforeHello(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()

	const token = "vm-secret"
	var methods []string
	go func() {
		defer sConn.Close()
		for {
			var req Request
			if err := ReadMessage(sConn, &req); err != nil {
				return
			}
			methods = append(methods, req.Method)
			resp := Response{ID: req.ID}
			switch req.Method {
			case MethodAuthenticate:
				var p AuthenticateRequest
				if err := unmarshalParams(req.Params, &p); err != nil || p.Token != token {
					resp.Error = "invalid auth token"
					resp.ErrorCode = ErrorCodeUnauthenticated
				} else {
					resp.Result = MarshalResult(AuthenticateResponse{Authenticated: true})
				}
			case MethodHello:
				resp.Result = MarshalResult(HelloResponse{
					ProtocolVersion:      ProtocolVersion,
					MinCompatibleVersion: MinCompatibleVersion,
					GuestAgentVersion:    "auth-test",
					Capabilities:         CurrentCapabilities(),
				})
			default:
				resp.Error = "unknown method: " + req.Method
				resp.ErrorCode = ErrorCodeUnknownMethod
			}
			if err := WriteMessage(sConn, &resp); err != nil {
				return
			}
		}
	}()

	c := newTestClient(t, cConn)
	c.SetAuthToken(token)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	if len(methods) < 2 || methods[0] != MethodAuthenticate || methods[1] != MethodHello {
		t.Fatalf("wire method order = %v, want [Authenticate Hello ...]", methods)
	}
}

// A rejected token surfaces as a Negotiate failure instead of proceeding to
// Hello on a connection the guest is about to drop.
func TestClient_SetAuthToken_RejectedTokenFailsNegotiate(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()

	go func() {
		defer sConn.Close()
		var req Request
		if err := ReadMessage(sConn, &req); err != nil {
			return
		}
		_ = WriteMessage(sConn, &Response{
			ID:        req.ID,
			Error:     "invalid auth token",
			ErrorCode: ErrorCodeUnauthenticated,
		})
	}()

	c := newTestClient(t, cConn)
	c.SetAuthToken("wrong")
	err := c.Negotiate(ctx)
	if err == nil || !strings.Contains(err.Error(), "authenticate") {
		t.Fatalf("Negotiate err = %v, want authenticate failure", err)
	}
}
