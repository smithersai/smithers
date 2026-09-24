# sessions/

Session minting for the GitHub Action. `handleSessions.ts` maps OIDC-token or
api-key auth to a registered repo, enforces the monthly spend cap BEFORE
claiming a quota slot, then runs `claimReviewSlot.ts` (a single conditional
INSERT, race-safe) and `mintSession.ts` (hashed `srs_` token, 2h TTL).

- `verifyOidc.ts` — full RS256 JWKS verification of GitHub Actions OIDC
  tokens, with tagged failure reasons.
- `fetchJwks.ts` + `jwksCache.ts` — 10-minute in-memory JWKS cache. An unknown
  non-empty `kid` bypasses the TTL once, with concurrent refreshes coalesced
  and miss-triggered requests limited to one per JWKS URL every five seconds.
  Entries for other algorithms or non-signing uses are ignored; every RS256
  candidate must be importable before a refresh can replace the last good
  keys. Failed or malformed refreshes retain those keys and back off all
  refresh paths for five seconds; cached network/HTTP/JSON errors are rethrown
  during that window. Tests clear the exported map.
- `lookupApiKey.ts` / `lookupRepo.ts` — hashed-key and repo-registration
  lookups.

Ordering invariant: comment-mode refusal, then spend-cap check, then quota
claim, then mint — so a blocked request never consumes a quota slot, and a
crash after claiming charges quota without leaking inference. A `comment`
mode repo answers 409 `comment-mode` to any OIDC token whose `event_name` is
not `issue_comment`.
