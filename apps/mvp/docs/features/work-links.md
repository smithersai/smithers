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

### TODOs made from an issue

A TODO made from an issue links its own work there, with no post: the stack's writer (`worker/stack/Stack.ts`, `linkWork`), in the same transaction as each change to the TODO, writes its links with `source` `todo:<number>`. The TODO itself is a `session` link, `TODO #<n>` (`working`, `done` once merged, `closed` once dropped, `failed`; no state while queued or in review); its pull request a `pr` link, `#<p>` to GitHub (`open`, `merged`, `closed`); and once merged, its merge commit a `merge` link (`merged`). So an issue a TODO took to a merged pull request reads Merged, with the TODO, the pull request and the merge one click away. No one else may post as `todo:<n>`: it is the server's own write, not a route.

## Our own work: the lane helper and the importer

Our lanes track their work as issues on the public repositories smithersai/vibelang and smithersai/smithers, as a tree under **Ship VibeLang** on smithersai/vibelang (`ops/issues/tree.mjs`), filed as GitHub sub-issues.

```sh
node ops/issues/track.mjs open    --repo smithersai/vibelang --title "<title>" --body-file <f> --key fuzz:<id> --label migrate:alchemy --parent smithersai/vibelang#<N> --dry-run
node ops/issues/track.mjs link    --repo smithersai/vibelang --issue <N> --kind lane --ref <lane> --state working
node ops/issues/track.mjs comment --repo smithersai/vibelang --issue <N> --body-file <f>
node ops/issues/track.mjs parent  --repo smithersai/smithers --issue <N> --parent smithersai/vibelang#<M>
```

- **Who writes.** The identity file at `--identity` or `$SMITHERS_ISSUE_IDENTITY`: JSON with `login`, and `cookie` plus `personId` (issues and comments), `runnerToken` (links) and `githubToken` (sub-issues). It refuses to write without the file or as a person's login. `--dry-run` sends nothing and prints each request with each secret named, not shown.
- **Reuse.** `open` reads the repository's issues shape and reuses an open issue whose body has the same `key: <kind>:<id>` line, or whose normalized title matches; otherwise it creates one with a write id derived from the key. Labels go in the body's marker block, since the writes route takes none.
- **Public content.** Everything sent goes through `ops/issues/scrub.mjs`: it redacts credentials, home and internal paths, machine names, account names, emails and private repository names (passed at run time, never committed), and fails closed, exit 2, on a title, label or ref that needs a redaction.
- **Sub-issues.** GitHub's, with its limits checked first: 100 children per parent, eight levels, the same owner (any repository of it).
- **The importer.** `node ops/issues/import.mjs --out <plan.jsonl> [--draft <source>=<file>]...` reads the open merge-queue entries, the open spec-review and scoped-review findings and the example-repository migration findings on the lane host (read-only), main's pending fuzz gaps, and the agents' drafts; deduplicates by key and title; scrubs; places each in the tree; and writes a mode-600 plan with every dropped record and why. It posts nothing.

## Routes

