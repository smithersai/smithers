# Smithers UI runtime contract

The same React application runs against two explicit hosts: Smithers Cloud and a
local Bun origin. Electrobun is an optional native shell around the local
origin; it is not a separate application or state model.

## Composition roots

| Host | Server | Native privileges | Typical capabilities |
| --- | --- | --- | --- |
| Smithers Cloud | `apps/server` Cloudflare Worker | none | agent, identity, Smithers Cloud, checkout when configured |
| Local browser/headless | `apps/ui/src/bun/serve.ts` | explicit development path entry | repositories, targets, terminal, harnesses; agent/identity only in hybrid mode |
| Local native | `apps/ui/src/bun/index.ts` + Electrobun | folder picker and system-browser handoff | same local services; no renderer-supplied filesystem paths |

The client first loads `GET /api/bootstrap` and validates it with
`AppBootstrapSchema`. Commands declare required runtime capabilities; the
registry omits unavailable commands. Components render from that registry,
so disabled hosts do not expose controls that can only fail.

Supported capabilities are `agent`, `identity`, `cloud`, `billing.checkout`,
`keys.byok`, `local.repositories`, `local.repository-path-entry`,
`local.targets`, `local.terminal`, and `local.harnesses`.

## Local modes

`SMITHERS_LOCAL_MODE=offline` is the headless default and performs no Smithers
Cloud requests. `hybrid` enables the configured chat and identity upstreams.
`SMITHERS_CHAT_STUB=1` supplies a deterministic in-process agent for tests and
also disables the identity proxy.

The native launcher defaults to hybrid unless explicitly set to offline. The
packaged app serves its built SPA from `127.0.0.1` on a port chosen at first
launch and saved as `local-origin-port` in its application-support directory.
Later launches reuse that port because OPFS and localStorage belong to the
complete browser origin. If the saved port is occupied, startup fails rather
than moving the user's conversation to an empty origin. `SMITHERS_LOCAL_PORT`
is an explicit development/test override and does not replace the saved port. The
headless server prints `SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port>` when it
is ready.

## Local-origin security

Each server launch creates a fresh 256-bit token. The token is placed in the
served document's `smithers-local-session` meta tag. The client sends it in
the `x-smithers-local-session` header and in the WebSocket subprotocol.

The server rejects missing/invalid tokens, cross-origin API requests,
unexpected `Host`/`Origin` values, non-JSON mutation bodies, oversized HTTP
bodies and WebSocket frames, excessive subscriptions, and unknown client
message types. It binds loopback only.

The native RPC surface has exactly two privileged operations:

- `pickLocalRepository({ access })`, which returns a short-lived, one-shot
  authorization id for the selected directory;
- `openExternal({ url })`, which accepts only HTTP(S) URLs and opens the
  system browser.

Neither operation has an HTTP fallback in the packaged app.

The identity proxy re-scopes the seam's session cookie to the local origin
before the WebView sees it: `Domain` goes because the cookie belongs to this
origin now, and `Secure` goes because WebKit refuses a `Secure` cookie set over
`http://127.0.0.1` (Chromium accepts one, so only the native renderer showed
the failure). The trail line for `/api/auth/native/claim` names the cookie's
attributes, never its value, and every `/` and `/api/*` request leaves a
`METHOD /path -> status in Nms` line.

The cloud proxy (`/api/cloud/*`, lane piper) forwards to `SMITHERS_CLOUD_API`
(default `https://api.jjhub.tech`) with the same rules as the identity proxy:
Host and Origin follow the upstream, `content-length` and the local session
header are dropped, Set-Cookie is re-scoped, and the request carries
`Authorization: Bearer` from the Bun-side credential. The cloud token NEVER
reaches the renderer. Cloud sign-in (`/api/cloud-auth/*`) is the CLI's browser
flow: start answers the login URL, the callback lands on a loopback listener,
and the token lives in the macOS keychain (`smithers-cloud`) plus Bun memory;
the session route answers `{ state, username, expiresAt }` only.
`SMITHERS_CLOUD_TOKEN` is a dev/CI override read first. A signed-in session
loads the repository inventory (the sidebar's `org/ → repo → working copies`
tree) through the proxy; the bootstrap advertises the `cloud` capability when
the proxy is enabled.

## Repository and process authority

