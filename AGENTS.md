# Permanent product interaction rules

Every agent in this repository follows these rules. The source of truth for
what we build is [the rulings](apps/mvp/docs/rulings.md): Will's latest words,
then his decision-queue answers, then the decision records in
`apps/mvp/docs/decisions/`, then older docs. Anything that contradicts a ruling
is out of date; fix it or report it (Will, 2026-10-20, SCOPE-9). Each rule
below cites its ruling ID.

## What we are building now (Will, 2026-10-19 and 2026-10-20)

- **The app is [`apps/mvp`](apps/mvp/AGENTS.md),** built from scratch one
  feature at a time (SCOPE-1). Read its `AGENTS.md` before touching it.
  The old app ("v4", `apps/app`), its edge Worker (`apps/server`), the Go
  backend (`packages/backend`, `apps/backend`) and its microVM daemon
  (`packages/smithers-machined`) were removed on 2026-10-21 (SCOPE-3
  addendum). They are prior art: read them with
  `jj file show -r 78407fce59dd <path>` and port the minimal proven code into
  the new architecture (SCOPE-3, ARCH-1). Plue lives in its own repository.
- **The work is Will's feature list** (rulings SCOPE-6 and SCOPE-7), not an MVP
  scope, a build stage or a journey suite. Don't raise MVP scope (SCOPE-5).
  `.specs/product/` is the product vision; where it disagrees with the rulings,
  the rulings win.
- **Hosted only, on Cloudflare** (SCOPE-8, ARCH-1, ARCH-3): Effect-native
  Workers deployed by Alchemy (no Wrangler config), Neon Postgres synced by
  Electric into TanStack DB (ARCH-4), git hosting on Code Storage (ARCH-13),
  branch sandboxes on Cloudflare Containers (ARCH-14), and a secrets egress
  proxy (ARCH-16). Google Cloud is abandoned. The self-hosted Mac install waits
  until after ship (SCOPE-8).
- **The agent runs in the browser** on `@smthrs/platform-browser`'s durable
  engine. The app is a local-first PWA, and every model call goes through our
  server's model proxy (ARCH-5, ARCH-6, ARCH-17).
- **Web first.** Add an Electrobun desktop app only when a feature must run on
  the person's own machine (SCOPE-10).
- **Go fast; land the final draft.** Quality comes from fast iterations with
  Will's feedback, and the code that lands is held to perfection, test
  coverage included (PROC-3, SDK-14).

## Everything is a durable flow (Will, 2026-10-19, permanent)

Smithers is built on its own durable flows (`@smthrs/flow`). Every action the
app or an agent takes runs as a durable flow step, and that includes every model
call. Flows run on the user's machine, on Cloudflare, or on our sandbox
provider (DUR-1).

- **Durable by default.** The flow engine supplies retries, resumption after a
  crash, idempotency and deadlines. App and library code never write their own
  retry loops, background jobs, sweeps, queues or "re-dispatch" logic (DUR-2).
- **Model calls go through the durable layer only.** That means a flow step,
  through `@smthrs/agent` or `@smthrs/flow`. No handler or app module calls
  `Model.stream` directly. The app uses the Smithers agent, and a durable model
  call keeps the provider's prompt cache (DUR-4, DUR-6).
- **Never substitute another runtime for one.** No Cloudflare Workflows,
  Durable Object job loops, bare `waitUntil` work, Temporal, Inngest,
  Trigger.dev, Vercel AI SDK, LangChain or LangGraph, or Mastra. If the flow
  engine can't run where a job must run, the fix is a host for it in the SDK
  (`@smthrs/platform-node`, `-bun`, `-browser`, and the Cloudflare and sandbox
  hosts). A workaround in an app is not a fix (DUR-3, DUR-7).
- **Local first.** A flow runs remotely only when it needs a server-held key, a
  machine to run code, or to continue while every device is off; never because
  it is long (DUR-5).
