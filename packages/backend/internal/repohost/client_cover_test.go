package repohost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- shared cover helpers (prefixed clientCover to avoid collisions) ---

var (
	errClientCoverResolver = errors.New("clientcover resolver boom")
	errClientCoverWrite    = errors.New("clientcover write boom")
)

// clientCoverErrResolver always fails to resolve, exercising the
// "resolve storage set url" error branch of every method.
type clientCoverErrResolver struct{}

func (clientCoverErrResolver) ResolveURL(ctx context.Context, owner, repo string) (string, error) {
	return "", errClientCoverResolver
}

// clientCoverBadURLResolver resolves to a URL containing a control character.
// ResolveURL succeeds, but http.NewRequestWithContext (or url.Parse) fails on it,
// exercising the request-construction error branches.
type clientCoverBadURLResolver struct{}

func (clientCoverBadURLResolver) ResolveURL(ctx context.Context, owner, repo string) (string, error) {
	return "http://bad\x00host", nil
}

// clientCoverFailWriter always fails writes, exercising io.Copy error branches.
type clientCoverFailWriter struct{}

func (clientCoverFailWriter) Write(p []byte) (int, error) { return 0, errClientCoverWrite }

func clientCoverJSONErrorServer(t *testing.T, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"message":"upstream boom"}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestClient_Cover_ResolverErrorPropagates verifies every resolver-backed method
// wraps a ResolveURL failure with the "resolve storage set url" context and the
// original sentinel error.
func TestClient_Cover_ResolverErrorPropagates(t *testing.T) {
	t.Parallel()

	c := NewClient(clientCoverErrResolver{}, "tok")
	ctx := context.Background()

	calls := []struct {
		name string
		fn   func() error
	}{
		{"InitRepo", func() error { return c.InitRepo(ctx, "o", "r", "main", false) }},
		{"ForkRepo", func() error { return c.ForkRepo(ctx, "o", "r", "o2", "r2") }},
		{"MoveRepo", func() error { return c.MoveRepo(ctx, "o", "r", "o2", "r2") }},
		{"DeleteRepo", func() error { return c.DeleteRepo(ctx, "o", "r") }},
		{"InitWikiRepo", func() error { return c.InitWikiRepo(ctx, "o", "r") }},
		{"InitDocsRepo", func() error { return c.InitDocsRepo(ctx, "o", "r") }},
		{"CommitWikiPage", func() error { _, e := c.CommitWikiPage(ctx, "o", "r", "P", "c", "a", "e", "m"); return e }},
		{"CommitDoc", func() error { _, e := c.CommitDoc(ctx, "o", "r", "p.md", "c", "a", "e", "m"); return e }},
		{"GetWikiPageContent", func() error { _, e := c.GetWikiPageContent(ctx, "o", "r", "P", ""); return e }},
		{"GetDocContent", func() error { _, e := c.GetDocContent(ctx, "o", "r", "p.md", ""); return e }},
		{"ListWikiPageHistory", func() error { _, e := c.ListWikiPageHistory(ctx, "o", "r", "P", 10); return e }},
		{"ListDocHistory", func() error { _, e := c.ListDocHistory(ctx, "o", "r", "p.md", 10); return e }},
		{"DeleteWikiPage", func() error { return c.DeleteWikiPage(ctx, "o", "r", "P", "a", "e") }},
		{"DeleteDoc", func() error { return c.DeleteDoc(ctx, "o", "r", "p.md", "a", "e") }},
		{"ListBookmarks", func() error { _, _, e := c.ListBookmarks(ctx, "o", "r", "", 10); return e }},
		{"CreateBookmark", func() error { _, e := c.CreateBookmark(ctx, "o", "r", CreateBookmarkRequest{Name: "n"}); return e }},
		{"DeleteBookmark", func() error { return c.DeleteBookmark(ctx, "o", "r", "n") }},
		{"ListChanges", func() error { _, _, e := c.ListChanges(ctx, "o", "r", "", 10); return e }},
		{"GetChange", func() error { _, e := c.GetChange(ctx, "o", "r", "chg"); return e }},
		{"GetChangeDiff", func() error { _, e := c.GetChangeDiff(ctx, "o", "r", "chg"); return e }},
		{"GetRevisionDiff", func() error { _, e := c.GetRevisionDiff(ctx, "o", "r", "chg", "a", "b", "p"); return e }},
		{"GetChangeFiles", func() error { _, e := c.GetChangeFiles(ctx, "o", "r", "chg"); return e }},
		{"ListFilesAtChange", func() error { _, e := c.ListFilesAtChange(ctx, "o", "r", "chg", "pre"); return e }},
		{"GetChangeConflicts", func() error { _, e := c.GetChangeConflicts(ctx, "o", "r", "chg"); return e }},
		{"GetFileAtChange", func() error { _, e := c.GetFileAtChange(ctx, "o", "r", "chg", "a.txt"); return e }},
		{"LandChanges", func() error { _, e := c.LandChanges(ctx, "o", "r", LandRequest{}); return e }},
		{"ListOperations", func() error { _, _, e := c.ListOperations(ctx, "o", "r", "", 10); return e }},
		{"GetWorkingTreeStatus", func() error { _, e := c.GetWorkingTreeStatus(ctx, "o", "r"); return e }},
		{"CreateSnapshot", func() error { _, e := c.CreateSnapshot(ctx, "o", "r", SnapshotRequest{}); return e }},
		{"ImportRefs", func() error { return c.ImportRefs(ctx, "o", "r") }},
		{"ProxyReceivePack", func() error { return c.ProxyReceivePack(ctx, "o", "r", nil, io.Discard) }},
		{"ProxyUploadPack", func() error { return c.ProxyUploadPack(ctx, "o", "r", nil, io.Discard) }},
		{"ProxyUploadPackBody", func() error { return c.ProxyUploadPackBody(ctx, "o", "r", nil, io.Discard) }},
		{"InfoRefs", func() error { _, e := c.InfoRefs(ctx, "o", "r", "git-upload-pack", io.Discard); return e }},
		{"InfoRefsUploadPack", func() error { _, e := c.InfoRefsUploadPack(ctx, "o", "r"); return e }},
		{"InfoRefsReceivePack", func() error { _, e := c.InfoRefsReceivePack(ctx, "o", "r"); return e }},
	}

	for _, tc := range calls {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := tc.fn()
			require.Error(t, err)
			assert.ErrorIs(t, err, errClientCoverResolver)
			assert.Contains(t, err.Error(), "resolve storage set url")
		})
	}
}

