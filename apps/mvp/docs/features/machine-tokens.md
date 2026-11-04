# Machine tokens

An agent files issues with no person behind it: it holds a scoped, expiring token, and the server writes to GitHub as the App, so the App's bot is the author. No GitHub account or collaborator grant is involved.

## How it works

```
operator                     smithers.sh                                                GitHub
ops/machine-token/issue.ts ─ digest, agent, lane, repository, scope, end ─▶ machine_tokens
                                    (the raw token goes to a mode-600 file)

agent ─ Bearer smm_… ─ POST /api/repos/<o>/<n>/writes ─▶ machine_writes, the owner's queue
                                                          github/MachineDispatch, one per owner
                                                          round: a durable sleep, one tick
                                                          tick: the hold ─ oldest write ─ its authority
                                                                ─ token ─ reads ─ at most one POST ──▶ as the App (issues: write)
agent ─ GET /api/repos/<o>/<n>/writes/<id> ◀─ { status, failure, cause, githubStatus, number }
```

- **Issuing.** `~/vault-ws-deployer/bin/mvp-prod-env node ops/machine-token/issue.ts --project <neon id> --by <name> --repo <o/n> --agent <agent> --lane <lane> --out <file>`. It runs under the deployment's production credentials, writes only the token's digest, and prints one audit JSON line. `--revoke <digest>` ends a token at once. No person signs anything. That is acceptable because this operator can already write this database: the command gives them no power they lack, and a token it makes does less than they can.
- **What a token is.** `smm_` and 32 random bytes, for one repository, at most 7 days. Its `scope` holds some of `issue/create`, `issue/update`, `issue/comment`, `issue/relate` and `work/link`. A TODO record has no scope here: it waits for v1.1's external TODOs, and `todo/commit` stays a person's.
- **What a token can't do.** Only the writes route and the work-links route read one. To everything else on smithers.sh it is no session, so a route answers as for anyone signed out: every person-only act of decision 0016, starting a run or committing a TODO among them, is refused because nothing there knows the token. The writes route parses machine writes with their own schema, so `issue/triage` and `pr/merge` are `400 invalid` before any role is asked. A `smithers:` label is refused too, since triage and commitment state are read from those labels. `issue/update` touches no labels.
- **Labels on create.** `labels` accepts up to 20 strings or `{ name, color?, description? }` objects, mixed in one array. Names hold 1–50 characters, colors are six hexadecimal digits without `#`, and descriptions hold at most 100 characters. The defaults for a missing label are neutral `ededed` and an empty description. Before the issue POST, the dispatcher GETs each repository label by its encoded name. A 404 creates it through the same paced GitHub seam; each creation consumes one tick's mutation, with a 7.5 s hold before the next tick. Existing labels keep their metadata. A lost creation answer is recovered by GET; a concurrent creation's 422 `already_exists` also succeeds. Other refusals store their usual cause, such as `github_status:403`. Both string and object `smithers:` names stay refused at admission; descriptions pass the public-content checks too. Successful provisioning logs `github.machine_write` with `writeId` and `outcome: label_ready`, without label content.
- **Identity.** An agent or a lane holds no `/`, at issuing and in the table: a work link's source is `machine:<agent>/<lane>`, and it names one pair.
- **Authority across repositories.** `issue/relate` writes to the parent's repository, so the parent must be one the deployment acts on and this agent and lane must hold a live `issue/relate` token there.
- **At the moment of work.** A tick checks the write's token, and for a sub-issue the parent's, again. A token revoked since admission settles the write `refused` `revoked`. A repository that left `GITHUB_ALLOWED_REPOSITORIES`, the write's or the parent's, settles it `refused` `not_allowed`, and a retry is refused too.
- **Ownership.** A write belongs to its agent and lane: another lane reads `404`, and resubmits `409`. `issue/update` needs a `done` create of this lane's for that number, and GitHub saying this App wrote it. Updates to one issue land in admission order, field by field: an older update, as a retry can be, leaves alone each of title, body and state a newer one has already set, and sends the rest; with nothing left it settles `refused` `superseded`. An update is `done` once GitHub accepts its PATCH, whatever the read after it. A machine's work link never replaces another source's link.
- **Public content.** What a machine posts is public. Its body and comments are filed with every ASCII punctuation character backslash-escaped (`src/features/issues/publicContent.mjs`), so GitHub shows exactly the text written: no emphasis, link, entity, HTML or mention can join, hide or reveal anything, and an agent can't mention a person. Credential-shaped text (machine tokens included) and home paths are refused `422 public_content`, as written and decoded (percent escapes, numeric entities, backslash escapes), naming the kind, whatever client sent them. A title is filed as written and shows code spans, so a backtick in one is refused `422 public_content` `markup`. The lane helper (`ops/issues/scrub.mjs`) runs the same rule before it sends.
- **After the body.** The token is held live and in scope in the transaction that admits the write or the link, so a request already open when a token is revoked admits nothing.
- **Backlog.** At most 20 pending writes per token, on every way into pending, else `429` with `retry-after: 30`.
- **Its own tables and flow.** `machine_tokens` is not `runners`, so no runner route can read one by leaving a filter out. `machine_writes` is not `github_writes`, and `github/MachineDispatch` is not `github/Write`: a person's write, its plan and any run in flight are untouched.

