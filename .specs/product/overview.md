# Smithers product overview

Status: product vision, signed off by Will, 2026-10-02; release scope updated by Will's brief of 2026-10-15 Pacific ([#4022](https://github.com/smithersai/smithers/issues/4022)) and his rulings of 2026-10-19 and 2026-10-20 (mvp.md M-53 to M-57). What we build now follows [the rulings](../../apps/mvp/docs/rulings.md); where this page disagrees with them, the rulings win (SCOPE-9). High level only. The details are in [mvp.md](mvp.md), the design in [`.specs/design/`](../design/) and the engineering in [`.specs/engineering/`](../engineering/).

## In one sentence

Smithers replaces the GitHub web UI. It wraps your GitHub repository, gives each branch its own machine, lets people and agents work on that branch together, and is built entirely from flows you can change.

It is a wrapper, not a fork: GitHub keeps `main`, issues, pull requests and reviews (M-22); a pull request's checks are Smithers flow runs, never GitHub Actions (M-52). Smithers adds the live layer, and every action and customization in it is a durable workflow (M-44).

## What we are building now

The app is `apps/mvp`, built from scratch one feature at a time, following Will's feature list (rulings SCOPE-1, SCOPE-6, SCOPE-7; M-53):

```
browser     React view over a framework-free Effect state machine; TanStack DB, local first (OPFS);
            the agent and flows on @smthrs/platform-browser's durable engine; an installable PWA
Cloudflare  Effect-native Workers deployed by Alchemy: the model proxy (Qwen on Cerebras),
            remote flows (Durable Objects), branch sandboxes (Containers), the secrets egress proxy
services    Neon Postgres, synced by Electric; git hosting on Code Storage
GitHub      the truth for issues, pull requests and branches; the Smithers GitHub App signs people in
```

It is hosted only, at `smithers.sh` (M-54). Everything is a plugin: the app's core holds infrastructure and primitives, and features ship as plugins over the same public interface anyone uses (M-55).

## Why it is different: everything is a flow

A flow is a durable workflow. Every action in Smithers is a flow, from a button or a slash command to an agent step or the whole factory. Flows live in the repository, under `.smithers/flows/` (M-49). This has four consequences:

- **Customizable.** Users, and the agent on their behalf, reshape the factory by editing its flows. The few system flows that keep "people merge" and stack order safe can't be overridden (mvp.md M-30).
- **Self-improving.** The factory learns from its own runs and gets better over time.
- **Durable.** Every run is recorded, survives a restart without redoing finished work, and can be watched, steered, or resumed.
- **Agent parity.** The agent can run any flow a person can, through the same flows. A few decisions stay with people: merging, approvals, members and secrets.

## How it is built

```
1. Durable flows    The engine. Anything built on it is durable and can run distributed.
        │
2. The agent        Built on durable flows, so it inherits those properties.
        │           Strong at answering questions about the repository (with Jev).
        │
3. The product      A simple multiplayer coding factory.
```

## What a user gets

### Where it runs

Hosted at `smithers.sh`, on Cloudflare (M-54). It wraps an existing GitHub repository; open it in a browser, or install it as a PWA, to reach the Smithers app. Billing and plans are not in scope (M-09). One machine you own, such as a Mac mini, comes after ship (SCOPE-8).

### Entry routes

| URL | What it opens |
| --- | --- |
| `/` | The launcher: open a repository Smithers already has, create one, explore others, and read what changed in Smithers itself. |
| `/owner/repo` | That repository, at the path GitHub uses, so replacing `github.com` with `smithers.sh` in a repository URL opens it here. |

A repository opens on its file tree, and its own flows and custom UIs can replace that default view. A repository that GitHub has and Smithers doesn't offers import to a signed-in person the Smithers GitHub App already covers, and the App's installation path to everyone else. Signed out, absent, inaccessible and failed-import all say what is true and nothing more (M-45, M-46).

### Branches

```
same branch        one live working copy on one machine; people and agents edit it together;
                   it feels like a CRDT
different branches fork a branch into a new one; TODOs stack in order toward main, each one
                   squash-merged PR (the stack's order lives in Postgres; the mythical
                   history comes later, M-57)
```

A branch is a singleton: exactly one live copy, with one sandbox (a Cloudflare Container), and one conversation. It can be shared to read or write, Google Docs style (BR-1, BR-2, BR-4). To work separately, fork it.

