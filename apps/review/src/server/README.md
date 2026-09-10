# server/

Cloudflare Worker for the review service: walkthrough sharing (R2), session
minting with quota and spend caps (D1), a metered Anthropic proxy, plus admin
and Prometheus endpoints. `../../alchemy.run.ts` deploys it and names the
domain it serves. `worker.ts` is the router; `createReviewWorker(overrides)`
lets tests inject `jwksUrl`, `anthropicBaseUrl`, `fetchUpstream`, and a clock.

Subdirectories:

- `sessions/` — OIDC + api-key auth, quota slot claiming, session minting.
- `proxy/` — Anthropic request forwarding and usage metering.
- `admin/` — bearer-token operator endpoints (repos, keys, usage).
- `metrics/` — Prometheus `/metrics`, read from the `usage_totals` rollup that
  `proxy/recordUsage.ts` maintains per (repo, model) at settlement and
  `migrations.ts` backfills once, never from the full `usage_events` log.
- `walkthroughs/` — walkthrough upload to R2.

Root helpers: `d1.ts` (narrow D1 interface tests implement over bun:sqlite),
`env.ts` (bindings), `migrations.ts` (idempotent schema + additive columns),
`monthKey.ts` / `repoMonthlyCapUsd.ts` / `repoMonthlySpendUsd.ts`
(calendar-month quota math), `sha256Hex.ts`, `randomTokenHex.ts`,
`timingSafeStringEqual.ts`, `jsonError.ts`, `landingPage.ts`.

Security invariants: tokens are stored hashed only; all bearer comparisons are
constant-time; unknown vs revoked keys are indistinguishable to callers; the
per-repo monthly spend cap exists because per-session caps reset on every mint.
