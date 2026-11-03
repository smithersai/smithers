---
title: Run admission ownership and authority
status: in-progress
area: access
owner: retro-runs
updated: 2026-11-02
links: [../features/actions.md]
---

Verify the reported ownership conflict and stale admission authority against main through the HTTP handlers and real Postgres stores. Each reproduced finding gets a separate unlanded commit. No push, main movement, deployment or review is authorized.

## Finding 1: intent ownership

Reproduced on main `6d773cefcf4f`: `a conflicting sandbox-call intent cannot claim or cancel another person's execution` failed with `conflicting intent must not grant cancellation: expected 202 to be 403` (1 failed, 18 filtered skips). The HTTP start returned 409, then the real cancellation handler admitted the conflicting execution.

Ownership recording now shares the intent-admission transaction; a conflict rolls back before the 409 is returned. The same regression verifies 403, no cancellation handoff and no ownership row. Focused run: `worker/ci/RunsApi.test.ts`, 19 passed, 0 failed, 0 skipped. Existing `@smthrs/integrations` and Effect SQL services are retained; no new library.

Finding 2 was also reproduced against the same main source before its fix: body/GitHub response gates crossed with session/repository-role revocation, 4 failed, 19 filtered skips. Implementation and final validation remain pending.
