# Organization host

A local host that runs an agent organization (`Org/` from
`@smthrs/organization`) against your repositories: requests arrive from the
CLI or one Slack app, roles work in microVMs, and approved changes land on
`organization/…` branches with receipts under `Org/Runs/`. It is the native
control plane and gateway (`/rpc`, `/projections`, `/health`) on loopback,
with durable SQLite state; runs survive a restart.

## Commands

```sh
node flows/organization/cli.ts init ~/org                 # setup/: writes Org/ and ~/.smithers/org/.env
node flows/organization/cli.ts doctor                     # setup/: checks everything below
node flows/organization/cli.ts serve                      # the host, foreground; Ctrl-C stops it
node flows/organization/cli.ts submit "<task>" --wait     # start a request, wait, print its receipt
node flows/organization/cli.ts status [--write]           # counts, then parked/failed/running runs; --write rewrites Org/Status.md
node flows/organization/cli.ts status --run <id>          # one run and its gates
node flows/organization/cli.ts answer <gate> approve      # or decline; --run <id> when several wait
node flows/organization/cli.ts hire <parent> "<need>" [--task "<task>" [--acceptance <line>]...]
node flows/organization/cli.ts delegate <parent> <specialist> "<objective>" [--input <text>]... [--acceptance <line>]...
node flows/organization/cli.ts retire <principal>
node flows/organization/cli.ts specialists                # hired principals: id, status, kind, hirer, name
node flows/organization/cli.ts meetings plan
node flows/organization/cli.ts book <role> <minutes> "<purpose>" [--not-before <time>]
```

