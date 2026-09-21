package pairauth

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ShareQuerier is the minimal database surface AuthorizeRoom needs to resolve a
// Pair share token. It is satisfied by *db.Queries. The query only yields live
// (non-revoked, non-expired) links — see
// GetPairShareLinkByTokenHash in db/queries/pair.sql — so a miss (any error)
// means "no valid grant".
//
// internal/db does not import internal/pairauth, so depending on db here is
// cycle-free.
type ShareQuerier interface {
	GetPairShareLinkByTokenHash(ctx context.Context, tokenHash string) (db.PairShareLink, error)
}

// Decision is the outcome of authorizing a Pair request against the configured
// env keys and the share-link table. It distinguishes an unauthenticated
// request (no valid grant → 401) from an authenticated-but-underprivileged one
// (valid grant, insufficient level → 403).
type Decision int

const (
	// DecisionDeny: no valid credential at all — caller should 401.
	DecisionDeny Decision = iota
	// DecisionForbid: a valid grant exists but its level is insufficient for
	// the requested operation — caller should 403.
	DecisionForbid
	// DecisionAllow: the request is authorized.
	DecisionAllow
)

// AuthorizeRoom decides whether a request may act on `room` at (at least) the
// `want` level. Authorization is granted by EITHER:
//   - a configured env access key (SMITHERS_PAIR_ACCESS_KEYS) — global,
//     edit-level, and the dev "open mode" when no keys are configured; or
//   - a live DB share token bound to `room` whose level satisfies `want`.
//
// A DB token bound to a different room, or no/unknown/revoked/expired token,
// yields DecisionDeny (401). A valid token for the right room but too low a
// level yields DecisionForbid (403).
func AuthorizeRoom(ctx context.Context, q ShareQuerier, r *http.Request, envKeys []string, room string, want Level) Decision {
	key := RequestKey(r)

	// Env key path: matches (or open mode) grant full edit access to any room.
	if AuthorizedKey(key, envKeys) {
		return DecisionAllow
	}

	if key == "" || q == nil {
		return DecisionDeny
	}

	link, err := q.GetPairShareLinkByTokenHash(ctx, TokenHash(key))
	if err != nil {
		return DecisionDeny
	}
	if link.RoomID != room {
		return DecisionDeny
	}
	if LevelSatisfies(Level(link.Level), want) {
		return DecisionAllow
	}
	return DecisionForbid
}