- **Before choosing any library,** find the job in
  [the library catalog](docs/libraries.md), and say in the change which entry
  you used. A brief written for another agent states this rule.

## Everything is a plugin (Will, 2026-10-20, permanent)

Like webpack, Smithers treats everything as a plugin. The app's core supplies
infrastructure and primitives; every feature we can express that way ships as
an opinionated first-party plugin built on the same public plugin interface
anyone uses to add Smithers flows, flows as config, custom flows and custom
UIs. Everything is ultimately a flow, running locally or remotely in a sandbox
(PLUGIN-1).

- Don't hardcode a feature into the app that a plugin could declare. A new
  feature starts as a plugin, or says in its change why the core needs it.
- First-party plugins get no private interface; if a plugin needs something,
  the public interface gains it.
- Trust boundaries are unchanged: system flows stay non-overridable, people
  merge, agents never approve or merge, and secrets stay opaque.
- The interface is being designed by a four-model panel; Will reviews it before
  building starts (PLUGIN-2). Docs that hardcode a feature are marked
  "superseded by: everything is a plugin (design pending)" until then.

## Use the Smithers libraries (Will, 2026-10-19)

Before writing code that calls a model, runs an agent loop, makes a durable
workflow, renders UI, or touches GitHub, use the Smithers library for that job
from [the library catalog](docs/libraries.md). Hand-rolling one needs a stated
reason in the change, such as a missing feature and its issue (SDK-2, SDK-3).

- **We maintain the SDK.** When a package lacks something the app needs, add
  it to that package with tests and docs, then use it; never hand-roll it in an
  app (SDK-1). Libraries stay generic enough for other apps (SDK-10).
- **Effect for everything; React is only the view** (ARCH-2, FE-5). Use every
  library through Effect: its own Effect API when it has one, else a thin
  Effect wrapper in the SDK (SDK-8). Run an Effect only at the program's
  absolute boundary, and only where necessary; on the Alchemy backend, never
  (SDK-7).
- **Choices are services.** The model, URLs and limits come from a service or
  Effect `Config`, named for what they are, not for one vendor (SDK-9).
- Workspace packages depend on each other with pnpm `workspace:` specifiers
  (SDK-6).

Platform code (`node:*`, `Bun.*`, the DOM, child processes, sockets, the
filesystem) lives only in the host packages `@smthrs/platform-node`,
`@smthrs/platform-bun` and `@smthrs/platform-browser`, and reaches every other
package as injected Effect services and layers. Every other library must
import and run in a browser, a Cloudflare Worker, Node and Bun, and consumers
import only from a package's root entry; make public what should be public
(SDK-4, SDK-5). A package that breaks this has a bug; the catalog lists the
known ones. Apps, command-line programs and `@smthrs/ui` components are exempt.
Cloudflare is reached only through dependency injection, so the same code runs
elsewhere later (ARCH-7).

Every engineering rule becomes a lint rule, an `ImportRules` check or a Jev
rubric in `PACKAGE.ts`, catalogued in [`apps/mvp/docs/rules.md`](apps/mvp/docs/rules.md)
(PROC-4).

## VibeLang is ours (Will, 2026-10-20 and 2026-10-21)

Smithers' packages are being rewritten in VibeLang (`.vibe`), our language for
Effect. We maintain it: github.com/smithersai/vibelang, checked out beside this
repository as `../effectscript`, on npm as `vibelang` (OTHER-1).

- Before writing or reviewing `.vibe`, read the skill,
  `node_modules/vibelang/skills/vibelang/SKILL.md` (about 4,000 tokens). Write
  idiomatic VibeLang, never Effect TypeScript in a `.vibe` file;
  `vibelang --fix` rewrites TypeScript-style forms. Files with no Effect code
  stay `.ts`.
- Never work around a VibeLang bug, missing feature or tooling gap. Fix it in
  VibeLang with a test, or record a minimal reproduction where the migration
  tracks pain points, and say so in the change.
- A change that breaks how existing VibeLang code compiles or behaves goes to
  Will before it is made.