// TestClient_Cover_DoJSONMethodsSurfaceStatusError verifies that methods routed
// through doJSON return a *StatusError with the upstream code when repo-host
// answers with an unexpected status.
func TestClient_Cover_DoJSONMethodsSurfaceStatusError(t *testing.T) {
	t.Parallel()

	srv := clientCoverJSONErrorServer(t, http.StatusInternalServerError)
	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ctx := context.Background()

	calls := []struct {
		name string
		fn   func() error
	}{
		{"CommitWikiPage", func() error { _, e := c.CommitWikiPage(ctx, "o", "r", "P", "c", "a", "e", "m"); return e }},
		{"CommitDoc", func() error { _, e := c.CommitDoc(ctx, "o", "r", "p.md", "c", "a", "e", "m"); return e }},
		{"GetWikiPageContent", func() error { _, e := c.GetWikiPageContent(ctx, "o", "r", "P", "sha"); return e }},
		{"GetDocContent", func() error { _, e := c.GetDocContent(ctx, "o", "r", "p.md", "sha"); return e }},
		{"ListWikiPageHistory", func() error { _, e := c.ListWikiPageHistory(ctx, "o", "r", "P", 10); return e }},
		{"ListDocHistory", func() error { _, e := c.ListDocHistory(ctx, "o", "r", "p.md", 10); return e }},
		{"DeleteWikiPage", func() error { return c.DeleteWikiPage(ctx, "o", "r", "P", "a", "e") }},
		{"DeleteDoc", func() error { return c.DeleteDoc(ctx, "o", "r", "p.md", "a", "e") }},
		{"CreateBookmark", func() error { _, e := c.CreateBookmark(ctx, "o", "r", CreateBookmarkRequest{Name: "n"}); return e }},
		{"DeleteBookmark", func() error { return c.DeleteBookmark(ctx, "o", "r", "n") }},
		{"GetChange", func() error { _, e := c.GetChange(ctx, "o", "r", "chg"); return e }},
		{"GetChangeDiff", func() error { _, e := c.GetChangeDiff(ctx, "o", "r", "chg"); return e }},
		{"GetChangeFiles", func() error { _, e := c.GetChangeFiles(ctx, "o", "r", "chg"); return e }},
		{"ListFilesAtChange", func() error { _, e := c.ListFilesAtChange(ctx, "o", "r", "chg", ""); return e }},
		{"GetChangeConflicts", func() error { _, e := c.GetChangeConflicts(ctx, "o", "r", "chg"); return e }},
		{"GetFileAtChange", func() error { _, e := c.GetFileAtChange(ctx, "o", "r", "chg", "a.txt"); return e }},
		{"LandChanges", func() error { _, e := c.LandChanges(ctx, "o", "r", LandRequest{}); return e }},
		{"GetWorkingTreeStatus", func() error { _, e := c.GetWorkingTreeStatus(ctx, "o", "r"); return e }},
		{"CreateSnapshot", func() error { _, e := c.CreateSnapshot(ctx, "o", "r", SnapshotRequest{}); return e }},
	}

	for _, tc := range calls {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := tc.fn()
			require.Error(t, err)
			se, ok := IsStatusError(err)
			require.True(t, ok, "expected *StatusError, got %T: %v", err, err)
			assert.Equal(t, http.StatusInternalServerError, se.StatusCode)
			assert.Equal(t, "upstream boom", se.Message)
		})
	}
}

