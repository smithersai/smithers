---
title: W19 production followups
status: in-progress
area: app
owner: codex-w19-followups
updated: 2026-10-28
links: []
---

Resolve the Home clone refusal and the signed-in WebKit Issues layout audit at
390, 768 and 1280 pixels. Reproduce under the production lock, retain red-first
regressions, validate focused coverage and gates on Latitude, and deliver without
pushing or deploying.

Catalog: ui (repository controls), flow (durable clone), effect-tanstack-db
(repository role and live Issues rows), effect-electric (applied snapshots).

The server correctly reports Guest access on the home fixture. The header offered
Clone transiently before repository state settled; it now waits for that
repository's authority. Readers get the existing Members can clone state without
Clone or Try again. Failed authority preserves the previous refusal and dispatches
nothing; a successful role refresh permits recovery.

The hydrated Issues page has about 4,100 controls. The old audit spent roughly
19 seconds per 100 indexed controls and exhausted its 180-second budget near
control 900. All three widths reproduce this with the controls still present.
The replacement measures every visible control in one browser turn and retains
every size, viewport, overlap and clipping check. Signed-in Issues waits for the
network snapshots and their real decoded/persisted receipts. Desktop keeps
full-document PNG dimensions, pixel equality and content stability; a single
comparison replaces the shorter screenshot polling deadline.

Old-source regressions cover forbidden admission, the rendered header and live
list replacement. Additional regressions cover authority failure/recovery,
unknown authority, deferred installation, reload/navigation history and the
real Effect console transport in both browsers. Codex Astra and Fable findings
have been addressed.

The implementation awaits the lander's deployment. No push or deployment was
performed. Read-only production reproduced the forbidden offer without sending
a clone. Before the stricter applied-state gate, all six populated Issues layouts
passed with no findings and the desktop PNGs matched. The current deployment
cannot emit the new applied receipts, so the final strict run correctly stays
red. The local mini passes all six Issues layouts; its two declared Home cases
lack Code Storage credentials. The lander must deploy and run both browsers'
declared Home and signed-in Issues cases at all three widths under the lock.

Final Latitude validation: typecheck, import rules and lint pass. All 506 focused
tests pass across 40 files, with 100% statements, branches, functions and lines
on the ten measured changed modules. The browser probes cover both engines,
all three widths, list replacement, reload history and real Effect logging.
Astra and Fable's final focused console-transport reviews have no findings.
Decision 0125 was free on the fetched main revision.