- Migrating a package keeps its public API (its emitted declarations)
  identical and every test passing at 100% coverage. Packages first; apps
  later.

## Zero tech debt; one backend (Will, 2026-09-25)

No tech debt and no dead code. Finish every migration in the same effort:
delete the old path, never leave two implementations of one behavior (SDK-11).
The backend is `apps/mvp`'s Effect-native Workers on Cloudflare (Will,
2026-10-19, ARCH-1). Plue is the old stack; add no product code to it.

## TODOs reach `main` through a person (Will, 2026-09-25 and 2026-10-20)

`main` is append-only; never rewrite it. Each TODO is worked on its own branch
and reaches `main` as one squash-merged GitHub pull request (TODO-1). People
merge, by hand or by pre-approving a TODO (M-39); merging runs a configurable
workflow, by default for Maintainers and up (BR-7). Agents never approve, merge
or move `main`. The stack's order lives in Postgres, written only by
`apps/mvp/worker/stack/Stack.ts`; the `mythical` history comes later, not now
(TODO-2).

## Trust boundaries (Will, 2026-10-15 and 2026-10-19)

- People approve and merge; agents never do. System flows can't be overridden
  (M-47).
- A secret is referenced by name only. Its value never enters a sandbox and
  never appears in a card, log, trace, metric or diagnostic (ARCH-16, OBS-5).
- GitHub is the truth for issues, pull requests and branches. Smithers has no
  GitHub Actions support or view; a pull request's checks are Smithers flow
  runs (GH-1, M-52).
- Opening a repository says what is true in every case: signed out, absent,
  inaccessible, rate limited or GitHub down. Never report an import that did
  not happen, widen a permission, or sign a person in silently (GH-4, M-46).
- A feature with a known security hole ships switched off.

## Instant chat; slow work runs in the background (Will, 2026-09-15)

Chat responses acknowledge an action immediately. Repository setup, research,
planning, implementation, tests, and other slow work run in the background.

- Persist the request and return an honest acknowledgment without awaiting the
  network request or the job. “Requested” is not “started” or “completed.”
- Show background progress in the app's shared toast stack; keep the toast
  running through launch AND execution, then resolve it from the real
  completion or failure. A launch acknowledgment is not job completion. Keep
  detailed output in the durable run card.
- Keep Chat, navigation, and unrelated actions usable throughout. Advance
  dependent work only after its real completion receipts exist.
- Deduplicate repeated launches, reconnect persisted requests after reload,
  and ignore stale responses from an earlier request. Failures
  must remain visible and retryable without claiming successful completion.
- Test with a deliberately unresolved launch and a running remote job: the
  command must return before either finishes, chat must remain usable, and
  the toast must settle only with the job. Cover failure and duplicate input.

Reference: `apps/mvp`'s durable outbox ([decision 0002](apps/mvp/docs/decisions/0002-local-first.md)),
the agent's status ([decision 0015](apps/mvp/docs/decisions/0015-agent-status.md))
and the feed and toasts ([decision 0009](apps/mvp/docs/decisions/0009-notifications-and-live-work.md)).

## Flow layering

`@smthrs/flow` is the fundamental library; every other flow API is a thin wrapper over it. Never add a second node or graph model. A prompt flow is a kind of code flow, not a second model (Will, 2026-10-20, FLOW-2).

One shape, everywhere: a file flow lives at `.smithers/flows/<name>/flow.ts` (mvp.md M-49; never a root `flows/`) and its `export default` is `Flow.make("<tag>", { description, capabilities, effects, modelInvocable?, payload, success, error?, body })` from `@smthrs/flow`. The tag is the first argument and is required, so a flow is never anonymous; a file flow declares the name its path derives.

Anything a person can do, the agent can do, through the same flows (FLOW-3). The agent acts; it never answers with steps for the person to do (FLOW-5).

## ⚖️ MINIMAL TEXT (Will, 2026-09-15, permanent)

