# @smthrs/bug-worker — src

Cloudflare Worker source for the bug.smithers.sh intake (routes, caps, and
deploy instructions live in `../README.md`).

- `worker.ts` — the entry point and fetch router: permissive CORS,
  `POST /api/bugs` with a 256KB body cap, and admin-only `GET /api/bugs/:id`.
  `createBugWorker(deps)` exists so tests can inject a clock; the default
  export uses `Date.now`.
- `repoRequests.ts`, `repoClaims.ts`, `onboardingAnswers.ts` — route handlers.
  Only `worker.ts` imports them; they import the leaf modules below and never
  `worker.ts` or each other. `tests/moduleGraph.test.ts` pins this.
- `repoForks.ts` — forks a newly nominated repository into the community
  organization and records the outcome.
- `RepoCompletion.ts` — Durable Object that commits one published app URL per
  repository.
- `deps.ts` — `BugWorkerDeps`, the clock and fetch every route takes as
  arguments.
- `checkRateLimit.ts` — per-IP hourly KV counter, one bucket per route.
- `isOperator.ts` — timing-safe `x-bug-admin` check against `BUG_ADMIN_TOKEN`.
- `readBodyBounded.ts` — streamed body read that aborts once the byte cap is
  exceeded, so a lying content-length can't buffer the platform cap.
- `repoName.ts` — normalizes a GitHub URL or `owner/repo` to a lowercase
  repository root.
- `bugReportSchema.ts` — loose zod schema requiring a non-blank `summary` or
  `title` (1 to 500 characters). Accepts current string and 0.x object platform
  values, preserves unknown fields, and stores either envelope without conversion.
- `newBugId.ts` — sortable ulid-ish id (base32 ms timestamp + 16 random chars).
- `env.ts` — `BugWorkerEnv`/`BugKv` binding interfaces; tests satisfy them with
  `tests/helpers/memoryKv.ts`.

The rate limiter is advisory by design (KV has no atomic increment, so
concurrent bursts can race past it); a hard cap needs a Durable Object or a
Cloudflare Rate Limiting binding.
