---
title: Request-owned Worker I/O
status: done
area: worker
owner: Codex workerd-concurrency
updated: 2026-10-25
links: []
---
Prove thirty cold About reads through the bundled production route under workerd,
and prevent shared in-flight Effect caches and deferred values in Worker sources.
Uses the catalog's @smthrs/integrations GitHub client, @smthrs/database
PostgresDatabase and @smthrs/targets NodeTest entries, with Effect HttpClient.

Latitude: exact parent 9c0c4e4a53 fails with 29/30 HTTP 500; exact fix
4dceac5135fd passes 30/30 HTTP 200. Both use only the new test/host overlay.
Typecheck, importRules, app lint, 49 guard regressions and 61 focused tests pass.
RepoRoles and Compare have 100% statements, branches, functions and lines;
the guard has 100% lines, branches and functions with enforced thresholds.
Astra's forward-alias finding and Fable's Effect 4 constructor gap are fixed and
covered. Other Fable observations and their scope/semantics rationale are recorded
in the builder evidence.
The full app suite is reserved for the lander's batch gate.
