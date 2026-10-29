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

The Chromium desktop CSS comparison uses bounded 8,192px PNG clips, with a
coordinate manifest covering the entire document at its full width. WebKit retains its strict
full-document capture. The two passes share the same applied snapshot barrier
and original scroll position; scrolling each clip would repeat fixed overlays
and conceal document pixels at clip boundaries. Every PNG byte, document
dimension and text check remains strict, and CSS and scroll restore on failure.
No masks, pixel tolerance or deadline changes. The existing 10-second stable
window bounds each capture and paint wait, stops work at expiry and awaits
restoration before returning; a real stalled-font regression checks that no
capture resumes after the failed comparison has returned. Expiry preserves
the last substantive pixel or content failure.

A 1280×254435 Chromium full-document capture omitted rectangular raster patches
at rows 103633–104141. A repeated production comparison reproduced those exact
rows while all 32 nearby rows retained identical markup, attributes, bounds and
computed styles before and after each capture. Fonts were ready before both
captures. This is capture evidence; no product settling behavior changes. A
static replay with a slightly different document height did not reproduce it.
The bounded Chromium clips are checked scanline by scanline at the failing
height, with stripe/last-row text compared against visible element captures.
Regressions still reject a CSS change concealed by a fixed header, changing
content, changing document dimensions and missing comparison rules.
