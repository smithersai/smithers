# OIDC session verification

`POST /api/sessions` verifies GitHub Actions RS256 tokens against the issuer's
JWKS. The token's `kid` must identify a trusted signing key. Claims are checked
only after the signature verifies.

Signature decoding failures return HTTP 401 with `{"error":"oidc: malformed"}`.
Forged signatures, payload tampering, and cryptographic verification errors
return HTTP 401 with `{"error":"oidc: bad-signature"}`. Rejected tokens create
neither a session nor a `reviewed_prs` quota row.

Each JWKS request has a five-second deadline covering fetch and JSON body
consumption. A timeout aborts the request, releases all callers awaiting that
refresh, and returns HTTP 503 with `{"error":"oidc: jwks-unavailable"}`.
Network, HTTP, and JSON parsing failures use the same unavailable outcome.

JWKS keys remain cached for ten minutes. Refreshes for a URL share one request.
Failures use the existing five-second cooldown measured from the refresh's
start time. Once that cooldown expires, a subsequent request may retry.
A timed-out request cannot replace cached keys if its body completes later.


Registration binds `repositoryId` and `ownerId` to GitHub's immutable numeric
IDs. Both are required on `POST /api/admin/repos`, alongside the plan fields.
OIDC sessions require matching `repository_id` and `repository_owner_id`
claims. A mismatch returns 403; missing identity claims return 401. A legacy
registration without IDs returns 503 until an operator backfills it. Refusals
consume neither quota nor sessions.

Apply migration `0002_repository_identity.sql` before the Worker update, then
backfill registrations with IDs verified through GitHub. Resolve any existing
case-duplicate names before creating the unique name index, preserving usage,
quota and reservation records. New names are lowercase; existing stored keys
remain unchanged so case variants cannot reset billing. Registration updates
cannot rebind an existing repository or owner ID. Repository renames/transfers
require an operator migration preserving accounting and revoking old sessions.