// --- StatusError / IsStatusError ---

func TestStatusError_Cover_ErrorString(t *testing.T) {
	t.Parallel()

	withMsg := &StatusError{StatusCode: 500, Message: "boom"}
	assert.Equal(t, "repo-host returned status 500: boom", withMsg.Error())

	noMsg := &StatusError{StatusCode: 404}
	assert.Equal(t, "repo-host returned status 404", noMsg.Error())
}

func TestStatusError_Cover_IsStatusError(t *testing.T) {
	t.Parallel()

	se, ok := IsStatusError(nil)
	assert.Nil(t, se)
	assert.False(t, ok)

	other := errors.New("plain")
	se, ok = IsStatusError(other)
	assert.Nil(t, se)
	assert.False(t, ok)

	target := &StatusError{StatusCode: 418, Message: "teapot"}
	se, ok = IsStatusError(target)
	assert.True(t, ok)
	assert.Same(t, target, se)
}

// --- Health error branches ---

func TestClient_Cover_HealthBadURLFailsRequestConstruction(t *testing.T) {
	t.Parallel()

	c := NewClient(&StaticStorageSetResolver{URL: "http://unused"}, "tok")
	err := c.Health(context.Background(), "http://bad\x00host")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create repo-host health request")
}

func TestClient_Cover_HealthTransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := c.Health(ctx, srv.URL)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Contains(t, err.Error(), "repo-host health request failed")
}

// --- ForkRepo / MoveRepo happy paths (previously 0%) ---

func TestClient_Cover_ForkRepoSuccess(t *testing.T) {
	t.Parallel()

	var gotPath, gotMethod string
	var gotBody forkRepoRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotMethod = r.Method
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	err := c.ForkRepo(context.Background(), "alice", "src", "bob", "dst")
	require.NoError(t, err)
	assert.Equal(t, "/repos/fork", gotPath)
	assert.Equal(t, http.MethodPost, gotMethod)
	assert.Equal(t, forkRepoRequest{SrcOwner: "alice", SrcRepo: "src", DstOwner: "bob", DstRepo: "dst"}, gotBody)
}

