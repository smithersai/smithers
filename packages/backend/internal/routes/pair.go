package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pairauth"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// PairHandler serves the realtime multiplayer pair-coding API. Read/write
// access is gated by a shared access key (X-Pair-Key header or ?key= query)
// rather than a jjhub user session. The key must be a configured env key
// (SMITHERS_PAIR_ACCESS_KEYS); per-room `pairlink_` share tokens were removed
// (see authorizeLevel and pair-session authorization).
type PairHandler struct {
	Service *services.PairService
	Pool    *pgxpool.Pool
	keys    []string
	q       pairauth.ShareQuerier

	snapshotFn func(context.Context, string) (map[string]any, error)
	landingFn  func(context.Context, string) (services.PairLandingResult, error)
}

// NewPairHandler reads the allowed access keys from SMITHERS_PAIR_ACCESS_KEYS
// (comma/space separated). When unset, the API is open (dev convenience).
func NewPairHandler(service *services.PairService, pool *pgxpool.Pool) *PairHandler {
	return &PairHandler{Service: service, Pool: pool, keys: pairauth.KeysFromEnv(), q: db.New(pool)}
}

// pairServeSSE deliberately stays on the per-client sse.ServeSSE path rather than
// the shared broker used by every other SSE endpoint. Pair auth is a shared
// access key with NO jjhub user, so there is no per-user identity: folding these
// clients onto the shared per-user-capped broker would collapse every keyless
// client into a single userID=0 bucket and 429 legitimate viewers. The route is
// also currently unmounted (legacy /api/pair/* was retired), so it serves no
// production traffic and consumes no pool slots today; standing up a dedicated
// broker would instead pin one pooled connection permanently for a dead route.
// If Pair is remounted, migrate it onto a DEDICATED broker with an effectively
// unlimited MaxStreamsPerUser (or a per-connection synthetic id) — never the
// shared, per-user-capped one.
var pairServeSSE = sse.ServeSSE

var pairRoomRe = regexp.MustCompile(`[^a-z0-9]`)

// normalizePairRoom lowercases, strips non-alphanumerics, defaults to
// "default", and caps length at 40 — the single source of truth for how a room
// identifier is derived, used both for query-param rooms and share-link rooms.
func normalizePairRoom(room string) string {
	room = pairRoomRe.ReplaceAllString(strings.ToLower(room), "")
	if room == "" {
		room = "default"
	}
	if len(room) > 40 {
		room = room[:40]
	}
	return room
}

func (h *PairHandler) room(r *http.Request) string {
	return normalizePairRoom(r.URL.Query().Get("room"))
}

// authorizeLevel enforces that the request carries a credential sufficient for
// `want` on the request's room. It writes the appropriate error response and
// returns false when the caller should stop: 403 when a valid share token
// exists but is under-privileged (e.g. a view token on a write route), 401
// otherwise. A view token that only satisfies LevelView must NOT pass a
// LevelEdit check — this is what stops a view link from driving the shared
// Codex agent via /prompt.
func (h *PairHandler) authorizeLevel(w http.ResponseWriter, r *http.Request, want pairauth.Level) bool {
	switch pairauth.AuthorizeRoom(r.Context(), h.q, r, h.keys, h.room(r), want) {
	case pairauth.DecisionAllow:
		return true
	case pairauth.DecisionForbid:
		pairWriteJSON(w, http.StatusForbidden, map[string]string{"message": "edit access required"})
		return false
	default:
		pairWriteJSON(w, http.StatusUnauthorized, map[string]string{"message": "access key required"})
		return false
	}
}

func pairWriteJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func pairOrAnon(s string) string {
	if strings.TrimSpace(s) == "" {
		return "anon"
	}
	return s
}

func (h *PairHandler) snapshot(ctx context.Context, room string) (map[string]any, error) {
	if h.snapshotFn != nil {
		return h.snapshotFn(ctx, room)
	}
	return h.Service.Snapshot(ctx, room)
}

func (h *PairHandler) createLandingRequest(ctx context.Context, room string) (services.PairLandingResult, error) {
	if h.landingFn != nil {
		return h.landingFn(ctx, room)
	}
	return h.Service.CreateLandingRequest(ctx, room)
}

// Stream is the SSE endpoint. Mounted in its own group (no JSONTimeout).
func (h *PairHandler) Stream(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeLevel(w, r, pairauth.LevelView) {
		return
	}
	room := h.room(r)
	cfg := sse.StreamConfig{
		Pool:      h.Pool,
		Channels:  []string{"pair_room_" + room},
		EventType: "pair",
		OnConnect: func(w http.ResponseWriter, r *http.Request, flusher http.Flusher) {
			snap, err := h.snapshot(r.Context(), room)
			if err != nil {
				return
			}
			data, err := json.Marshal(snap)
			if err != nil {
				return
			}
			_, _ = fmt.Fprintf(w, "event: pair\ndata: %s\n\n", data)
			flusher.Flush()
		},
	}
	pairServeSSE(w, r, cfg)
}

// State returns the current room snapshot as JSON (used by the gate probe).
func (h *PairHandler) State(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeLevel(w, r, pairauth.LevelView) {
		return
	}
	snap, err := h.snapshot(r.Context(), h.room(r))
	if err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	pairWriteJSON(w, http.StatusOK, snap)
}

