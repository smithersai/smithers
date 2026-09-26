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
node flows/organization/cli.ts status [--write]           # runs and open gates; --write rewrites Org/Status.md
node flows/organization/cli.ts answer <gate> approve      # or decline; --run <id> when several wait
```

`serve` runs standalone (`--standalone` is accepted and changes nothing); a
backend-supervised mode is not built (#1934). After `init`, the state directory's
`.env` names the root and the repositories, so `serve` needs no flags. Client
commands talk to `127.0.0.1:7433` (`--port`, `SMITHERS_ORG_PORT`). The
loopback port has no credential: any local user or process can submit,
answer gates, and read `/projections` (#1932).

## Configuration

Flags override variables, variables override the state directory's `.env`
(the setup commands read the same names):

| Setting | Flag | Variable | Default |
| --- | --- | --- | --- |
| Directory holding `Org/` | `--root` | `SMITHERS_ORG_ROOT` | current directory |
| State (databases, `.env`) | `--state-dir` | `SMITHERS_ORG_STATE_DIR` | `~/.smithers/org` |
| Repositories | `--repo name=path` (repeat) | `SMITHERS_ORG_REPOS` (comma-separated) | required |
| Checks run on every change | `--check name=command` (repeat) | `SMITHERS_ORG_CHECKS` (one per line) | none |
| Builder/checker rounds | `--max-rounds` | `SMITHERS_ORG_MAX_ROUNDS` | 2 |
| Concurrent microVMs | | `SMITHERS_ORG_MAX_CONCURRENT_VMS` | `vm.maxConcurrentVMs` |
| Seat credentials | | `SMITHERS_ORG_AUTH` (`subscription` or `api-key`) | `subscription` |
| Slack | | `SMITHERS_SLACK_BOT_TOKEN`, `SMITHERS_SLACK_APP_TOKEN`, `SMITHERS_SLACK_TEAM_IDS`, `SMITHERS_SLACK_USER_IDS` | off |

A repository is named as the roster's `grants.repositories` name it. A bare
path is named by its `origin` remote's `owner/name`, else its directory name;
use `name=path` when that differs. `doctor` fails on a name no active role
holding `workspace` is granted. Seats resolve from the environment
(see [Model access](#model-access)). With `judge: none` role results are
checked by the flow, not by a judge.

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
  receipt → thread reply. A role whose `done` result breaks its charter is
  asked again once with the violations; a second break stops the delivery,
  and the receipt names each violation. Every principal a role names is re-resolved against
  the pinned roster, so an inactive one is refused. It is registered but not
  listed: only intake starts it.
- `organization/status` — rewrites `wiki.statusFile` from the receipts.

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

## Restart and machines

Workspace and check machines boot without network (`vm.network: true` in
`Org/Organization.md` turns it on) and are seeded with `git archive` of the
commit: no dependencies or toolchain beyond the image, so a check such as
`pnpm test` fails unless the image carries what it needs (#1931).

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

## Command registry

`cli.ts` exports `registry`, a map from name to `Command`
(`{ name, usage, run(argv, io) => Promise<exitCode> }`, from
`setup/settings.ts`). `setup/index.ts` exports `commands`; each is registered
by name beside `serve`, `submit`, `status`, and `answer`. To add one, add it to
that array.

## Tests

```sh
node --test flows/test/organization-host.test.mjs        # land, duplicate, gate + restart, kill mid-build, charter correction, provider refusal, retired, forged
node --test flows/test/organization-host-slack.test.mjs  # DM, thread replies, buttons
```

Both run the host in a separate process with scripted seats
(`testing/scripted-host.ts`; the builder edits with `edit`, a compensable
step as a model's edit is) and real microVMs,
and skip by name where none can boot. The scripted seats play the example
roster's parts; `SMITHERS_ORGANIZATION_SCRIPTED_ROLES` maps another roster's
principals to them (`route:<to>`, `contract:<builder>,<checker>`, `build`,
`check`), and `SMITHERS_ORGANIZATION_SCRIPTED_OMIT` makes a principal leave a
charter field out. Targets: `//flows:organizationHost`,
`//flows:organizationSetup`.
