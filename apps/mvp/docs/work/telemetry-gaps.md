---
title: Production flow usage and ask correlation
status: blocked
area: observability
owner: telemetry-gaps
updated: 2026-10-25
links: [../observability.md]
---

Investigate the production sweep's absent flow usage and incomplete ask correlation. Use the library catalog entries for `@smthrs/flow` RunMetrics and `@smthrs/observability` OTLP export and relay. Preserve all correlation assertions and exclude content and credentials.

## Evidence

The sweep's browser log emits the theme run's started and settled lines. The relay allowlist includes those names and all usage fields. A content-free synthetic relay probe retained the usage fields, proving the relay contract only, not a button run. The real engine/exporter/relay integration test now asserts the button run's origin, settlement and duration and passes on Latitude.

The original live tail reader fails the exact readiness-receipt regression; the replacement and its POST-only filter pass live. Sampling, malformed frames and socket loss remain permanent failures for the affected capture, even after streaming resumes. Existing usage and correlation assertions are unchanged.

A production button rerun still misses the target usage lines: 33 telemetry responses were 200, both browser services were present, and other flows' usage lines arrived. The wire diagnostic records only byte sizes and occurrences of the predefined theme tag, never request bodies. The production stored-log query API refuses access (403); no permissions were widened. The correlation rerun stopped on the model's Couldn't answer before reaching its log assertion.

Latitude typecheck and import rules pass. The full suite passed: 343 files, 4,472 tests, with 100% statements, branches, functions and lines; three expected failures and 19 declared skips remain. The focused telemetry integration passed 6/6. Local browser verification on the mini failed before tests because the existing development Worker build parsed a `.vibe` type import as JavaScript; the separate migration is outside this change.

A separate content-free browser transport reproduction received ten complete JSON acknowledgments (`{}`), with no partial rejection, redirects, challenges or service worker. Only five matching records appeared in the tail. Aborting at headers versus reading the complete body did not repair the gap. Node probes through the same collector retained all 20 records. The configured head sampling rate is 1; no overload notification arrived. The cause of this remaining production capture gap is unresolved, so this work is not complete.

Handoff: capture helper live regressions pass 11/11, including exact readiness, actual server-side filtering and header privacy. The unchanged original reader fails the readiness regression. `telemetry-transport.spec.ts` retains the browser acknowledgment/tail discrepancy as the explicit `telemetryTail` known failure; original feature assertions are not marked broken or relaxed. Need an existing authorized stored-log query capability to determine whether acknowledged records persisted outside the tail.