func (h *PairHandler) Tree(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeLevel(w, r, pairauth.LevelView) {
		return
	}
	entries, err := h.Service.Tree(r.Context())
	if err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (h *PairHandler) File(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeLevel(w, r, pairauth.LevelView) {
		return
	}
	rel := r.URL.Query().Get("path")
	content, size, err := h.Service.File(r.Context(), rel)
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrInvalid):
			pairWriteJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid path"})
		case errors.Is(err, fs.ErrNotExist):
			pairWriteJSON(w, http.StatusNotFound, map[string]string{"message": "file not found"})
		case strings.Contains(err.Error(), "file too large"):
			pairWriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"message": "file too large"})
		default:
			pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		}
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]any{"path": rel, "content": content, "size": size})
}

func (h *PairHandler) Diff(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeLevel(w, r, pairauth.LevelView) {
		return
	}
	diff, note, err := h.Service.Diff(r.Context(), h.room(r))
	if err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	resp := map[string]any{"diff": diff}
	if note != "" {
		resp["note"] = note
	}
	pairWriteJSON(w, http.StatusOK, resp)
}

func (h *PairHandler) Landing(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeLevel(w, r, pairauth.LevelEdit) {
		return
	}
	result, err := h.createLandingRequest(r.Context(), h.room(r))
	if err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	if result.URL == "" {
		pairWriteJSON(w, http.StatusOK, result)
		return
	}
	pairWriteJSON(w, http.StatusCreated, result)
}

func (h *PairHandler) FileEdit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Author  string `json:"author"`
	}
	if !h.decode(w, r, &body) {
		return
	}
	if err := h.Service.EditFile(r.Context(), h.room(r), body.Path, body.Content, pairOrAnon(body.Author)); err != nil {
		switch {
		case errors.Is(err, fs.ErrInvalid):
			pairWriteJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid path"})
		case errors.Is(err, fs.ErrNotExist):
			pairWriteJSON(w, http.StatusNotFound, map[string]string{"message": "file not found"})
		case strings.Contains(err.Error(), "file too large"):
			pairWriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"message": "file too large"})
		default:
			pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		}
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// decode gates every JSON write route (file-edit, doc, presence, prompt,
// draft, collab) on LevelEdit before reading the body, so a view token can
// never mutate the room or drive the shared Codex agent via /prompt.
func (h *PairHandler) decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if !h.authorizeLevel(w, r, pairauth.LevelEdit) {
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		pairWriteJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid body"})
		return false
	}
	return true
}

func (h *PairHandler) Doc(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
		Author  string `json:"author"`
	}
	if !h.decode(w, r, &body) {
		return
	}
	if err := h.Service.EditDoc(r.Context(), h.room(r), body.Content, pairOrAnon(body.Author)); err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *PairHandler) Presence(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID    string `json:"clientId"`
		Name        string `json:"name"`
		Color       string `json:"color"`
		Cursor      *int   `json:"cursor"`
		FilePath    string `json:"filePath"`
		Draft       string `json:"draft"`
		PromptFocus bool   `json:"promptFocus"`
		Leave       bool   `json:"leave"`
	}
	if !h.decode(w, r, &body) {
		return
	}
	if body.ClientID == "" {
		pairWriteJSON(w, http.StatusBadRequest, map[string]string{"message": "clientId required"})
		return
	}
	var err error
	if body.Leave {
		err = h.Service.Leave(r.Context(), h.room(r), body.ClientID)
	} else {
		err = h.Service.UpdatePresence(r.Context(), h.room(r),
			services.MakePresence(body.ClientID, pairOrAnon(body.Name), body.Color, body.Cursor, body.FilePath, body.Draft, body.PromptFocus))
	}
	if err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *PairHandler) Prompt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Prompt      string `json:"prompt"`
		Author      string `json:"author"`
		Color       string `json:"color"`
		ClearShared bool   `json:"clearShared"`
		// Provider is an optional per-request agent override. The live Pair path
		// currently accepts only "codex"; empty falls back to SMITHERS_PAIR_PROVIDER.
		Provider string `json:"provider"`
	}
	if !h.decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		pairWriteJSON(w, http.StatusBadRequest, map[string]string{"message": "prompt required"})
		return
	}
	if err := h.Service.SubmitPrompt(r.Context(), h.room(r), body.Prompt, pairOrAnon(body.Author), body.Color, body.ClearShared, body.Provider); err != nil {
		if errors.Is(err, services.ErrUnsupportedPairProvider) {
			pairWriteJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
			return
		}
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *PairHandler) Draft(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
		Author  string `json:"author"`
	}
	if !h.decode(w, r, &body) {
		return
	}
	if err := h.Service.EditDraft(r.Context(), h.room(r), body.Content, pairOrAnon(body.Author)); err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *PairHandler) Collab(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Collab bool `json:"collab"`
	}
	if !h.decode(w, r, &body) {
		return
	}
	if err := h.Service.SetCollab(r.Context(), h.room(r), body.Collab); err != nil {
		pairWriteJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	pairWriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// NOTE: The per-room `pairlink_` share-link mint/revoke handlers (CreateShare /
// DeleteShare) were removed. They let any authenticated user mint a share token
// for an ARBITRARY room and read that room's pair_state realtime stream,
// bypassing the SMITHERS_PAIR_ACCESS_KEYS env-key gate with no ownership check.
// The legacy pair_state shape is now gated solely by the env key; the live Pair
// clients authenticate with that key, so no real client depended on share links.
