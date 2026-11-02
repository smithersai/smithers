# Work links

What links an issue to the work on it: who works on it, their lane or agent session, the merge-queue entry, the pull request, the merge and the review. Whoever does the work posts the links; the issue's status follows them, and no person edits it ([decision 0147](../decisions/0147-work-links.md)).

## How it works

```
a lane, the merge queue, a reviewer                  ChatApi                               every device
  ops/work-links/link.mjs ── POST .../issues/<n>/links ──▶ a Member, a run credential, or
     Bearer <runner token>                                 a runner on the repository
                                                           upsert work_links (newer `at` wins)
                                                                 │
  smthrs issue list, the proof ◀── GET .../issues?work=pr-or-queue (status + links per issue)
                                                                 └──▶ Electric /api/shapes/work-links ──▶ list chips, issue page sections
```

## Routes

| Route | Answers |
|---|---|
| `POST /api/repos/<owner>/<name>/issues/<number>/links` | `{ links: [{ kind, ref, label?, url?, state?, at? }] }`, 1 to 50 links: `200 { links, changed }`. `kind` is `assignee`, `session`, `queue`, `pr`, `merge` or `review`; `state` `working`, `queued`, `open`, `passed`, `failed`, `merged`, `done` or `closed`; `url` `https` only; `at` UTC ISO 8601, at most 5 minutes ahead, else the server's time. A link already there changes for a newer `at`, even with the same state (a lane working again after its queue entry failed is the newest word); the same `at` changes it only when something differs, so a post sent again changes nothing. The client sets `at` once per post. Who: a Member or above (session or run credential), or `Authorization: Bearer <token>` of a runner registered on the repository (`source` `runner:<name>`). `400 invalid`, `401 authentication`, `403 forbidden`, `404 not_found`, `405`, `413 too_large`, `429`/`503` from the role check with `retry-after`, `503 unavailable`. One `work.links` log line and span and one `smithers_work_link_posts` count by `outcome` and `by`; never a ref, label or URL |
| `GET /api/repos/<owner>/<name>/issues` | each issue has `work: { status, links }`; `?work=pr-or-queue` keeps issues with a `pr` or `queue` link, `?work=any` issues with any link. A runner's token reads it too ([issues](issues.md#routes)) |
| `GET /api/shapes/work-links?repo=<owner>/<name>` | the repository's `work_links` with `WORK_LINK_COLUMNS`, read as the issue shapes are |

## Status

`workStatusOf` in `src/features/issues/work.ts`: `merged` once any link merged; otherwise the latest link with a state other than `closed` decides: `working` Working, `queued` Queued to merge, `open` In review, `passed` Passed the queue, `failed` Failed, `done` Done; none: No work linked.

## The browser

- **The list** (`/$owner/$repo/issues`): each row's status chip, and its pull request, queue entry and merge when their links have a URL. The Work tabs: Any, and **Linked to a PR or queued merge** (`?work=pr-or-queue`), combinable with search, sort and the schedule.
- **The issue page**: a Work section with the status, then one section per kind (Working on it, Session, Queue entry, Pull request, Merge, Review), each link one click when it has a URL, with its state.

## Posting links: the client

`ops/work-links/link.mjs`, no dependencies. Register a runner on the repository for the poster first ([runners](agent-runners.md#setting-it-up)); its token is the poster's.

```sh
node ops/work-links/link.mjs --repo acme/widgets --issue 12 --kind session --ref lane:fix-12 --state working
node ops/work-links/link.mjs --repo acme/widgets --issue 12 --kind queue --ref 1793580204-fix-12 --state queued
node ops/work-links/link.mjs --repo acme/widgets --issue 12 --kind pr --ref 41 --state open --url https://github.com/acme/widgets/pull/41
node ops/work-links/link.mjs --repo acme/widgets --issue 12 --kind merge --ref 5e0fdb74 --state merged --url https://github.com/acme/widgets/commit/5e0fdb74
```

The token comes from `--token-file`, `$SMITHERS_WORK_TOKEN_FILE` or `~/.smithers/runner/runner-token`, never argv. With curl: `curl -H "authorization: Bearer $(cat <file>)" -H 'content-type: application/json' -d '{"links":[...]}' https://smithers.sh/api/repos/<o>/<n>/issues/<n>/links`.

## The proof

One command proves on a deployment that Smithers tracks our issues: `E2E_PROD_URL=https://smithers.sh node e2e/prod.mjs e2e/issue-tracking.spec.ts --project=deployment`. It needs a PRIVATE repository the test account administers, with the App on it, named in the run's `e2e.env` with the import's files (need `trackingRepository`); the records hold private paths, so never a public one.

1. **Collect**, at run time, never committed: `node ops/issue-tracking/collect.mjs` reads the proxy inbox and, on the lane host, every lane's prompt, start and exit, its review report and each merge-queue entry, scrubs anything credential-shaped, and writes one issue record each, with the links it implies, to a mode-600 file.
2. **Seed**: `node ops/issue-tracking/seed.mjs --repo <owner>/<name>` creates them through Smithers' own writes route as the test person, one every 7.5 s (480 an hour, under GitHub's 500 content creations an hour), resumable, waiting out `retry-after`, and pausing while a production e2e run holds `run.lock`. 5,000 issues take about 10.5 hours.
3. **Prove**: (a) the paged list walks every issue and the browser lists, searches and opens one within budgets; (b) every seeded record is an issue with its title; (c) a registered runner posts each record's links, the list and its `?work=pr-or-queue` filter answer them, and from a lane's issue one click reaches its lane, session, queue entry and merge; (d) a new issue's status follows a machine's posts, live on its page. Numbers go to `test-results/issue-tracking.json`.

Settings: `E2E_TRACKING_REPOSITORY`, `E2E_TRACKING_RECORDS`, `E2E_TRACKING_SEED_STATE`, `E2E_TRACKING_RUNNER_TOKEN_FILE` (made and registered by the spec when absent), `E2E_TRACKING_MIN_ISSUES`, `E2E_TRACKING_LINKED`.

## Tests

| File | Proves |
|---|---|
| `src/features/issues/work.test.ts` | the status rules: latest wins, merged for good, closed says nothing, ties; the filter |
| `src/features/issues/workView.test.ts` | links grouped per issue, the row chip and links, the page's sections, `?work=` |
| `worker/github/WorkLinks.test.ts` | the route: a Member's and a runner's posts, out-of-order posts, refusals, the list's status and filter, the shape's authorization |
| `ops/work-links/link.test.ts` | the client's request, its token handling and its waits |
| `ops/issue-tracking/records.test.ts` | the import's scrubbing, its records and links, and their order |
| `e2e/issue-tracking.spec.ts` | production: volume, import, links and status, above |
