---
title: W17 layout and browser durability regressions
status: done
area: ui
owner: Codex w17-ui
updated: 2026-10-28
links: [../features/docs.md, ../features/issues.md, ../decisions/0122-who-may-ask.md]
---

Reproduce and repair native Sort sizing, Docs navigation overlap, WebKit offline
reload, and the new-person conversation setup. Use the library catalog's Render UI
entry (`@smthrs/ui`) and existing durable device services. Preserve every assertion;
exercise both real browsers locally and the read-only production paths.


Product: the native Sort control shares `IssueSort` and the library input class with an explicit control-height
(the WebKit popup ignores min-height alone). Docs reserves a scrollbar gutter and end inset around block links.
Terminal refusal reads the existing live auth observation; promotion recovers without storing a refused phase.

Harness: dev precaching excludes stale generated registration files (a real 404 prevented worker installation).
Device activation is bounded and records controller/protocol state. A real TLS relay loses the network while
WebKit offline emulation is released; both browsers prove a new document restores the same Requested write,
positive pre-cut traffic, no new relay traffic, and a failing uncached session fetch after reload.

Validation: typecheck, importRules and lint; 17 focused tests at 100% statements, branches, functions and lines
for changed logic (`terminal/view.ts`, `offlineTransport.ts`). The actual native control passes 12 browser cases
at 320, 390, 768, 960, 961 and 1280 px in Chromium and WebKit. Mini layout audits passed all 24 signed-out cases;
the complete new-person hello journey passed in both browsers. Astra and Fable findings were fixed and rereviewed.

Qualification limits: the later mini repeat reached repository opening but GitHub answered 403 `rate_limited`
(remaining zero), hiding the README link; signed-in Docs repeated 503 before rendering. Those failures remain
recorded. Production read-only mobile reruns retain 16 WebKit failures on the deployed CSS (32 pass); the final
real-disconnect write test passes in both browsers. The new-person scenario declares local-only dev needs in
production, and the offline write scenario declares its deployment-only scratch need on the mini. The lander
must repeat the affected production mobile cells after deploying and repeat the local hello journey after the
anonymous GitHub allowance recovers. No push or deploy was performed.
