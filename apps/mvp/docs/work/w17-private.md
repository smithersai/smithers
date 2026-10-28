---
title: Honest feature availability in private browsers
status: done
area: browser
owner: Codex w17-private
updated: 2026-10-28
links: [../decisions/0011-the-agent-runs-in-the-browser.md, ../decisions/0120-session-flow-editors.md]
---

Trace W17's unavailable browser engine, preserve content-free storage diagnostics,
and expose unavailable terminal, saved-flow and TODO actions without promising
reload retention. Session editor collections are not a flow engine; decision 0120
retains the durable-action requirement. Catalog: `@smthrs/platform-browser`
(SQLite/OPFS and browser engine), `@smthrs/effect-tanstack-db` (existing local
collections), `@smthrs/ui` (existing feature cards and empty states).

Decision settled for W19: retain decisions 0011/0120. Keep session editors,
disable durable actions when OPFS is unavailable, and explain how to recover.
Session-only flow execution is not added; no memory engine, remote rerouting or
durable-admission bypass is introduced.

Terminal routes now retain their panel with an unavailable state even when branch
tracking cannot run. Saved-flow reads explain the missing engine; previously
loaded source stays editable with Save disabled. TODO drafts stay editable with
Commit disabled, recovery guidance and a reminder to copy before reloading.

Native production probes at 390, 768 and 1280 px: private WebKit rejects OPFS
`getDirectory()` with `UnknownError`; Chromium opens it. This is independent of
the app bundle, preparation, migrations and W13's repaired module identity.
An injected OPFS `UnknownError` now produces a `build/ready`, `opfs/failed`
diagnostic and preserves the typed refusal, without attempting a memory engine.

The production feature companion remains red on the deployed build's generic
flow-read failure. Chromium reached its code absence and editable TODO checks,
but ordinary app startup also emitted credential, watch and timeline-summary
POSTs. That run does not qualify as fully read-only; retain its evidence rather
than claiming six green read-only cells. No TODO/flow write or terminal launch
was requested. Subsequent production checks are native storage probes only.

Final validation: Latitude app typecheck, import rules and lint pass; nine focused
tests cover changed app logic at 100% in all four metrics. The full app suite ran
once: 5,909 passed, three expected failures and 23 declared skips, at 100% configured
coverage. React views have DOM integration and real browser evidence. The final
browser SDK check, full lint and 387-test suite pass at 100%; two pre-existing
formatter failures were corrected with whitespace-only changes.

Local WebKit and Chromium: 36 application cases plus setup pass, including the
original terminal, saved-flow and TODO cells at all three widths, visitors'
terminal absence, and branch/edit/compare refusals. Thirty recordings pass their
GIF checks. Six production native probes issued zero API requests.

Astra's five findings and Fable's cancellation-classification finding are fixed.
Diagnostic spans preserve the caller's original failure outside the span and
export only bounded fields. Interrupted initialization is counted separately
from refusal. Restoring the earlier implementations fails the new UI, diagnostic,
export-privacy and interruption assertions; the fixed implementations pass.
