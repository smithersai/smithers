package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

func pairZPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping DB-backed pair route coverage test in short mode")
	}
	databaseURL := strings.TrimSpace(os.Getenv("SMITHERS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("SMITHERS_TEST_DATABASE_URL is required for DB-backed pair route coverage")
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	require.NoError(t, err)
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	require.NoError(t, err)
	require.NoError(t, pool.Ping(context.Background()))
	t.Cleanup(pool.Close)
	return pool
}

func pairZHandler(t *testing.T, pool *pgxpool.Pool) (*PairHandler, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "large.txt"), []byte(strings.Repeat("x", 513*1024)), 0o644))
	t.Setenv("SMITHERS_PAIR_REPO_DIR", root)
	svc := services.NewPairService(pool, nil, nil)
	require.NoError(t, svc.EnsureSchema(context.Background()))
	return &PairHandler{Service: svc, Pool: pool, keys: []string{"envkey"}}, root
}

func pairZBadRepoHandler(t *testing.T, pool *pgxpool.Pool, root string) *PairHandler {
	t.Helper()
	notDir := filepath.Join(root, "not-a-directory")
	require.NoError(t, os.WriteFile(notDir, []byte("not a directory"), 0o644))
	t.Setenv("SMITHERS_PAIR_REPO_DIR", notDir)
	return &PairHandler{Service: services.NewPairService(pool, nil, nil), Pool: pool, keys: []string{"envkey"}}
}

func pairZRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("X-Pair-Key", "envkey")
	return req
}

func pairZCanceled(req *http.Request) *http.Request {
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	return req.WithContext(ctx)
}

func TestPair_Z_StreamOnConnectBranches(t *testing.T) {
	oldServeSSE := pairServeSSE
	t.Cleanup(func() { pairServeSSE = oldServeSSE })

	pairServeSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.StreamConfig) {
		require.Equal(t, []string{"pair_room_rooma"}, cfg.Channels)
		require.Equal(t, "pair", cfg.EventType)
		require.NotNil(t, cfg.OnConnect)
		cfg.OnConnect(w, r, w.(http.Flusher))
	}

	t.Run("snapshot error returns without replay", func(t *testing.T) {
		h := &PairHandler{
			keys: []string{"envkey"},
			snapshotFn: func(context.Context, string) (map[string]any, error) {
				return nil, errors.New("snapshot failed")
			},
		}
		rec := httptest.NewRecorder()
		h.Stream(rec, pairZRequest(http.MethodGet, "/api/pair/stream?room=Room-A", ""))
		assert.Empty(t, rec.Body.String())
	})

	t.Run("marshal error returns without replay", func(t *testing.T) {
		h := &PairHandler{
			keys: []string{"envkey"},
			snapshotFn: func(context.Context, string) (map[string]any, error) {
				return map[string]any{"bad": make(chan int)}, nil
			},
		}
		rec := httptest.NewRecorder()
		h.Stream(rec, pairZRequest(http.MethodGet, "/api/pair/stream?room=rooma", ""))
		assert.Empty(t, rec.Body.String())
	})

	t.Run("snapshot replay writes pair event", func(t *testing.T) {
		h := &PairHandler{
			keys: []string{"envkey"},
			snapshotFn: func(_ context.Context, room string) (map[string]any, error) {
				return map[string]any{"kind": "snapshot", "room": room}, nil
			},
		}
		rec := httptest.NewRecorder()
		h.Stream(rec, pairZRequest(http.MethodGet, "/api/pair/stream?room=rooma", ""))
		assert.Contains(t, rec.Body.String(), "event: pair")
		assert.Contains(t, rec.Body.String(), `"room":"rooma"`)
	})
}

