# bug-worker

Cloudflare Worker behind `https://bug.smithers.sh` that receives bug reports
from `smithers bug` (and anyone else) and stores them in KV.

## Community repositories

The home page also uses this Worker for public repository requests, smithering
status, and completion emails. See [REPO-REQUESTS.md](./REPO-REQUESTS.md) for
the app handoff, API, notification configuration, and deployment requirements.

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
  cap), per-IP rate limit of 20/hour via a
  KV counter. The KV counter is **best-effort/advisory** — KV has no atomic
  increment, so a concurrent burst from one IP can race past the limit; use a
  Durable Object or a Rate Limiting binding if a hard cap is ever needed.
  Stores `bug:<id>` and returns `{ id, url }`. No auth: reporting must be
  zero-friction. CORS allows POST from anywhere.
- `GET /api/bugs/:id` — maintainers only; requires the `x-bug-admin` header
  to match the `BUG_ADMIN_TOKEN` binding.
- `GET /healthz`

## Test

```sh
pnpm -C apps/bug-worker test
```

Tests run the real fetch handler against an in-memory KV binding with real
TTL semantics (`tests/helpers/memoryKv.ts`); no route mocking.
`tests/smithersBugPayload.test.ts` is the contract with the CLI's `bug` verb.

## Deploy

Not run by CI. `alchemy.run.ts` requires `CLOUDFLARE_API_TOKEN`,
`ALCHEMY_PASSWORD`, and `BUG_ADMIN_TOKEN` in the environment. Configure them
through your usual secret mechanism (a gitignored `.env`, or the runner's
secret store); never type them on the command line, where shell history keeps
them in plaintext. Then, from this directory:

```sh
pnpm -C apps/bug-worker deploy
```

Optional: `CLOUDFLARE_SMITHERS_ZONE_ID` (zone id for smithers.sh; alchemy
resolves it from the domain when omitted) and `BUG_PUBLIC_BASE_URL`
(defaults to `https://bug.smithers.sh`). See `alchemy.run.ts`.
