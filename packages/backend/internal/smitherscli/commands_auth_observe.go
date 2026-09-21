package smitherscli

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

func validObserveNonce(value string) bool {
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(b) == 32
}

// openObserveSession binds a one-use ticket to a verifier generated in the
// destination browser tab. Neither the PAT nor the verifier enters a URL.
func openObserveSession(base, token string) error {
	if err := validateObserveURL(base); err != nil {
		return err
	}
	base = strings.TrimRight(base, "/")
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	state := base64.RawURLEncoding.EncodeToString(nonce[:])
	listener, err := authListen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	origin := "http://" + listener.Addr().String()
	_, port, _ := strings.Cut(listener.Addr().String(), ":")
	done := make(chan error, 1)
	var mu sync.Mutex
	finished := false
	mux := http.NewServeMux()
	mux.HandleFunc("/observe", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
		if "http://"+r.Host != origin {
			http.Error(w, "invalid callback host", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, observeBridgeHTML)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("Origin") != origin || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "invalid callback origin", http.StatusForbidden)
			return
		}
		var payload struct {
			State     string `json:"state"`
			Challenge string `json:"challenge"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&payload); err != nil ||
			subtle.ConstantTimeCompare([]byte(payload.State), []byte(state)) != 1 || !validObserveNonce(payload.Challenge) {
			http.Error(w, "invalid callback state", http.StatusForbidden)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if finished {
			http.Error(w, "sign-in already completed", http.StatusConflict)
			return
		}
		finished = true
		ticket, err := issueObserveHandoff(r.Context(), base, token, payload.Challenge)
		if err != nil {
			http.Error(w, "Observe sign-in failed. Return to the terminal.", http.StatusBadGateway)
			done <- err
			return
		}
		destination := base + "/login/cli#" + url.Values{"state": {state}, "ticket": {ticket}}.Encode()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"url": destination})
		done <- nil
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 35 * time.Second}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = server.Close()
	}()
	go func() { _ = server.Serve(listener) }()
	start := base + "/login/cli#" + url.Values{"state": {state}, "port": {port}}.Encode()
	fmt.Fprintln(os.Stderr, "Opening Smithers Observe…")
	if err := authOpenBrowser(start); err != nil {
		// The fallback contains only a fresh state and loopback port, never a PAT.
		fmt.Fprintf(os.Stderr, "Open this URL in your browser to finish:\n%s\n", start)
	}
	timer := time.NewTimer(browserLoginTimeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		return fmt.Errorf("timed out opening Observe; run smithers auth login --observe again")
	}
}

func issueObserveHandoff(ctx context.Context, base, token, challenge string) (string, error) {
	body, _ := json.Marshal(map[string]string{"challenge": challenge})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v1/auth/browser-handoff", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("invalid Observe URL")
	}
	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach Observe")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("browser sign-in rejected by Observe (HTTP %d); check observe_url and admin access", response.StatusCode)
	}
	var result struct {
		Ticket string `json:"ticket"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result) != nil || !validObserveNonce(result.Ticket) {
		return "", fmt.Errorf("invalid sign-in ticket returned by Observe")
	}
	return result.Ticket, nil
}

const observeBridgeHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Opening Observe</title></head><body><p id="status">Opening Smithers Observe…</p><script>
(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  try {
    const response = await fetch("/observe", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({state: params.get("state"), challenge: params.get("challenge")})});
    if (!response.ok) throw new Error("Sign-in failed. Return to the terminal and run the command again.");
    const result = await response.json();
    location.replace(result.url);
  } catch (error) { document.getElementById("status").textContent = error.message; }
})();
</script></body></html>`
