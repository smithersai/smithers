# 0014: Flows you can create, debug and see, and a repository's own home view

Status: amended by Will's ruling on Q1 (FLOW-2). Built: authoring a person's flows (decision 3), run pages (6), the run acts (9) and a repository's home (10) ([flows](../features/flows.md), [runs](../features/runs.md), [home](../features/home.md)). Not built: the QuickJS realm flow host for hand-edited code, a repository's flows (`flow_bindings`, `flow/refresh`, `flow/propose`) and Try ([your own flows](../features/flows.md#your-own-flows)). Design panel: Opus as lead and merger, and Sol; 2026-10-20. §1, §2 and Q1 amended 2026-10-20 by Will's ruling on Q1: one flow model, below. It answers the last item of Will's 2026-10-20 list: "ability to create a repositories own home view is important. Stuff related to flows debugging flows creting flows which wasn't listed is another one." It builds on [0002](0002-local-first.md) (the outbox), [0003](0003-flows-and-the-agent.md) (the registry and parity), [0004](0004-agent-ui-codemode-and-rendering.md) (views, the presentation realm, the frame and forms), [0005](0005-sandboxes-secrets-and-the-forge.md) (sandboxes), [0007](0007-roles-and-tags.md) (roles), [0008](0008-auth.md) (actors), [0009](0009-notifications-and-live-work.md) (`runs` rows and run acts) and [0011](0011-the-agent-runs-in-the-browser.md) (the browser engine). Decisions 0012 (the git flow) and 0013 (the branch workspace) are designed beside it. Opus and Sol designed independently; the [appendix](#appendix-opus-sol-and-final-compared) compares them point by point, and Will's one question is at the end.

## Decision

1. **Everything is a flow, and there is one flow model: `Flow.make` from `@smthrs/flow`.** Will, 2026-10-20, answering Q1: "No everything is a flow this ruling is clear prompt flows are just a type of code flow". A flow drafted from a prompt is not a second kind stored another way. It is flow source, a typed `Flow.make("<name>", { ... })` module with its payload, success, error and body, written by the system, so it reads, edits, versions and runs like any other flow and can grow into hand-written code.

   | Where it lives | Source | Written by | Runs on |
   |---|---|---|---|
   | The app | `src/features/<f>/flows.ts` | the team | the browser engine, or Cloudflare by 0011's need rule; unchanged |
   | A person ("Mine") | one `flow.ts` module per revision, in Postgres | the system from a prompt, or the person and the agent by hand | by its placement, below |
   | A repository | `.smithers/flows/<name>/` (M-49); a `flow.mdx` or `SKILL.md` there lowers to the same `@smthrs/flow` flow through the registry's `Executable` | a person or the agent, merged by a person | a job sandbox only (0005), started remotely |

   **A person's flow runs where its source says, never where a flag says.** Its placement is read from its bytes. Exactly the module the system writes for a drafted flow (its description, instructions and calls are the only data in it, and its body is one agent step, `<name>/agent`) is `client`: the person's own engine runs it, pinning that data and running the step as the engine declares it (`flow/run/prompt`), so the engine only ever runs a body the system wrote. Any other code, a hand edit included, is `sandbox`.
2. **Scope never confers trust, and a person's own code runs only where repository code may.** A person's own flows ("Mine", Will's flows usable in any repository) are stored in Postgres and synced to that person's devices. A repository's flows are files in `.smithers/flows/<name>/` (M-49) and reach the default branch only through a pull request a person merges (M-04, M-39). The two differ only in where they live and who may run them, never in kind. Repository code runs only once a host runs repository code (0005), and a person's own hand-written code stays inside the same boundary: it never runs in the tab, the engine worker or the Worker.
   - **The limit today:** the QuickJS realm flow host doesn't run a person's hand-edited code yet ([0017](0017-everything-is-a-plugin.md) slice 5). A `sandbox` revision is saved and readable, but its run fails `FlowNeedsSandbox` before anything runs, and the Flows page says `Needs a sandbox`. A drafted flow as drafted runs. Drafting it again writes a drafted module that runs here again. Will, 2026-10-20 17:05: "The question makes no sense to me quickjs is a sandbox": once that host runs personal flows, only code that needs a machine waits for a container (ruling FLOW-2).
   - A flow run in a repository acts with its person's grants there, never more (0007 §5).
3. **Authoring is one durable flow, `flow/new`, on the browser engine.** A form card (where, name, what it should do) starts it, and the repository defaults to the one the person is in (Will, 2026-10-13). Each round drafts the files, asks optional questions with the default it assumed, checks the draft and writes the draft row. It parks on a `HumanTask` only for a blocking question. **Try** runs the draft once, **Save** stores a personal flow, and **Propose** opens a pull request through 0012.
4. **A repository flow becomes runnable through an activation receipt.** When the Code Storage mirror's head moves, `flow/refresh` discovers `.smithers/flows/` at that commit without running it, checks each flow, and advances that flow's active revision in `flow_bindings` by compare-and-set. A flow that fails keeps its previous revision active and shows `Merged · not active` (mvp.md §6.12, "Pinned versions").
5. **One catalog.** The slash menu, the Flows pages, the agent's `ctx.flows` and later the CLI read one join: the app registry, the person's flows and the open repository's active bindings. Every non-app flow runs through one registered flow, `flow/run { ref, input }`, so the registry's laws hold unchanged. A personal or repository flow never shadows an app flow.
6. **The run page reads the engine that holds the journal.** A run on this device is read from the browser engine through a new `BrowserEngine.inspect` request. A Cloudflare run is read through `GET /api/runs/:id/trace` over `smithers_flows`. Both use one SDK reader, `RunInspection` in `@smthrs/engine-store`, and one fold, `@smthrs/gateway`'s `RunTrace`. No journal is copied into Postgres.
7. **The run list is 0009's `runs` rows,** with this device's engine runs merged in by id, the engine's answer winning, so the device's own runs show offline and before they sync.
8. **Step inputs and outputs are content.** They reach only people who may read the run. The host's read passes every value through `@smthrs/journal`'s `Redaction`, never releases a `Redacted` schema field, drops provider error text and HTTP headers in favor of closed codes, and clips each value to 16 KiB. The page renders values as text. No value reaches a log, span or metric.
9. **Four acts on a run:** `run/cancel` (live), `run/retry` (settled: a new linked execution, on the pinned version or the current one), `run/resume` (`Control.resume`'s meaning: restart a run that hasn't settled and that no host drives; a durable timer is never skipped) and `run/answer` (0009). Cancel and Resume carry the row's `seq` they acted on, and a stale one is refused. An act on a run another device or host holds becomes a 0009 `run_commands` row that the owning engine applies; the row reads `Stopping` until it settles.
10. **A repository's home is data at `.smithers/home.json`** on the default branch's head. Its blocks are v4's vocabulary, whose schema moves to `@smthrs/views` as `Home`, and `@smthrs/ui` renders them natively. The tree is one tab away, and `/tree/` and `/blob/` links open what they name. A `view` block draws a flow's `view.tsx` through 0004's presentation realm and frame (phase 3). Arriving at a home runs no flow.
11. **People merge; agents propose.** The agent may author, try, save its person's flows and propose repository flows. It never merges or activates, and a person's flow's catalog never includes the `flow/*` or `run/*` acts.

## Why

- **One flow model is Will's ruling and the flow-layering rule.** "Never add a second node or graph model" (root `AGENTS.md`). `@smthrs/flow` already makes a prompt flow a kind of code flow: `Flow.make` takes a typed prompt renderer and "lowers to one ordinary action implemented by the host" (`packages/smithers/flows/flow/src/Flow/make.ts:160-170`). A stored `SKILL.md` would have been a second format with its own parser, checks and runner.
- **"Repository code never in the app's realm" still leaves one safe executor in the browser: the agent.**
  - A drafted flow's instructions are text the agent loop reads, with the same trust as a file `repo/read` returns (0004 §1, eval 11). Its catalog is its own `flows` list intersected with what its person may run.
  - So the engine may run a drafted flow only while its source is exactly what the system wrote: then the body that runs is the system's agent step and only the data came from the draft. Telling that apart needs no evaluation: re-render the module from the data read out of it and compare the bytes (`readGenerated`, `apps/mvp/src/features/flows-ui/source.ts`).
  - So the first slice needs no sandbox. Sandboxes (0005) are unbuilt, and the browser engine (B1) runs today. Anything else waits for the sandbox, as repository code does.
- **Discovery is already static.** `Discovery` scans flows "without loading their bodies" (`packages/smithers/agent/registry/src/Discovery.ts:46-62`). `ModuleMetadata` reads a `flow.ts` declaration's description, payload JSON Schema, placement and `modelInvocable` from its source text (`registry/src/internal/ModuleMetadata.ts:26-60`). `executionDigest` binds a run to the exact bytes it ran (`registry/src/Descriptor.ts:841`).
- **The engine keeps what a debugger needs.**
  - Its tables: `flows_runs`, `flows_attempts` and `flows_journal_events` (`packages/smithers/flows/run-store/src/migrations/0001_initial.ts:20,91`; `packages/smithers/flows/journal/src/migrations/0001_initial.ts:20`).
  - A revisioned change feed with tombstones (`engine-store/src/RunChangeFeed.ts:42-52`).
  - A content-free observation per run: status, flow name, times, parent, lineage, cancellation and wait kind (`engine-store/src/internal/ExecutionSnapshotRead.ts:206-236`).
- **Port v4's monitor model, not its gaps.**
  - `RunTrace` folds journal records into run, frame, model, cell and call spans with waterfall geometry. It is pure and its package root is browser-safe (`packages/smithers/gateway/src/RunTrace.ts:1-17,1932,1948`).
  - v4's card printed values verbatim (`apps/app/src/mainview/cards/RunTraceCard.tsx:68-75`) and trusted writers to redact. But the journal deliberately leaves attempt outcomes unredacted, because they replay (`packages/smithers/flows/journal/src/Redaction.ts:1-25`). So redaction happens at the host's read, the one display boundary.
- **v4's authoring proved the shape and showed two faults.** `create-flow` had optional and blocking questions (`.smithers/flows/create-flow/flow.mdx:25-46`). The app found its output by scanning the journal for file writes (`apps/app/src/mainview/state/FlowAuthoringReceipts.ts:4-48`), the files landed in a machine's working copy outside review, and the only check was an automatic plan. Here a draft is a row, and repository files reach `main` only by a merged pull request.
- **The spec asks for activation, not presence.** "If loading fails, the previous version stays active and the card shows 'Merged · not active' with the error" (mvp.md §6.12). A flow file on `main` is not yet a runnable flow.
- **v4's home contract is right, and this repository already uses it.** A home is data, not code; a missing or broken declaration keeps the tree with one sentence; a button runs only when pressed (`apps/app/src/mainview/cards/RepositoryHomeView.tsx:16-50,254-262`). `.smithers/home.json` already declares one, so our own repository works the day W6 lands.
- **A module keeps a personal flow portable.** The same `flow.ts` is a repository flow under M-49, and `@smthrs/registry`'s `ModuleFlow` reads it without importing it, as `Discovery` reads a repository's (added for this, 2026-10-20). Superseded reasoning, kept for the record: **`SKILL.md` kept a personal flow portable.** It follows the Agent Skills format: a `name` of up to 64 lowercase letters, digits and hyphens, and a `description` of up to 1,024 characters ([skills]). The same file is a repository flow under M-49 and a Claude Code skill. It lowers to `@smthrs/flow` through the registry's `Executable`, so the root `AGENTS.md` flow-layering rule holds.

## Consequences

- **SDK work, each piece with its consumer here:**
  - `@smthrs/engine-store`: `RunInspection`, one read of a run's spans, attempts, waits and journal page, over SQLite or Postgres.
  - `@smthrs/platform-browser`: `inspect` and `list` on `BrowserEngine` and its worker protocol. Today it offers `start`, `result`, `cancel`, `signal` and `events` only (`src/BrowserEngine.ts:135`).
  - `@smthrs/views`: `Home`, the block schema, moved from `packages/smithers/build/targets/src/Home.ts`, which re-exports it. `@smthrs/targets` can't load in a browser (`docs/libraries.md`, "Known violations").
  - `@smthrs/effect-code-storage`: `CodeStorageFileSystem`, a read-only Effect `FileSystem` over a repository at a commit, so `Discovery` runs in the Worker (L1).
  - `@smthrs/ui`: the components in §5, and `Textarea`'s `code` for a flow's code page.
  - `@smthrs/registry`: `ModuleFlow.fromModule`, a `flow.ts`'s descriptor and declared tag read from text, for checking a person's flow source (built 2026-10-20).
- **The remote door returns with its first consumer.** `POST /api/flows/run` starts a code flow, as `features/remote-flows.md` "No remote door" foresaw (L2).
- **0009's run acts are spelled `run/cancel` and `run/retry`,** lowercase verbs as `app/theme/set` is. 0009 gains `run/resume`, and `run/cancel` and `run/resume` carry the row's `seq`.
- **Library catalog entries used:** `@smthrs/flow`, `@smthrs/agent` (`AgentAction`, `ModelStep`), `@smthrs/registry`, `@smthrs/engine-store`, `@smthrs/journal`, `@smthrs/control`, `@smthrs/gateway`, `@smthrs/platform-browser`, `@smthrs/platform-cloudflare`, `@smthrs/platform-node` (`SandboxedFlow`), `@smthrs/sandbox`, `@smthrs/views`, `@smthrs/ui`, `@smthrs/integrations`, `@smthrs/effect-code-storage`, `@smthrs/artifacts` (`ImmutableCache`), `@smthrs/effect-tanstack-db`, `@smthrs/effect-electric` and `@smthrs/observability`.

## 1. Data and state

**Postgres.** One migration for the skeleton's three tables and one for `flow_bindings` (L1); their numbers go through the lead, because 0012 and 0013 add migrations too.

```sql
flows          (id uuid PRIMARY KEY, owner_id uuid NOT NULL,
                name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,63}$'),
                revision int NOT NULL, description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
                deleted_at timestamptz, created_at timestamptz, updated_at timestamptz,
                UNIQUE (owner_id, name))                                                  -- REPLICA IDENTITY FULL
flow_revisions (flow_id uuid, revision int, digest text NOT NULL,
                source text NOT NULL CHECK (octet_length(source) <= 65536),
                created_by uuid NOT NULL, created_at timestamptz,
                PRIMARY KEY (flow_id, revision))                                          -- append-only
flow_drafts    (id uuid PRIMARY KEY, actor_id uuid NOT NULL,
                scope text CHECK (scope IN ('person','repo')), repo_id text, target text CHECK (target IN ('flow','home')),
                name text, request text CHECK (length(request) <= 4096),
                status text CHECK (status IN ('drafting','needs_you','ready','failed','saved','proposed')),
                round int NOT NULL DEFAULT 0,
                files jsonb,       -- [{path, text}], 64 KiB in all
                checks jsonb,      -- [{check, ok, code?}]
                questions jsonb,   -- [{id, text, assumed, blocking, answer?}], at most 5 a round
                failure text, flow_id uuid, pull_number int, created_at timestamptz, updated_at timestamptz)
flow_bindings  (repo_id text, name text,
                active_sha text, active_digest text, description text, input jsonb, model_invocable bool,
                minimum text, candidate_sha text, failure text, updated_at timestamptz,
                PRIMARY KEY (repo_id, name))                                              -- L1; only flow/refresh writes it
```

| Shape (`ShapeProxy`, authorized per request, 0007 §7) | `where` |
|---|---|
| `flows`, `flow_revisions` | `owner_id = $actor`, revisions through their flow |
| `flow_drafts` | `actor_id = $actor` |
| `flow_bindings` | `repo_id = $1` with `repo:read` |
| `runs` (0009 §3) | 0009's scopes |

A draft card in a shared conversation shows its author and status to everyone. Its files reach only its author until a pull request makes them public.

**On the device** (`@smthrs/effect-tanstack-db`; no `useState`):

| Collection | Kind | Key | Holds |
|---|---|---|---|
| `flows`, `flowRevisions`, `flowDrafts`, `flowBindings` | Electric, persisted | their keys | the shapes above |
| `homes` | local, persisted | `<repoId>@<sha>` | the decoded `.smithers/home.json`, or `absent`, `invalid` or `unreadable` |
| `localRuns` | local | run id | this engine's observations, from `RunChangeFeed` and `ExecutionSnapshot` |
| `runTraces` | local | run id | `RunTrace`'s model and the journal cursor |
| `runPage` | local, per tab | route | the selected span, the tab and the scrubber's sequence |

A home at a commit never changes, so it is cached with `ImmutableCache` (`BrowserCache.layer()`).

**The engine's tables are read, never written,** by these features: `flows_runs`, `flows_attempts`, `flows_journal_events` and `flows_run_changes`.

**A run's identity.** A run of a non-app flow records `ref`, either `{source: "person", flowId, revision}` or `{source: "repo", repo, sha, name}` (0003 §1's `{source, revision, tag}`), and the descriptor's `executionDigest`. 0009's `runs` row carries both as `flow_version`.

## 2. Flows

Each is registered in `src/flows/registry.ts` and is model-invocable unless the table says why not. Placement is `client` unless noted; "remote by need" follows 0011 §2. Minimums use 0007's catalog, including `repo:flow-run`.

| Flow | Payload | Placement | Who may run it | Doors |
|---|---|---|---|---|
| `flow/new` | `{ scope: "person" \| "repo", repo?, name?, request }` | client; model calls through the endpoint, role `agent` | person: signed in; repo: Member | `/flow.new`, New flow, the agent |
| `flow/answer` | `{ draftId, round, answers: [{ id, value }] }` | client; completes the round's `HumanTask` when it lives here | the draft's author | the card. User-only: "The agent that asked can't answer itself." |
| `flow/try` | `{ draftId, input }` | a drafted module as drafted: client; other code: remote by need (sandbox) | the draft's author; a Guest's code waits for a Member (0007 §1) | Try, the agent |
| `flow/save` | `{ draftId }` | client; ChatApi admits the outbox write | the draft's author, scope person | Save, the agent |
| `flow/read` | `{ name, revision? }` | client read | its owner | Code, the agent |
| `flow/write` | `{ name, revision, source }` | client; checked as every revision is, admitted while `revision` is the latest | its owner | Save on the code page, the agent |
| `flow/propose` | `{ draftId }` | client, through 0012's branch and pull-request flow (GitHub App token: remote by need) | Member | Propose, the agent |
| `flow/refresh` | `{ repo, sha }` | remote: it runs when the mirror moves, with every device off, over the Code Storage key | the flow that moves `repositories.head_sha` | none; not invocable |
| `flow/run` | `{ ref, input }` | a drafted module as drafted: client; other code: remote by need, `POST /api/flows/run` (L2; refused `FlowNeedsSandbox` until then) | person: its owner; repo: `repo:flow-run` (Member, or the flow's minimum) | `/flow.run <name>`, `/<name>` when no app command has it, Run, the agent |
| `flow/list` | `{ repo? }` | client read | readers of the scope | `/flows`, the agent |
| `flow/delete` | `{ flowId }` | client | its owner | Delete, the agent |
| `run/list` | `{ scope?, status? }` | client read | run readers (below) | `/runs`, the agent |
| `run/inspect` | `{ runId, afterSeq? }` | client read: the local engine or RunApi | run readers | Inspect, `/run.inspect <id>`, the agent |
| `run/cancel` | `{ runId, seq }` | the owning engine; elsewhere a `run_commands` row | its launcher; repository runs: Maintainer; system runs: Admin | Stop, the agent |
| `run/retry` | `{ runId, version: "pinned" \| "current" }` | the run's own placement; execution id `retry:<runId>:<n>` | anyone who may run the flow now; it runs as the retrier | Retry, Retry with the current flow, the agent |
| `run/resume` | `{ runId, seq }` | the owning engine: restart this device's worker, or `ExecutionObject.wake` (0009 §5) | as `run/cancel` | Resume, the agent |
| `repo/home/edit` | `{ repo, request }` | client; `flow/new`'s machinery with target `.smithers/home.json` | Member | Edit home, the agent |

**Run readers:** the launcher; for a run in a repository, anyone with `repo:read` there; for a system run (`chat/Expire`, `auth/*`), Admins.

**`flow/new`, one round:**

```
flow/new (execution <draftId>:<round>; Deadline 10 min)
  Open      round 0 only: insert the draft row (outbox); add a flow-draft view to the conversation
  Read      sealed: the request, the files so far, every answer so far (the draft row)
  Draft     AgentAction, seat agent ─▶ {files, questions ≤ 5, summary}
            tools: repo/tree, repo/read, flow/list, run/inspect (reads only)
  Check     the static checks below; a failure goes back to Draft, twice at most
  Write     the draft row: files, checks, questions, status ready | needs_you
  Blocking question? HumanTask "answers:<round>" ─ flow/answer completes it
  Settle; an answer that arrived after Read starts round n + 1
```

A round never waits on an optional question. An answer given after the round settled starts the next round on the same draft. This is `create-flow`'s rule, with the questions in a row instead of reply text.

**Static checks** (in `Check`, and again wherever a write is admitted):

Every revision is checked the same way, whoever wrote it: its source read by `@smthrs/registry`'s `ModuleFlow`, without importing it.

| Check | Every flow's source | Also, a repository's |
|---|---|---|
| Parses | a `Flow.make` default export, read without a warning | |
| Name | the tag `Flow.make` declares: `^[a-z][a-z0-9-]{0,63}$`; outside the app namespaces (`app`, `chat`, `repo`, `ui`, `view`, `flow`, `run`); the flow's name; free in its scope | matches its directory |
| Description | 1 to 1,024 characters | |
| Calls | each `flows` entry is an app flow its person may run or a flow in the same scope; never `flow/*` or `run/*` | from `capabilities`, checked in the sandbox |
| Model | absent, or a role the endpoint knows (`agent`); never a provider's model id | |
| Placement | none declared: the host reads it from the source (§1) | `sandbox` |
| Size | 64 KiB | 64 KiB for all files |
| Typecheck, tests, plan | a drafted module is type-checked once, in the app's tests | `flow/check` in a job sandbox (L2); a plan is a declaration preview, not proof |

**`flow/run` for a person's flow:**

```
flow/run (client)
  Load    sealed: the flow.ts at its revision (a flow_revisions row); digest and checks verified, then its placement:
          sandbox ─▶ FlowNeedsSandbox, before anything runs (until L2)
          client  ─▶ its instructions and calls, pinned in the child's payload
  Agent   flow/run/prompt: AgentAction "flow/run/agent", seat agent, system FLOW_SYSTEM, the module's own prompt
          (its instructions, then the input); catalog = flows ∩ (the app catalog for this person's role); nesting ≤ 3
  ─▶ the agent's answer text
```

**`flow/run` for a repository's flow, or a person's `sandbox` code (L2).** The device calls `POST /api/flows/run`. FlowApi admits it: sign-in, `repo:flow-run`, repository read, the binding's active revision and the budget. It then starts `flow/Sandboxed { repo, sha, name, input, actor }` on the `FlowExecution` Durable Object. That flow wakes a job sandbox at the commit, discovers the flow there, and runs `SandboxedFlow.execute` under the person's capability ceiling, with egress through 0005's `Egress`. It never trusts a descriptor the device sent. The device shows the remote run.

**`flow/refresh` (L1).** It is started, execution `flow-refresh:<repo>:<sha>`, by the flow that moves `repositories.head_sha` (`repo/Clone`'s Settle and 0012's sync). It runs `Discovery` over `CodeStorageFileSystem` at the commit, runs the static checks (code flows: `flow/check` too), and writes each binding by compare-and-set on `active_sha`. A failure sets `candidate_sha` and `failure` and leaves the active revision. A root `flows/` folder gets M-49's one diagnostic and runs nothing.

**`flow/propose` (L1)** hands the files to 0012's branch and pull-request flow, one change per draft. It needs one multi-file commit fenced on the branch's head: GitHub's GraphQL `createCommitOnBranch` takes `expectedHeadOid`, "the git commit oid expected at the head of the branch prior to the commit" ([commit]). An uncertain pull-request creation is reconciled by listing pulls by `head` and `base` before retrying ([pulls]). Authored files never see a token.

**When a flow becomes runnable:**

| Scope | In the catalog when | A run pins |
|---|---|---|
| Mine | `flow/save` is admitted | `flows.revision` |
| A repository | `flow_bindings.active_sha` names it | `active_sha` when the run starts |
| A draft | always, for its author's Try | the draft's round |

## 3. Reading runs

```
the run page ─▶ run/inspect ─┬─ a run on this device ─▶ BrowserEngine.inspect ─▶ leader worker ─▶ RunInspection (SQLite, OPFS)
                             ├─ a Cloudflare run ─▶ GET /api/runs/:id/trace?afterSeq= ─▶ RunApi ─▶ RunInspection (Postgres smithers_flows)
                             └─ a browser run on another device ─▶ "On another device"; its runs row still shows status
RunInspection: spans, attempts, waits, a journal page (≤ 500 events) ─ Redaction ─ clip 16 KiB ─▶ RunTrace.traceFromJournal ─▶ runTraces
```

- **Live.** A local trace follows `BrowserEngine.events`. A remote trace re-reads from its cursor when its `runs` row's `seq` moves; nothing polls.
- **RunApi** answers `200` with a page, `403` for a person who may not read the run, `404` for an unknown or forgotten run, and `413` past the page bound. Authorization follows the readers rule in §2.
- **Retention.** Cloudflare runs keep their history in `smithers_flows` (`features/remote-flows.md`). Local runs follow `@smthrs/engine-store`'s `Retention` in the engine worker. Signing out deletes the engine's OPFS directory with the device's other data (`features/sign-in.md:95`).

## 4. A repository's home

- **The declaration** is `.smithers/home.json` at the default branch's head, read through RepoApi's blob route and decoded by `@smthrs/views`'s `Home`.
- **Blocks:**
  - `text`;
  - `links`, absolute `http` and `https` only;
  - `markdown`, a repository path at the same commit, 512 KiB at most;
  - `prompt`, which opens the composer, or runs its flow on Send;
  - `flows`, the repository's active flows with Run;
  - `app`, one flow's button, shown only when the catalog has that flow, as v4 did (`RepositoryHomeView.tsx:78-83`);
  - `runs`, the repository's recent runs, once 0009's rows exist;
  - `view`, phase 3.
- **Bounds are v4's:** 32 blocks, 120-character titles, 4,096-character text, no HTML (`packages/smithers/build/targets/src/Home.ts:30-130`). An unknown block kind is skipped. `stack` waits for TODOs.
- **Failures:**
  - absent: the tree, as today;
  - invalid or unreadable: the tree with one line, `Home is invalid` or `Couldn't read home`;
  - a stale custom home is never shown.
- **Sections and audiences (built 2026-10-20, after Will's review of the first recording).** A home's blocks sit in sections, each for `everyone`, `contributor` or `maintainer`. ChatApi decides the audience from the session (`GET /api/repos/<owner>/<name>/home`); a repository's own file is public, and each live block's rows come from a shape that checks the role again. New declared blocks (`hero`, `code`, `cards`, `stats`, `releases`, `action`) and live ones (`issues`, `runs`, with `flows` and `stack` now drawn) landed with their first consumers, as 0017's block row says. The design is [design/repo-home/repo-home.html](../design/repo-home/repo-home.html); [features/home.md](../features/home.md) is the reference.
- **Curated homes (built 2026-10-20).** A repository Smithers doesn't control, such as `Effect-TS/effect`, gets a home Smithers keeps as data (`apps/mvp/worker/home/curated/`), in the same format, never hardcoded in a component. When the plugin host lands, each curated home becomes a first-party plugin's `repo/home` tap (0017), and the route serving it today becomes that plugin's.
- **Phase 3, custom UI.** A `view` block names a flow whose directory holds `view.tsx`. `ViewCode.check` checks it and `PresentationRealm` renders it in QuickJS with `{ repo, revision, runs }`. `GeneratedView` shows it in the opaque frame (0004 §4 to §6). Its declared events dispatch flows through the registry after a click, under the viewer's role. The same view draws on that flow's run pages (mvp.md §6.14, "A flow can declare a custom view"; line 479, "A flow's own screen").

Presentation code (a pure `View` and `reduce`) runs in 0004's QuickJS realm, which already admits untrusted model code. Flow code, which has effects, runs only in a sandbox.

## 5. UI

**Routes** (TanStack Router; `app` is a reserved owner, `features/repo.md` "Refusals"):

| Route | Screen |
|---|---|
| `/app/flows` | Mine: name, description, Run, Edit, Delete |
| `/app/runs`, `/app/runs/$runId` | every run this person may read, and its run page |
| `/$owner/$repo` | the declared home, or the tree |
| `/$owner/$repo/actions` | the repository's flows, drafts and recent runs; GitHub's path, labelled Flows |
| `/$owner/$repo/actions/runs/$runId` | a repository run's page; GitHub's path |

**The draft card** (a `flow-draft` view in the conversation; full size at `/app/views/$viewId`, 0004 §6):

```
┌ New flow ────────────────────────────────── ◌ Drafting · round 2 ┐
│ Where [maya/tinyhttp ▾]  Name [release-notes]                     │
│ What  [Summarize merged PRs since the last tag]                   │
│ ? Which tag pattern?         [v*          ] assumed               │
│ ? Post as a draft release?   [no          ] assumed               │
│ flow.ts ▸                    ✓ parses  ✓ name  ✓ calls            │
│                                              [Try]  [Propose]     │
└───────────────────────────────────────────────────────────────────┘
```

**The run page:**

```
┌ release-notes · ✓ Done · 0:42 · this device ───────────── [Retry ▾] ┐
│ Steps │ Timeline │ Journal                            ◀──●──── #212  │
│ ✓ Load                    12 ms   │ repo/read                        │
│ ✓ model · frame 1        1.2 s    │ Input   { repo, revision, path } │
│ ✓ cell 1 → repo/read      84 ms ◀ │ Output  "## Changes …"  clipped  │
│ ◆ waits for an answer   since 12:04 │ Attempts  1 ✕ unavailable · 2 ✓│
│ ✓ model · frame 2        0.9 s    │                                  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Words** are 0009 §4's closed vocabulary, plus `On another device`, `Expired` and `No access`.
- **The tabs:** Timeline is `RunTrace`'s waterfall, and Journal lists sequence, type and time, with values on demand.
- **The scrubber** reads the trace at a sequence, read-only: no fork or rewind (root `AGENTS.md`).
- **Waits** show their kind, since when and when they wake. A human wait shows Answer.
- **Tokens and time per step** show when the journal recorded them.

**The home:**

```
/maya/tinyhttp   [Home] [Code] [Flows] [Issues] [Pull requests]
┌ What should we work on?  [Ask Smithers…                 ] ┐
│ Docs · Report a bug                                       │
│ README.md, rendered                                       │
│ Flows  [release-notes ▸] [triage ▸]                       │
└────────────────────────────────────────────────────────────┘
```

**`@smthrs/ui`.**
- **Used as is:** `StatusPill`, `Tabs`, `Table`, `ToolCallInput`, `ToolCallOutput`, `StackTrace`, `RelativeTime`, `FlowFormView`, `Markdown`, `GeneratedView`, `EmptyState` and the code-view adapter.
- **Missing; each lands with its tests and docs:**
  - `FlowDraftView`, new; its form is `FlowFormView`;
  - `RunList`, `RunHeader`, `SpanTree`, `SpanDetail` and `RunWaterfall`, ported from `apps/app/src/mainview/cards/RunTraceCard.tsx` and `RunTraceSummary.tsx`;
  - `JsonValue`, a clipped, collapsible value shown as text;
  - `RepositoryHome`, ported from `apps/app/src/mainview/cards/RepositoryHomeView.tsx` and rendering `Home` blocks.
- **Reused from 0009:** `RunCard` and `RunProgress`, not duplicated.

## 6. Failure and recovery

| Failure | What happens |
|---|---|
| The tab closes mid-round | The engine resumes the round on reopen, and a sealed model call isn't paid again (B1) |
| The model refuses or rate-limits | `ModelStep`'s retry policy; past it the draft is `failed` with its code, and Retry starts a round |
| A check fails twice | The draft is `ready` with the failing check named; Save and Propose stay off |
| The name is taken at Save | `409`; the card says `Name taken` |
| A personal flow changes or is deleted mid-run | The run keeps its revision; Retry `pinned` reads it from `flow_revisions` |
| A merged flow fails `flow/refresh` | The previous revision stays active; the Flows page says `Merged · not active` with the code |
| The mirror's head moves | `flow/refresh` runs once per commit; running runs keep their pinned revision |
| RepoApi can't read the home | The tree, with `Couldn't read home` |
| A flow calls outside its list | The cell gets a refused call naming the flow; the run continues |
| Flows nest deeper than 3 | Refused the same way |
| A person's flow whose code isn't the drafted module, before L2 | `FlowNeedsSandbox` before anything runs; the Flows page says `Needs a sandbox` |
| A code edit from a revision another followed | `409 stale`; the code page says `Changed since you opened it` |
| A browser run is opened on another device | `On another device`, with its status from the `runs` row |
| A remote run is forgotten or unreadable | `Expired`, or `No access` on a `403` |
| This device's engine worker fails | The engine-failure state with Reload; Resume on a stuck local run restarts the worker |
| Cancel races completion | The receipt names the final status (`Control`'s `Terminal`) |
| A stale act | Its `seq` no longer matches; the act is refused and the page shows the current row |
| A repeated Retry | One run: execution `retry:<runId>:<n>` |
| A browser writes a `runs` row claiming a server run, an approval or a wider scope | Refused at admission; only the owning host writes its runs |

## 7. Observability

No record carries a request, a draft file, a question or answer, a personal flow's name, a step value or home text. A sentinel puts a canary in each, and the test reads every OTLP export.

| Record | Kind | Fields |
|---|---|---|
| `flow.author` | log, span | `draftId`, `round`, `scope`, `target`, `outcome` (`ready`, `needs_you`, `failed`), `checks` (failed codes), `questions`, `durationMs` |
| `smithers_flow_author_rounds` | counter | `scope`, `outcome` |
| `flow.save`, `flow.propose` | log, span | `draftId`, `outcome`, `code` |
| `flow.refresh` | log, span | `repoId`, `sha`, `flows`, `activated`, `failed`, `durationMs` |
| `smithers_flow_activations` | counter | `kind`, `outcome` |
| `flow.dispatch` (exists) | log, span | adds `source` (`app`, `person`, `repo`), `placement` (`client`, `sandbox`) and the digest's first 12 hex characters |
| `run.inspect` | log, span | `host` (`local`, `remote`), `outcome`, `events`, `bytes`, `clipped`, `durationMs` |
| `smithers_run_acts` | counter | `act` (`cancel`, `retry`, `resume`, `answer`), `host`, `outcome` |
| `smithers_run_command_ack_ms` | histogram | `host_kind` |
| `home.resolve` | log, span | `repoId`, `sha`, `outcome` (`declared`, `absent`, `invalid`, `unreadable`), `blocks`, `skipped` |
| `runs.api` | log, span | `route`, `status`, `code` |
| `realm.limit_hit` (0004) | counter | `limit`, for home views |

## 8. Tests

**Unit, on compose Postgres and Electric; the model is the only scripted seam; faults by injected services:**
- `RunInspection` over SQLite and Postgres from one fixture journal gives the same trace. It redacts a credential-shaped attempt outcome, clips at 16 KiB, never releases a `Redacted` field, and pages by `seq` without gaps or repeats while events append.
- `BrowserEngine.inspect` through the real worker protocol in Node, as `src/flows/engine.test.ts` runs the engine.
- `RunTrace` folds a recorded `chat/Answer` journal and a `flow/run` journal into spans with each call's input and output.
- `flow/new`:
  - one round against a scripted draft;
  - each static check's refusal;
  - an answer during a round starts round n + 1;
  - a blocking question parks on its `HumanTask`, and `flow/answer` completes it;
  - a killed engine resumes with no second model call.
- `flow/save`'s admission: size, name, duplicate and a signed-out actor.
- `flow/run` for a person's flow:
  - code that isn't the drafted module, byte for byte, is refused `FlowNeedsSandbox` before any model call;
  - it calls only its list, and anything else is a typed refusal;
  - nesting stops at 3;
  - a model role the endpoint lacks is refused.
- `flow/refresh` over `CodeStorageFileSystem`: activation, a failing flow keeps the previous revision, a stale compare-and-set, and a root `flows/` diagnostic.
- The registry's parity law over the new flows and the joined catalog.
- `Home`: every block and bound, HTML refused, an unknown kind skipped, and an `app` block for a missing flow hidden. The decoder is fuzzed, and counterexamples are kept.
- RunApi: every reader and actor combination, `403`, `404` and the page bound.
- A spoofed `runs` row from a browser for a server run is refused.

**End to end (`pnpm e2e`, real stack, video and a GIF each):**
- F1, the slice: `/flow.new` → the draft → Save → `/release-notes` → the run card → Inspect → each step's input and output → Retry.
- F2: an optional question answered mid-round steers the next round.
- F3: closing the tab mid-round, then reopening; the round finishes once.
- F4: a flow saved on one device is in the other device's slash menu.
- F5: a fixture repository's `.smithers/home.json` draws its blocks; Code opens the tree; `/blob/` opens the file. It skips without `CODE_STORAGE_*`, as `e2e/repo.spec.ts` does.
- F6: the run page of a `repo/Clone` run on Cloudflare.
- F7: Stop on a live local run reads `Stopping`, then `Cancelled`; keyboard only, both themes.

**Evals** (0004's suite; live runs by hand): "make a flow that …" calls `flow/new` with the current repository and never answers with steps for the person to follow; a drafted flow's injected text can't reach a flow outside its list.

**Benchmarks** (`pnpm bench`, against a baseline): folding a 5,000-event journal, a run-list query over 1,000 runs, and a home's first paint.

## 9. Build plan

**The walking skeleton, one owner, in order,** until F1 passes on `alchemy dev`. It needs no sandbox, no pull request and no 0009 table.
1. `RunInspection` in `@smthrs/engine-store`, and `inspect` and `list` on `BrowserEngine` and its protocol.
2. `/app/runs` and the run page over the local engine with `RunTrace`; `run/cancel` and `run/retry` on local runs.
3. The migration for `flows`, `flow_revisions` and `flow_drafts`; their shapes; admission of `flow/save`'s outbox write.
4. `flow/new` with optional questions, `flow/answer`, `flow/try` and `flow/save`, scope person; the `flow-draft` view. A draft whose scope is a repository can be tried, and Propose arrives with L1.
5. `flow/run` for drafted flows; the joined catalog in the slash menu and the agent; a `run` view with Inspect.

**Then, by file ownership.** `src/flows/registry.ts`, `PACKAGE.ts`, the vitest configs, the router and the migration numbers go through the lead.

| WS | Owns | Needs | Proves |
|---|---|---|---|
| W1 SDK reads | `packages/smithers/flows/engine-store/src/RunInspection.ts`; `packages/smithers/flows/platform-browser/src/{BrowserEngine.ts,internal/Protocol.ts,internal/Engine.ts}` | none | one trace on SQLite and Postgres; redaction; 100% |
| W2 SDK UI | `packages/smithers/ui/src/{run-page,flow-draft-view,repository-home,json-value}/**` | W3 for the home | conformance, keyboard and both themes |
| W3 SDK schemas | `packages/smithers/ui/views/src/Home.ts`, the re-export in `packages/smithers/build/targets/src/Home.ts` | none | one schema; this repository's `.smithers/home.json` decodes |
| W4 app flows | `apps/mvp/src/features/flows/**` | W1 | authoring, the catalog and runs of drafted flows |
| W5 app runs | `apps/mvp/src/features/runs/**`, `apps/mvp/src/screens/runs/**`, `apps/mvp/worker/RunApi.ts` | W1, W2 | local and remote run pages; the four acts |
| W6 app home | `apps/mvp/src/features/home/**`; the Home and Code tabs in `apps/mvp/src/screens/repo/**`, with the repository owner | W2, W3 | F5 |
| W7 evidence | `apps/mvp/e2e/{flows,runs,home}.spec.ts`, `apps/mvp/evals/flows.eval.ts`, the benchmarks, `apps/mvp/docs/features/{flow-authoring,runs,home}.md` | with W4 to W6 | §8 |
| L1 repository flows | `flow/propose`, `flow/refresh`, `repo/home/edit`, the `flow_bindings` migration; `CodeStorageFileSystem` in `packages/effect-code-storage` | 0012's branch and pull-request flow | a merged flow activates after sync, and a broken one stays `not active` |
| L2 code flows | `apps/mvp/worker/FlowApi.ts`, `apps/mvp/worker/flows/{Sandboxed,Check}.ts` | 0005's job sandboxes, built with 0013 | a `flow.ts` runs and is checked in a job sandbox, never in the tab |
| L3 custom home views | the `view` block | 0004 V3 | a repository's `view.tsx` renders in the frame |
| L4 one run list | 0009's `runs` rows and `run_commands` in `/app/runs` | 0009 phase 1 | runs from other devices and Cloudflare in one list; Stop across devices |

## Questions for Will

1. **Answered no, 2026-10-20 at about 14:25.** The question was "Your own flows, usable in any repository, are prompt flows: a `SKILL.md` of instructions plus the flows it may call. Code flows (`flow.ts`) live only in repositories and run only on a sandbox." Will: "No everything is a flow this ruling is clear prompt flows are just a type of code flow." The same day: "Flows are the most important part of our product and technology and should be supported very very well but we should be thoughtful and high quality with adding support to flows." §1 and §2 record the result: one flow model, a person's flow stored as `Flow.make` source, a drafted flow running on the device only as drafted, and other code waiting for a sandbox. Migration `0025_flow_source` converted the `SKILL.md` flows the first slice stored.

## Sources

- [skills] Agent Skills, https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview: `name` and `description` limits.
- [commit] GitHub GraphQL, https://docs.github.com/en/graphql/reference/commits: `createCommitOnBranch` and `expectedHeadOid`. The page doesn't state the error on a mismatch, so L1 proves it with a test.
- [pulls] GitHub REST, https://docs.github.com/en/rest/pulls/pulls#list-pull-requests: filter by `head` (`user:ref-name`) and `base`.
- [contents] GitHub REST, https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents: one file per commit, and no parallel use with delete. This is why L1 commits through `createCommitOnBranch`.
- [dispatch] GitHub Actions, https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs: typed run inputs (`boolean`, `choice`, `number`, `environment`, `string`; 25 at most). It is prior art for a flow's run form.
- [temporal] Temporal Web UI, https://docs.temporal.io/web-ui: Timeline, All, Compact and JSON history; pending activities; input and results; cancel and signal. It is prior art for the run page's tabs.
- [cf-security] Cloudflare Sandbox, https://developers.cloudflare.com/sandbox/concepts/security/: the sandbox is the trust unit (0005 §4).
- This repository:
  - `packages/smithers/agent/registry/src/{Discovery,Descriptor,MarkdownFlow,Executable}.ts` and `registry/docs/concepts/delegation.md`;
  - `packages/smithers/agent/src/{PromoteFlows,FlowStore}.ts`;
  - `packages/smithers/flows/engine-store/src/{RunChangeFeed,ExecutionSnapshot,EventTypes,RunCatalogRead}.ts`;
  - `packages/smithers/flows/journal/src/Redaction.ts`;
  - `packages/smithers/flows/platform-browser/src/BrowserEngine.ts`;
  - `packages/smithers/flows/platform-node/src/SandboxedFlow.ts:1-60`;
  - `packages/smithers/control/docs/guides/cancel-and-resume.md`;
  - `packages/smithers/gateway/src/{RunTrace,EngineTrace}.ts`;
  - `packages/smithers/build/targets/src/{Flow,Home,FlowCatalog}.ts`;
  - `.smithers/home.json` and `.smithers/flows/create-flow/flow.mdx`;
  - `apps/app/src/mainview/cards/{RunTraceCard,RunTraceSummary,RepositoryHomeView,FlowFormCards,FlowCard}.tsx`, `apps/app/src/mainview/state/FlowAuthoringReceipts.ts` and `apps/app/src/mainview/state/seams/RepositoryFlowsSeam.ts`;
  - `apps/mvp/src/flows/registry.ts`, `apps/mvp/src/features/commands/catalog.ts` and `apps/mvp/src/router.tsx`;
  - `.specs/product/mvp.md`: §6.12, §6.14, §6.16, line 479, M-04, M-30, M-39, M-45, M-47 and M-49.

## Appendix: Opus, Sol and final compared

Opus and Sol wrote their designs independently on 2026-10-20; Opus merged them. Each claim of Sol's that the final design adopts was checked against its primary source: `createCommitOnBranch` and the pull-request list filters on GitHub's pages, Cloudflare's trust unit on its security page, and Sol's prior-art lines in this repository.

**Agreed:** both designs said the same thing, and the final design keeps it.

| Point | Final |
|---|---|
| Authoring door | a form card in the conversation; the repository defaults to the current one; optional questions that steer; a `HumanTask` only when blocked |
| Repository flows | `.smithers/flows/<name>/`, never a root `flows/`; reach `main` only through a pull request a person merges |
| Repository code | never in the tab, the engine worker or the Worker; a job sandbox through `SandboxedFlow` |
| Presentation code | a pure TSX view in 0004's QuickJS realm and frame is allowed; its events dispatch flows under the viewer's role, after a click |
| One catalog | the slash menu, buttons, the agent and the CLI read one catalog; no repository flow shadows an app flow |
| The run list | 0009's `runs` rows; journals stay on their hosts and are never copied into Postgres |
| The run page | a read-only scrubber, waits, attempts, inputs and outputs, from bounded pages; another profile's browser run says so (`On another device`) |
| Retry | a new linked execution; `pinned` or `current` |
| The home | declared in `.smithers/home.json`; the tree stays reachable; deep links open what they name; no flow runs on arrival |
| Evidence | real-browser e2e with a GIF per flow; no content in telemetry, proved by a sentinel |

**Differed:**

| Point | Opus | Sol | Final | Why |
|---|---|---|---|---|
| What a flow is | prompt flows (`SKILL.md`, run by the agent in the browser) and code flows (sandbox) | one shape: `flow.ts`; every authored flow is code in a sandbox | Will, question 1: one shape, `Flow.make` source; a drafted module as drafted runs in the browser, other code on a sandbox | "prompt flows are just a type of code flow" (Will, 2026-10-20). The slice still ships before sandboxes, because the drafted module's body is the system's own |
| Personal flows | prompt only, in Postgres | code in `@smthrs/artifacts` objects, in a sandbox | code (`flow.ts` source) in Postgres | 64 KiB of text fits a row that Electric syncs; `apps/mvp` wires no artifact store |
| App-wide scope | none | App flows published by an Admin | none | Will asked for flows usable in any repository and in one; a person's own flows meet both. An Admin catalog adds an approval path nobody asked for |
| Activation | runnable when the file is on the head | an activation receipt; a failed load keeps the previous version | Sol's, as `flow_bindings` and `flow/refresh` | mvp.md §6.12 requires `Merged · not active` with the previous version kept |
| Where discovery runs | the device, over RepoApi reads | a sandbox with no credentials | the Worker, over `CodeStorageFileSystem` | Discovery parses text and runs nothing (verified, `Discovery.ts:46-62`), so it needs no sandbox; one server pass per commit beats a request per file on every device |
| Validation and tests | static checks in the round | static checks, typecheck and the flow's tests in a sandbox | both: static in the round; `flow/check` in a sandbox for code the system didn't write | the drafted module is type-checked once in the app's tests; other code needs its real dependencies |
| Safe values | readers only, `Redaction`, a 16 KiB clip, text | an allowlisted projection; arbitrary values hidden by default | Opus, plus Sol's host-boundary rules: no `Redacted` field, no provider error text or headers | The brief asks for each step's input and output; hiding them by default hides what debugging needs |
| Resume | `Control.resume`: restart a run no host drives | continue a parked run; answer a human wait; a timer is never skipped | Opus's meaning with Sol's timer rule; Answer stays its own act | 0009 already names Answer; a durable timer is the flow's own intent |
| Stale and remote acts | not covered | `expectedVersion`; acts queued for an absent browser host | Sol's, as the row's `seq` and 0009's `run_commands` | stops a stale Stop; Stop works across devices |
| Run routes | `/app/runs/$runId`; `/$owner/$repo/actions` | `/owner/repo/runs/<id>` | `/$owner/$repo/actions` and `/$owner/$repo/actions/runs/$runId` for repository runs, `/app/runs/$runId` for the rest | GitHub's own paths keep the domain swap (M-45); `app` is a reserved owner |
| Home format | v4's data blocks; a `view` block later | `{kind: "view", path}` or `{kind: "flow", name}`, TSX only | Opus's blocks, then Sol's view as the `view` block | blocks render natively with no realm, and this repository's `.smithers/home.json` already decodes |
| Home storage | read at the commit on the device | a `repository_homes` table | Opus | an immutable read at a commit needs no table and no flow |
| Pull-request writes | through 0012 | `createCommitOnBranch` with `expectedHeadOid`; reconcile by listing `head` and `base` | Sol's, through 0012 | verified on GitHub's pages; one fenced multi-file commit, and no duplicate pull request |
| Run reader | `RunInspection` in `@smthrs/engine-store` and `@smthrs/gateway`'s `RunTrace` | a projection contract across control, journal and sync, in `packages/rpc` | Opus | both pieces exist or extend existing modules (verified); `packages/rpc` is the old app's zod package |
| Walking skeleton | a personal drafted flow: create, save, run, inspect | a repository code flow: sandbox tests, a pull request, a merge, activation and the home | Opus; Sol's path becomes L1 and L2 | a skeleton that waits on two unbuilt platforms (0005, 0012) doesn't walk |
| Tests | the slice, durability, two devices, the home | adds spoofed rows, fuzzing, gap-free paging and benchmarks | both | broader failure coverage |
| Questions for Will | two | none | one, answered | the split between prompt and code flows decided the slice, and the designs disagreed on it; Will ruled one model (question 1). The other is settled by M-04 and Will's 2026-10-13 ruling |

### Preview selection (2026-10-23)

The clone’s home selection wins over an earlier preview. Check and selection happen in the same `HomeStore.current.update` recipe: checking before an asynchronous update lets a delayed preview overwrite the clone’s default branch. A regression delays the real store write until the clone has selected its home.
