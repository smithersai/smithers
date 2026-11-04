---
title: Cold issue search budget
status: blocked
area: app
owner: Codex GPT-6 Astra
updated: 2026-11-04
links:
  - ../features/navigation.md
---

The storage improvement is validated; the five-second search budget is not reliable yet. Stopped before a broader startup design change, as requested. No landing, push or deployment is authorized.

The exclusive browser SQLite VFS now coalesces adjacent WAL fragments in a bounded 64 KiB buffer, preserving FULL sync, file visibility, failure propagation and crash recovery. The real Chromium regression falls from 93 native writes to 3 for one fixed 128-row transaction. Eight buffer cases cover 100% of the new helper; 40 existing SQLite/connection/restore cases and eight real browser cases pass. Final targeted lint and package source/test type checks pass.

Five alternating before/after cold profiles in one remote container measure search at median 5.768 s (5.253–6.171) before and 4.172 s (4.166–4.851) after. All five paired after cases meet the budget without a loading state. Separate initial batches measured 4.677 s (4.207–5.138) before and 4.737 s (4.234–5.290) after. The original volume proof still fails at 5.207 s search, while opening the issue in 691 ms; it also reports the fixture's refs 404. These failures are retained, not excluded to claim acceptance.

Search waits for the worker-backed shared store and application services, including restored chat drafts. In the paired after cases, opening the shared store after activation takes 900–1,008 ms, then services take another 405–504 ms. The separate diagnostic measures 5,576 VFS writes consuming 5.094 s through search completion, with only 794 ms of main-thread long tasks; it does not attribute every write to the pre-render interval.

Pending design choices: make authorized issue search usable independently of the shared-store/service startup boundary, or change startup transaction grouping while preserving durable commit acknowledgments. The former removes that 1.3–1.5 s dependency from the search path; the latter targets the measured startup transactions without changing UI ordering. Neither option is implemented or benchmarked. Keep server authorization, device data gates and loading-free cold paint in either design.

Private methods, all individual runs, failed intermediate candidates and review receipts are retained in the operator's searchcold runner directory. The app build and live API were exercised together; this is not a deployed change. Library catalog entries: browser durable engine and shared SQLite (`@smthrs/platform-browser`), persisted collections (`@smthrs/effect-tanstack-db`), SQL transactions and migrations (`@smthrs/database`).
