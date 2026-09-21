//go:build integration

package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestNotificationFactsHTTPBaselineLiveReadAndPagedReplay(t *testing.T) {
	f := setupSSETicketRevocationFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	user := routesIntegrationCreateUser(t, f.pool, "facts_recipient")
	owner := routesIntegrationCreateUser(t, f.pool, "facts_owner")
	repo := routesIntegrationCreateRepo(t, f.pool, owner, "facts_public", true)
	issue, err := f.queries.CreateIssue(ctx, db.CreateIssueParams{RepositoryID: repo.ID, AuthorID: owner.ID, Title: "Source"})
	require.NoError(t, err)
	client := routesIntegrationAuthenticatedClient(t, f.server, routesIntegrationCreateSessionCookie(t, f.queries, user))
	// One accepted transaction exceeds the maximum durable page size. The
	// trigger journals every row and commits all facts before the stream opens.
	_, err = f.pool.Exec(ctx, `INSERT INTO notifications(user_id,source_type,source_id,subject) SELECT $1,'issue',$2,'notice ' || n FROM generate_series(1,1005) n`, user.ID, issue.ID)
	require.NoError(t, err)
	open := func(after int64) (*http.Response, *bufio.Reader) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+"/api/notifications/events/stream", nil)
		require.NoError(t, err)
		if after > 0 {
			req.Header.Set("Last-Event-ID", fmt.Sprint(after))
		}
		resp, err := client.Do(req)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		return resp, bufio.NewReader(resp.Body)
	}
	resp, reader := open(0)
	defer resp.Body.Close()
	read := func(sequence int64) services.NotificationFact {
		frame := readAgentSSEFrameFromReader(t, reader, resp.Body, 3*time.Second)
		require.Equal(t, fmt.Sprint(sequence), frame["id"])
		require.Equal(t, "notification.fact", frame["event"])
		var fact services.NotificationFact
		require.NoError(t, json.Unmarshal([]byte(frame["data"]), &fact))
		require.Equal(t, sequence, fact.Sequence)
		require.Equal(t, fmt.Sprintf("notifications:%d", user.ID), fact.StreamID)
		return fact
	}
	var first services.NotificationFact
	for sequence := int64(1); sequence <= 1005; sequence++ {
		fact := read(sequence)
		require.Equal(t, "notification.created", fact.Type)
		if sequence == 1 {
			first = fact
		}
	}
	marked := routesIntegrationDoRequest(t, client, f.server.URL, http.MethodPatch, fmt.Sprintf("/api/notifications/%d", first.NotificationID), nil)
	_ = routesIntegrationReadBody(t, marked)
	require.Equal(t, http.StatusNoContent, marked.StatusCode)
	live := read(1006)
	require.Equal(t, "notification.read", live.Type)
	require.Equal(t, first.NotificationID, live.NotificationID)
	require.Equal(t, "read", live.Notification.Status)
	require.NotNil(t, live.Notification.ReadAt)
	require.NoError(t, resp.Body.Close())

	marked = routesIntegrationDoRequest(t, client, f.server.URL, http.MethodPut, "/api/notifications/mark-read", nil)
	_ = routesIntegrationReadBody(t, marked)
	require.Equal(t, http.StatusNoContent, marked.StatusCode)
	resp, reader = open(1006)
	defer resp.Body.Close()
	for sequence := int64(1007); sequence <= 2010; sequence++ {
		require.Equal(t, "notification.read", read(sequence).Type)
	}
	require.NoError(t, resp.Body.Close())

	// Independent REST pages have the same stable identities and rebuild all
	// final read states. No application-side journal copy supplies these pages.
	var facts []services.NotificationFact
	var cursor int64
	for {
		response := routesIntegrationDoRequest(t, client, f.server.URL, http.MethodGet, fmt.Sprintf("/api/notifications/events?after=%d&limit=1000", cursor), nil)
		require.Equal(t, http.StatusOK, response.StatusCode)
		var page services.NotificationFactPage
		routesIntegrationDecodeJSON(t, response, &page)
		require.False(t, page.VisibilityFiltered)
		facts = append(facts, page.Events...)
		cursor = page.Cursor
		if !page.HasMore {
			break
		}
	}
	require.Equal(t, first.ID, facts[0].ID)
	projection, err := services.RebuildNotificationProjection(facts)
	require.NoError(t, err)
	require.Equal(t, int64(2010), projection.Cursor)
	require.Len(t, projection.Notifications, 1005)
	for _, value := range projection.Notifications {
		require.Equal(t, "read", value.Status)
	}
	// Visibility is deliberately an external input. A private-source change
	// must prevent disclosure of every retained historical snippet on replay.
	_, err = f.pool.Exec(ctx, `UPDATE repositories SET is_public=false WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	response := routesIntegrationDoRequest(t, client, f.server.URL, http.MethodGet, "/api/notifications/events?after=0", nil)
	require.Equal(t, http.StatusOK, response.StatusCode)
	var hidden services.NotificationFactPage
	routesIntegrationDecodeJSON(t, response, &hidden)
	require.Empty(t, hidden.Events)
	require.True(t, hidden.VisibilityFiltered)
	require.True(t, hidden.HasMore)
	require.Equal(t, int64(1000), hidden.Cursor)
	otherClient := routesIntegrationAuthenticatedClient(t, f.server, routesIntegrationCreateSessionCookie(t, f.queries, owner))
	response = routesIntegrationDoRequest(t, otherClient, f.server.URL, http.MethodGet, fmt.Sprintf("/api/notifications/events?user_id=%d", user.ID), nil)
	var other services.NotificationFactPage
	routesIntegrationDecodeJSON(t, response, &other)
	require.Empty(t, other.Events)
	require.Zero(t, other.Head)
}
