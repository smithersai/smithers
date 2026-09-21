package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pairauth"
)

// fakePairShareQuerier implements pairauth.ShareQuerier in-memory. Only live
// links are stored (a miss stands in for a revoked/expired/unknown token,
// matching the SQL filter in GetPairShareLinkByTokenHash).
type fakePairShareQuerier struct {
	links map[string]db.PairShareLink
}

func (f *fakePairShareQuerier) GetPairShareLinkByTokenHash(ctx context.Context, h string) (db.PairShareLink, error) {
	if link, ok := f.links[h]; ok {
		return link, nil
	}
	return db.PairShareLink{}, pgx.ErrNoRows
}

// handlerWithKeys builds a PairHandler gated by a non-empty env key list (so
// open mode is off) backed by the given fake querier. Service is nil; the tests
// below only exercise paths that return before touching Service.
func handlerWithKeys(q *fakePairShareQuerier) *PairHandler {
	return &PairHandler{keys: []string{"envkey"}, q: q}
}

// --- security: view token cannot drive the agent ---------------------------

func TestPrompt_ViewTokenForbidden(t *testing.T) {
	raw := "pairlink_view"
	q := &fakePairShareQuerier{links: map[string]db.PairShareLink{
		pairauth.TokenHash(raw): {RoomID: "rooma", Level: "view"},
	}}
	h := handlerWithKeys(q)

	req := httptest.NewRequest(http.MethodPost, "/api/pair/prompt?room=rooma", strings.NewReader(`{"prompt":"drive the agent"}`))
	req.Header.Set("X-Pair-Key", raw)
	rec := httptest.NewRecorder()
	h.Prompt(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("view token on /prompt: got %d want 403 (%s)", rec.Code, rec.Body.String())
	}
}

func TestFileEdit_ViewTokenForbidden(t *testing.T) {
	raw := "pairlink_view"
	q := &fakePairShareQuerier{links: map[string]db.PairShareLink{
		pairauth.TokenHash(raw): {RoomID: "rooma", Level: "view"},
	}}
	h := handlerWithKeys(q)

	req := httptest.NewRequest(http.MethodPost, "/api/pair/file-edit?room=rooma", strings.NewReader(`{"path":"a","content":"b"}`))
	req.Header.Set("X-Pair-Key", raw)
	rec := httptest.NewRecorder()
	h.FileEdit(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("view token on /file-edit: got %d want 403 (%s)", rec.Code, rec.Body.String())
	}
}

func TestPrompt_RevokedTokenUnauthorized(t *testing.T) {
	q := &fakePairShareQuerier{links: map[string]db.PairShareLink{}} // no live link
	h := handlerWithKeys(q)

	req := httptest.NewRequest(http.MethodPost, "/api/pair/prompt?room=rooma", strings.NewReader(`{"prompt":"x"}`))
	req.Header.Set("X-Pair-Key", "pairlink_revoked")
	rec := httptest.NewRecorder()
	h.Prompt(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked token on /prompt: got %d want 401 (%s)", rec.Code, rec.Body.String())
	}
}

func TestPrompt_NoKeyUnauthorized(t *testing.T) {
	h := handlerWithKeys(&fakePairShareQuerier{links: map[string]db.PairShareLink{}})

	req := httptest.NewRequest(http.MethodPost, "/api/pair/prompt?room=rooma", strings.NewReader(`{"prompt":"x"}`))
	rec := httptest.NewRecorder()
	h.Prompt(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no key on /prompt: got %d want 401 (%s)", rec.Code, rec.Body.String())
	}
}