func TestPair_Z_StateTreeFileDiffAndLandingBranches(t *testing.T) {
	pool := pairZPool(t)
	h, root := pairZHandler(t, pool)
	room := "pair-z-" + uuid.NewString()

	rec := httptest.NewRecorder()
	h.State(rec, pairZRequest(http.MethodGet, "/api/pair/state?room="+room, ""))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"kind":"snapshot"`)

	rec = httptest.NewRecorder()
	h.State(rec, pairZCanceled(pairZRequest(http.MethodGet, "/api/pair/state?room="+room, "")))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	badRepo := pairZBadRepoHandler(t, pool, root)
	rec = httptest.NewRecorder()
	badRepo.Tree(rec, pairZRequest(http.MethodGet, "/api/pair/tree", ""))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.File(rec, pairZRequest(http.MethodGet, "/api/pair/file?path=large.txt", ""))
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)

	rec = httptest.NewRecorder()
	badRepo.File(rec, pairZRequest(http.MethodGet, "/api/pair/file?path=main.go", ""))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.Diff(rec, pairZRequest(http.MethodGet, "/api/pair/diff?room="+room, ""))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "directory snapshot")

	rec = httptest.NewRecorder()
	badRepo.Diff(rec, pairZRequest(http.MethodGet, "/api/pair/diff?room="+room, ""))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.Landing(rec, pairZRequest(http.MethodPost, "/api/pair/landing?room="+room, ""))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "workspace-backed room")

	landingCreated := &PairHandler{
		keys: []string{"envkey"},
		landingFn: func(context.Context, string) (services.PairLandingResult, error) {
			return services.PairLandingResult{Available: true, Number: 12, URL: "https://example.test/landings/12"}, nil
		},
	}
	rec = httptest.NewRecorder()
	landingCreated.Landing(rec, pairZRequest(http.MethodPost, "/api/pair/landing?room="+room, ""))
	require.Equal(t, http.StatusCreated, rec.Code)

	landingUnavailable := &PairHandler{
		keys: []string{"envkey"},
		landingFn: func(context.Context, string) (services.PairLandingResult, error) {
			return services.PairLandingResult{Message: "not available"}, nil
		},
	}
	rec = httptest.NewRecorder()
	landingUnavailable.Landing(rec, pairZRequest(http.MethodPost, "/api/pair/landing?room="+room, ""))
	require.Equal(t, http.StatusOK, rec.Code)

	landingErr := &PairHandler{
		keys: []string{"envkey"},
		landingFn: func(context.Context, string) (services.PairLandingResult, error) {
			return services.PairLandingResult{}, errors.New("landing failed")
		},
	}
	rec = httptest.NewRecorder()
	landingErr.Landing(rec, pairZRequest(http.MethodPost, "/api/pair/landing?room="+room, ""))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestPair_Z_FileEditDocPresencePromptDraftAndCollabBranches(t *testing.T) {
	pool := pairZPool(t)
	h, root := pairZHandler(t, pool)
	badRepo := pairZBadRepoHandler(t, pool, root)
	room := "pair-z-" + uuid.NewString()

	rec := httptest.NewRecorder()
	h.FileEdit(rec, pairZRequest(http.MethodPost, "/api/pair/file-edit?room="+room, `{"path":"main.go","content":"package main\n\nfunc main() {}\n","author":"alice"}`))
	require.Equal(t, http.StatusOK, rec.Code)

	rec = httptest.NewRecorder()
	h.FileEdit(rec, pairZRequest(http.MethodPost, "/api/pair/file-edit?room="+room, `{"path":"missing.go","content":"x"}`))
	require.Equal(t, http.StatusNotFound, rec.Code)

	rec = httptest.NewRecorder()
	badRepo.FileEdit(rec, pairZRequest(http.MethodPost, "/api/pair/file-edit?room="+room, `{"path":"main.go","content":"x"}`))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.Doc(rec, pairZRequest(http.MethodPost, "/api/pair/doc?room="+room, `{"content":"# doc","author":"alice"}`))
	require.Equal(t, http.StatusOK, rec.Code)

	rec = httptest.NewRecorder()
	h.Doc(rec, pairZCanceled(pairZRequest(http.MethodPost, "/api/pair/doc?room="+room, `{"content":"# doc"}`)))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.Presence(rec, pairZRequest(http.MethodPost, "/api/pair/presence?room="+room, `{"name":"alice"}`))
	require.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	h.Presence(rec, pairZRequest(http.MethodPost, "/api/pair/presence?room="+room, `{"clientId":"c1","name":"alice","cursor":4,"filePath":"main.go","draft":"d","promptFocus":true}`))
	require.Equal(t, http.StatusOK, rec.Code)

	rec = httptest.NewRecorder()
	h.Presence(rec, pairZRequest(http.MethodPost, "/api/pair/presence?room="+room, `{"clientId":"c1","leave":true}`))
	require.Equal(t, http.StatusOK, rec.Code)

	rec = httptest.NewRecorder()
	h.Presence(rec, pairZCanceled(pairZRequest(http.MethodPost, "/api/pair/presence?room="+room, `{"clientId":"c2"}`)))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.Prompt(rec, pairZCanceled(pairZRequest(http.MethodPost, "/api/pair/prompt?room="+room, `{"prompt":"ship it"}`)))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.Prompt(rec, pairZRequest(http.MethodPost, "/api/pair/prompt?room="+room, `{"prompt":"ship it","author":"alice","color":"#123456","clearShared":true}`))
	require.Equal(t, http.StatusOK, rec.Code)
	time.Sleep(75 * time.Millisecond)

	rec = httptest.NewRecorder()
	h.Draft(rec, pairZRequest(http.MethodPost, "/api/pair/draft?room="+room, `{"content":"draft","author":"alice"}`))
	require.Equal(t, http.StatusOK, rec.Code)

	rec = httptest.NewRecorder()
	h.Draft(rec, pairZCanceled(pairZRequest(http.MethodPost, "/api/pair/draft?room="+room, `{"content":"draft"}`)))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	rec = httptest.NewRecorder()
	h.Collab(rec, pairZRequest(http.MethodPost, "/api/pair/collab?room="+room, `{"collab":true}`))
	require.Equal(t, http.StatusOK, rec.Code)

	rec = httptest.NewRecorder()
	h.Collab(rec, pairZCanceled(pairZRequest(http.MethodPost, "/api/pair/collab?room="+room, `{"collab":false}`)))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}