| Route | Answers |
|---|---|
| `POST /api/repos/<owner>/<name>/issues/<number>/links` | `{ links: [{ kind, ref, label?, url?, state?, at? }] }`, 1 to 50 links: `200 { links, changed }`. `kind` is `assignee`, `session`, `queue`, `pr`, `merge` or `review`; `state` `working`, `queued`, `open`, `passed`, `failed`, `merged`, `done` or `closed`; `url` `https` only; `at` UTC ISO 8601, at most 5 minutes ahead, else the server's time. A link already there changes for a newer `at`, even with the same state (a lane working again after its queue entry failed is the newest word); the same `at` changes it only when something differs, so a post sent again changes nothing. The client sets `at` once per post. Who: a Member or above (session or run credential), or `Authorization: Bearer <token>` of a runner registered on the repository through its Admin role, with the App's installation recorded (`source` `runner:<name>`; decision 0148). `400 invalid`, `401 authentication`, `403 forbidden`, `403 not_authorized` (a runner that needs [registering again](agent-runners.md#registering-a-runner-again)), `404 not_found`, `405`, `413 too_large`, `429`/`503` from the role check with `retry-after`, `503 unavailable`. One `work.links` log line and span and one `smithers_work_link_posts` count by `outcome` and `by`; never a ref, label or URL |
| `GET /api/repos/<owner>/<name>/issues` | each issue has `work: { status, links }`; `?work=pr-or-queue` keeps issues with a `pr` or `queue` link, `?work=any` issues with any link. A runner's token reads it too, on the same terms as a post ([issues](issues.md#routes)) |
| `GET /api/shapes/work-links?repo=<owner>/<name>` | the repository's `work_links` with `WORK_LINK_COLUMNS`, read as the issue shapes are |

## Status

`workStatusOf` in `src/features/issues/work.ts`: `merged` once any link merged; otherwise the latest link with a state other than `closed` decides: `working` Working, `queued` Queued to merge, `open` In review, `passed` Passed the queue, `failed` Failed, `done` Done; none: No work linked.

## The browser

- **The list** (`/$owner/$repo/issues`): each row's status chip, and its pull request, queue entry and merge when their links have a URL. The Work tabs: Any, and **Linked to a PR or queued merge** (`?work=pr-or-queue`), combinable with search, sort and the schedule.
- **The issue page**: a Work section with the status, then one section per kind (Working on it, Session, Queue entry, Pull request, Merge, Review), each link one click when it has a URL, with its state.

## Posting links: the client

`ops/work-links/link.mjs`, no dependencies. Register a runner on the repository for the poster first ([runners](agent-runners.md#setting-it-up)); its token is the poster's. A runner token posts and reads only while its runner is current as a claim requires: registered through the repository's Admin role, with the App's installation recorded ([decision 0148](../decisions/0148-runner-git-credential.md)). Otherwise a post is `403 not_authorized` and the script exits 1 with `work link refused: HTTP 403 not_authorized`: [register the runner again](agent-runners.md#registering-a-runner-again).

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

**The cold waterfall**: `E2E_PROD_URL=https://smithers.sh node e2e/prod.mjs e2e/issue-waterfall.spec.ts --project=deployment` opens the list and one issue on new devices (`E2E_WATERFALL_VISITS`, 3 by default) and prints each visit's stages: the document, the app's assets, the boot's marks, every `/api/` request and the main thread's long tasks, until the first rows or the issue's title showed. `E2E_WATERFALL_PROFILE=<dir>` saves each visit's CPU profile. Paths name the repository `<repo>`; no title or body leaves the browser.

Settings: `E2E_TRACKING_REPOSITORY`, `E2E_TRACKING_RECORDS`, `E2E_TRACKING_SEED_STATE`, `E2E_TRACKING_RUNNER_TOKEN_FILE` (made and registered by the spec when absent), `E2E_TRACKING_MIN_ISSUES`, `E2E_TRACKING_LINKED`.

## Tests

| File | Proves |
|---|---|
| `src/features/issues/work.test.ts` | the status rules: latest wins, merged for good, closed says nothing, ties; the filter |
| `src/features/issues/workView.test.ts` | links grouped per issue, the row chip and links, the page's sections, `?work=` |
| `worker/github/WorkLinks.test.ts` | the route: a Member's and a runner's posts, out-of-order posts, refusals, the list's status and filter, the shape's authorization |
| `ops/work-links/link.test.ts` | the client's request, its token handling and its waits |
| `ops/issues/scrub.test.ts` | the public-content scrub: what it redacts, what it keeps, and failing closed |
| `ops/issues/track.test.ts` | the lane helper: identity refusals, dry runs without secrets, reuse, links, sub-issues and GitHub's limits |
| `ops/issues/sources.test.ts` | the importer's records per source, and the tree's placement, parts and depth |
| `ops/issue-tracking/records.test.ts` | the import's scrubbing, its records and links, and their order |
| `e2e/issue-tracking.spec.ts` | production: volume, import, links and status, above |
| `e2e/issue-waterfall.spec.ts` | production: the cold list's and the cold issue page's stages, above |
