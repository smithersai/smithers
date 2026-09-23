package routes

import (
	"encoding/json"
	"net/http"
)

// PublicRepositoryCatalog is deployment neutral. Hosted Plue may replace the
// catalog at its edge; a standalone backend still exposes its own repository.
func PublicRepositoryCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"repos": []map[string]string{{
			"name":    "smithersai/smithers",
			"title":   "Smithers",
			"url":     "https://github.com/smithersai/smithers",
			"summary": "Smithers is a durable workflow framework that lets agents plan, run, and review changes to a code repository.",
		}},
		"comingSoon": []any{},
	})
}

// Recommend is the honest fallback when no recommender provider is composed.
// The client already computes rule suggestions locally.
func Recommend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"id":"shared-backend","commands":[],"model":"none"}`))
}

// RecommendOutcome accepts the receipt sent after a user chooses a suggestion.
func RecommendOutcome(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ModelStream is the sealed author stream used by conversation summarization.
// The shared product has no second provider relay; an empty notes document is
// a valid summary and keeps the local path deterministic when no relay is
// composed.
func ModelStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	_, _ = w.Write([]byte("{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"{\\\"notes\\\":[]}\"}\n{\"type\":\"done\",\"reason\":\"stop\"}\n"))
}
