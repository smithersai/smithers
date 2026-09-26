# Quickstart: a local organization

Runs on one macOS (Apple silicon) or Linux/KVM machine. Every agent command
runs in a Microsandbox microVM.

## 1. Install

```sh
git clone https://github.com/smithersai/smithers && cd smithers
pnpm install
cargo +1.98.0 build --release --locked -p smithers-ffi --bin smithers-jj-export
```

Node must be at least `.node-version`. `doctor` pulls the VM image
(`node:26-bookworm`) when it is not cached.

## 2. Create the organization

```sh
node flows/organization/setup/cli.ts init ~/org
```

`~/org/Org` starts as the four-role example. `init` also writes
`Org/Setup/.env.example`, `Org/Setup/slack-app-manifest.yaml`, and
`~/.smithers/org/.env` (mode 600). Running `init` on an existing `Org/` only
validates it.

## 3. Logins and repository

Seats run on your subscriptions. Sign in once: `codex login` (ChatGPT, for
`openai:*` seats) and `claude` (Claude, for Anthropic seats). Then edit
`~/.smithers/org/.env`: `SMITHERS_ORG_REPOS=example/demo=<path to a git checkout>`,
the name the example roles are granted.

## 4. Slack (optional)

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** →
   paste `Org/Setup/slack-app-manifest.yaml`.
2. **Basic Information → App-Level Tokens** → generate one with
   `connections:write` → `SMITHERS_SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → install → `SMITHERS_SLACK_BOT_TOKEN` (`xoxb-…`).
4. `SMITHERS_SLACK_USER_IDS`: your profile → ⋮ → **Copy member ID**.
5. `SMITHERS_SLACK_TEAM_IDS`: run `doctor`; it prints the team id `auth.test`
   returned.

## 5. Check

```sh
node flows/organization/setup/cli.ts doctor
```

Each line is `PASS`, `SKIP`, or `FAIL` with its fix. The exit code is 0 only
when nothing fails. Slack lines are `SKIP` until both tokens are set.

## 6. Run

```sh
node flows/organization/cli.ts serve
```

The host runs in the foreground on `127.0.0.1:7433`; Ctrl-C stops it and
runs resume at the next start. From another terminal:

```sh
node flows/organization/cli.ts submit "Add a line to README.md" --wait
node flows/organization/cli.ts status
node flows/organization/cli.ts answer <gate> approve
```

Or DM the app a small task. Approved changes land on `organization/…`
branches of the repository, never pushed; receipts are under `Org/Runs/`.

## 7. Dependencies and tests

Machines hold only the committed files and have no network until the
repository has an environment under `repositories` in `Org/Organization.md`:
a `prepare` command run once per lockfile with the network it names, the
network builders get (default none), and the checks every change runs. See
`flows/organization/host.md#repository-environments`; `doctor` prints an
`env` line for it.