Cards, panes, toasts, and lessons carry the fewest words needed to act. No explanatory prose about how the product works, no provenance footers, no rows whose value is "not measured yet", no summary sentence beside a button. Show a button, a count, or a picture instead of a sentence. Unrequested buttons and unrequested copy are defects (NO INVENTION); delete them on sight (FE-15). Confusing prose, a noisy layout, broken CSS and weak keyboard access are bugs, fixed with a regression test that fails on the old build (M-48).

## Product words (Will, 2026-09-26)

Docs and visible UI copy use product words, not internal modeling terms such as thread or task. [D-16](docs/mvp/PRODUCT.md#in-force) is the rule, and the [vocabulary](.specs/product/mvp.md#3-vocabulary) lists the words.

## Testing quality (Will, 2026-09-27 and 2026-10-19)

- A feature works only when a real end-to-end test passes, and is broken when
  one fails. E2e tests run locally and against production, at every layer the
  feature has (UI, API, CLI, TUI), and every feature or flow yields a GIF on
  request (TEST-1, TEST-3, TEST-4, TEST-6).
- No mocks. Unhappy paths inject a faulty Effect service; happy paths use the
  real one. Any other mock is justified to Will, or the test is deleted or made
  real (TEST-2, TEST-7). Known-broken behavior has a committed test marked
  broken (TEST-5). Agent behavior has real evals (TEST-11).
- Earn 100% coverage with meaningful behavioral assertions. Cover parameter
  combinations, boundaries, error cases, cancellation, recovery, and ordering;
  coverage is necessary, never sufficient. Do not lower thresholds or hide
  production code to make a test gate pass.
- Prioritize unit tests, then integration, end-to-end, fuzz, and benchmarks.
  Unit and integration suites must each provide confidence independently.
  Integration tests use real dependencies. Exercise the terminal, browser,
  HTTP API, and public authoring API through their user-facing boundaries.
- Retain reproducible fuzz counterexamples and benchmark methods, artifacts,
  correctness checks, and limitations. Distinguish executed coverage from
  configured thresholds, skipped cases, and platform-specific evidence.
  Benchmarks run locally and live (TEST-8); publish a benchmark claim only with
  its reproducible method, artifacts and limitations.
- Sonnet agents author pepper tests that probe weak classes (Will, 2026-10-02);
  GPT-6.1 Sol agents implement durable suites and fix every discovered product
  bug, retaining its regression test and validation receipts. The orchestrator
  reviews both.

## Observability (Will, 2026-10-13 and 2026-10-19)

Every action logs, traces and counts what it does, front end and back end, with
tests and docs (OBS-1, OBS-2). When the records can't answer a question, fix
observability before debugging (OBS-4). A dependency an agent can't debug from
its records is not used (OBS-3). Credentials and user content never appear in
logs, spans or metrics (OBS-5).

## Track work in the maintainer app (Will, 2026-10-20)

Work is tracked in the maintainer app, not GitHub issues (Will, 2026-10-20:
"Let's switch now to using maintainer app. Once we have the smithers app
working we will also get the maintainer app working within smithers and we will
dogfood smithers with smithers").

- Each workstream is one note in [`apps/mvp/docs/work/`](apps/mvp/docs/work/)
  with frontmatter (title, status, area, owner, updated, links). Before
  starting, set yourself as `owner` and the status to `in-progress`; never take
  a note another agent owns and updated in the last 6 hours.
- Will's decisions and reviews go through the decision queue
  (`apps/maintainer-site`, `queue/`). His answers are rulings.
- Don't open new GitHub issues for our own work or claim them with
  `issue-claim`. Existing issues stay as history; product GitHub issues (the
  app's issues feature) are unaffected.
- When Smithers runs well, the maintainer app moves into it as a plugin and we
  dogfood Smithers on Smithers.

## Commit and push to `main` with jj (Will, 2026-10-13)

- Commit and push this repository's development and maintenance directly to
  append-only `main` with jj; open no pull requests for it. Product TODO
  approval and merge rules still hold for customer repositories.
- Land finished work on `main` continuously, before Will reviews it; he still
  reviews every feature (HOST-3). Commit current changes before starting new
  ones (HOST-4).
- Push everything to GitHub; never back up repositories to the MacBook, and
  don't waste its disk (HOST-2, HOST-8). No long-lived branches: a side
  `jj workspace` lives for one change, lands on `main`, and is removed (HOST-5).
- `apps/mvp` deploys with Alchemy (`pnpm run deploy --yes`,
  [infrastructure](apps/mvp/docs/infrastructure.md)). While there are no
  users, deploy from a pushed `main` revision without a fresh ask, and
  smoke-test after (Will, 2026-10-20 17:32: "Deploy now; no users yet").
- Our hosted deployment's details belong in the private `smithers-infra`
  repository (Will, 2026-10-20: "we should have the deployment info private
  in smithers-infra repo"), which isn't created yet; until it is, they stay in
  our private operations notes, never here. This repository keeps a generic, self-hostable
  stack whose deployment-specific values arrive as an Effect Layer; private
  operations, credentials and marketing stay out, and public builds never
  depend on private files or services.
- Heavy work runs on the Latitude servers, where any agent, Claude or Codex,
  may run (HOST-6, HOST-7).

## Working with Will (Will, 2026-10-19)

- Be short and conversational; answer only what was asked. A feature works or
  doesn't, never "partly"; say plainly whether work is done (COMM-1 to COMM-5).
- Ask Will only what he can answer and what is being built now. Settle micro
  choices yourself and record them (PROC-7, PROC-8, PROC-16).
- Record a durable decision in a decision record under
  `apps/mvp/docs/decisions/`, and document every feature in the app's docs
  (PROC-5).
- Reviews: `/codex` reviews work in progress; finished work gets a Codex Astra
  review, then fixes, then a Fable review. Agent reviews never block Will's
  own (PROC-1, PROC-2). Important designs: Claude Opus and Codex Sol design
  independently and Opus merges them (PROC-6).
- No agent carries Will's authority (PROC-17). Never send bug or feedback
  reports (PROC-11).

## Libraries we keep (Will, 2026-10-01, [#3385](https://github.com/smithersai/smithers/issues/3385))

Keep the build system and the independent public library packages, including
jj, the time-travel and recovery libraries, and decoding of existing persisted
history; old sessions and recorded events stay readable. Restoring the public
marketplace ([#3402](https://github.com/smithersai/smithers/issues/3402)), the
theme collection ([#3403](https://github.com/smithersai/smithers/issues/3403)),
or Pair ([#3401](https://github.com/smithersai/smithers/issues/3401)) beyond the
branch sharing and presence Will asked for (BR-1, BR-4) needs his authorization.

## Where to read next

Task-specific maintenance guidance lives in
[the repository skill](.agents/skills/smithers-maintenance/SKILL.md): use it for
workspace graph changes, generated docs, benchmarks, and flow authoring. Read
[`apps/mvp/AGENTS.md`](apps/mvp/AGENTS.md) for the app and
[`apps/tui/AGENTS.md`](apps/tui/AGENTS.md) for the TUI. Keep `AGENTS.md` rules to
behavior that applies throughout their directory trees.

## Execution environments

`smthrs environment` selects persistent local, SSH, or Cloud execution locations.
Tools manage their own login in the selected home; profiles contain location
settings only. `smthrs tui` is one CLI app consuming the same location and agents.
Use this shared capability instead of provider-specific login or remote harness
commands. See [#1757](https://github.com/smithersai/smithers/issues/1757).

## Cache contracts

Enable default caching only after the executed toolchain, declared environment,
dependency inputs, and produced outputs have complete content identities.
Action-backed tools need executable identity just as native argv rules do.
Keep mutating modes and incomplete contracts fail-closed; never weaken affected
selection to compensate for missing cache contracts. Nix alone grants no
cacheability.
