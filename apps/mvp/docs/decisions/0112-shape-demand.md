# 0112: A tab requests only the shapes its person and page read

Status: accepted. Step S2 of the Electric-at-scale plan (2026-10-26): smithers.sh's one Electric object overloaded with about 8 signed-out tabs, and each tab followed shapes it never read.

Every store built its collections on boot, and each collection started its shape at once. On 2026-10-26 a signed-out tab on `/smithersai/smithers` in production asked for 18 shapes, and kept a live long-poll on each. Ten returned nothing it could use: a person's own `runs`, `flows`, `flow-drafts`, `notifications`, `my-conversations` and `github-writes` (no rows for nobody), `triage-settings`, and every pull request's `pull-commits`, `reviews` and `checks`, which only a pull request's page reads.

Extend decision 0110's gate from authority to demand. A collection's requests wait on a condition, through `ShapeSource.gated` in `@smthrs/effect-electric`:

- A person's own shapes and the triage settings wait while no one is signed in (`src/features/auth/source.ts`). The triage settings also wait for repository authority. Sign-in on the tab opens them without a reload.
- A pull request's commits, reviews and checks wait while the route shows no pull request (`src/features/pulls/store.ts`).

A waiting collection sends nothing and stays loading; a view never shows it as empty. A request already sent runs to its end, and the next one waits again. The server still authorizes every request, so the gate saves load and never grants access.

Rejected: Electric's `on-demand` subsets, which the shape proxy drops; and building stores per route, which would tear down collections the outbox and background followers own.

Library catalog entries: `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`.

## Cold pull request lists (2026-10-26)

The list query joins the authority-gated items and pull metadata, not the detail shapes. The repository sync receipt can arrive before that query is ready on a cold device. Until both are ready, an empty list shows unknown counts, never a spinner or confirmed empty counts (ARCH-5). Existing rows render immediately; refusals still hide them. Keep the detail shapes gated: opening them does not resolve this dependency.
