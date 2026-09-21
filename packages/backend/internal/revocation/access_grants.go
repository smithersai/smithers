package revocation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"strconv"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

const accessGrantRevokeTimeout = 4 * time.Second

// NewAccessGrantHandler builds the fast bus callback that invalidates
// controller-side SSH grants for every sandbox concretely named by an event.
// The controller mutation runs asynchronously because Bus subscribers must not
// block delivery to SSE, terminal, SSH, and relay consumers.
func NewAccessGrantHandler(ctx context.Context, revoker sandbox.AccessGrantRevoker) func(Event) {
	return func(event Event) {
		if revoker == nil || len(event.SandboxIDs) == 0 {
			return
		}
		ids := uniqueSandboxIDs(event.SandboxIDs)
		for _, sandboxID := range ids {
			sandboxID := sandboxID
			go func() {
				revokeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), accessGrantRevokeTimeout)
				revokeCtx = sandbox.WithIdempotencyKey(revokeCtx, accessGrantIdempotencyKey(event, sandboxID))
				err := revoker.RevokeAccessGrant(revokeCtx, sandboxID)
				cancel()
				if err != nil {
					slog.Error("sandbox access-grant revocation failed", "kind", event.Kind, "event_id", event.ID, "sandbox_id", sandboxID, "error", err)
				}
			}()
		}
	}
}

func uniqueSandboxIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func accessGrantIdempotencyKey(event Event, sandboxID string) string {
	digest := sha256.Sum256([]byte(strconv.FormatInt(event.ID, 10) + "\x00" + string(event.Kind) + "\x00" + sandboxID))
	return "revocation-access-" + hex.EncodeToString(digest[:16])
}
