# 0147: Work links

Status: accepted
Date: 2026-11-02

Will, 2026-11-02: prove smithers.sh can track all our issues, and "a list of all issues whose working on it links to prs or queued merges". Our work runs outside Smithers: lanes on our hosts, a merge queue, reviews. Smithers knew an issue's TODOs (decision 0016) and nothing else, so no issue could say who works on it, which queue entry carries it, or whether it merged, and no status could follow that work.

## Decision

1. **A work link is Smithers' own row, not GitHub's.** `work_links` (migration 0088): one row per issue, kind and ref (`<repo_id>#<number>/<kind>/<ref>`), with a label, an optional `https` URL, an optional state and who posted it. Kinds: `assignee`, `session`, `queue`, `pr`, `merge`, `review`. States: `working`, `queued`, `open`, `passed`, `failed`, `merged`, `done`, `closed`. GitHub has no field for a lane or a queue entry, and writing them as labels or comments would spend GitHub's content-creation limits (80 a minute, 500 an hour) on status changes.
2. **Whoever does the work posts it.** `POST /api/repos/<owner>/<name>/issues/<number>/links` takes 1 to 50 links. A Member or above posts in their session or a run's credential; a machine posts with the token of a runner registered on that repository (decision 0136), so a lane or the queue needs no person's session and an Admin can retire it at once. A link need not wait for its issue to sync.
3. **Status is derived, never edited.** `workStatusOf` (`src/features/issues/work.ts`), one pure function the worker and the browser share: `merged` once any link merged; otherwise the latest link that says anything, by the time the poster gave (`at`). `closed` says nothing. A post older than the row changes nothing, so links posted out of order end in the newest state.
4. **Read where issues are read.** The links sync per repository through `GET /api/shapes/work-links`, authorized as the issue shapes are. The paged issues list (`GET .../issues`) answers each issue's status and links, and `?work=pr-or-queue` is Will's list. A runner's token also reads that list, so a lane can find its issues on a private repository.

## Consequences

- An issue's status chip and side-column sections come only from links. An issue with no poster shows no work, which is true.
- A link's URL is the poster's. Lanes and the queue have no web view today, so their links show as text until one exists; pull requests and merges link to GitHub.
- Not built: deleting a link (post `state: closed`), links from Smithers' own TODO runs (their side column already shows them), and a person editing a link in the app.

Libraries: none new. Effect SQL and the existing Electric shape proxy.
