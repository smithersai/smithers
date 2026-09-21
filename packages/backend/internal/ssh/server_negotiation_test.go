package ssh

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// lockedSession is a testSession whose stdout is safe to read while the
// client goroutine is still writing stdin.
type lockedSession struct {
	*testSession
	mu  sync.Mutex
	out bytes.Buffer
}

func (s *lockedSession) Read(p []byte) (int, error) { return s.testSession.stdin.Read(p) }
func (s *lockedSession) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.out.Write(p)
}
func (s *lockedSession) stdoutString() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.out.String()
}

func pkt(line string) string { return fmt.Sprintf("%04x%s", len(line)+4, line) }

// A stateful SSH fetch client pipelines two have batches (16, then 32) and
// then blocks until upload-pack answers with ACK/NAK. The bridge must answer
// each flushed batch before the client will ever send "done".
func TestProxyUploadPack_AnswersHaveBatchesBeforeDone(t *testing.T) {
	t.Parallel()

	oid := func(i int) string { return strings.Repeat("a", 38) + fmt.Sprintf("%02x", 0x10+i) }
	var haves strings.Builder
	for i := 0; i < 32; i++ {
		haves.WriteString(pkt("have " + oid(i) + "\n"))
		if i == 15 {
			haves.WriteString("0000")
		}
	}
	firstChunk := pkt("want "+oid(99)+"\n") + "0000" + haves.String() + "0000"

	var bodies []string
	server := &Server{RepoHostClient: &mockRepoHostGitProxy{
		infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
			return []byte("0000"), nil
		},
		proxyUploadPackBodyFn: func(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
			raw, err := io.ReadAll(body)
			require.NoError(t, err)
			bodies = append(bodies, string(raw))
			if strings.Contains(string(raw), "done\n") {
				_, err = io.WriteString(stdout, pkt("ACK "+oid(0)+"\n")+"PACK")
				return err
			}
			// repo-host re-acknowledges every replayed have each round.
			_, err = io.WriteString(stdout, pkt("ACK "+oid(0)+" common\n")+pkt("NAK\n"))
			return err
		},
	}}

	stdinR, stdinW := io.Pipe()
	sess := &lockedSession{testSession: newTestSessionWithReader("git-upload-pack 'alice/demo.git'", stdinR)}
	go func() {
		_, _ = io.WriteString(stdinW, firstChunk)
		deadline := time.Now().Add(5 * time.Second)
		for !strings.Contains(sess.stdoutString(), "NAK") {
			if time.Now().After(deadline) {
				_ = stdinW.CloseWithError(fmt.Errorf("client never got an ACK/NAK for its haves"))
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		_, _ = io.WriteString(stdinW, pkt("done\n"))
		_ = stdinW.Close()
	}()

	require.NoError(t, server.proxyUploadPack(context.Background(), sess, "alice", "demo"))

	require.Len(t, bodies, 3)
	assert.Equal(t, 16, strings.Count(bodies[0], "have "))
	assert.True(t, strings.HasSuffix(bodies[0], "0000"), "negotiation round ends with a flush")
	assert.Equal(t, 32, strings.Count(bodies[1], "have "))
	assert.Equal(t, 32, strings.Count(bodies[2], "have "))
	assert.True(t, strings.HasSuffix(bodies[2], pkt("done\n")))
	assert.Equal(t, 1, strings.Count(bodies[2], "0000"), "final round carries only the wants flush")
	// Round 1 relays the ACK + NAK; round 2 drops the repeated common ACK; the final round streams through.
	assert.Equal(t, "0000"+pkt("ACK "+oid(0)+" common\n")+pkt("NAK\n")+pkt("NAK\n")+pkt("ACK "+oid(0)+"\n")+"PACK", sess.stdoutString())
}
