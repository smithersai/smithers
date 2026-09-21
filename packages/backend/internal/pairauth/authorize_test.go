package pairauth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// fakeShareQuerier is an in-memory ShareQuerier keyed by token hash. Only live
// links are stored, mirroring the SQL filter in GetPairShareLinkByTokenHash, so
// a miss stands in for a revoked/expired/unknown token.
type fakeShareQuerier struct {
	links map[string]db.PairShareLink
}

func (f *fakeShareQuerier) GetPairShareLinkByTokenHash(ctx context.Context, h string) (db.PairShareLink, error) {
	if link, ok := f.links[h]; ok {
		return link, nil
	}
	return db.PairShareLink{}, pgx.ErrNoRows
}

func reqWithKey(key string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/pair/state?room=rooma", nil)
	if key != "" {
		r.Header.Set("X-Pair-Key", key)
	}
	return r
}

func TestLevelSatisfies(t *testing.T) {
	cases := []struct {
		grant, want Level
		ok          bool
	}{
		{LevelView, LevelView, true},
		{LevelEdit, LevelView, true},
		{LevelEdit, LevelEdit, true},
		{LevelView, LevelEdit, false}, // view can never edit
		{"", LevelView, false},
		{"", LevelEdit, false},
	}
	for _, c := range cases {
		if got := LevelSatisfies(c.grant, c.want); got != c.ok {
			t.Fatalf("LevelSatisfies(%q,%q)=%v want %v", c.grant, c.want, got, c.ok)
		}
	}
}

func TestAuthorizeRoom_EnvKeyGrantsEdit(t *testing.T) {
	// A configured env key authorizes any room at edit level regardless of the
	// share table (the static-key path must keep working unchanged).
	if got := AuthorizeRoom(context.Background(), nil, reqWithKey("envkey"), []string{"envkey"}, "rooma", LevelEdit); got != DecisionAllow {
		t.Fatalf("env key edit: got %v want DecisionAllow", got)
	}
}

func TestAuthorizeRoom_NoEnvKeysFailsClosed(t *testing.T) {
	// No env keys and open mode off (SMITHERS_PAIR_ALLOW_OPEN unset) => fail
	// closed. With no key on the request this denies.
	if got := AuthorizeRoom(context.Background(), nil, reqWithKey(""), nil, "rooma", LevelEdit); got != DecisionDeny {
		t.Fatalf("fail closed: got %v want DecisionDeny", got)
	}
}

func TestAuthorizeRoom_ViewTokenReadsButCannotEdit(t *testing.T) {
	raw := "pairlink_view"
	q := &fakeShareQuerier{links: map[string]db.PairShareLink{
		TokenHash(raw): {RoomID: "rooma", Level: "view"},
	}}
	envKeys := []string{"envkey"} // non-empty so open mode is off

	if got := AuthorizeRoom(context.Background(), q, reqWithKey(raw), envKeys, "rooma", LevelView); got != DecisionAllow {
		t.Fatalf("view token read: got %v want DecisionAllow", got)
	}
	// The core security property: a view token must NOT satisfy an edit route
	// (e.g. /prompt) — it is Forbidden (403), not merely unauthenticated.
	if got := AuthorizeRoom(context.Background(), q, reqWithKey(raw), envKeys, "rooma", LevelEdit); got != DecisionForbid {
		t.Fatalf("view token edit: got %v want DecisionForbid", got)
	}
}

func TestAuthorizeRoom_EditTokenReadsAndWrites(t *testing.T) {
	raw := "pairlink_edit"
	q := &fakeShareQuerier{links: map[string]db.PairShareLink{
		TokenHash(raw): {RoomID: "rooma", Level: "edit"},
	}}
	envKeys := []string{"envkey"}

	for _, want := range []Level{LevelView, LevelEdit} {
		if got := AuthorizeRoom(context.Background(), q, reqWithKey(raw), envKeys, "rooma", want); got != DecisionAllow {
			t.Fatalf("edit token want=%q: got %v want DecisionAllow", want, got)
		}
	}
}

func TestAuthorizeRoom_TokenBoundToOtherRoomDenied(t *testing.T) {
	raw := "pairlink_edit"
	q := &fakeShareQuerier{links: map[string]db.PairShareLink{
		TokenHash(raw): {RoomID: "rooma", Level: "edit"},
	}}
	// Requesting roomb with a roomA token is Denied (401), not a 403 — the
	// token grants nothing here.
	if got := AuthorizeRoom(context.Background(), q, reqWithKey(raw), []string{"envkey"}, "roomb", LevelView); got != DecisionDeny {
		t.Fatalf("cross-room: got %v want DecisionDeny", got)
	}
}

func TestAuthorizeRoom_RevokedOrExpiredTokenDenied(t *testing.T) {
	// Empty link table => the query "misses" (as it would for a revoked/expired
	// row filtered out by the SQL), so the token is Denied (401).
	q := &fakeShareQuerier{links: map[string]db.PairShareLink{}}
	if got := AuthorizeRoom(context.Background(), q, reqWithKey("pairlink_gone"), []string{"envkey"}, "rooma", LevelView); got != DecisionDeny {
		t.Fatalf("revoked/expired: got %v want DecisionDeny", got)
	}
}

func TestAuthorizeRoom_NoKeyDenied(t *testing.T) {
	q := &fakeShareQuerier{links: map[string]db.PairShareLink{}}
	if got := AuthorizeRoom(context.Background(), q, reqWithKey(""), []string{"envkey"}, "rooma", LevelView); got != DecisionDeny {
		t.Fatalf("no key: got %v want DecisionDeny", got)
	}
}

func TestAuthorizeRoom_QuerierErrorDenied(t *testing.T) {
	q := errShareQuerier{err: errors.New("db down")}
	if got := AuthorizeRoom(context.Background(), q, reqWithKey("pairlink_x"), []string{"envkey"}, "rooma", LevelView); got != DecisionDeny {
		t.Fatalf("querier error: got %v want DecisionDeny", got)
	}
}

type errShareQuerier struct{ err error }

func (e errShareQuerier) GetPairShareLinkByTokenHash(ctx context.Context, h string) (db.PairShareLink, error) {
	return db.PairShareLink{}, e.err
}
