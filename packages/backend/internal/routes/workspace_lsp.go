package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// LSPWebSocket handles GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/lsp
// (#505, RFD-005): it relays one language server's stdio inside the workspace
// as JSON-RPC 2.0 over a WebSocket with subprotocol `lsp`.
//
// It mirrors TerminalWebSocket step for step. Before the upgrade: Origin
// (cookie and ticket principals), auth, repository, session lookup, kind and
// language checks, session status (409 failed/stopped, 425 pending), the
// per-user active cap (429), SSH connection info, then the language server
// is launched over SSH and its ready line read, so a missing binary answers
// 409 language_server_missing with the install line and never a 101.
//
// Wire: one JSON-RPC message per text frame, 1 MiB per frame, larger
// messages as {seq,last,data} fragments; server pings every 30 s.
// Close codes: 1000 final (`language_server_exited: 0`, `language_server_idle`,
// client closed), 1001 reconnect (client too slow), 1008 revoked, 1011
// retry once (`language_server_exited: <code>`), 1002/1003/1009 client
// protocol faults (final).
func (h *WorkspaceTerminalHandler) LSPWebSocket(w http.ResponseWriter, r *http.Request) {
	authInfo := middleware.AuthInfoFromContext(r.Context())
	isTicketAuth := strings.TrimSpace(r.URL.Query().Get("ticket")) != ""
	if authInfo == nil || !authInfo.IsTokenAuth || h.hasSessionCookie(r) || isTicketAuth {
		origin := r.Header.Get("Origin")
		if !h.checkOrigin(origin, r) {
			slog.Warn("websocket origin rejected",
				"origin", origin,
				"remote_addr", r.RemoteAddr,
				"path", r.URL.Path,
			)
			if h.Metrics != nil {
				h.Metrics.IncWebSocketOriginRejection()
			}
			pkgerrors.WriteError(w, pkgerrors.Forbidden("origin not allowed"))
			return
		}
	}

	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	observe := func(result string) {
		if h.Metrics != nil {
			h.Metrics.ObserveWorkspaceLSPAttach(result)
		}
	}

	session, svcErr := h.Service.GetSession(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		observe("session_error")
		writeRouteError(w, r, svcErr)
		return
	}
	if session.Kind != services.WorkspaceSessionKindLSP {
		observe("kind_mismatch")
		pkgerrors.WriteError(w, &pkgerrors.APIError{
			Status:  http.StatusConflict,
			Code:    services.CodeWorkspaceSessionKindMismatch,
			Message: "workspace session is a " + session.Kind + " session; create one with kind lsp",
		})
		return
	}
	if want := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("language"))); want != "" && want != session.Language {
		observe("language_mismatch")
		pkgerrors.WriteError(w, pkgerrors.BadRequest("language "+want+" does not match the session's language "+session.Language))
		return
	}
	switch strings.ToLower(strings.TrimSpace(session.Status)) {
	case "running":
	case "failed":
		observe("session_failed")
		pkgerrors.WriteError(w, pkgerrors.Conflict("workspace session provisioning failed; create a new session and retry"))
		return
	case "stopped":
		observe("session_stopped")
		pkgerrors.WriteError(w, pkgerrors.Conflict("workspace session is stopped; create a new session and retry"))
		return
	default:
		observe("session_pending")
		w.Header().Set("Retry-After", "2")
		pkgerrors.WriteError(w, &pkgerrors.APIError{
			Status:  http.StatusTooEarly,
			Code:    pkgerrors.CodeWorkspaceSessionPending,
			Message: "workspace session is still provisioning",
		})
		return
	}

	// Same per-user active cap as terminals, reserved before any SSH work.
	if h.ActiveConnections != nil && !h.ActiveConnections.Acquire(user.ID) {
		slog.Warn("workspace lsp active-connection cap exceeded",
			"scope", "workspace_terminal_active",
			"user_id", user.ID,
			"session_id", sessionID,
			"hit_type", "active_cap",
			"max", h.ActiveConnections.Max(),
		)
		observe("active_cap")
		resetAt := time.Now().UTC().Add(time.Second)
		limit := h.ActiveConnections.Max()
		remaining := 0
		w.Header().Set("Retry-After", "1")
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(resetAt.Unix(), 10))
		pkgerrors.WriteError(w, &pkgerrors.APIError{
			Status:    http.StatusTooManyRequests,
			Code:      pkgerrors.CodeRateLimitExceeded,
			Message:   "too many active terminal and language-server connections",
			Limit:     &limit,
			Remaining: &remaining,
		})
		return
	}
	defer func() {
		if h.ActiveConnections != nil {
			h.ActiveConnections.Release(user.ID)
		}
	}()

	sshInfo, svcErr := h.Service.GetSSHConnectionInfo(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		observe("ssh_info_error")
		writeRouteError(w, r, svcErr)
		return
	}
	launch, svcErr := h.Service.ResolveLanguageServer(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		observe("resolve_error")
		writeRouteError(w, r, svcErr)
		return
	}

	slog.Info("workspace lsp websocket upgrade",
		"session_id", sessionID,
		"user_id", user.ID,
		"workspace_id", sshInfo.WorkspaceID,
		"vm_id", sshInfo.VMID,
		"language", launch.Language,
	)

	manager := h.lspSessionManager()
	lspSess, err := manager.start(r.Context(), sessionID, sshInfo, launch)
	if err != nil {
		switch {
		case errors.Is(err, errLanguageServerMissing):
			observe("language_server_missing")
			writeRouteError(w, r, services.LanguageServerMissing(launch.Spec))
		default:
			var startErr *lspStartError
			if errors.As(err, &startErr) {
				slog.Error("language server exited before ready", "session_id", sessionID, "language", launch.Language, "exit_status", startErr.code, "stderr", startErr.stderr)
				observe("start_error")
				pkgerrors.WriteError(w, pkgerrors.Internal("language server failed to start"))
				return
			}
			slog.Error("language server start failed", "error", err, "session_id", sessionID, "language", launch.Language)
			observe("backend_error")
			writeRouteError(w, r, err)
		}
		return
	}

	activityCh := make(chan struct{}, 8)
	notifyActivity := func() {
		select {
		case activityCh <- struct{}{}:
		default:
		}
	}

	wsConn, wsErr := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		Subprotocols:       []string{"lsp"},
	})
	if wsErr != nil {
		slog.Error("websocket accept failed", "error", wsErr, "session_id", sessionID)
		observe("accept_error")
		lspSess.destroy(websocket.StatusInternalError, "websocket accept failed")
		return
	}
	defer func() { _ = wsConn.CloseNow() }()
	wsConn.SetReadLimit(lspMaxMessageBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	if err := lspSess.attach(wsConn, notifyActivity); err != nil {
		observe("attach_error")
		_ = wsConn.Close(websocket.StatusInternalError, "failed to attach language server")
		return
	}
	observe("success")

	principal := requestPrincipal(r, revocation.Principal{
		RepositoryID: repoCtx.Repository.ID,
		WorkspaceID:  sshInfo.WorkspaceID,
		SandboxID:    sshInfo.VMID,
	})
	lspSess.setPrincipal(principal)
	if source := currentRevocationSource(); source != nil {
		revoked := source.Watch(ctx, principal)
		go func() {
			select {
			case ev := <-revoked:
				reason := "access revoked"
				if ev.Reason != "" {
					reason += ": " + ev.Reason
				}
				lspSess.destroy(websocket.StatusPolicyViolation, reason)
				cancel()
			case <-ctx.Done():
			}
		}()
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(terminalKeepAliveInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := wsConn.Ping(ctx); err != nil {
					return
				}
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(terminalActivityRefreshInterval)
		defer ticker.Stop()
		pending := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-activityCh:
				if !pending {
					if touchErr := h.Service.TouchSessionActivity(ctx, sessionID); touchErr != nil {
						slog.Debug("touch session activity failed", "error", touchErr, "session_id", sessionID)
					}
					pending = true
				}
			case <-ticker.C:
				if pending {
					if touchErr := h.Service.TouchSessionActivity(ctx, sessionID); touchErr != nil {
						slog.Debug("touch session activity failed", "error", touchErr, "session_id", sessionID)
					}
					pending = false
				}
			}
		}
	}()

	lspSess.run(ctx)
	cancel()
	wg.Wait()

	code, reason := lspSess.closeStatus()
	slog.Info("workspace lsp websocket closed",
		"session_id", sessionID,
		"user_id", user.ID,
		"language", launch.Language,
		"close_code", int(code),
		"close_reason", reason,
	)
}

func (h *WorkspaceTerminalHandler) lspSessionManager() *LSPSessionManager {
	h.managerMu.Lock()
	defer h.managerMu.Unlock()
	if h.LSPSessions == nil {
		h.LSPSessions = NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
			client, sess, err := h.dialSSH(info, 0, 0)
			if err != nil {
				return nil, nil, err
			}
			return client, sess, nil
		})
		if source := currentRevocationSource(); source != nil {
			source.Subscribe(h.LSPSessions.RevokeMatching)
		}
	}
	return h.LSPSessions
}