Repo-scoped slash commands treat a trailing `owner/repo` in argument text as
an explicit target only when it names a loaded repository or the active working
copy's repository. Other path-shaped tokens stay in the text: `/issues.create Fix
src/index.ts` keeps the full title and uses the active repository, or the sole
loaded repository when none is selected. Repository-only commands such as
`/repos.import acme/new` can name a repository that is not loaded yet.

Native repository opening is a two-step grant flow: the picker authorizes a
canonical path for 60 seconds, then `/api/repo/open` consumes the authorization
exactly once. Both repository and connector pickers wait for adoption before
publishing inspection metadata; capabilities never enter the transition journal
or verbose trace. Headless development explicitly advertises
`local.repository-path-entry` and may instead send `{ path }`.

Open repositories receive opaque `repoId` values and a read-only or read-write
access level. Process APIs accept `repoId`, never a renderer-controlled `cwd`.
Terminals and target execution require read-write access. Target queries mint
opaque target ids; a run resolves the command label server-side and rechecks
the current graph before spawning it.

Make read-only sends `POST /api/repo/access { repoId, access: "read" }`.
Disconnect sends `POST /api/repo/close { repoId }`. The controller resolves the
connector's canonical root against `/api/repos`, waits for host success, then
refreshes open repositories and commits the connector transition. A failed
request leaves the connector unchanged and reports the error.

Both host actions deny new writes, cancel pending target runs, terminate running
target children and repository PTYs, and wait for in-flight PTY creation to
settle and terminate. Requests preparing a target recheck authorization before
starting it. Home-directory PTYs are independent. Close also ends language
servers and removes the repository from the open set. Reduced grants and
removals are saved atomically to `repositories.json` before success; a failed
save leaves host writes denied and the repository addressable for retry.
The access endpoint cannot upgrade a grant. Upgrading requires a fresh picker
authorization (or a new explicit path open on a development host).

Language servers (`apps/ui/src/bun/lsp/`) read: `/api/lsp/*` requires read
access. One `typescript-language-server --stdio` runs per (repository,
language), started on the first request from a static registry that names
the binary, its argv and its install line (the renderer names none of them).
The binary is found on the HOST (the harness candidate dirs and PATH) and
never inside the repository: a `node_modules/.bin/typescript-language-server`
a repository ships is a program the repository chose, and opening a
repository (read-only or not) runs nothing it ships. The server runs under
the `lsp` sandbox policy (no network, scratch-only writes) with an
environment of its own (`HOME`, `PATH`, `TMPDIR`, locale, zone, and none of the
provider keys, SSH agent or config dirs the PTY allowlist hands a harness).
At most four run; the least recently used makes room; ten idle minutes with
no request in flight, `POST /api/repo/close` and shutdown end them (LSP
`shutdown`/`exit`, SIGKILL after two seconds). Repository close cancels pending
session acquisitions before resolving, including waits for Node discovery or
server retirement. Requests during close are refused; a later request may
start a fresh session after the repository is reopened. Host shutdown cancels
all pending acquisitions and permanently refuses new ones. Cancelled
acquisitions return `503 language_server_failed`. Request bodies are capped at
64 KiB, with 8 RPCs in flight per server. Deadline budgets are separate:

- Initialization allows 15 s (`LSP_STARTUP_TIMEOUT_MS` in
  [`LspSession.ts`](../src/bun/lsp/LspSession.ts)).
- After initialization, the first hover or definition starts a shared 15 s
  project-load deadline (`LSP_STARTUP_TIMEOUT_MS`). Concurrent cold queries
  use its remaining time; they do not extend it. A successful positioned
  response ends the cold window. Queries sent after success or deadline
  expiry use the steady-state budget.
- Steady-state RPCs allow 5 s (`LSP_REQUEST_TIMEOUT_MS` in
  [`LocalApp.ts`](../../../packages/rpc/src/LocalApp.ts)).
- Diagnostics wait up to 5 s for a publication (`LSP_REQUEST_TIMEOUT_MS`,
  passed by [`routes/lsp.ts`](../src/bun/routes/lsp.ts)), after initialization
  and document sync. A cached current publication returns immediately.

These are stage budgets, not a five-second end-to-end request limit. The
[`LspSession.startup.test.ts`](../src/bun/lsp/LspSession.startup.test.ts)
example exercises bounded initialization, concurrent cold queries and the
return to steady-state deadlines.

What the server writes in free text
(hover markdown, diagnostic messages, its last stderr line) has the host's
absolute paths made repository-relative, or cut to their last segment
outside the repository, before it reaches the renderer, the model or `/ws`;
the type of a symbol imported from outside the repository is still the type
tsserver computed for it. Every answer names the digest
(`RepoFilesResponse.digest`, SHA-256 of the bytes) of the file text it was
about, and every cap says it cut (`total`, `omitted`, `truncated`).

PTY admission defaults to eight slots, including launches still resolving
their setup and children still terminating after a tab closes. Exited display
records do not consume a process slot. The internal PTY owner has an idempotent,
permanent `dispose()` (replacing `killAll()`): pending create calls settle as
`manager_closed`, late setup cannot spawn, and new creates are refused (HTTP
503 while the route is still reachable). Injected setup work itself has no
abort contract. Termination failures reject shutdown; they never report a
clean stop or release the still-owned child's capacity. Independent local
listener, auth and LSP finalizers are attempted even if PTY disposal fails.

Closing a local terminal or harness tab removes it only after the session
DELETE succeeds or returns 404. Other HTTP responses and transport failures
surface a termination error and keep the tab. A pending close confirmation
stays open so Close session retries; exited tabs retry through close directly.
Closing a cloud workspace terminal still detaches without deleting its session.

PTY scrollback retains at most 64 KiB of raw UTF-8 output per session.
`GET /api/pty/:id/output?tail=<bytes>` strips ANSI escapes and returns a suffix
within the requested non-negative safe-integer byte limit. It drops a partial
code point at the cut, so a result can be shorter than the requested limit;
`truncated` reports either scrollback or requested-tail loss. This is text
capture, not a reconstruction of the terminal screen.

Target-run count, input bytes, retained history and WebSocket subscriptions
also have limits. Target cancellation and host shutdown signal each target's
process group with SIGTERM, allow two seconds to exit, then send SIGKILL if
the run or its group remains. They cancel output readers after escalation so
inherited pipes cannot hold shutdown open, and await the direct child's exit.
After SIGKILL, the host allows two seconds for the process group to disappear;
a surviving group rejects shutdown.
Descendants that leave the process group are outside this signal boundary.
Shutdown closes target admission before waiting and cancels armed pending runs.
The cancel response and route shutdown wait for terminal history appends;
server shutdown awaits the route shutdown before the native launcher exits.

Target run requests reserve an inert run and write its initial journal record
before enabling attachment or the one-second auto-start timer. If journal
initialization fails, the request returns HTTP 500, releases the reservation,
and never starts the target. Reservations count toward the active-run limit.

Target history acknowledges frames only after their journal append succeeds.
On the first append failure, list/replay return `run.journal` (or the listed
record's `journal`) with `state: "degraded"` and `error`; later frames for that
run are not appended or acknowledged. An unsettled history record becomes
`failed` without an exit code. The host logs the first error once per run.
`history.flush()` waits for queued appends and rejects on any append failure;
server shutdown awaits it after target termination, alongside independent
finalizers. It does not provide an fsync guarantee.
Target history memory is bounded independently of journal size. Loading a
repository streams at most four journals at a time line by line and keeps only
each run's record. A run's resident stdout/stderr tail is capped at 1,000,000
characters, dropping the oldest log frames and never a structured frame. At
most 16 settled runs keep their event tail resident, in last-use order; a
replay of an evicted run re-reads its journal with the same cap. Live and
degraded runs are never evicted. A run's unwritten log backlog is capped at
4,000,000 characters: `history.event()` resolves once the backlog is under
the cap, and the runner reads the next chunk of child output only after the
previous frame's consumer resolved. Output the child has already written to
its pipe is buffered by the runtime and is outside this bound.
After restart, a journal missing its terminal record reports degraded history
with a generic interruption error. The original filesystem error is available
only in the failing process and its log, since a failed disk cannot reliably
persist its own failure. Successfully appended stdout/stderr remains subject
to the in-memory tail cap.

## Multi-workspace repositories and plugins

Repository detection records the root and child Smithers workspaces (up to two
levels deep) as paths relative to the opened repository. Target discovery runs
the CLI once per detected workspace. Each opaque target grant binds its
workspace and label on the server; extra renderer-supplied fields cannot move a
process to another directory or change the command. A grant id stays stable
across re-queries while its target (workspace and label) survives, so one
client's query never invalidates another's cards. A grant is retired when the
target disappears from the query snapshot or the repository's authority closes.

A target's presentation is part of its declaration, never a separate
manifest: a PACKAGE.ts target may carry `summary: "..."` (one line, shown
under the label in the targets card) and `featured: true` (the target leads
the card's Featured view beside the user's stars). The label is inferred from
the package path and export name; the loader listing carries `summary` and
`featured` beside `label`, `target`, and `kinds`. "Run everything" is not a
declaration either: the Featured view's run strip is derived from the CLI's
verbs over `//...` for the kinds the repository actually has.

## HTTP and WebSocket surface

All mutations require `Content-Type: application/json`; failures use
`{ error: { code, message } }` locally. A path whose percent-encoding is not
valid UTF-8 answers `400 invalid_path` in that envelope, static or routed, and
leaves its trail line. An agent turn body is capped at 1 MiB by the bytes
received, so a chunked body is refused with `413 body_too_large` like one that
declares its length.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bootstrap` | Versioned host/capability contract |
| GET | `/api/health` | Local process, Node, and sandbox status |
| POST | `/api/agent/turn` | NDJSON agent stream (`/api/chat/turn` is a compatibility alias) |
| POST | `/api/agent/turn/cancel` | Cancel a turn (`/api/chat/cancel` is an alias) |
| GET | `/api/harnesses` | Installed harness snapshot (each row states its verified model suggestions and whether it has a list command) |
| GET | `/api/harnesses/:id/models` | The harness's own model list (its list command under a 5 s cap), else the table's verified suggestions; empty + reason on failure |
| GET | `/api/agents` | The agents (built-in and custom), seeded from the built-ins into `<stateDir>/agents.json` on first read |
| PUT | `/api/agents/:id` | Create or edit an agent `{ label, purpose, harness, model }`; the harness must take a verified model flag, the model id no spaces or leading dash; a built-in keeps its harness |
| DELETE | `/api/agents/:id` | Remove a custom agent; a built-in answers 409 |
| POST | `/api/repo/open` | Consume `{ authorizationId }`, or dev-only `{ path }` |
| GET | `/api/repos` | Open repository snapshot |
| POST | `/api/repo/access` | Downgrade `{ repoId, access: "read" }`, stop repository processes and save the reduced grant |
| POST | `/api/repo/close` | Revoke and forget `{ repoId }`, stopping repository processes |
| POST | `/api/repo/files` | `{ repoId, path? }`: a directory's entries or one file's text with its `digest` (read access; bounded; binary stated) |
| POST | `/api/lsp/hover` | `{ repoId, path, line, character }` (1-based): the language server's hover at the position, `{ hover: { contents, truncated, range? } \| null, digest }`, text cut at 4 KiB and `truncated` when it was (read access) |
| POST | `/api/lsp/definition` | Same body: `{ locations, total, omitted, digest }`, repository-relative, at most 20; targets outside the repository are counted in `omitted`, never listed |
| POST | `/api/lsp/diagnostics` | `{ repoId, path }`: the server's publication for the file, `{ path, version, items, total, digest }` (at most 50 items of `total`; `items: null` when none arrived within 5 s) |
| GET | `/api/lsp/servers` | `{ servers: [{ repoId, language, state }] }`: the language servers running, `starting \| ready \| exited` |
| POST | `/api/targets/query` | Query `{ repoId }` and mint target ids |
| POST | `/api/targets/run` | Run `{ repoId, targetId }` |
| POST | `/api/targets/cancel` | Cancel `{ runId }` |
| POST | `/api/targets/{graph,runs,runs/replay,affected,ci,open-source}` | Local target graph/history tools |
| GET/POST | `/api/pty` | List/create PTYs; create accepts `repoId`, never `cwd` |
| POST | `/api/pty/:id/resize` | Resize a PTY |
| DELETE | `/api/pty/:id` | Stop a PTY |
| ANY | `/api/cloud/*` | Cloud proxy to `SMITHERS_CLOUD_API` (Bearer from the Bun credential; 501 offline) |
| POST | `/api/cloud-auth/start` | Begin the browser login; answers `{ url }` |
| GET | `/api/cloud-auth/session` | `{ state, username, expiresAt }`, never the token |
| POST | `/api/cloud-auth/sign-out` | Delete the keychain credential and the in-memory token |
| POST | `/api/linear-auth/start` | Begin the Linear OAuth handoff (lane sync): a loopback listener on a random port waits for the cloud's redirect; answers `{ url }` to open. 501 offline |
| GET | `/api/linear-auth/session` | `{ state: "idle" \| "waiting" \| "authorized", setupKey? }`, the setup key once the callback lands, never the token |

`POST /api/targets/affected` requests CLI plan inputs and uses static declaration
inputs when a target has no plan input list. An empty plan list is authoritative.
The fallback recognizes exported or indented const bindings, the imported
`Smithers` alias, and literal `file("path")`, `glob("pattern")`, and
`glob(["pattern"])` calls. Package declaration edits remain inputs for their
targets. The declaration files are rescanned per request, by the same walk the
graph digest does, so a PACKAGE.ts written after the repository was opened
counts; `/api/targets/ci` renders its preview from that same fresh list. Globstar matches zero or more path segments; each unique pattern compiles
once per request. The response names the available input sources in `signal` and
propagates matches through reverse graph reachability.

WebSocket subscriptions carry target-run and PTY output and, on
`lsp:<repoId>`, every diagnostics publication a language server makes for a
file the renderer asked about (`{ type: "lsp.diagnostics", repoId, path,
version, items, total, digest }`).
Client messages are limited to subscription control, `target-run.attach`, and
`pty.input`.

`/api/lsp/*` refusals are typed: `409 language_server_missing` carries the
install line verbatim in `error.install` (nothing installs it),
`400 language_unsupported` names the extension no row of the registry
handles, `504 language_server_timeout` and `502 language_server_failed` name
a server that did not answer or left, and path refusals reuse the files
route's codes.

A file card of a CLOUD repository asks the language server plue runs inside
the repository's running workspace instead (lane L6, plue#505): the renderer's
`CloudLspClient` creates the session (`POST …/workspace/sessions
{ workspace_id, kind: "lsp", language }` through `/api/cloud/`), opens
`/api/cloud-ws/repos/{o}/{r}/workspace/sessions/{id}/lsp`, the same tunnel
as the terminal, with plue's `lsp` subprotocol and a 1 MiB frame cap on that
branch alone (a larger message crosses as `{ seq, last, data }` fragments the
renderer reassembles up to 16 MiB), and speaks LSP itself: `initialize` with
`rootUri file:///home/developer/workspace`, `initialized`, `didOpen` with the
card's text at its checkout-relative path, then hover, definition and the
publications. A refused upgrade closes the renderer's socket with a 44xx code
that mirrors plue's status; on this branch the reason carries plue's
`code: message` verbatim (`language_server_missing: npm i -g …`) and, for a
425 `workspace_session_pending` (4425) or 503 `guest_not_ready` (4503), the
`Retry-After` it named, which the client honors with a bounded retry while the
card shows the server's words. 1011 retries once with a fresh initialize,
1001 and an abnormal drop reconnect, 1008/1002/1003/1009 are final, and every
close reason reaches the card verbatim. A cloud repository without a running
workspace is told which act opens or resumes one; a file no relayed language
handles is told the DTO's `lsp.languages`.

## Target presentation

Opening a repository renders nothing in the transcript; the sidebar pin and
the composer's selector name it. Target discovery is the explicit
`/target.list` act (the model has the same flow): it appends the trusted typed
React card, and a repository with no Smithers workspace answers the reason as
text.
Models can provide explanatory text but cannot author markup, scripts, command
labels, bridge messages, or action handlers. Historical HTML cards remain
decodable for migration and render in a CSP-restricted inert iframe with
scripts and network access denied.

Target-run Timeline controls invoke `/target.timeline <repoId> <runId>`.
Replay scrubs share a cursor index per recording and coalesce pending values to the latest cursor.
Each node projects at most 200,000 log characters. Replay indexes and completed live folds each
retain at most 16 runs and an estimated 16 MiB of payload plus index metadata, in last-use order.
Entries without a graph or timeline card are released; controller disposal clears both caches.
Evicted recordings are fetched again when a timeline or scrub needs them. Oversize recordings
can be projected but are not retained in the replay cache.
Run and failed-node Explain controls send `agent.explain` a JSON envelope with
`kind: "target-failure"`, a fixed `request`, and `evidence` containing `repoId`,
`runId`, `target`, `exitCode`, and the last 4,000 characters of captured output.
The explainer keeps the request separate from a delimited JSON evidence
message. Target metadata and output are untrusted data; higher-priority
instructions forbid following instructions embedded in them. JSON escapes
angle brackets so captured text cannot close the evidence delimiter.
Ordinary `/agent.explain <what>` questions remain plain text.

## Cards

Every capability's output is an embedded card in the transcript (THE EMBED
LAW); maximizing one is a presentation transition of the same component. Each
card file's header comment is that card's own contract: the facts it renders,
the facets it switches, and the acts it binds. This section names the
surfaces; the file states the detail, and its tests pin it.

The run lifecycle (lane `runs`, `docs/workbench-lanes/runs.md`) adds three
surfaces, all over the workspace gateway's own projections and procedures:

- **`run-list`** (`/runs.list [status] [flow] [by=] [lineage=] [owner/repo]`):
  the workspace's runs from the `workspace-runs` projection, newest first, a
  mono count line by status in the header and filter chips that re-invoke
  `runs.list` with the chip's argument. A row's Open materializes the run's
  own card (`/runs.open <runId>`); the footer's `Stop all N` runs
  `/flow.run.stop-all` (a confirming flow). `by=` refuses honestly: the wire's
  run summary records no launcher.
- **`approvals-inbox`** (`/approvals.list [owner/repo]`): every pending gate
  across the workspace's runs (the `approvals` projection with no run id).
  Each row carries the submit-ready envelope the gateway published, so its
  Approve/Deny dispatch the ordinary `approval.approve` / `approval.deny`
  flows addressed `inboxCardId:requestId` and the decision goes back
  unchanged. `/approvals.open <runId>` materializes one run's gates as
  ordinary approval cards.
- **`flow-run`** grows the run card's lifecycle beyond launch: Stop on
  every non-terminal phase (`/flow.run.stop <cardId> [reason]`, confirming),
  Resume when the control plane names a wait other than an approval
  (`/runs.resume`), Run again when settled (`/runs.rerun`, the launch input
  recorded on the card at launch; an honest refusal when this client never
  saw it), and a steer row (`/runs.steer`, `/runs.seat`, `/runs.thinking`,
  `/runs.tools`) whose queued state reads `steering pending · delivered at
  the next turn`. A waiting run names the control plane's reason:
  `accepted · nothing is driving it` for an accepted run, the wait's word for
  a parked one. Three facet tabs switch the body: Steps (default),
  Transcript (`/runs.logs <runId> [--follow]`: follow merges the
  `transcript` projection on the pump's own cycle), and Events
  (`/runs.events <runId>`, the raw journal, rendered only where
  `/debug.verbose` is on).

Lane `citc` (ADR 0002) adds the persistent cloud computers:

- **`workspace`** (`/workspace.open [bookmark] [owner/repo]`, `/workspace.view
  <id>`) opens one cloud computer bound to a repository bookmark. The header
  names the repo, the target bookmark, and the BOOKMARK's head (`bookmark
  main head @ qupxosqw`), then the facts line the DTO carries: the sandbox
  kind, the workspace's OWN head (`workspace head @ qupxosqw a03f5f11`), how
  far it is `ahead` of and `behind` the bookmark, its uptime, the Nix
  environment it was built from (`source @ revision`), its persistence, and
  the languages it relays a language server for (`lsp: typescript`, from the
  DTO's `lsp.languages`). Every fact renders only when the payload carries
  it: an absent field renders NOTHING, never a placeholder and never a zero
  the wire did not state. A vm or desktop adds what it booted (`env ·
  <closure> · <image tag>`), a driving agent session is named but not opened,
  and the ssh host rides its own copyable line. A six-state pill (pending,
  starting, running, suspended, stopped, failed) leads; a starting workspace
  streams its `provisioningStage`, a failed one names the stage plus plue's
  failure code and message verbatim and offers the three kinds as the retry
  (`/workspace.open … --kind <kind>`). The facet strip switches Terminal (the
  attachment or the refusal in plue's own words and code, then every session
  with its id, its status, and its Destroy), Files (the repository file
  card's own listing, bound to the workspace's routes), Services (each
  declared service with the port and url it publishes), Snapshots (Fork
  from, Make template, Delete per row), and Egress (each call this computer
  made, whether it was allowed or blocked, and which secret NAMES the proxy
  swapped in, never a value); a `desktop` workspace also gets Desktop, which
  mints a session and streams plue's NixOS VM over VNC, so it is its own
  confirmed act rather than a facet switch. The footer acts: Suspend or
  Resume, Fork, Snapshot, and Delete behind a typed confirm.
  `/workspace.terminal` opens the workspace's terminal as an ordinary
  terminal tab whose row carries a `workspaceId` instead of a `cwd` (the
  socket tunnels through the Bun server's `/api/cloud-ws/` bridge with the
  Bun-held bearer attached upstream, and the token never reaches the
  renderer), and closing the tab detaches; killing the session is the
  explicit `/workspace.session.destroy`. That act is rendered only where the
  live registry holds `workspace.terminal`, and the Terminal facet otherwise
  says terminals are not on the web yet. Every workspace act refuses a
  `degraded` cloud session with the "sign in again to enable" wording (ADR
  0001's legacy scope set).

Lane `change` (ADR 0003) makes the change the unit of review:

- **`change`** (`/change.view <changeId>`) renders one card per change, from
  plue's change DTO plus its auxiliaries: the per-repo stat, the carrying
  landing request's stack position (`Landing #42 · position 2 of 2 · open →
  main`), and the changeset when the repository's owner is an org (a `failed`
  changeset renders its `failure_reason` verbatim). The header names `repo ·
  changeId · rev N of M · commit · author`, the landing pill, and whose turn
  it is by LOGIN (`turn: will · reviewer`); a field the GET did not state
  renders nothing, so a change with no recorded revision shows no revision
  count. Five facets always switch the body: Diff (two revision pickers that
  pin any pair through `change.pins`, the file rows at those pins each
  opening its one-file diff and offering Split while the stack's landable
  prefix is short, and `since your review at rev N` with show all once a
  human review is recorded), Findings (the analyzer runs, then one row per
  finding with its severity, analyzer, `path:line`, summary, the revision
  that raised it, `· stale` when its anchor moved off, the feedback that
  dimmed it, and its two acts, Please fix and Not useful), Checks (a revision
  picker, then the newest answer per context with the work it did, `12
  affected · 3 ran · 9 cached · 4s`), Review (the verdict strip with the
  confidence WORD, the Request review picker off the landing's
  `review_requests[]`, and the threads with Done / Ack / Reopen, each anchor
  carrying `· stale` or `· moved → :line`),
  and History (one row per revision with its provenance, its Diff to current
  and Open computer acts, then the landed row). Walkthrough joins the strip
  only when an artifact exists, leading when the current revision came from
  an agent session and the change touches more than 20 files and otherwise
  sitting after History; Owners closes the strip only when the change GET
  carried ownership. The footer acts: Land (the carrying landing request:
  queued, never "merged"; `Land 1 → N` for a stack, `Retry land` for a failed
  one, the changeset's own atomic route when one carries the change, a 409
  re-reads, and a blocked gate names its reason beside the button), Split
  ready while the changeset can still land, Revert on a landed change, and
  Full diff. A `degraded` sign-in reads a change freely; dispatching the
  resolve agent refuses with the "sign in again to enable" wording.
- **`diff`** (`/change.diff <changeId> [from] [to] [path]`) renders one from →
  to pair pinned at the change's commit (`parent → rev 2 · pinned at rev 2 ·
  a03f5f11`), conflicted files leading. Any pair pins: `parent → current`
  reads plue's bare route and every other pair is a revision diff with jj
  interdiff semantics, so a rev → rev interdiff is an ordinary read; a token
  naming no recorded revision refuses by name and guesses nothing. A hunk
  inlines up to 400 patch lines; a larger one rides by reference and names
  its re-read (`/change.diff <changeId> parent current <path>`), and a binary
  file says so instead of showing a diff.

Lane `sync` (ADR 0005) adds Linear and GitHub sync as actions:

- **`connector-setup`** (`/linear.connect [owner/repo]`, `/github.app
  [owner/repo]`): one card kind serves both handoffs. The Linear half is
  the wizard: the steps authorize → team → repository → confirm render as
  rows that fill in (`authorized as Will`, `ENG · Engineering`), a failed
  step reads the server error verbatim (`authorization expired · Open
  Linear again`), and the OAuth handoff rides the Bun server's
  `/api/linear-auth/*` receiver. The setup key, never a token, reaches the
  renderer and stays in transient seam state shared by the user and agent
  bindings. Cards, transition history, persistence, and error text exclude
  the handle. Completion, failure, and expiry discard it; reloading requires
  Open Linear again. Confirm requires a numeric integration id from the
  create response or refreshed list; otherwise the setup card shows an error.
  On confirm the SAME card turns into the connected state:
  `ENG · Engineering → org/repo`, the last-sync age, and Sync now /
  Activity / Disconnect (`/linear.sync`, `/linear.activity`,
  `/linear.disconnect`, the last confirming). The GitHub half renders the
  App status read (`/github.app`): installed `· installation <id> ·
  configured`, or the trusted install link with Open GitHub
  (`/github.app.open`), plus Re-check and Reconcile
  (`/github.reconcile`; the route is 404 in prod today and its message
  shows verbatim). `/repos.app` stays as `github.app`'s hidden alias.
- **`sync-ops`** (`/linear.sync [integration]`, `/linear.activity
  [integration]`, `/github.mirror-sync [owner/repo]`) is one card kind for
  Linear syncs and GitHub mirror syncs: the subject, the run's own state word
  and, for a mirror, the repository's `mirror_status`, the refs line (`behind
  GitHub · 3 refs · 1 failed`), the run's counts (`12 of 20 · 1 failed`), the
  run id or the trigger's one fact (`sync started`, `already running`), then
  the durable ops newest first. An op row carries its glyph, `source → target
  entity action` in the wire's own words, its status, its age, its error
  verbatim, and, when the wire marked it retryable, a Retry on its OWN
  backend's route (`/sync.retry <opId>` for a Linear op through the
  integration that carries it, `/github.mirror.retry-ref` for a mirror ref);
  a failed op is never filtered out. Past ten ops the card offers Show more
  (`/sync.ops.show-more`), and a feed with older pages offers Load older
  (`/sync.ops.load-older`, the Link header's keyset cursor). A null `runState`
  wears the neutral pending pill, never "done".
- **`repo-import`** grows the job's own progress: the stage counts (`refs
  214 of 214 · objects … · issues …`) when the wire carries them, the
  failed phase's Retry through `/repos.import.retry <jobId>` (the route
  exists), and the done state's workspace link (`/workspace.view`). A
  structured 429 (`code: "github_rate_limited"`) renders the ADR's
  rate-limit line on every sync card (`GitHub rate limit reached · 0 of
  5,000 · resets 12:40 · Retry after`), as does a status answer whose
  remaining budget drops under a fifth; a plain 429 invents no reset.
- **`issue`** names the Linear link the DTO carries (`Linear ENG-482`,
  linked) or offers Link to Linear…, the button door of
  `issues.link-linear` carrying the issue number, so THE FORM LAW renders
  the form that asks for the identifier. The act POSTs that identifier to
  the issue's own `linear-link` route and re-reads the detail card, so the
  card states the link it just made; `issues.unlink-linear` DELETEs the same
  route and gates the removal on the linked identifier typed back exactly,
  naming the one the card already read.

The Connectors surface's rows read only what the app has read: GitHub's
count is the App statuses its own act filed, Linear's per-team state is the
integrations the seam loaded. A repository never checked is absent, never
assumed.

The composer's origin chip carries the probed checkout's pin: `~/smithers ·
qupxosqw · a03f5f` (`changeId#seq` only when the changes collection knows a
sequence, never from a commit comparison alone), beside piper's `N ahead of
main`. `rev N exists · view` renders only when BOTH seqs are known.

## Navigation and persistence

`AppStore` declares persisted collections once, including each schema, key,
and recovery policy. Construction, preload, and recovery use that declaration;
the repository tree remains memory-only. Cloud seams share `CloudClient` for
JSON transport and failure metadata while keeping their own authorization,
DTO parsing, and retry decisions.

`cloudWorkspaces` owns live workspace facts. `WorkspaceViews` derives working
copies and card headers through TanStack DB queries; ordinary updates and status
polls write the workspace row only. Local pins and sparse older inventory remain
readable until a full workspace row supersedes them. Removing a workspace from the
inventory retains its last observed card facts until a live row is available again.
Frame and branch snapshots capture complete cards and mark workspace cards as
snapshots. Restoring one preserves its captured facts until an explicit workspace
act refreshes it.

Durable routes use `/w/:workspace/b/:branch/f/:frame`. Browser back/forward,
reload, and immutable branch forks operate on workspace/branch/frame records in
the same store as cards. Fullscreen is explicit; the composer remains mounted
and usable while a card is maximized.

Repositories have one address space (lane piper, ADR 0001): the sidebar's
Repos section is the tree `org/ → repo → working copies`: cloud repositories
from the signed-in inventory, local checkouts nested under their repository
when the remote parses into it (standalone rows otherwise), cloud workspaces
beneath their repo. Selecting a repo row names `org/repo`; selecting a copy
row names `org/repo#copyId`. The composer's origin chip states where the
selection lives (`~/smithers · 3 ahead of main`, or `head @ qupxosqw` at a
repository's head). File cards carry the global address
(`/org/repo/path`) and the position the read was taken at; when the
repository's head commit has moved since, a "head moved" line offers an
explicit refresh. Nothing re-reads on its own. `/files.list` and
`/files.read` accept a global path (`/files.read /org/repo/README.md`) when
the two-segment prefix is a repository the app knows.

## Client error reporting

`ClientErrors.report` never throws or awaits delivery. Non-stringifiable
rejection reasons use an object label, then `Unknown error` if that also fails.
Report construction, clock/pathname callbacks, and transport failures are
contained. Failed construction and sends count toward the per-page attempt cap.

## Build and verification

```sh
pnpm --filter smithers-ui typecheck
pnpm --filter smithers-ui test
pnpm --filter smithers-ui build:web
pnpm --filter smithers-ui test:e2e
bun run test:e2e
```

The web build is the Cloud Worker asset and the local server asset. Heavy graph
and markdown-editor modules are dynamic chunks, so they are absent from the
initial application chunk.

`bun test src` does not infer permission to inspect or build a developer's
personal checkouts. The host-workspace cases in `TargetGraph.integration.test.ts`
skip by default. To run them deliberately, set `SMITHERS_HOST_WORKSPACE_TESTS=1`
and an absolute `SMITHERS_GRAPH_READ_WORKSPACE` and/or
`SMITHERS_GRAPH_RUN_WORKSPACE`. These fixtures expect `//src:typeCheck` and
`//src:srcs`; the run workspace must be a disposable clone because its build
commands execute there. The suite retains generated run histories and never
removes a host checkout's existing history directory. Only its own temporary
server directories are automatically cleaned up.

The piper, runs, citc, change and sync browser specs install common routes with
`e2e/playwright/cloudFixture.ts`. Local bootstrap, repository and cloud-session
responses use the shared RPC contracts. Cloud inventory lists use bare arrays;
bookmarks use `{ items, next_cursor }`. Repository loading reads that cursor
envelope when resolving the default bookmark head. Fixture options override
capabilities, local repositories, cloud inventory, per-repository bookmarks,
workspaces and degraded sessions. Register scenario routes after the installer
to override its defaults. Route matching uses exact pathnames and accepts query
strings. `cloudFixture.spec.ts` checks these contracts and override isolation.

The default Playwright host also owns a temporary home/state directory and
does not discover installed harnesses, inspect their account files, or pass
ambient credentials to test terminal sessions. Its harness table reports the
normal contract entries as unavailable. `SMITHERS_E2E_HOST_HARNESSES=1`
explicitly enables real-host detection and the installed-harness browser tests;
those tests can read local account state and launch installed CLIs. This flag
does not enable cloud identity or real chat. `SMITHERS_CHAT_STUB=0` is a separate
explicit real-chat request. A successful server shutdown removes only its
owned temporary directory; failed startup/shutdown retains it for inspection.

The root `test:e2e` command packages the stable macOS app with Electrobun's
native renderer, launches the actual bundle, and drives it through a loopback
bridge that exists only when `SMITHERS_E2E_BRIDGE=1` and requires a random
bearer token. The runner redirects application state to a temporary home,
keeps the local origin fixed across relaunch, fetches the pinned public
`codeplanesmithers/canary-sandbox` fixture into an isolated clone, and
preserves failure artifacts under `apps/ui/test-results/electrobun-packaged/`.
It covers the stable renderer, bridge security, native repository picker and
authorization, repository failure recovery, real target execution, chat and
repository persistence, card tabs, and a real PTY/WebSocket lifecycle.

`PackagedApp.quit()` drains only the detached process group recorded at launch,
including descendants remaining after the launcher exits. It never discovers
cleanup targets by executable path, so another instance of the same bundle
keeps running. Bridge deadlines cover headers, the complete response body,
and decoding, including error responses and screenshots.

`PackagedApp.eval(script)` sends potentially mutating scripts once. A failed
reply reports an unknown outcome and does not retry, because renderer execution
may already have completed. Use `evalReadOnly(script)` only for repeatable reads;
it retries bridge timeouts within its deadline. `waitFor` also requires a
read-only expression because it polls repeatedly.

The runner holds an atomic lease plus a per-test cleanup marker. If a prior
process died before cleanup, the next run preserves its isolated state, writes a
stale-fixture report, and fails before launching a test.
`SMITHERS_E2E_RECOVER_STALE=1 bun run test:e2e` explicitly repairs a readable
lease whose owner is no longer alive and continues in a single invocation.
Recovery and cleanup claim and recheck the lease generation before moving it
aside for deletion. Missing or unreadable leases may belong to initializing
owners and are always preserved. An interrupted retirement leaves a `.retiring`
guard; inspect and remove the abandoned registry only after confirming no
suite is running. Failed package staging removes its temporary workspace and
reports both errors if cleanup also fails. The packaged lane is macOS-only and
the GitHub fixture scenario requires network access.


### Approval ownership

Approval and approvals-inbox cards are created by runtime transitions from
chain policy or gateway requests. The store persists their trusted request
records separately in `app-approval-requests`, binding the displayed question
to the original submit-ready envelope. A pending gate cannot be relabeled or
retargeted. Inbox refreshes retain the wording and envelope of existing rows.
Decision submission reads the trusted record; decision state remains on the
card. Signing out clears both collections.

Model card frames and the chain's `card.show` and `card.update` calls cannot
create or replace approval, approvals-inbox, grant-confirm, or flow-form cards,
or patch existing cards of those kinds. Runtime flow handlers still create
their own output. Chain policy registers approvals directly with the store.
Legacy cards without a trusted request cannot authorize an operation; a fresh
runtime request or gateway refresh must register the gate first.

## App-shell verification

From `apps/ui`, `pnpm test` runs Bun tests under `src/` and `scripts/`.
`pnpm run test:e2e:auth` runs the browser OAuth callback regression with
Playwright Chromium and local fixture servers. CI's `browserE2e` wrapper runs
it before the Playwright specs; packaged native probes remain a separate tier.

`pnpm run checklist -- --target <origin>` works from the repository root or
`apps/ui`. `--dry-run` writes reports without network calls or a browser.
Exit codes are `0` for no failed or undecided probes (prerequisite skips are
allowed), `1` for failures, and `2` for probes that ran but could not decide.
See [the scripts runbook](../scripts/README.md#launch-checklist-launch-checklistts)
for prerequisites, commands and report fields.