## Read tokens

An operator can give an agent short-lived GitHub installation access for repository metadata and issues, without a
personal login or the App's private key. From `apps/mvp`:

```sh
~/vault-ws-deployer/bin/mvp-prod-env node ops/github/read-token.ts \
  --owner <owner> --repo <name> --repo <another-name> --out <private-directory>/github-read
```

The command reads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in the operator's environment. It uses the owner's
installation and requests exactly `{ metadata: "read", issues: "read" }`. Repeat `--repo` to narrow access; omit it
for all repositories available to that installation. GitHub sets the expiry, normally one hour. No key is passed to
the agent, and neither a key nor a token goes on argv or into output.

`--out` is a new mode-600 file containing only the token. Its parent must already exist and must not be group- or
world-writable. The command also creates `<out>.json`, a mode-600, non-secret scope receipt. Neither file is overwritten.
One audit JSON line reports `owner`, `installation`, `repos` (null for installation-wide), `permissions` and `expires_at`.
Give the agent both files and set `SMITHERS_GITHUB_READ_TOKEN_FILE` to the raw token file's path.

Revoke without loading the App's credentials:

```sh
node ops/github/read-token.ts --revoke <private-directory>/github-read
```

This sends `DELETE /installation/token` with the token read from its private file, prints `{ "status": 204 }` on success,
and exits nonzero on refusal. Revoking does not delete the local files.

Direct GitHub GET consumers can import `githubRead` from `ops/issues/githubRead.mjs`:

```js
const reads = githubRead()
const response = await reads.get("https://api.github.com/repos/acme/widgets/issues?state=all")
const summary = reads.summary()
```

`get` returns a Response and accepts only HTTPS `api.github.com` URLs or paths. It uses `authorization: token …` only
for the receipt's owner and, when narrowed, listed repositories. Other owners and non-repository paths are anonymous;
without the environment variable all reads are anonymous. Redirects are returned without following them. A token's
401 triggers one anonymous fallback, marks `summary.tokenExpired` true, and keeps later reads anonymous. The summary
counts authenticated and anonymous requests without holding credentials. Missing, invalid or unsafe configured files
fail with fixed diagnostic messages. A scope receipt describes issuance; it never grants access GitHub did not grant.
Issuing failures report `github_read_token.failed` with the stage and, when available, an HTTP status; response bodies
and exception details are never printed.

`track.mjs` reads the public Smithers issue shape through `/api/shapes/items`; it has no direct GitHub issue reads to
rewire. Other operator scripts can adopt the exported helper. Both commands use the Worker's shared
`GitHub.GitHubClient.USER_AGENT` from `@smthrs/integrations`. AppAuth supplies signing and minting; these commands are
the operator credential boundary, alongside the existing machine-token issuer, rather than an app plugin or a job.
The helper registers the shipped `vibelang/register` loader before loading the checkout's SDK sources, so the documented
plain `node` invocation needs no extra loader flag.

`ops/github/read-token.test.ts` checks signed JWTs, exact permissions and repository narrowing, private files,
redacted failures, unsafe directories and revoke. `ops/issues/githubRead.test.ts` checks owner and repository scope,
anonymous reads, redirect refusal, private-file enforcement and the single 401 downgrade, with the requested injected
fetch boundary.

## Routes

| Route | Answers |
|---|---|
| `POST /api/repos/<owner>/<name>/writes` with `Authorization: Bearer smm_…` | `{ writeId, op: "issue/create", title, body, labels? }`, `{ writeId, op: "issue/update", number, title?, body?, state? }`, `{ writeId, op: "issue/comment", number, body }` or `{ writeId, op: "issue/relate", number, parent: { repo, number } }`. `202 { writeId }` new, `200 { writeId, status }` already taken. `401 authentication`: unknown, expired, revoked or another repository's. `403 forbidden`: out of scope, a `smithers:` label, or a parent's repository it holds no token on. `422 public_content`, `429 rate_limited` with `retry-after`, `400 invalid`, `409 conflict`, `413 too_large`, `503 not_configured`, `503 unavailable` |
| `GET /api/repos/<owner>/<name>/writes/<id>` | The agent and lane's own write: `200 { status, failure, cause, githubStatus, number }`, `status` `pending`, `done`, `refused` or `failed`. `cause` names the refusal check or failed reason; `githubStatus` is the upstream HTTP status when available. Both are nullable, null for pending/done writes and older receipts, and cleared on retry; `404 not_found`; `401 authentication` |
| `POST /api/repos/<owner>/<name>/writes/<id>/retry` | Puts the agent and lane's `failed` write at the back of the queue, under this token, which needs the write's scope and room, and the parent's repository; its marker keeps it one issue. A write already pending starts its dispatcher again, so a lost start can be made good. `202 { writeId, status }`; `403 forbidden`; `429 rate_limited`; `409 conflict` when it isn't theirs, or has settled otherwise |
| `POST /api/repos/<owner>/<name>/issues/<n>/links` | [Work links](work-links.md), within `work/link`, with `source` `machine:<agent>/<lane>` |

