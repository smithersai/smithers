package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pairauth"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type pairCovShareQuerier struct {
	links map[string]db.PairShareLink
}

func (q pairCovShareQuerier) GetPairShareLinkByTokenHash(_ context.Context, tokenHash string) (db.PairShareLink, error) {
	if link, ok := q.links[tokenHash]; ok {
		return link, nil
	}
	return db.PairShareLink{}, pgx.ErrNoRows
}

func TestPair_Cov_NewHandlerRoomAndAuthorDefaults(t *testing.T) {
	t.Setenv("SMITHERS_PAIR_ACCESS_KEYS", " alpha, beta\n gamma ")
	h := NewPairHandler(nil, nil)
	assert.Equal(t, []string{"alpha", "beta", "gamma"}, h.keys)

	req := httptest.NewRequest(http.MethodGet, "/api/pair/state?room=Room-ABC_123!!!", nil)
	assert.Equal(t, "roomabc123", h.room(req))

	longReq := httptest.NewRequest(http.MethodGet, "/api/pair/state?room="+strings.Repeat("A", 60), nil)
	assert.Len(t, h.room(longReq), 40)

	defaultReq := httptest.NewRequest(http.MethodGet, "/api/pair/state?room=!!!", nil)
	assert.Equal(t, "default", h.room(defaultReq))

	assert.Equal(t, "anon", pairOrAnon("  "))
	assert.Equal(t, "alice", pairOrAnon("alice"))
}

func TestPair_Cov_AuthorizeAndDecodeResponses(t *testing.T) {
	viewToken := "pairlink_view_cov"
	editToken := "pairlink_edit_cov"
	h := &PairHandler{
		keys: []string{"envkey"},
		q: pairCovShareQuerier{links: map[string]db.PairShareLink{
			pairauth.TokenHash(viewToken): {RoomID: "rooma", Level: string(pairauth.LevelView)},
			pairauth.TokenHash(editToken): {RoomID: "rooma", Level: string(pairauth.LevelEdit)},
		}},
	}

	viewReq := httptest.NewRequest(http.MethodGet, "/api/pair/state?room=rooma", nil)
	viewReq.Header.Set("X-Pair-Key", viewToken)
	viewRec := httptest.NewRecorder()
	assert.True(t, h.authorizeLevel(viewRec, viewReq, pairauth.LevelView))

	forbidReq := httptest.NewRequest(http.MethodPost, "/api/pair/prompt?room=rooma", strings.NewReader(`{"prompt":"x"}`))
	forbidReq.Header.Set("X-Pair-Key", viewToken)
	forbidRec := httptest.NewRecorder()
	assert.False(t, h.authorizeLevel(forbidRec, forbidReq, pairauth.LevelEdit))
	require.Equal(t, http.StatusForbidden, forbidRec.Code)
	assert.Contains(t, forbidRec.Body.String(), "edit access required")

	denyReq := httptest.NewRequest(http.MethodGet, "/api/pair/state?room=rooma", nil)
	denyRec := httptest.NewRecorder()
	assert.False(t, h.authorizeLevel(denyRec, denyReq, pairauth.LevelView))
	require.Equal(t, http.StatusUnauthorized, denyRec.Code)
	assert.Contains(t, denyRec.Body.String(), "access key required")

	badJSONReq := httptest.NewRequest(http.MethodPost, "/api/pair/doc?room=rooma", strings.NewReader(`not-json`))
	badJSONReq.Header.Set("X-Pair-Key", editToken)
	badJSONRec := httptest.NewRecorder()
	var decoded struct {
		Content string `json:"content"`
	}
	assert.False(t, h.decode(badJSONRec, badJSONReq, &decoded))
	require.Equal(t, http.StatusBadRequest, badJSONRec.Code)
	assert.Contains(t, badJSONRec.Body.String(), "invalid body")

	viewEditReq := httptest.NewRequest(http.MethodPost, "/api/pair/doc?room=rooma", strings.NewReader(`{"content":"x"}`))
	viewEditReq.Header.Set("X-Pair-Key", viewToken)
	viewEditRec := httptest.NewRecorder()
	assert.False(t, h.decode(viewEditRec, viewEditReq, &decoded))
	require.Equal(t, http.StatusForbidden, viewEditRec.Code)
}

func TestPair_Cov_UnauthorizedEndpointsReturnJSON(t *testing.T) {
	h := &PairHandler{keys: []string{"envkey"}, q: pairCovShareQuerier{links: map[string]db.PairShareLink{}}}
	tests := []struct {
		name   string
		method string
		target string
		body   string
		hit    func(http.ResponseWriter, *http.Request)
	}{
		{"stream", http.MethodGet, "/api/pair/stream?room=rooma", "", h.Stream},
		{"state", http.MethodGet, "/api/pair/state?room=rooma", "", h.State},
		{"tree", http.MethodGet, "/api/pair/tree?room=rooma", "", h.Tree},
		{"file", http.MethodGet, "/api/pair/file?room=rooma&path=a.txt", "", h.File},
		{"diff", http.MethodGet, "/api/pair/diff?room=rooma", "", h.Diff},
		{"landing", http.MethodPost, "/api/pair/landing?room=rooma", "", h.Landing},
		{"file edit", http.MethodPost, "/api/pair/file-edit?room=rooma", `{"path":"a.txt","content":"x"}`, h.FileEdit},
		{"doc", http.MethodPost, "/api/pair/doc?room=rooma", `{"content":"x"}`, h.Doc},
		{"presence", http.MethodPost, "/api/pair/presence?room=rooma", `{"clientId":"c1"}`, h.Presence},
		{"prompt", http.MethodPost, "/api/pair/prompt?room=rooma", `{"prompt":"x"}`, h.Prompt},
		{"draft", http.MethodPost, "/api/pair/draft?room=rooma", `{"content":"x"}`, h.Draft},
		{"collab", http.MethodPost, "/api/pair/collab?room=rooma", `{"collab":true}`, h.Collab},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			tc.hit(rec, req)
			require.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")
			assert.Contains(t, rec.Body.String(), "access key required")
		})
	}
}

