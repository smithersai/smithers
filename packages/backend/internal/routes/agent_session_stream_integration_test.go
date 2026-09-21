//go:build integration
// +build integration

package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestAgentSessionStream_LiveRouteStreamsNotifyAndReplaysOnReconnect(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "agent_sse_user")
	repo := routesIntegrationCreateRepo(t, pool, user, "agent_sse_repo", false)
	sessionID := uuid.NewString()
	session, err := queries.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repo.ID,
		UserID:       user.ID,
		Title:        "Agent SSE route integration",
		Status:       "active",
	})
	require.NoError(t, err)

	service := services.NewAgentServiceWithPool(queries, pool, services.WithAgentDispatchQuerier(queries))
	server, _ := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		agentSessionStreamService: service,
		agentSessionStreamPool:    pool,
	})
	client := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))
	streamPath := fmt.Sprintf("/api/repos/%s/%s/agent/sessions/%s/stream", repo.Owner, repo.Name, session.ID)

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+streamPath, nil)
	require.NoError(t, err)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	defer cancel()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "text/event-stream")
	liveReader := bufio.NewReader(resp.Body)

	liveMessage, err := service.AppendMessage(context.Background(), session.ID, "assistant", []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`{"text":"live-route"}`)},
	})
	require.NoError(t, err)

	liveFrame := readAgentSSEFrameFromReader(t, liveReader, resp.Body, 3*time.Second)
	assert.Equal(t, fmt.Sprint(liveMessage.ID), liveFrame["id"])
	assert.Equal(t, "agent.session", liveFrame["event"])
	liveEvent := decodeAgentSessionSSEEvent(t, liveFrame)
	assert.Equal(t, "message", liveEvent.Action)
	require.NotNil(t, liveEvent.Message)
	assert.Equal(t, liveMessage.ID, liveEvent.Message.ID)
	assert.Contains(t, liveFrame["data"], `"live-route"`)

	cancel()
	_ = resp.Body.Close()

	missedMessage, err := service.AppendMessage(context.Background(), session.ID, "assistant", []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`{"text":"replayed-route"}`)},
	})
	require.NoError(t, err)

	replayCtx, replayCancel := context.WithCancel(context.Background())
	replayReq, err := http.NewRequestWithContext(replayCtx, http.MethodGet, server.URL+streamPath, nil)
	require.NoError(t, err)
	replayReq.Header.Set("Accept", "text/event-stream")
	replayReq.Header.Set("Last-Event-ID", fmt.Sprint(liveMessage.ID))
	replayResp, err := client.Do(replayReq)
	require.NoError(t, err)
	defer replayResp.Body.Close()
	defer replayCancel()

	require.Equal(t, http.StatusOK, replayResp.StatusCode)
	assert.Contains(t, replayResp.Header.Get("Content-Type"), "text/event-stream")
	replayReader := bufio.NewReader(replayResp.Body)

	replayFrame := readAgentSSEFrameFromReader(t, replayReader, replayResp.Body, 3*time.Second)
	assert.Equal(t, fmt.Sprint(missedMessage.ID), replayFrame["id"])
	assert.Equal(t, "agent.session", replayFrame["event"])
	replayEvent := decodeAgentSessionSSEEvent(t, replayFrame)
	assert.Equal(t, "message", replayEvent.Action)
	require.NotNil(t, replayEvent.Message)
	assert.Equal(t, missedMessage.ID, replayEvent.Message.ID)
	assert.Contains(t, replayFrame["data"], `"replayed-route"`)

	require.NoError(t, service.IngestRunnerEvent(context.Background(), services.IngestRunnerEventInput{
		SessionID: session.ID,
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	}))

	statusFrame := readAgentSSEFrameWithAction(t, replayReader, replayResp.Body, "status", 3*time.Second)
	assert.Equal(t, "agent.session", statusFrame["event"])
	assert.Empty(t, statusFrame["id"])
	statusEvent := decodeAgentSessionSSEEvent(t, statusFrame)
	assert.Equal(t, session.ID, statusEvent.SessionID)
	assert.Equal(t, "status", statusEvent.Action)
	assert.Equal(t, "completed", statusEvent.Status)
}

func decodeAgentSessionSSEEvent(t *testing.T, frame map[string]string) services.AgentSessionEvent {
	t.Helper()

	var event services.AgentSessionEvent
	require.NoError(t, json.Unmarshal([]byte(frame["data"]), &event))
	return event
}

func readAgentSSEFrameWithAction(t *testing.T, reader *bufio.Reader, closer io.Closer, action string, timeout time.Duration) map[string]string {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			_ = closer.Close()
			t.Fatalf("timed out waiting for agent session SSE action %q after %s", action, timeout)
		}

		frame := readAgentSSEFrameFromReader(t, reader, closer, remaining)
		event := decodeAgentSessionSSEEvent(t, frame)
		if event.Action == action {
			return frame
		}
	}
}

func readAgentSSEFrame(t *testing.T, body io.ReadCloser, timeout time.Duration) map[string]string {
	t.Helper()
	return readAgentSSEFrameFromReader(t, bufio.NewReader(body), body, timeout)
}

func readAgentSSEFrameFromReader(t *testing.T, reader *bufio.Reader, closer io.Closer, timeout time.Duration) map[string]string {
	t.Helper()

	type result struct {
		frame map[string]string
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		frame, err := readAgentSSEFrameBlocking(reader)
		ch <- result{frame: frame, err: err}
	}()

	select {
	case got := <-ch:
		require.NoError(t, got.err)
		return got.frame
	case <-time.After(timeout):
		_ = closer.Close()
		t.Fatalf("timed out waiting for agent session SSE frame after %s", timeout)
	}
	return nil
}

func readAgentSSEFrameBlocking(reader *bufio.Reader) (map[string]string, error) {
	frame := map[string]string{}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			if len(frame) == 0 {
				continue
			}
			return frame, nil
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		frame[key] = strings.TrimPrefix(value, " ")
	}
}