func TestClient_Cover_MoveRepoSuccess(t *testing.T) {
	t.Parallel()

	var gotPath, gotMethod string
	var gotBody moveRepoRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotMethod = r.Method
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	err := c.MoveRepo(context.Background(), "alice", "src", "bob", "dst")
	require.NoError(t, err)
	assert.Equal(t, "/repos/move", gotPath)
	assert.Equal(t, http.MethodPost, gotMethod)
	assert.Equal(t, moveRepoRequest{SrcOwner: "alice", SrcRepo: "src", DstOwner: "bob", DstRepo: "dst"}, gotBody)
}

// --- GetWorkingTreeStatus happy path (previously 0%) ---

func TestClient_Cover_GetWorkingTreeStatusSuccess(t *testing.T) {
	t.Parallel()

	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(WorkingTreeStatus{
			Backend: "jj",
			Branch:  "main",
			Head:    "abc123",
			Changes: []WorkingTreeChange{{Path: "a.txt", Status: "modified", Staged: false, Add: 2, Del: 1}},
		})
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	status, err := c.GetWorkingTreeStatus(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice:demo/status", gotPath)
	assert.Equal(t, "jj", status.Backend)
	assert.Equal(t, "main", status.Branch)
	assert.Equal(t, "abc123", status.Head)
	require.Len(t, status.Changes, 1)
	assert.Equal(t, "a.txt", status.Changes[0].Path)
	assert.Equal(t, uint32(2), status.Changes[0].Add)
}

// --- ProxyUploadPackBody happy path (previously 0%) ---

func TestClient_Cover_ProxyUploadPackBodyStreams(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("upload-body-response"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	out := &bytes.Buffer{}
	err := c.ProxyUploadPackBody(context.Background(), "alice", "demo", bytes.NewBufferString("upload-body-request"), out)
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice/demo/git/upload-pack", gotPath)
	assert.Equal(t, "upload-body-request", string(gotBody))
	assert.Equal(t, "upload-body-response", out.String())
}

// --- InfoRefsUploadPack / InfoRefsReceivePack / fetchRawInfoRefs ---

func clientCoverInfoRefsPrefix(service string) string {
	header := fmt.Sprintf("# service=%s\n", service)
	return fmt.Sprintf("%04x%s0000", len(header)+4, header)
}

func TestClient_Cover_InfoRefsUploadPackStripsHeader(t *testing.T) {
	t.Parallel()

	const refs = "00112233445566778899aabbccddeeff00112233 refs/heads/main\n0000"
	prefix := clientCoverInfoRefsPrefix("git-upload-pack")

	var gotService string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotService = r.URL.Query().Get("service")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(prefix + refs))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	raw, err := c.InfoRefsUploadPack(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, "git-upload-pack", gotService)
	assert.Equal(t, refs, string(raw))
}

func TestClient_Cover_InfoRefsReceivePackStripsHeader(t *testing.T) {
	t.Parallel()

	const refs = "aabbccddeeff00112233445566778899aabbccdd refs/heads/main\x00report-status\n0000"
	prefix := clientCoverInfoRefsPrefix("git-receive-pack")

	var gotService string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotService = r.URL.Query().Get("service")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(prefix + refs))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	raw, err := c.InfoRefsReceivePack(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, "git-receive-pack", gotService)
	assert.Equal(t, refs, string(raw))
}

func TestClient_Cover_InfoRefsUploadPackKeepsBodyWhenNoHeaderPrefix(t *testing.T) {
	t.Parallel()

	const rawRefs = "no-header-prefix-just-refs"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(rawRefs))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	raw, err := c.InfoRefsUploadPack(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, rawRefs, string(raw))
}

func TestClient_Cover_InfoRefsUploadPackPropagatesUpstreamError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("boom"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	raw, err := c.InfoRefsUploadPack(context.Background(), "alice", "demo")
	require.Error(t, err)
	assert.Nil(t, raw)
	assert.Contains(t, err.Error(), "502")
}