`hire`, `delegate`, `retire`, `meetings plan` and `book` start their flow
through the control plane as `submit` does and take `--key` (the same key
joins its run) and `--wait` (prints the run's end and its receipt).

`serve` runs standalone (`--standalone` is accepted and changes nothing); a
backend-supervised mode is not built (#1934). After `init`, the state directory's
`.env` names the root and the repositories, so `serve` needs no flags. Client
commands talk to `127.0.0.1:7433` (`--port`, `SMITHERS_ORG_PORT`).

`/rpc`, `/projections`, and `/sync` require a bearer credential; `/health`
does not. The host writes it to `<state>/credential` (mode 600) at its first
start and refuses to start if other users can read the file. Client commands
read it from the state directory (`--state-dir`, `SMITHERS_ORG_STATE_DIR`), so
a process that can read that file can act as the operator. To rotate it,
stop the host, delete the file, and start the host. The Slack intake runs
inside the host and does not use the credential.

## Configuration

Flags override variables, variables override the state directory's `.env`
(the setup commands read the same names):

| Setting | Flag | Variable | Default |
| --- | --- | --- | --- |
| Directory holding `Org/` | `--root` | `SMITHERS_ORG_ROOT` | current directory |
| State (databases, `.env`) | `--state-dir` | `SMITHERS_ORG_STATE_DIR` | `~/.smithers/org` |
| Repositories | `--repo name=path` (repeat) | `SMITHERS_ORG_REPOS` (comma-separated) | required |
| Checks run on every change | `--check name=command` (repeat) | `SMITHERS_ORG_CHECKS` (one per line) | none; per repository: [environments](#repository-environments) |
| Builder/checker rounds | `--max-rounds` | `SMITHERS_ORG_MAX_ROUNDS` | 2 |
| Concurrent microVMs | | `SMITHERS_ORG_MAX_CONCURRENT_VMS` | `vm.maxConcurrentVMs` |
| Concurrent role tasks | | `SMITHERS_ORG_MAX_CONCURRENT_TASKS` | 4 |
| Calendar (one-on-ones, bookings) | | `SMITHERS_ORG_CALENDAR_ID` with `SMITHERS_GOOGLE_ACCESS_TOKEN`, or `SMITHERS_GOOGLE_REFRESH_TOKEN` + `SMITHERS_GOOGLE_CLIENT_ID`/`_SECRET` | not connected |
| Seat credentials | | `SMITHERS_ORG_AUTH` (`subscription` or `api-key`) | `subscription` |
| Slack | | `SMITHERS_SLACK_BOT_TOKEN`, `SMITHERS_SLACK_APP_TOKEN`, `SMITHERS_SLACK_TEAM_IDS`, `SMITHERS_SLACK_USER_IDS` | off |
| Mac notifications without Slack | | `SMITHERS_ORG_NOTIFY` (`off` turns them off) | on |
| Node for `install-service` | | `SMITHERS_ORG_NODE` | found on `PATH`, fnm, Volta, nvm, Homebrew |

A repository is named as the roster's `grants.repositories` name it. A bare
path is named by its `origin` remote's `owner/name`, else its directory name;
use `name=path` when that differs. `doctor` fails on a name no active role
holding `workspace` is granted. Seats resolve from the environment
(see [Model access](#model-access)). With `judge: none` role results are
checked by the flow, not by a judge.

## Notifications

Without Slack, a host on macOS shows a notification when a run parks at a
gate (`answer land: Land this change?`) or fails (`<run> failed`), once per
gate or run, across restarts (`<state>/notified.json`).

## Wiki commits

With `wiki.commit: true` on the organization page, the host commits what it
wrote to the wiki's git repository every 30 seconds and when it stops:
`wiki.generatedDir` (receipts, documents, meeting notes, bookings),
`<rosterDir>/Specialists/` (hires) and `wiki.statusFile`. The commit is
limited to those paths, so your own edits elsewhere stay as they are, staged
or not. It skips hooks and signing, and never pushes. `backup` commits them
first, so the manifest's wiki revision holds every receipt and hire the state
cites.

## Flows

- `organization/intake` — admits a request (a Slack author must be in
  `SMITHERS_SLACK_USER_IDS`; the repository must be configured), says "On it."
  in a Slack thread as the assistant, and starts delivery. A request key
  (`slack:<team>:<event>` or `cli:<key>`) deduplicates: the same key joins the
  run it started.
- `organization/deliver` — assistant routes → the role it hands to writes a
  contract naming a builder and a checker → the builder works in a microVM
  workspace → the diff is collected → checks run in a fresh microVM → the
  checker decides, for at most `--max-rounds` rounds → the change lands on
  `organization/<key>-<hash>` (never the checked-out branch, never pushed) →
  receipt → thread reply. A builder whose turn leaves no change is asked
  once more; a second empty diff blocks the delivery (`no change`, a failing
  `change` check) and nothing is checked or lands. A role whose result breaks its charter is
  asked again once with the violations; a second break stops the delivery,
  and the receipt names each violation. Every principal a role names is re-resolved against
  the pinned roster, so an inactive one is refused. A request whose output is
  a document or a reply (a brief, a triage, a draft) is answered by the role
  the assistant hands it to, with no handoff: a role holding `wiki-write`
  gets its summary and output fields written to
  `<generatedDir>/<key>/<role>.md`, and the delivery ends `answered` with the
  document in its receipt; without `wiki-write` it ends `blocked`. Every
  ending after the workspace is prepared removes its machine. It is
  registered but not listed: only intake starts it.
- `organization/status` — rewrites `wiki.statusFile` from the receipts.
- `organization/qualify` — one attempt at one qualification case: the case's
  principal answers its task over the case's context, checked against its
  charter as a delivery checks it, and the answer is written as a receipt.
  The `qualify` command starts it; see [Qualification](#qualification).
- `organization/hire` — a principal hires a specialist for a need: it
  answers with a structured `hire` field (`Hiring.HireSpec`, or null); the
  host validates it against the hiring rules (grants inside the parent's,
  never personal accounts or owner contact, depth/children/persistent/budget
  limits, an active chain), asks once more with the broken rules, writes the
  hire to `<rosterDir>/Specialists/<id>.md` and pins the roster with it.
  With `task`, the first task runs as `organization/delegate` `<key>.task`.
- `organization/delegate` — a parent hands a task to a principal it hired;
  the hire answers under its own grants, memory and budget, the parent
  reviews it (`verdict`: `accept`/`revise`, two rounds at most), and the
  accepted output is written to `<generatedDir>/<key>/<hire>.md` with the
  review (published by the parent when the hire holds no `wiki-write`).
- `organization/retire` — retires a hire and everything it hired: grants
  revoked, `retiredAt` recorded, every later task refused.
- `organization/meetings-plan` — plans the weekly one-on-ones from
  `meetingsFile`: `<generatedDir>/meetings/plan.md`, one weekly calendar
  event per role when a calendar is connected (`not connected` otherwise,
  never faked), and each role's prepare (day before), open (slot start) and
  follow-up (5 minutes after the slot) triggers in the series' zone. Nothing
  is planned while `timezone`, `start` or `firstDate` is unset.
- `organization/meetings-prepare` / `-open` / `-follow-up` — a role's agenda
  from its receipts, blockers and open tasks, written to its private note
  `<generatedDir>/meetings/<role>/<date>.md`; the agenda posted in the owner's
  Slack DM with the app under the role's name (the owner's replies in that
  thread start `organization/meetings-reply`, not a delivery); the thread and
  the note's Notes section turned into tasks on
  `<generatedDir>/meetings/<role>/tasks.md`, or the slot recorded as not held.
- `organization/meetings-book` — extra time for a role, booked as the
  assistant in the first free weekday 09:00–17:00 slot clear of the weekly
  block, earlier bookings and the connected calendar's busy times;
  `<generatedDir>/meetings/bookings.md`, one booking per key.

Every role task runs under its principal's budget (`Budgets.layer`):
`tokensPerTask` over the run's budget, `tasksPerDay` charged to the principal
and every hirer above it (`<state>/budget-ledger.json`), `concurrency` per
principal, and the host's cap. A limit ends the task `blocked` with the limit
as its summary, so the receipt says why.

## Research

A role holding `retrieval` gets `web-fetch`: one public page as text,
fetched by the host. Without the grant it gets nothing. Limit it in the profile:

```yaml
grants:
  tools: [retrieval]
  retrieval: { allow: [rust-lang.org], deny: [ads.example.com] }   # each covers subdomains
```

`web-fetch` refuses private and loopback addresses, other ports than 80/443,
and names outside `allow` or inside `deny`; it stops at 20 s and 2 MiB, drops
scripts, and hands the text to the model as untrusted data. Every page a
task fetched is added to its result's evidence with its retrieval time.
The provider's own web search (`RoleHost.Resources.retrieval.providerSearch`)
is not enabled: in a real task one frame spent up to 134,000 tokens.

The host's scheduler (`@smthrs/triggers`, `<state>/triggers.db`) launches
scheduled runs through the host's own control plane, keyed by trigger and
occurrence; it runs `organization/meetings-plan` daily at 06:00 UTC.

Gates from `Org/Policy/Gates.md` attach at two boundaries; an empty policy adds
no node:

| Boundary | Target | Subject |
| --- | --- | --- |
| `task` | `organization/deliver` | request text and assignment |
| `external-write` | `organization/apply-change` | patch digest, files, branch, checks |

An Approval gate parks the run until `answer <gate> approve|decline`, or an
owner's button press in the request's Slack thread (the host posts the prompt
there). A Review gate runs the reviewer's role task.

The host needs `jj` on `PATH`: the durable engine snapshots its execution
root (an empty jj repository at `<state>/execution`, never `Org/`) around each
compensable step. `doctor` checks it.

## Repository environments

A repository named under `repositories` in `Org/Organization.md` gets its
dependencies prepared once and its builders and checks run on that tree:

```yaml
vm:
  provider: microsandbox
  image: node:26-bookworm
  cpus: 4
  memoryMib: 8192
  diskMib: 32768          # sparse root disk (default 32768)
  maxConcurrentVMs: 4     # a task uses a builder VM and a fresh check VM
repositories:
  smithersai/smithers:
    prepare:
      run: npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile
      key: [pnpm-lock.yaml, pnpm-workspace.yaml, package.json, patches]
      network: [registry.npmjs.org]   # none | all | domain list (*.suffix allowed)
      timeoutMs: 1800000              # default 30 minutes
    network: none                     # builders and checks; default none
    checks:
      - name: changed packages
        run: CI=1 pnpm --filter '[HEAD]' run test
```

- **Prepared base.** The first task at a commit seeds a VM with the commit,
  runs `prepare.run` in the workspace root with only `prepare.network`
  reachable (deny-by-default egress, DNS to the gateway), and captures the VM
  disk as a Microsandbox snapshot. The base is keyed by the command, its
  network, the content of the `key` paths at the task's commit, the image, and
  the disk size, so every later task with the same lockfile boots from it and
  only the source difference to its commit is applied (the archive when the
  difference does not apply). The newest two bases per repository are kept
  (`msb` lists them as `smthrs-env-…` snapshots); a failed preparation is
  never captured and the delivery fails with the command's last output.
- **Builders and checks** boot from the base with `network` (default `none`):
  dependencies are installed, the registry is not reachable. What the
  preparation left in the tree is part of the baseline, so it never shows up
  in a change. The check VM is fresh, applies the patch, and runs the
  repository's `checks` before `SMITHERS_ORG_CHECKS`. In the check VM `HEAD`
  is the task's commit and the patch is uncommitted, so `--filter '[HEAD]'`
  selects the packages the change touches.
- **Measured on an M4 Pro** (`smithersai/smithers`, 4 vCPU / 8 GiB): the
  first task's prepare took 33 s (30 s of it `pnpm install`), a later task's
  2.3 s; the check VM ran the changed package's tests in 3.6 s.
- A repository without an entry is seeded with `git archive` alone and boots
  without network (`vm.network: true` turns it on for all of them).
- Rust and `jj` are not in `node:26-bookworm`; a check that needs them fails
  until the image or the prepare command installs them.

`doctor` prints one `env` line per configured repository with an entry and
fails when a `key` path is missing at `HEAD`.

## Restart and machines

Runs survive a restart, including one killed in the middle of a builder's
turn. Machines carry this installation's owner label and this process's
holder label, and a workspace machine also carries its workspace key
(`smithers.workspace`). At startup the host removes machines whose holder
process is gone, except the workspace machines of executions the engine
database records as unfinished: the resumed run reattaches its machine,
relabels it as the new process's, and replays its recorded steps. A tool
call that finished before the stop is not repeated; one in flight at the
stop runs again. Workspace machines of finished runs, and check machines,
are removed.

A role task's session refuses a machine that holds no seeded checkout, or one
seeded from another commit, so a run whose machine was lost some other way
fails with `workspace-unavailable: workspace … holds no seeded checkout`
rather than working in an empty machine; submit the request again under a new
key. A failed run's workspace machine stays until the next start. The roster
is pinned at startup: a run pinned to a roster revision the restarted host no
longer has is refused, never run against the new one.

## Model access

Seats run on the owner's subscriptions (`setup/subscriptions.ts`); nothing in
`Org/` changes but the seat strings:

| Seats | Subscription | Sign in |
| --- | --- | --- |
| `openai:*` | ChatGPT, on the codex CLI's login (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`) | `codex login` |
| `anthropic:*` or a bare model id | Claude, on `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_AUTH_TOKEN`) when set, else the Claude Code login (macOS keychain or `~/.claude/.credentials.json`), read at each seat resolution | `claude`, or `claude setup-token` for a token |

In subscription mode the host removes `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` from its environment at startup, so a stale key never takes
precedence, and routes `openai:*` seats to ChatGPT (`SMITHERS_OPENAI_AUTH=chatgpt`).
An expired Claude Code login is refused with the fix: open `claude` once, or
use a setup token. `SMITHERS_ORG_AUTH=api-key` reads `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` instead. A Smithers account pool
(`SMITHERS_ACCOUNT_POOL_URL`, `SMITHERS_ACCOUNT_POOL_PROVIDERS`,
`SMITHERS_ACCOUNT_POOL_KEY`) serves hosted workspaces and agent runs and is
not used here.

`doctor` resolves every seat the way the host does and names the login a seat
lacks. A provider refusal (for example no credits) fails the run with the
provider's code and message in the receipt and the reply:
`HarnessError(model_failed): The cell frame failed: quota_exceeded: …`.

## Qualification

```sh
node flows/organization/qualify/cli.ts [--runs 3] [--delivery-runs <n>] [--concurrency 2] [--case <id>]... [--role <id>]... [--only role|delivery] [--keep] [--real-budgets]
```

Runs every case under the organization's cases directory (`casesDir`,
default `Org/Cases`) against a host it starts itself, with real seats, over a
scratch state directory, a scratch copy of `Org/` and the pages roles'
knowledge names, and scratch clones of the repositories: the live host's
state, memory, receipts and branches are never touched. A role case is one
`organization/qualify` run; a delivery case (`request:` instead of `task:`)
is one request through intake (`--delivery-runs` times). A workspace case
may start at a named `revision`, and may have the change its principal left
collected and run through the repository's checks and its own in a fresh
machine; a `host-commands` case runs `backup`/`restore` on the qualification
host first and hands the principal their output. Each attempt is scored
against the case's `expect` (`qualify/cases.ts` documents the format), and
the scorecard, per role and per case with each failure reason and its count,
stamped with the wiki revision, the roster revision and the cases' digest, is
written to `<generatedDir>/Qualification-<date>.md`. A case whose `requires`
this host cannot provide, or whose revision the repository lacks, is listed
pending; a page that is not a case is listed invalid. Daily task budgets are
lifted in the scratch copy so every attempt runs; `--real-budgets` keeps the
roster's own, one day's per round of attempts (`--runs 3`: three days' worth).
Exit 0 only when every attempt passed.

## Command registry

`cli.ts` exports `registry`, a map from name to `Command`
(`{ name, usage, run(argv, io) => Promise<exitCode> }`, from
`setup/settings.ts`). `setup/index.ts` exports `commands`; each is registered
by name beside `serve`, `submit`, `status`, `answer`, `hire`, `delegate`,
`retire`, `specialists`, `meetings`, and `book`. To add one, add it to that
array.

## Tests

```sh
node --test flows/test/organization-host.test.mjs        # land, duplicate, gate + restart, kill mid-build, charter correction, provider refusal, retired, forged, credential
node --test flows/test/organization-host-slack.test.mjs  # DM, thread replies, buttons
node --test flows/test/organization-host-document.test.mjs  # wiki document answer, missing wiki-write, declined landing removes its machine
node --test flows/test/organization-host-qualify.test.mjs   # qualify: scorecard, pending/invalid cases, scratch clones, uncaught refused wiki read
node --test flows/test/organization-host-relocate.test.mjs  # a parked run resumes after the state directory moved
node --test flows/test/organization-hiring.test.mjs         # hire, delegate, review, budget block, retire, refused hires, restart
node --test flows/test/organization-meetings.test.mjs       # plan + triggers, prepare, Slack DM open/reply/follow-up, not held, bookings, calendar
node --test flows/organization/cli.test.ts                  # client commands against a stand-in control RPC
node --test flows/organization/setup/*.test.ts              # every setup command
```

The `flows/test` suites run the host in a separate process with scripted seats
(`testing/scripted-host.ts`; the builder edits with `edit`, a compensable
step as a model's edit is) and real microVMs,
and skip by name where none can boot. The scripted seats play the example
roster's parts; `SMITHERS_ORGANIZATION_SCRIPTED_ROLES` maps another roster's
principals to them (`route:<to>`, `contract:<builder>,<checker>`, `build`,
`check`, `document`), `SMITHERS_ORGANIZATION_SCRIPTED_OMIT` makes a principal
leave a charter field out, and `SMITHERS_ORGANIZATION_SCRIPTED_READ` makes
every role but a builder first read a wiki page without catching a refusal.
Host tasks answer by task id: a hire with the spec
`SMITHERS_ORGANIZATION_SCRIPTED_HIRE` names for the request key or principal,
a review `accept` (`revise` first with `SMITHERS_ORGANIZATION_SCRIPTED_REVISE=1`),
an agenda, a meeting reply, and follow-up tasks. Targets: `//flows:organizationHost` (the
`flows/test` suites), `//flows:organizationSetup` (every setup test and
the CLI).
