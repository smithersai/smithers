# One-Click Fork & Upstream Contributor Loop

Signed-in third-party contributors can fork any public repository from its header or home page, install the Smithers GitHub App on their fork, work on it with full maintainer capabilities (branches, stack, flows, BYOA or paid cloud sandboxes), sync with upstream, and open cross-fork pull requests back upstream ([0175](../decisions/0175-third-party-contributors-paid-compute-and-forks.md)).

## Routes

| Route | Auth | Description |
|---|---|---|
| `GET /api/repos/<owner>/<name>/fork` | Signed in | Current user's fork state for `<owner>/<name>` (if forked) plus GitHub App install URL |
| `POST /api/repos/<owner>/<name>/fork` | Signed in (person-only) | Starts durable `repo/Fork` flow using the person's GitHub OAuth token |
| `POST /api/repos/<owner>/<name>/sync-upstream` | Signed in (person-only) | Syncs the fork's default branch with its upstream repository via GitHub `merge-upstream` |
