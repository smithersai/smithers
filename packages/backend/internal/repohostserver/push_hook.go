package repohostserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
)

// pushHookDeliveryTimeout bounds each individual push-hook callback. Every
// payload gets its own budget so a large stacked push cannot exhaust a shared
// deadline partway through and silently drop the remaining refs.
const pushHookDeliveryTimeout = 10 * time.Second

// deliverPushHooks sends one callback per changed ref. Deliveries are
// independent: a failure for one ref is logged and never skips the remaining
// refs, since each ref's webhook/config-sync/workflow dispatch stands alone.
func deliverPushHooks(client *http.Client, cfg Config, logger *slog.Logger, payloads []PushHookPayload) {
	for _, payload := range payloads {
		ctx, cancel := context.WithTimeout(context.Background(), pushHookDeliveryTimeout)
		err := sendPushHook(ctx, client, cfg, payload)
		cancel()
		if err != nil && logger != nil {
			logger.Warn("push hook callback failed", "ref_name", payload.RefName, "error", err)
		}
	}
}

type PushHookPayload struct {
	Owner       string `json:"owner"`
	Repo        string `json:"repo"`
	RefName     string `json:"ref_name"`
	CommitSHA   string `json:"commit_sha"`
	PusherID    int64  `json:"pusher_id"`
	PusherLogin string `json:"pusher_login"`
}

type PushHookSender struct {
	PusherID    int64
	PusherLogin string
}

func sendPushHook(ctx context.Context, client *http.Client, cfg Config, payload PushHookPayload) error {
	if cfg.PushHookCallbackURL == "" {
		return nil
	}
	if cfg.PushHookCallbackToken == "" {
		return fmt.Errorf("push hook callback token is not configured")
	}

	body := mustMarshalJSON(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.PushHookCallbackURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create push hook request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.PushHookCallbackToken)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("send push hook callback request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound && repositoryNotFound(resp) {
		// The repository was deleted after the push; nothing to dispatch.
		return nil
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("push hook callback returned status %d", resp.StatusCode)
	}

	return nil
}

// repositoryNotFound reports whether a 404 carries the API's typed not_found
// code. Any other 404 (a wrong callback path, or an API that did not register
// the push-hook route) is a failed delivery, not a deleted repository.
func repositoryNotFound(resp *http.Response) bool {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body); err != nil {
		return false
	}
	return body.Code == "not_found"
}

func mustMarshalJSON(v any) []byte {
	body, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("marshal json: %v", err))
	}
	return body
}

func pushHookClient() *http.Client {
	return observability.NewHTTPClient(10 * time.Second)
}

func pushHookSenderFromHeaders(headers http.Header) PushHookSender {
	var pusherID int64
	if value := headers.Get("X-Smithers-Pusher-Id"); value != "" {
		_, _ = fmt.Sscan(value, &pusherID)
	}
	return PushHookSender{
		PusherID:    pusherID,
		PusherLogin: headers.Get("X-Smithers-Pusher-Login"),
	}
}

func pushHookPayloadsFromRefDiff(beforeRefs, afterRefs map[string]string, owner, repo string, sender PushHookSender) []PushHookPayload {
	refSet := make(map[string]struct{}, len(beforeRefs)+len(afterRefs))
	for refName := range beforeRefs {
		refSet[refName] = struct{}{}
	}
	for refName := range afterRefs {
		refSet[refName] = struct{}{}
	}

	refNames := make([]string, 0, len(refSet))
	for refName := range refSet {
		refNames = append(refNames, refName)
	}
	sort.Strings(refNames)

	payloads := make([]PushHookPayload, 0, len(refNames))
	for _, refName := range refNames {
		// refs/jj/* (especially refs/jj/keep/*) are implementation details that
		// can change in bulk during one push. They are not user push events and
		// must not trigger webhooks or workflows. Match Git hosting semantics by
		// publishing only branch and tag updates.
		if !strings.HasPrefix(refName, "refs/heads/") && !strings.HasPrefix(refName, "refs/tags/") {
			continue
		}
		beforeSHA, hadBefore := beforeRefs[refName]
		afterSHA, hadAfter := afterRefs[refName]
		if hadBefore == hadAfter && beforeSHA == afterSHA {
			continue
		}
		payloads = append(payloads, PushHookPayload{
			Owner:       owner,
			Repo:        repo,
			RefName:     refName,
			CommitSHA:   afterSHA,
			PusherID:    sender.PusherID,
			PusherLogin: sender.PusherLogin,
		})
	}

	return payloads
}
