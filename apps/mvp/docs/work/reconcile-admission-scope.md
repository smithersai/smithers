---
title: Reconcile admission and terminal scope under Alchemy
status: done
area: github
owner: Codex / vl-mvp-closed-scope
updated: 2026-11-10
links:
  - ../features/issues.md
  - ../observability.md
---

Check the cold production bridge under `alchemy dev`, including the issues admission and the branch terminal's pump.
Audit scoped forks in the app and its dependency packages. No deployment in this lane.

Each admission records `github.reconcile.admission` (span and log) and increments `github_reconcile_admissions` at
its first instruction, including fresh reads and development without a GitHub App. These names carry no payload or
metric attributes. The stale admission's existing outcome records stay unchanged.

Library catalog: Effect's tracing, logging and metrics; existing `@smthrs/flow` admission and
`@smthrs/effect-electric` shape proxy. This changes the core's observations of an existing flow, with no new feature,
dependency or background job.


Cold `alchemy dev`, 2026-11-10: session, items and summaries returned 200; both admissions began. A real tmux fixture
in the production sandbox image, reached through the normal terminal endpoint, returned 101 and the actual attach
fiber began. With the bridge hunk enabled, no scoped fork was cancelled before entry and no fork targeted a closed
scope. Without the hunk, the deliberate ambient-scope control was interrupted before entry; both admissions and the
actual terminal pump still began. The pump's own scope is independent of the inherited constructor scope.

The default local rootless Docker egress gateway refused the forge connection, so this check creates the tmux session
and its matching database row as fixture data. It proves fiber entry through the real bundle, bridge and bindings;
it does not certify local forge checkout or terminal UI behavior. No HTTP request is intercepted.

Audit: three backend scoped-fork source sites remain: terminal attach and interrupt in `BranchSandboxes.ts`, and the
renewal/expiry helper in `SocketAccess.ts`. All use `pumps`. Reconcile admission uses a joined request child
(`github/Access.ts`; decision 0104), or a joined `Effect.all` for paginated issues. The rest of the application and its
transitive SDK dependencies use live browser, operation, coordinator or execution runtime scopes. The browser's
ManagedRuntime stays open until it is stopped; the Cloudflare engine is built per drive/call. No scope fix is needed
for these sites. The shared bridge fix from `17ebb33a` stays in the next deploy for constructors that need it.

Checks and per-file coverage are recorded in the lane report on nyc-01. No deployment in this lane.