// --- InitWikiRepo / InitDocsRepo error branches ---

func TestClient_Cover_InitWikiDocsErrorBranches(t *testing.T) {
	t.Parallel()

	type initFn func(c *Client, ctx context.Context) error
	methods := []struct {
		name string
		fn   initFn
	}{
		{"InitWikiRepo", func(c *Client, ctx context.Context) error { return c.InitWikiRepo(ctx, "o", "r") }},
		{"InitDocsRepo", func(c *Client, ctx context.Context) error { return c.InitDocsRepo(ctx, "o", "r") }},
	}

	for _, m := range methods {
		m := m
		t.Run(m.name+"/badURLFailsRequestConstruction", func(t *testing.T) {
			t.Parallel()
			c := NewClient(clientCoverBadURLResolver{}, "tok")
			err := m.fn(c, context.Background())
			require.Error(t, err)
			assert.Contains(t, err.Error(), "create request")
		})

		t.Run(m.name+"/transportError", func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusCreated)
			}))
			t.Cleanup(srv.Close)
			c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			err := m.fn(c, ctx)
			require.Error(t, err)
			assert.ErrorIs(t, err, context.Canceled)
			assert.Contains(t, err.Error(), "repo-host request failed")
		})

		t.Run(m.name+"/unexpectedStatusReturnsStatusError", func(t *testing.T) {
			t.Parallel()
			srv := clientCoverJSONErrorServer(t, http.StatusInternalServerError)
			c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
			err := m.fn(c, context.Background())
			require.Error(t, err)
			se, ok := IsStatusError(err)
			require.True(t, ok, "expected *StatusError, got %T", err)
			assert.Equal(t, http.StatusInternalServerError, se.StatusCode)
			assert.Equal(t, "upstream boom", se.Message)
		})

		t.Run(m.name+"/noContentIsSuccess", func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))
			t.Cleanup(srv.Close)
			c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
			require.NoError(t, m.fn(c, context.Background()))
		})
	}
}

// --- DeleteRepo request-construction error ---

func TestClient_Cover_DeleteRepoBadURLFailsRequestConstruction(t *testing.T) {
	t.Parallel()

	c := NewClient(clientCoverBadURLResolver{}, "tok")
	err := c.DeleteRepo(context.Background(), "o", "r")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create repo-host delete request")
}

// --- ImportRefs request-construction and transport errors ---

func TestClient_Cover_ImportRefsBadURLFailsRequestConstruction(t *testing.T) {
	t.Parallel()

	c := NewClient(clientCoverBadURLResolver{}, "tok")
	err := c.ImportRefs(context.Background(), "o", "r")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create repo-host import-refs request")
}

func TestClient_Cover_ImportRefsTransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := c.ImportRefs(ctx, "o", "r")
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Contains(t, err.Error(), "repo-host import-refs request failed")
}

// --- proxyGitRPC (via ProxyReceivePack/ProxyUploadPack) branches ---

func TestClient_Cover_ProxyReceivePackNilStdinNilStdout(t *testing.T) {
	t.Parallel()

	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("resp"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	// Metadata pre-populated so no pkt-line peek is attempted; nil stdin and
	// nil stdout drive the nil-normalization branches in proxyGitRPCWithMeta.
	meta := ReceivePackMetadata{RefName: "refs/heads/main", CommitSHA: "abc123"}
	err := c.ProxyReceivePack(context.Background(), "alice", "demo", nil, nil, meta)
	require.NoError(t, err)
	assert.Empty(t, gotBody)
}

func TestClient_Cover_ProxyUploadPackBadURLFailsRequestConstruction(t *testing.T) {
	t.Parallel()

	c := NewClient(clientCoverBadURLResolver{}, "tok")
	err := c.ProxyUploadPack(context.Background(), "o", "r", bytes.NewBufferString("x"), io.Discard)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create git proxy request")
}

func TestClient_Cover_ProxyUploadPackTransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := c.ProxyUploadPack(ctx, "alice", "demo", bytes.NewBufferString("req"), io.Discard)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Contains(t, err.Error(), "git proxy request failed")
}

