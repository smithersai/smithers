# bug-worker

Cloudflare Worker behind `https://bug.smithers.sh` that receives bug reports
from `smithers bug` (and anyone else) and demo requests from the site's `/demo`
form, and stores them in KV.

## The payload

The current and 0.x CLI envelopes are accepted and stored without conversion.
Installed 0.x CLIs still target this endpoint with `title` and an object-valued
`platform`, so the intake retains both forms.

### rc.0, what `smithers bug` posts today

`packages/smithers/src/Command.ts` builds this through `Bug.report`, which scrubs
credentials out of every string, and POSTs it to `Bug.defaultEndpoint`. `runs`
is whatever `Control.list` returned; `digest` appears only when `--run` names a
run.

```jsonc
{
  "summary": "the review step exhausted its correction budget",
  "version": "1.0.0-rc.0",
  "platform": "darwin-arm64",
  "node": "22.19.0",
  "runs": [
    {
      "runId": "run-01JQ…",
      "flowId": "flows/build-and-review",
      // One of the seven rc.0 statuses: accepted, running, parked,
      // waiting-approval, cancelled, completed, failed.
      "status": "failed",
      "createdAt": 1788000000000,
      "updatedAt": 1788000042000
    }
  ],
  "digest": { "runId": "run-01JQ…", "events": [{ "sequence": 3, "kind": "control.run.failed" }] }
}
```

### 0.x, and anything hand-written

```jsonc
{
  "title": "Run run-01JQ… failed: the review step exhausted its correction budget",
  "body": "It failed the same way twice on a clean checkout.",
  "smithersVersion": "0.35.0",
  "platform": { "os": "darwin", "arch": "arm64", "nodeVersion": "v22.19.0" },
  "createdAtMs": 1788000050000,
  "run": { "runId": "r-123", "workflowName": "build-and-review", "status": "failed", "events": [] }
}
```

0.x sent `workflowName` and `workflowPath` instead of `flowId`, a five-status
vocabulary, and events keyed `seq`/`timestampMs`/`type`.

At least one of `summary` or `title` must contain non-whitespace text. Each
headline, when supplied and non-null, must be a string of 1 to 500 characters.
`platform` may be a string or an object with arbitrary fields. Optional fields
may be omitted or null; unknown fields are preserved.

`tests/smithersBugPayload.test.ts` pins both shapes, including a POST/admin-GET
round trip of the 0.x example, and builds current run DTOs through
`@smthrs/control`'s schemas. `tests/bugWorker.test.ts` also round-trips a
title-only report.

## Routes

- `POST /api/bugs` — zod-validated report: a non-blank `summary` or `title` is
  required, every other key is optional, and the object stays loose. 256KB cap
  (stream-counted, so a missing/spoofed content-length can't buffer past the
  cap), rate limits of 20 valid reports/hour per client and 2000/hour across all
  clients; a 400 or 413 never spends the budget. A request carrying the
  `x-bug-admin` token skips both budgets, and an all-clients refusal logs
  `bug_report.global_limit`. Each budget is an atomic
  `RateLimiter` Durable Object counter, so a concurrent burst cannot race past
  it. The all-clients cap is charged first, so its refusals spend no client's
  budget; a client refusal refunds its cap admission. Each counter's storage
  is deleted by an alarm when its hour ends. A client is Cloudflare's `cf-connecting-ip` (`x-forwarded-for` is
  ignored), charged per /64 for IPv6.
  Stores `bug:<id>` and returns `{ id, url }`. No auth: reporting must be
  zero-friction. CORS allows POST from anywhere.
