# Repository clone admission and complete layout audits

Status: accepted
Date: 2026-10-28

AUTH-8 requires Member access on the repository being cloned. The repository
header waits for that repository's role answer before offering Clone or Try
again. Readers see Members can clone. A ready copy stays readable. A failed
role lookup offers no clone action and does not claim the person is a reader.
The browser action also refuses a known insufficient role, records its admission
outcome and counts the click, without dispatching or sending a request. The
server remains authoritative when a role changes after the answer. Failed
authority preserves the previous clone state, records unavailable, and allows
retry after a successful role refresh.

The mobile layout audit measures all current controls in one browser turn.
It retains every target-size, viewport, hit-test and clipping check and records
selected and checked counts. This avoids thousands of protocol round trips and
index changes during a live list update. Signed-in Issues must finish their real initial
sync before the audit, including metadata, triage, pending writes and authorized
TODO snapshots and their applied receipts (decoding and persistence), before
rendering is measured. A passing empty loading shell cannot prove list layout.

Catalog: ui, flow, effect-tanstack-db. No new dependency or public SDK interface.