func TestClient_Cover_ProxyUploadPackCopyErrorSurfaced(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("response-body-to-copy"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	err := c.ProxyUploadPack(context.Background(), "alice", "demo", bytes.NewBufferString("req"), clientCoverFailWriter{})
	require.Error(t, err)
	assert.ErrorIs(t, err, errClientCoverWrite)
	assert.Contains(t, err.Error(), "stream git proxy response")
}

// --- proxyGitInfoRefs branches ---

func TestClient_Cover_InfoRefsNilStdoutUsesDiscard(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("refs"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ct, err := c.InfoRefs(context.Background(), "alice", "demo", "git-upload-pack", nil)
	require.NoError(t, err)
	assert.Equal(t, "application/x-git-upload-pack-advertisement", ct)
}

func TestClient_Cover_InfoRefsBadURLFailsRequestConstruction(t *testing.T) {
	t.Parallel()

	c := NewClient(clientCoverBadURLResolver{}, "tok")
	_, err := c.InfoRefs(context.Background(), "o", "r", "git-upload-pack", io.Discard)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create git info-refs request")
}

func TestClient_Cover_InfoRefsTransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.InfoRefs(ctx, "o", "r", "git-upload-pack", io.Discard)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Contains(t, err.Error(), "git info-refs request failed")
}

func TestClient_Cover_InfoRefsCopyErrorSurfaced(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("refs-to-copy"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	_, err := c.InfoRefs(context.Background(), "alice", "demo", "git-upload-pack", clientCoverFailWriter{})
	require.Error(t, err)
	assert.ErrorIs(t, err, errClientCoverWrite)
	assert.Contains(t, err.Error(), "stream git info-refs response")
}

func TestClient_Cover_InfoRefsMissingContentTypeFallsBack(t *testing.T) {
	t.Parallel()

	// Handler writes no body and no Content-Type header, so the client must
	// synthesize the advertisement content type from the service name.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ct, err := c.InfoRefs(context.Background(), "alice", "demo", "git-receive-pack", io.Discard)
	require.NoError(t, err)
	assert.Equal(t, "application/x-git-receive-pack-advertisement", ct)
}

// --- applyAuthHeader request-id propagation ---

func TestClient_Cover_ApplyAuthHeaderPropagatesRequestID(t *testing.T) {
	t.Parallel()

	var gotRequestID string
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRequestID = r.Header.Get("X-Request-Id")
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ctx := context.WithValue(context.Background(), chiMiddleware.RequestIDKey, "req-xyz-123")
	err := c.InitRepo(ctx, "alice", "demo", "main", false)
	require.NoError(t, err)
	assert.Equal(t, "req-xyz-123", gotRequestID)
	assert.Equal(t, "Bearer tok", gotAuth)
}

// --- doJSON internal edge branches (same-package direct calls) ---

func TestClient_Cover_DoJSONMarshalError(t *testing.T) {
	t.Parallel()

	c := NewClient(&StaticStorageSetResolver{URL: "http://unused"}, "tok")
	// channels cannot be JSON-encoded.
	err := c.doJSON(context.Background(), http.MethodPost, "http://example.invalid", make(chan int), http.StatusOK, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "marshal request")
}

func TestClient_Cover_DoJSONRequestConstructionError(t *testing.T) {
	t.Parallel()

	c := NewClient(&StaticStorageSetResolver{URL: "http://unused"}, "tok")
	err := c.doJSON(context.Background(), "bad method", "http://example.invalid", nil, http.StatusOK, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create request")
}

func TestClient_Cover_DoJSONTransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := c.doJSON(ctx, http.MethodGet, srv.URL, nil, http.StatusOK, nil)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Contains(t, err.Error(), "repo-host request failed")
}

func TestClient_Cover_DoJSONDecodeError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{not valid json"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	var out Change
	err := c.doJSON(context.Background(), http.MethodGet, srv.URL, nil, http.StatusOK, &out)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode response")
}

func TestClient_Cover_DoJSONEmptyBodyWithResponseTargetIsNoOp(t *testing.T) {
	t.Parallel()

	// Explicit zero Content-Length with a non-nil responseBody must short-circuit
	// before decoding.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	out := Change{ChangeID: "sentinel"}
	err := c.doJSON(context.Background(), http.MethodGet, srv.URL, nil, http.StatusOK, &out)
	require.NoError(t, err)
	// Untouched because the body was empty.
	assert.Equal(t, "sentinel", out.ChangeID)
}

// --- doJSONPaginated internal edge branches ---

func TestClient_Cover_DoJSONPaginatedParseError(t *testing.T) {
	t.Parallel()

	c := NewClient(&StaticStorageSetResolver{URL: "http://unused"}, "tok")
	_, _, err := doJSONPaginated[Bookmark](context.Background(), c, http.MethodGet, "http://bad\x7fhost/x", "", 10, http.StatusOK)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "parse endpoint")
}

func TestClient_Cover_DoJSONPaginatedRequestConstructionError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	_, _, err := doJSONPaginated[Bookmark](context.Background(), c, "bad method", srv.URL, "", 10, http.StatusOK)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create request")
}