### Issues and TODOs

- **Issue:** where discussion happens.
- **TODO:** work the team has committed to, scheduled or in progress. A TODO is the first prompt given to the agent that implements it.

### Agents

- **App agent:** runs in the person's browser on the durable engine, outside every sandbox, and works in the UI; its model calls go through our server (ARCH-6). It is fast, answers questions about the repository, and drives the app on the user's behalf.
- **Coding agent:** works a TODO on a branch, through that branch's sandbox and its tools; the sandbox exposes only the machine and its tools (ARCH-10). It is the factory that makes changes to that branch.

### Wiki

Not in the current build: it isn't on Will's feature list (SCOPE-5). The vision: one source of truth for the factory's memory, a Markdown vault people and agents read and write.

## The app

```
┌─────────────────────────────────────────────────────────┐
│ the branch's conversation (people prompt the agents)    │
│   ┌ card: diff ┐ ┌ card: run ┐ ┌ card: terminal ┐       │
│   └────────────┘ └───────────┘ └────────────────┘       │
│ background work: every running job, live, steerable     │
└─────────────────────────────────────────────────────────┘
```

- **Chat plus cards.** The agent shows its work as embedded cards: files, diffs, runs, terminals, forms, its own views, and web pages. Any card can go full screen or minimize; nothing is a separate UI (FE-9).
- **Async work.** Start work, keep chatting, watch every running job, and step in when needed.
- **Terminal.** A terminal session on the branch's machine is another card. Run Claude Code, Codex, or any other tool there.

## Everything a user can do

1. **Branches:** create, fork, share, and stack TODOs toward `main` (M-57).
2. **A checkout:** work with the coding agent on a branch's machine, open a terminal, and watch runs.
3. **The wiki:** read and edit the factory's memory (vision; not in the current build).
4. **The GitHub basics:** issues, pull requests, secrets, and notifications, each one a flow (M-47).
5. **Their own workflows and UI:** write a flow and the screen it draws, and run it from a slash command, a button or the agent.
6. **Runs:** watch, steer and resume every run the factory is doing.

Issues and TODOs connect these: discussion becomes a TODO, and a TODO becomes work on a branch. The same workflow architecture carries the rest: a repository's own flow can decide notification policy or move an issue from proposed to accepted (M-47).

## Scope rule

This overview is the product vision. What we build now is Will's feature list in [the rulings](../../apps/mvp/docs/rulings.md) (SCOPE-5 to SCOPE-7, M-53); a feature on neither is a candidate to delete or defer, decided one at a time.

## Details

Every detail this overview left open is decided in [mvp.md](mvp.md):

| Question | Where it is decided |
| --- | --- |
| When a TODO is done | M-01: its pull request merges into `main` on GitHub |
| Two writers editing one file | M-02: live co-editing; edits made outside the app are visible and recoverable (M-27) |
| What syncs with GitHub | §6.3 and M-22 |
| Self-improvement | M-04 and §6.12 |
| Permissions and approvals | M-05 as amended by BR-6 and decision 0007: Admin, Maintainer, Member, Guest; people merge through a configurable merge workflow |
| Machine sizing | M-06, superseded by M-54: hosted sandboxes; budgets are decided before ship (AUTH-5) |
| Benchmark claims | M-19: none without a sealed, paired run |
| Hosted use | M-54: hosted only now; M-09's billing and plans stay out |
| What we build now | M-53: `apps/mvp` and Will's feature list |
| Plugins | M-55: everything is a plugin ([decision 0017](../../apps/mvp/docs/decisions/0017-everything-is-a-plugin.md), approved 2026-10-20) |
| Prompt flows and code flows | M-56: one flow model; a prompt flow is a kind of code flow |
| Stack history | M-57: order in Postgres; the `mythical` history comes later |
| Entry routes and the launcher | M-45 |
| A repository GitHub has and Smithers doesn't | M-46 |
| Confusing copy, noisy layout, broken CSS, weak keyboard access | M-48: release bugs, not polish |
| Conversations | M-08: one per branch, shared |
| Where a repository's flows live | M-49: `.smithers/flows/<name>/`, never a root `flows/` |
| The old product spec | M-12: `docs/mvp/PRODUCT.md` is now a pointer |
