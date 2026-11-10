# 0031 — Signed-out GitHub reads go through smithers.sh, cached

Date: 2026-11-10. Lane vl-public-reads. Builds smithers.sh's
[decision 0165, addendum "public reads"](../../../mvp/docs/decisions/0165-hosted-site-github-delegation.md#addendum-public-reads-2026-11-10-lane-vl-public-reads).

## Why

On 2026-11-10 at 04:12 PST a signed-out `GET /api/wiki?page=index` logged `rate-limited` and answered 503; `/api/issues`
the same. The site read GitHub with no credential and shared the 60-per-hour anonymous limit with every Cloudflare
tenant on its egress address. The History object read an optional `GITHUB_TOKEN` that was never bound.

## Decision

```
wiki, issues, history ── PublicReads (the object's client)
                            │ ReadCache: fresh 30 s, then If-None-Match; stale on refusal
                            ▼
                         PublicRead.site: signed POST, no token ──▶ smithers.sh /api/auth/broker/public-read
```

- `worker/PublicReads.vibe` builds one client per object: `GitHub.ReadCache` over `GitHub.PublicRead.site`, keyed by
  `AUTH_BROKER_SITE_SECRET` and `VIBELANG_ORIGIN`, stored in the object's storage under `github-read/`. Without the key
  the same cache sits over an anonymous client.
- `asPerson` (`worker/GitHubDelegate.vibe`) uses it for every signed-out read; a connected person still reads through
  their delegation.
- The Accounts object provides it to the wiki and issues hosts, signed in or not; the History object folds main through
  it. `GITHUB_TOKEN` is gone: the site holds no GitHub credential.
- A read GitHub or smithers.sh refuses answers the last good copy. `/api/wiki` and `/api/issues` then carry
  `stale: <ms when GitHub last confirmed it>`. With no copy the answers are unchanged: `rate-limited` or `unavailable`.
- The panes show the copy as they show a fresh one. A visible stale mark waits for a designer's state (no design under
  `~/vl/designs/wiki` or `issues` has one).

## Tests

`test/publicReads.test.vibe`: the wiki, issues and history through smithers.sh's real route, with GitHub injected as an
`HttpClient` service that answers 403 with `x-ratelimit-remaining: 0`; the stale copy is served and marked. The shared
cases are in `@smthrs/integrations`' `test/PublicRead.test.vibe`; smithers.sh's in `apps/mvp/worker/PublicReads.test.ts`.

## Deploy contract

The site needs `AUTH_BROKER_SITE_SECRET` (bound today). smithers.sh needs `reads` on vibelang's `HOSTED_AUTH_SITES` entry
for `smithersai/vibelang` and `smithersai/smithers`, with their ids, and its App (`GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`). Deploy smithers.sh first: until it serves the route, the site's reads fail over to its copies.
