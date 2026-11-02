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
| `POST /api/repos/<owner>/<name>/issues/<number>/links` | `{ links: [{ kind, ref, label?, url?, state?, at? }] }`, 1 to 50 links: `200 { links, changed }`. `kind` is `assignee`, `session`, `queue`, `pr`, `merge` or `review`; `state` `working`, `queued`, `open`, `passed`, `failed`, `merged`, `done` or `closed`; `url` `https` only; `at` UTC ISO 8601, at most 5 minutes ahead, else the server's time. A link already there changes only for an `at` no older than its own. Who: a Member or above (session or run credential), or `Authorization: Bearer <token>` of a runner registered on the repository (`source` `runner:<name>`). `400 invalid`, `401 authentication`, `403 forbidden`, `404 not_found`, `405`, `413 too_large`, `429`/`503` from the role check with `retry-after`, `503 unavailable`. One `work.links` log line and span and one `smithers_work_link_posts` count by `outcome` and `by`; never a ref, label or URL |
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

## Tests

| File | Proves |
|---|---|
| `src/features/issues/work.test.ts` | the status rules: latest wins, merged for good, closed says nothing, ties; the filter |
| `src/features/issues/workView.test.ts` | links grouped per issue, the row chip and links, the page's sections, `?work=` |
| `worker/github/WorkLinks.test.ts` | the route: a Member's and a runner's posts, out-of-order posts, refusals, the list's status and filter, the shape's authorization |
| `ops/work-links/link.test.ts` | the client's request, its token handling and its waits |
| `e2e/issue-tracking.spec.ts` | production: links reach the list and the page, and the status follows the work |
