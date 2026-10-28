---
title: WebKit production navigation and request diagnostics
status: done
area: app
owner: Codex w15-webkit
updated: 2026-10-27
links: [../features/docs.md, ../observability.md]
---

Reproduce W15's Docs navigation and access-control failures against production under the shared lock. Retain content-free request, document and lifecycle records before changing product behavior or strict error classification. Catalog: existing observability, platform-browser and Effect HTTP services; no new dependency.


Production records bound the telemetry diagnostic to a full-document departure: 33 ms after navigation began,
64 ms before pagehide, same origin, no preflight, and no window error or unhandled rejection. An earlier completed
200 export shared its URL. The original credential console diagnostic followed its old worker’s door timeout, 35 ms after navigation
to the inbox began and 15 ms before its document committed, with no matching dispatched request; the watcher now applies the same bounded document witness to either delivery form.

A native probe opening only the version document proved that two macOS WebKit userDataDir profiles shared OPFS.
The signed-out visitor therefore inherited a sealed signed-in engine: its About flow never answered, so Docs never
appeared. A per-process Foundation home isolates OPFS without changing device ownership or Docs assertions.
Explicit browser environments remain explicit. A native browser regression and pure environment tests retain this.

The original Send journey stays unchanged. Its read-only companion opens the form and leaves for the inbox without
filing a report. The cancellation regression first completes an empty export, then attempts the same endpoint from
the cancelled live read's rejection; production must retain its native cancellation receipt. Locally it waits for
the Flows screen before starting the controlled live read, so departure does not interrupt Vite's startup imports.


Validation: production's 24 read-only cases passed without failures or skips across WebKit and Chromium; the final
cancellation setup also passed both production projects. Latitude typecheck, import rules and lint passed; 42 focused
tests cover browserProfile.ts and cancellations.ts at 100% statements, branches, functions and lines. Restoring old
profile selection and completion classification fails exactly four regression cases. Both Astra reviews found no
actionable issues; Fable was unavailable because all accounts were cooling. The lander still runs the original Send
journey, which deliberately writes a report and was excluded from this read-only production verification.

The final Mac mini run passes the cancellation journey after waiting for the Flows screen. Its native profile
isolation and read-only bug-form companion also pass. A final Latitude typecheck/import-rules/lint recheck passes;
an earlier dependency-read race is retained separately from that final receipt. No product runtime, permission,
Docs navigation assertion or Send assertion changed, and nothing was pushed or deployed.