- `POST /api/demo-requests` — the `/demo` form's four required fields,
  `firstName`, `lastName`, `workEmail` and `message`, trimmed and bounded
  (200, 200, 320 and 5000 characters; the email must be valid). Unknown keys are
  dropped. 16KB cap, rate limits of 20 valid requests/hour per client and
  200/hour across all clients, in buckets separate from bug reports; a 400 or
  413 never spends the budget, and an all-clients refusal logs
  `demo_request.global_limit`. The body also carries `submissionId`, an
  idempotency key the page retains on retry and rotates when a field changes.
  The submission's Durable Object binds the validated fields to a receipt for
  90 days. An hourly object charges both budgets in one transaction keyed by
  that receipt. After storing the lead in KV at `demo:<id>`, intake returns
  `201 { id }`. An identical retry returns the same receipt. Reusing the key
  with different fields returns `409`.
  `tests/demoRequests.test.ts` reads the endpoint and field names from
  `apps/site/src/pages/demo/index.astro` and posts that payload.
- `GET /api/bugs`, `GET /api/demo-requests` — maintainers only: one page of
  stored IDs, `{ ids, cursor? }`; pass `?cursor=` for the next page.
- `GET /api/bugs/:id`, `GET /api/demo-requests/:id` — maintainers only; the
  stored record.
- Every maintainer route requires the `x-bug-admin` header to match the
  `BUG_ADMIN_TOKEN` binding, answers `cache-control: private, no-store` and
  `x-content-type-options: nosniff`, and sends no CORS headers.
- `GET /healthz`

## Logs

Each line is JSON with the event, the route template, and either the stored
`id` or a stable failure `code`; submitted content and exception text never
reach a log.

| Event | Stream | Fields |
| --- | --- | --- |
| `bug_report.accepted`, `demo_request.accepted`, `demo_request.replayed` | stdout | `route`, `id` |
| `bug_report.failed`, `demo_request.failed` | stderr | `route`, `code`: `storage_unavailable` or `rate_limiter_unavailable` |
| `bug_report.global_limit`, `demo_request.global_limit` | stderr | `route`, `code`: `global_limit` |

## Test

```sh
pnpm -C apps/bug-worker test
```

Tests run the real fetch handler against an in-memory KV binding with real
TTL semantics (`tests/helpers/memoryKv.ts`); no route mocking.
`tests/smithersBugPayload.test.ts` is the contract with the CLI's `bug` verb.

## Deploy

Publication requires a qualified Cloud rollout, with a passing gate and an
immutable artifact at the exact `main` revision. Follow
[the deployment requirements](docs/deployment.md) for resource adoption,
lease and deployed-artifact verification. The local `deploy` script refuses
publication, including with `--adopt`; there is no local bypass.

Set `CLOUDFLARE_API_TOKEN`, `ALCHEMY_PASSWORD`,
`BUG_ADMIN_TOKEN` through your usual secret mechanism (a gitignored `.env`,
or the runner's secret store); never type them on the command line, where
shell history keeps them in plaintext. A deploy without one fails rather than
removing the live binding.

### Plan (no publication)

Inspect the first Alchemy 2 adoption plan for the existing resources:

```sh
pnpm -C apps/bug-worker run plan --adopt
```

For later plans, omit the adoption flag:

```sh
pnpm -C apps/bug-worker run plan
```

Both plans run the stage named by `ALCHEMY_STAGE` against the account's shared
`alchemy-state-store` Worker; a plan without it stops before reading state.

### Deployment configuration

The stack reads every installation-specific value from the environment, so
the same source plans an independent installation. Keep a hosted
installation's values with its other private deployment configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALCHEMY_STAGE` | required | The Alchemy stage, and so the state record, a plan or destroy uses. |
| `BUG_WORKER_NAME` | `smithers-bug-worker` | The Worker's physical name. |
| `BUG_REPORTS_NAMESPACE` | `smithers-bug-reports` | The KV namespace title. |
| `BUG_WORKER_DOMAIN` | none | The custom domain. Without one the Worker answers on `workers.dev`. |
| `BUG_WORKER_DOMAIN_ALIASES` | none | Comma-separated extra hostnames of the same Worker. |
| `BUG_WORKER_ZONE_ID` | none | The domain's Cloudflare zone, when Alchemy cannot find it by name. |

A changed name creates a second Worker or an empty namespace, and a declared
domain detaches every live hostname it does not list. Plan against an
existing installation with its current values.
