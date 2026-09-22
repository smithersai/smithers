package chat

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

const (
	TurnPath            = "/api/agent/turn"
	CancelPath          = "/api/agent/turn/cancel"
	ReplayPath          = "/api/agent/turn/replay"
	RetirePath          = "/api/agent/turn/retire"
	CommitPath          = "/internal/chat/commit"
	ProviderStartedPath = "/internal/chat/provider-started"
	journalHeader       = "x-smithers-turn-journal"
)

type Handler struct {
	Store      *Store
	Dispatcher *Dispatcher
}

type replayRequest struct {
	RunID   string         `json:"runId"`
	Journal JournalRequest `json:"journal"`
	After   *Cursor        `json:"after,omitempty"`
}

type cancelRequest struct {
	RunID string `json:"runId"`
}

type producerRequest struct {
	TurnID     string            `json:"turnId"`
	Generation int64             `json:"generation"`
	Expected   Cursor            `json:"expected"`
	Frames     []json.RawMessage `json:"frames"`
}

func decodeBounded(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxPayloadBytes+maxBatchBytes+4097))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return false
	}
	return true
}

func readTurnRequest(w http.ResponseWriter, r *http.Request) (string, JournalRequest, json.RawMessage, bool) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxPayloadBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maxPayloadBytes {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	value, _, err := parseCanonical(raw)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	object, ok := value.(map[string]any)
	if !ok {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	runID, ok := object["runId"].(string)
	if !ok || !validIdentity(runID) {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	journalValue, ok := object["journal"].(map[string]any)
	if !ok || len(journalValue) != 3 {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	version, versionOK := journalValue["version"].(json.Number)
	legID, legOK := journalValue["legId"].(string)
	token, tokenOK := journalValue["token"].(string)
	journal := JournalRequest{Version: 1, LegID: legID, Token: token}
	if !versionOK || version.String() != "1" || !legOK || !tokenOK || !validJournal(journal) {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	if _, ok := object["messages"].([]any); !ok {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	if _, ok := object["instructions"].(string); !ok {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	delete(object, "journal")
	canonical, err := canonicalValue(object)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return "", JournalRequest{}, nil, false
	}
	return runID, journal, json.RawMessage(canonical), true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeProblem(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"status": "error", "code": code})
}

func publicError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidRequest), errors.Is(err, ErrInvalidFrame):
		writeProblem(w, http.StatusBadRequest, "request_invalid")
	case errors.Is(err, ErrForbidden):
		writeProblem(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, ErrNotFound):
		writeProblem(w, http.StatusNotFound, "not-found")
	case errors.Is(err, ErrRetired):
		writeProblem(w, http.StatusGone, "retired")
	case errors.Is(err, ErrCursorConflict):
		writeProblem(w, http.StatusConflict, "cursor")
	case errors.Is(err, ErrConflict):
		writeProblem(w, http.StatusConflict, "conflict")
	case errors.Is(err, ErrTerminal):
		writeProblem(w, http.StatusConflict, "terminal")
	case errors.Is(err, ErrLimit):
		writeProblem(w, http.StatusConflict, "limit")
	case errors.Is(err, ErrCorrupt):
		writeProblem(w, http.StatusInternalServerError, "corrupt")
	default:
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
	}
}

func producerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProducerFenced), errors.Is(err, ErrNotFound):
		writeProblem(w, http.StatusUnauthorized, "producer_fenced")
	case errors.Is(err, ErrInvalidRequest), errors.Is(err, ErrInvalidFrame):
		writeProblem(w, http.StatusBadRequest, "frame_invalid")
	case errors.Is(err, ErrLimit):
		writeProblem(w, http.StatusConflict, "limit")
	case errors.Is(err, ErrConflict), errors.Is(err, ErrCursorConflict), errors.Is(err, ErrTerminal), errors.Is(err, ErrCancellationRequested):
		writeProblem(w, http.StatusConflict, "producer_conflict")
	default:
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
	}
}

func requestScope(r *http.Request) (Scope, error) {
	user := middleware.UserFromContext(r.Context())
	if user == nil || user.ID <= 0 || !validIdentity(user.Username) {
		return Scope{}, ErrForbidden
	}
	scope := Scope{UserID: user.ID, Owner: user.Username}
	if repository := middleware.RepoFromContext(r.Context()); repository != nil {
		scope.RepositoryID = repository.ID
	}
	return scope, nil
}

func (h *Handler) publicScope(w http.ResponseWriter, r *http.Request) (Scope, bool) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return Scope{}, false
	}
	scope, err := requestScope(r)
	if err != nil {
		writeProblem(w, http.StatusForbidden, "forbidden")
		return Scope{}, false
	}
	return scope, true
}