func TestPair_Cov_FileTreeAndPromptEdgeBranches(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644))
	require.NoError(t, os.Mkdir(filepath.Join(root, "docs"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "node_modules", "pkg", "index.js"), []byte("skip"), 0o644))
	large := strings.Repeat("x", 513*1024)
	require.NoError(t, os.WriteFile(filepath.Join(root, "large.txt"), []byte("small"), 0o644))

	resolvedRoot, err := filepath.EvalSymlinks(root)
	require.NoError(t, err)
	t.Setenv("SMITHERS_PAIR_REPO_DIR", resolvedRoot)
	service := services.NewPairService(nil, nil, nil)
	h := &PairHandler{Service: service, keys: []string{"envkey"}}

	treeReq := httptest.NewRequest(http.MethodGet, "/api/pair/tree", nil)
	treeReq.Header.Set("X-Pair-Key", "envkey")
	treeRec := httptest.NewRecorder()
	h.Tree(treeRec, treeReq)
	require.Equal(t, http.StatusOK, treeRec.Code)
	var treeBody struct {
		Entries []services.PairTreeEntry `json:"entries"`
	}
	require.NoError(t, json.Unmarshal(treeRec.Body.Bytes(), &treeBody))
	assert.Contains(t, treeBody.Entries, services.PairTreeEntry{Path: "a.txt", Type: "file"})
	assert.NotContains(t, treeBody.Entries, services.PairTreeEntry{Path: "node_modules/pkg/index.js", Type: "file"})

	fileReq := httptest.NewRequest(http.MethodGet, "/api/pair/file?path=a.txt", nil)
	fileReq.Header.Set("X-Pair-Key", "envkey")
	fileRec := httptest.NewRecorder()
	h.File(fileRec, fileReq)
	require.Equal(t, http.StatusOK, fileRec.Code)
	assert.Contains(t, fileRec.Body.String(), `"content":"hello"`)

	for _, tc := range []struct {
		name   string
		target string
		code   int
		msg    string
	}{
		{"invalid path", "/api/pair/file?path=../secret", http.StatusBadRequest, "invalid path"},
		{"missing file", "/api/pair/file?path=missing.txt", http.StatusNotFound, "file not found"},
		{"directory", "/api/pair/file?path=docs", http.StatusBadRequest, "invalid path"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.target, nil)
			req.Header.Set("X-Pair-Key", "envkey")
			rec := httptest.NewRecorder()
			h.File(rec, req)
			require.Equal(t, tc.code, rec.Code)
			assert.Contains(t, rec.Body.String(), tc.msg)
		})
	}

	fileEditReq := httptest.NewRequest(http.MethodPost, "/api/pair/file-edit", strings.NewReader(`{"path":"../secret","content":"x"}`))
	fileEditReq.Header.Set("X-Pair-Key", "envkey")
	fileEditRec := httptest.NewRecorder()
	h.FileEdit(fileEditRec, fileEditReq)
	require.Equal(t, http.StatusBadRequest, fileEditRec.Code)

	largeEditReq := httptest.NewRequest(http.MethodPost, "/api/pair/file-edit", strings.NewReader(`{"path":"large.txt","content":"`+large+`"}`))
	largeEditReq.Header.Set("X-Pair-Key", "envkey")
	largeEditRec := httptest.NewRecorder()
	h.FileEdit(largeEditRec, largeEditReq)
	require.Equal(t, http.StatusRequestEntityTooLarge, largeEditRec.Code)

	emptyPromptReq := httptest.NewRequest(http.MethodPost, "/api/pair/prompt", strings.NewReader(`{"prompt":"   "}`))
	emptyPromptReq.Header.Set("X-Pair-Key", "envkey")
	emptyPromptRec := httptest.NewRecorder()
	h.Prompt(emptyPromptRec, emptyPromptReq)
	require.Equal(t, http.StatusBadRequest, emptyPromptRec.Code)
	assert.Contains(t, emptyPromptRec.Body.String(), "prompt required")

	badProviderReq := httptest.NewRequest(http.MethodPost, "/api/pair/prompt", strings.NewReader(`{"prompt":"do it","provider":"other"}`))
	badProviderReq.Header.Set("X-Pair-Key", "envkey")
	badProviderRec := httptest.NewRecorder()
	h.Prompt(badProviderRec, badProviderReq)
	require.Equal(t, http.StatusBadRequest, badProviderRec.Code)
	assert.Contains(t, badProviderRec.Body.String(), "unsupported pair provider")
}