func TestClient_Cover_DoJSONPaginatedEmptyBodyReturnsEmptySlice(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		// no body
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	items, next, err := doJSONPaginated[Bookmark](context.Background(), c, http.MethodGet, srv.URL, "", 10, http.StatusOK)
	require.NoError(t, err)
	assert.Empty(t, next)
	assert.NotNil(t, items)
	assert.Len(t, items, 0)
}

func TestClient_Cover_DoJSONPaginatedBareArrayFallback(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode([]Bookmark{{Name: "main"}, {Name: "dev"}})
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	items, next, err := doJSONPaginated[Bookmark](context.Background(), c, http.MethodGet, srv.URL, "", 10, http.StatusOK)
	require.NoError(t, err)
	assert.Empty(t, next)
	require.Len(t, items, 2)
	assert.Equal(t, "main", items[0].Name)
	assert.Equal(t, "dev", items[1].Name)
}

func TestClient_Cover_DoJSONPaginatedUndecodableBodyErrors(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		// A bare JSON number decodes into neither the paginated object nor a slice.
		_, _ = w.Write([]byte("12345"))
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	_, _, err := doJSONPaginated[Bookmark](context.Background(), c, http.MethodGet, srv.URL, "", 10, http.StatusOK)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode response")
}

func TestClient_Cover_DoJSONPaginatedReadBodyError(t *testing.T) {
	t.Parallel()

	// Hijack the connection to promise more bytes than are delivered, then close.
	// io.ReadAll on the response body then fails with an unexpected EOF.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		require.True(t, ok)
		conn, buf, err := hj.Hijack()
		require.NoError(t, err)
		defer func() { _ = conn.Close() }()
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nshort")
		_ = buf.Flush()
	}))
	t.Cleanup(srv.Close)

	c := NewClient(&StaticStorageSetResolver{URL: srv.URL}, "tok")
	_, _, err := doJSONPaginated[Bookmark](context.Background(), c, http.MethodGet, srv.URL, "", 10, http.StatusOK)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read response")
}

// --- cursor helpers ---

func TestClient_Cover_CursorToOffset(t *testing.T) {
	t.Parallel()

	assert.Equal(t, int64(0), cursorToOffset(""))
	assert.Equal(t, int64(42), cursorToOffset("42"))
	assert.Equal(t, int64(0), cursorToOffset("not-a-number"))
	assert.Equal(t, int64(0), cursorToOffset("-5"))
}

func TestClient_Cover_CursorToPage(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 1, cursorToPage("", 30))
	assert.Equal(t, 3, cursorToPage("60", 30))
	// limit <= 0 defaults to 30.
	assert.Equal(t, 1, cursorToPage("", 0))
	assert.Equal(t, 3, cursorToPage("60", -1))
}