## Pacing

`machine_writes` is the queue, first in, first served, and one durable flow per owner, `github/MachineDispatch`, drains it: a durable sleep (`system/sleep`), one tick, the next round, until the queue is empty.

- **One send at a time.** A tick makes at most one POST, and rounds run one after another, so the send is held through its HTTP call. The next call waits 7.5 s from the end of it: under 480 an hour and 8 a minute, GitHub's secondary limits being 500 and 80.
- **The hold comes first.** `machine_dispatch.next_at` is checked before any read or token, so a hold stops everything. One row per owner, and an App has one installation per owner, so it is the installation's, within this deployment's database. Machine tokens are issued for production alone, so nothing else sends under this budget.
- **A rate limit** on any call, read or write, is a 429, or a 403 with `retry-after`, `x-ratelimit-remaining: 0` or a message naming a rate or abuse limit. It holds every call until the server's full wait, or a penalty of 60 s doubling to 30 minutes, whichever is later. A success resets the penalty, and the limit spends no try. A limit on looking up the installation or minting its token holds the same way, for GitHub's full wait.
- **A permission 403**, a 404 or a 422 settles the write `refused`, and is never retried, except for a missing repository label (404 creates it) and a concurrent label creation (422 `already_exists` succeeds).
- **A write that can't finish** settles `failed`: after 20 real tries (waiting and successful label provisioning spend none), or on a defect, which is that write's and not the queue's. The dispatcher goes on. Sending it again answers `failed` and starts nothing; the retry route is the deliberate way back.
- **Recovery.** Each write carries `<!-- smithers:write=<recovery id> -->`, an id the server makes when it admits the write and never the caller's `writeId`, so no caller can name a marker another write left. The search matches only issues and comments GitHub names this App as the author of, so a marker someone copies into their own older issue is ignored. A tick looks for it before it POSTs, closed issues included, so a lost answer or a killed run never makes a second issue. A same-title issue is never a receipt. `issue/relate` looks at the child's parent first: already there is done, another parent is `refused` `has_parent`, never replaced.
- **Starting.** Any request with a pending write starts the owner's current epoch, whose execution id is fixed, so a start that was lost is made good by the next request. A dispatcher more than 10 minutes past when it said it would wake is taken to be gone: the next request starts another epoch, and a tick of the old one stops itself.

## Lane helper

`track.mjs open --label name[:color[:description]]` passes metadata through to the create write. Repeat `--label` for more labels. For example, `--label tree:ededed:Tree` or `--label migrate:t3code:123ABC:Migration`. `--label tree::Description` uses the default color. A six-digit hexadecimal color or an empty color starts metadata; other colons remain in the name, so `--label migrate:t3code` is unchanged. Issue body markers list names only. Metadata is used only when creating a missing repository label.

## Tests

`E2E_MACHINE_TOKEN_FILE` names the private token file issued by `ops/machine-token/issue.ts` for the scratch
repository. The production spec declares `machineToken`; a missing file is a reported prerequisite, without reading
or printing its value during need detection.

| File | Proves |
|---|---|
| `worker/github/MachineWrite.test.ts` | the route's scope and refusals, a token revoked while its body arrived, a person-only act and policy labels refused, public content, authority over a parent's repository, lane ownership, the backlog bound on every way into pending, the App as author, missing/existing labels, metadata validation, label creation races and lost answers, twenty-label provisioning, stored label refusal causes and User-Agent coverage, recovery by marker, look-first sub-issues, service in order, spacing from the end of a send, holds before reads and tokens, penalties, a permission 403 with a future reset, truncated JSON, defects, lease and epoch, `failed` and its retry, updates by the owning lane, `github/Write` replaying with both flows registered |
| `ops/issues/track.test.ts` | label metadata parsing, name-only markers, metadata scrubbing and create payloads |
| `ops/machine-token/issue.test.ts` | only the digest stored, the 7-day and scope bounds, the mode-600 file |
| `e2e/machine-token.spec.ts` | production, on a sandbox repository the App is installed on: an agent token files an issue, the bot is its author, and a person-only act with the same token is refused |
