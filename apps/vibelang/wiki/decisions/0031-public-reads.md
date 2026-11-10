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
- The issues pane (list and issue) and the wiki editor show a `Stale` badge whose tooltip says when GitHub last
  confirmed the copy (`As of 2026-11-10 13:40 UTC`). The wiki reading pane shows the build's pages, never an API copy,
  so it needs no mark.

## Addendum: patience (2026-11-10, after the 05:42 deploy)

Deployed, `/api/wiki?page=index` answered 200 and `/api/issues` still answered 503 in 5 to 8 s. The issue list is five
pages of 100 (410 issues) plus assignees, read one after another. GitHub answers each page in 0.78 to 0.94 s and a
conditional 304 of one in 0.74 to 0.86 s, so every read older than 30 seconds spent about 5 s at GitHub alone, plus a
smithers.sh hop per request, and ran past the read flow's former 5-second deadline. The deadline ends the flow before the cache
can answer a stale copy. Measured from nyc-01 with an installation token; no production tail was available to this lane.

- Wiki and issue reads observe with `READ_PATIENCE` (`worker/PublicReads.vibe`, 3 seconds). After it, copies the object
  holds answer at once, `stale`, and their revalidations finish on their own; the next read finds them confirmed.
- A request to GitHub, once sent, runs detached from its reader: a read cut off by the deadline still stores what GitHub
  answered.
- GitHub's `rel="next"` links name a repository `/repositories/<id>`. smithers.sh refused them, so any list past 100
  items (an issue's timeline or comments, a pull's files) failed. It now admits them for a listed `repositoryId`.
- A read with no copy waits for GitHub. Its first five issue pages plus assignees need more than the previous
  5-second flow and 6-second accounts limits. Issue reads now have a 12-second engine deadline and a 13-second
  accounts boundary; wiki keeps 5 and 6 seconds. A cold read of 410 records at 1.1 seconds per request must answer
  200 on its first attempt through both boundaries. A stalled upstream still answers 503 within the bounded wait.

Confirmed against production after the 05:42 deploy (from the Mac, 2026-11-10 06:20 PST): eight signed-out
`/api/issues` reads one after another answered 503, 503, 503, then 200 in 5.2 s, and then 200 in 1.7 to 2.1 s from
fresh copies, and 200 in 8.0 s once every page needed revalidating. A read answered from fresh copies costs 1.7 to 2.1 s
before any GitHub request, so the issue list has about 3 s for six GitHub requests at about 1 s each through smithers.sh.

## Tests

`test/publicReads.test.vibe`: the wiki, issues and history through smithers.sh's real route, with GitHub injected as an
`HttpClient` service that answers 403 with `x-ratelimit-remaining: 0`; the stale copy is served and marked. The same file reads production's issue shape (410 records, five pages linked by repository id, 0.9 s per revalidation), preserves every record, and answers within the deadline. Cold reads at 1.1 s per answer cover the public and accounts boundaries; a stalled upstream tests the failure bound. The shared
cases are in `@smthrs/integrations`' `test/PublicRead.test.vibe`; smithers.sh's in `apps/mvp/worker/PublicReads.test.ts`.

## Deploy contract

The site needs `AUTH_BROKER_SITE_SECRET` (bound today). smithers.sh needs `reads` on vibelang's `HOSTED_AUTH_SITES` entry
for `smithersai/vibelang` and `smithersai/smithers`, with their ids, and its App (`GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`). Deploy smithers.sh first: until it serves the route, the site's reads fail over to its copies.