func (h *Handler) Turn(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	if h.Dispatcher == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	runID, journal, request, ok := readTurnRequest(w, r)
	if !ok {
		return
	}
	accepted, err := h.Store.Admit(r.Context(), AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: request})
	if err != nil {
		publicError(w, err)
		return
	}
	w.Header().Set(journalHeader, "1")
	if accepted.Status == "existing" {
		writeJSON(w, http.StatusOK, accepted)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeProblem(w, http.StatusInternalServerError, "storage_failed")
		return
	}
	w.Header().Set("content-type", "application/x-ndjson")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)
	encoder := json.NewEncoder(w)
	if err = encoder.Encode(Delivery{Type: "accepted", Cursor: accepted.Cursor}); err != nil {
		return
	}
	flusher.Flush()
	// Admission is visible to the renderer before any model host can start.
	// A full in-memory queue is harmless: PostgreSQL recovery owns delivery.
	h.Dispatcher.Enqueue(Candidate{Scope: scope, TurnID: accepted.TurnID})
	after := accepted.Cursor
	for {
		page, replayErr := h.Store.Replay(r.Context(), ReplayInput{Scope: scope, RunID: runID, Journal: journal, After: &after, Limit: 8})
		if replayErr != nil {
			return
		}
		for index := range page.Batches {
			batch := page.Batches[index]
			cursor := cursorAfter(batch)
			if err = encoder.Encode(Delivery{Type: "batch", Batch: &batch, Cursor: cursor}); err != nil {
				return
			}
			after = cursor
		}
		if len(page.Batches) > 0 {
			flusher.Flush()
		}
		if page.More {
			continue
		}
		if page.Terminal && sameCursor(after, page.Head) {
			terminal := true
			_ = encoder.Encode(Delivery{Type: "caught-up", Cursor: after, Terminal: &terminal})
			flusher.Flush()
			return
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-r.Context().Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (h *Handler) Replay(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	var request replayRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	page, err := h.Store.Replay(r.Context(), ReplayInput{Scope: scope, RunID: request.RunID, Journal: request.Journal, After: request.After, Limit: 8})
	if err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) Retire(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	var request replayRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	if err := h.Store.Retire(r.Context(), ReplayInput{Scope: scope, RunID: request.RunID, Journal: request.Journal}); err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "retired"})
}

func (h *Handler) Cancel(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	var request cancelRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	result, err := h.Store.Cancel(r.Context(), scope, request.RunID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		publicError(w, err)
		return
	}
	if h.Dispatcher != nil {
		for _, turnID := range result.TurnIDs {
			h.Dispatcher.CancelRunning(turnID)
		}
	}
	status := "cancelled"
	if errors.Is(err, ErrNotFound) || result.Count == 0 {
		status = "not-found"
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

func bearerToken(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("authorization"))
	if len(value) <= 7 || !strings.EqualFold(value[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(value[7:])
}

func (h *Handler) Commit(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	var request producerRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	token := bearerToken(r)
	if token == "" {
		writeProblem(w, http.StatusUnauthorized, "producer_fenced")
		return
	}
	result, err := h.Store.Commit(r.Context(), CommitInput{TurnID: request.TurnID, Generation: request.Generation, Token: token, Expected: request.Expected, Frames: request.Frames})
	if err != nil {
		producerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) ProviderStarted(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	turnID := strings.TrimSpace(r.URL.Query().Get("turnId"))
	generation, err := strconv.ParseInt(r.URL.Query().Get("generation"), 10, 64)
	if err != nil || turnID == "" || generation <= 0 || bearerToken(r) == "" {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return
	}
	if err = h.Store.MarkProviderStarted(r.Context(), ProducerGrant{TurnID: turnID, Generation: generation, Token: bearerToken(r)}); err != nil {
		producerError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MountPublic declares the exact renderer contract. The root composition owns
// shared AuthLoader/RequireAuth/RequireScope middleware and only mounts this set.
func (h *Handler) MountPublic(router chi.Router) {
	router.Post(TurnPath, h.Turn)
	router.Post(CancelPath, h.Cancel)
	router.Post(ReplayPath, h.Replay)
	router.Post(RetirePath, h.Retire)
}

// MountProducerCallbacks is for the private loopback or isolated host network.
func (h *Handler) MountProducerCallbacks(router chi.Router) {
	router.Post(CommitPath, h.Commit)
	router.Post(ProviderStartedPath, h.ProviderStarted)
}
