package repohostserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

type sourceTestFFI struct {
	*mockFFI
	read func(string, string, repohost.WorkspaceSource) (repohost.WorkspaceSourceReceipt, error)
}

func (f *sourceTestFFI) ReadWorkspaceSource(path, workspace string, source repohost.WorkspaceSource) (repohost.WorkspaceSourceReceipt, error) {
	return f.read(path, workspace, source)
}

func TestWorkspaceSourceRouteDistinguishesMissingPinFromMissingCapability(t *testing.T) {
	source := repohost.WorkspaceSource{ChangeID: strings.Repeat("k", 32), CommitID: strings.Repeat("a", 40), TreeID: strings.Repeat("b", 40), ParentCommitIDs: []string{strings.Repeat("0", 40)}}
	const workspace = "0f8fad5b-d9cb-469f-a165-70867728950e"
	for _, mode := range []string{"retained", "missing-pin", "old-ffi", "wrong-workspace", "unauthenticated"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			var ffi FFIClient = &sourceTestFFI{mockFFI: &mockFFI{}, read: func(path, id string, s repohost.WorkspaceSource) (repohost.WorkspaceSourceReceipt, error) {
				calls++
				require.Equal(t, workspace, id)
				require.Equal(t, source, s)
				if mode == "missing-pin" {
					return repohost.WorkspaceSourceReceipt{}, &repohostffi.Error{Code: "workspace_source_missing", Message: "not retained"}
				}
				return repohost.WorkspaceSourceReceipt{Status: "retained", WorkspaceID: id, Source: s, Ref: repohost.WorkspaceSourceRef(id, s.CommitID)}, nil
			}}
			if mode == "old-ffi" {
				ffi = &mockFFI{}
			}
			srv, err := NewWithFFI(Config{StoragePath: t.TempDir(), AuthToken: testAuthToken, PushHookCallbackToken: "test-callback"}, ffi)
			require.NoError(t, err)
			request := repohost.WorkspaceSourceRequest{WorkspaceID: workspace, Source: source}
			if mode == "wrong-workspace" {
				request.WorkspaceID = "not-a-workspace"
			}
			payload, err := json.Marshal(request)
			require.NoError(t, err)
			req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/workspace-source", strings.NewReader(string(payload)))
			if mode != "unauthenticated" {
				req.Header.Set("Authorization", validAuth())
			}
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			expected := 200
			switch mode {
			case "missing-pin":
				expected = 404
				require.Contains(t, rec.Body.String(), `"code":"workspace_source_missing"`)
			case "old-ffi":
				expected = 503
				require.NotContains(t, rec.Body.String(), `"code":"workspace_source_missing"`)
			case "wrong-workspace":
				expected = 400
			case "unauthenticated":
				expected = 401
			}
			require.Equal(t, expected, rec.Code, rec.Body.String())
			if mode == "retained" || mode == "missing-pin" {
				require.Equal(t, 1, calls)
			} else {
				require.Zero(t, calls)
			}
		})
	}
}
