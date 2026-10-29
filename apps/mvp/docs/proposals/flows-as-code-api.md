# Workflows as code: PACKAGE.ts, the Bazel model and an Effect-native authoring API

Status: approved as recommended (Will, 2026-10-21; ruling FLOW-10). Nothing here is built yet. It answers ruling FLOW-9 ([rulings](../rulings.md)). Merged by Claude Opus from four independent designs (Claude Opus, Claude Fable, Codex Sol, Codex Astra), which all followed one brief. Every code claim kept here was checked against the repository at the cited `file:line`; claims that failed the check were corrected or dropped. The four full drafts are in the session scratchpad: `final/fac-panel-{opus,fable,sol,astra}.md`. It replaces the earlier two-panelist version of this file, which Will called too thin to judge (FLOW-9, 2026-10-20 23:50).

**Reading this document.** Paths start at the repository root unless they start with `~/`. Prefixes: `T/` = `packages/smithers/build/targets/src/`; `B/` = `packages/smithers/build/build-cli/src/`; `BI/` = `B/internal/`; `F/` = `packages/smithers/flows/flow/src/`; `P/` = `packages/smithers/flows/plan/src/`; `PS` = `packages/smithers/flows/platform-node/src/ProcessSandbox.ts`; `M/` = `apps/mvp/`; `A/` = the installed Alchemy 2.0.0-beta.83 source. `rev:path:line` is a historical file read with `jj --ignore-working-copy file show`. Decisions 0014 and 0017 are in `apps/mvp/docs/decisions/`.

## 1. Summary

**In one sentence.** Keep `PACKAGE.ts` as Bazel's data and `@smthrs/flow` as the one engine; make a `Node` an Effect so every flow body is plain `Effect.gen`; run every target as one durable action whose sandbox is an Effect Layer built from its declared files; and bind flows to events only through the repository's plugin manifest.

### 1.1 Executive summary

**What Will asked.** Thin abstractions over Effect, with no wrapper that exists only to make Effect look simpler, because VibeLang will remove the boilerplate at the language level. Higher-level libraries only where an orchestration pattern earns one. Copy Bazel deliberately. And an honest inventory of what exists, what needs a tweak and what is missing (FLOW-9).

**What exists.** Smithers already copies Bazel twice, and the copies have drifted apart.

- **The build system is Bazel in TypeScript.** `PACKAGE.ts` declares targets as values, labels are map keys, any target in another target's attrs is an edge, declared files are content-keyed, tools run under bubblewrap, seatbelt or Docker, and caching fails closed (3.2 to 3.5).
- **The flow engine is the durable half.** Actions declare file boundaries, keys fold in a complete environment, results go to a step cache, and placement routes a step to another host (3.8).

Neither copy is finished, and the gaps are measurable:

| Fact | Evidence |
|---|---|
| Smithers runs every build tool unconfined, so no Smithers build result reaches the remote cache | `default: S.Sandbox.None()` (`.smithers/WORKSPACE.ts:62-69`) → `publishable` is false (`BI/PackageRunner.ts:662-676`); "No job publishes today" (`packages/smithers/build/infra/CACHE-TRUST.md:83-85`) |
| The remote holds results, never blobs | the CLI calls only `/ac`; the server's `/cas` is never called (`B/Cache.ts:1306-1429`; `packages/smithers/build/infra/worker/protocol.ts:1709`) |
| A dependency keys by its action key, so a comment edit rebuilds everything downstream | `B/Planner.ts:816-820`; "smithers build has no output-file model yet" (`T/Filegroup.ts:33-34`) |
| Half the rules run through a second, name-matched executor | `BI/PackageRunner.ts:2108-3130`; 67 `notImplemented(` calls in `T/` |
| The other half run on a fresh in-memory engine per target; no build is durable | `B/TargetExecution.ts:48-111` |
| Flow bodies are continuation chains with hand-typed requirements | `.smithers/flows/release/flow.ts:22-36`, `:47-95` |
| Triggers are strings nothing runs, and five flow names in `FACTORY.ts` match no flow | `.smithers/FACTORY.ts:58`, `:63-89`; `M/worker/github/Reconcile.ts:19-20` |
| Confinement to declared inputs that a process can't escape exists only on the `PACKAGE.ts` path; the old JSX `<Sandbox>` never declared inputs, and flows' `WorkspaceSandbox` is in-process only | `186e86d85b96:packages/sandbox/src/execute.js:604-620`; "not a security boundary" (`packages/smithers/flows/engine-store/src/WorkspaceSandbox.ts:24`) |

**The design, in eight decisions.**

1. **`PACKAGE.ts` stays data.** `S.Package({ targets })` is Bazel's `BUILD` file and needs no Effect wrapper (question 2).
2. **A `Node` is an Effect.** A flow body is plain `Effect.gen`: `yield*` runs a step and waits, `Node.all` runs steps together, `Node.branch` decides on a result. `bindPlanned` and `andThen` are deleted; nothing named `Flow.gen` is added (question 1).
3. **One action per target, implemented by a Layer.** `Target.toLayer(rule, (attrs) => Effect)` implements a rule the way `Action.toLayer` implements an action and an Alchemy provider implements a resource. A rule whose work is several durable steps names a flow. The second executor route and its 67 stubs go.
4. **A sandbox is a Layer.** The host builds `FileSystem`, `ChildProcessSpawner`, `HttpClient` and `Toolchains` from a target's declared reads, writes and network, assembling pieces that exist (`ProcessSandbox`, `WorkspaceSandbox`, the egress). Confinement turns on in Smithers first.
5. **Outputs are typed artifacts.** `lib.outputs.dist` is a value; naming it is the edge, and its digest, not its producer's key, is key material. That is Bazel's provider model and its early cutoff.
6. **The build is a durable flow.** `smthrs build|test|ci` start `build/run`: round 1 loads and plans, round 2 runs one action per target. A laptop, CI on Cloudflare and an agent's branch run one graph with one cache (question 4).
7. **`FACTORY.ts` is the repository's plugin.** It is data with imported flow values, compiled to decision 0017's approved `Plugin.Manifest` and activated by `plugin/refresh`. Triggers are `Trigger.bind({ flow, on, input })` there and in plugins, never on `Flow.make` (question 3).
8. **Remote execution reuses placement.** Phase A runs a whole build on a job container (GitHub-runner parity); phase B runs each action on an executor that stages its input root from the CAS (Bazel remote execution).

**The three biggest calls.**
- **`Node` becomes an Effect (Fable), and `yield*` waits (Opus).** It deletes the continuation-passing boilerplate without inventing a wrapper, and makes a flow body read the way VibeLang code reads.
- **`PACKAGE.ts` stays data (Fable, Sol, Astra; Opus dissented).** The Effect-native part is the implementation side: rules as Layers, sandboxes as Layers.
- **Targets become durable actions with typed artifacts, and confinement turns on first (Opus).** This makes "hermetic" true in Smithers, lets the cache share across machines, and makes CI one graph instead of 15 hand-split jobs.

**Libraries that earn their place** (section 7): the build graph, triggers and events, plugins and activation, external jobs, and a trimmed set of policy patterns. **What gets no library:** CI jobs, a separate definitions engine, Alchemy inside definitions, `Flow.gen`, and generic `Ci.sequence`-style helpers.

**What it deletes.** About 12,800 lines of library source (the second executor route, the per-target engine, the build's private cache, two file models, six patterns that restate engine primitives, `S.Cron`, `S.Factory`, the GitHub YAML renderers once the `ci` flow passes) plus 1,773 lines of generated `ci.yml`. The net new surface is about a dozen names (5.0).

**What happens first.** This week, with no new API: VibeLang's docs become one `S.Generate` target in a root `PACKAGE.ts` (8.1), and confinement turns on in Smithers (slice 1). Section 10 orders the remaining eleven slices, each with a falsifier.

**Questions for Will** (section 11): the flow body model (75%); `PACKAGE.ts` stays data (85%); `FACTORY.ts` is the repository's plugin (80%); the build executor folds into the engine (70%); per-step commit status names (60%).

### 1.2 The whole model

```
AUTHORING: TypeScript in the repository. Data where nothing happens; Effect where something does.
┌────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────────┐ ┌────────────────────────────────┐
│ .smithers/WORKSPACE.ts │ │ <dir>/PACKAGE.ts          │ │ .smithers/flows/<n>/flow.ts   │ │ .smithers/FACTORY.ts           │
│ S.Workspace({          │ │ S.Package({ targets })    │ │ Flow.make(tag, { body:        │ │ .smithers/plugins/<id>/        │
│   toolchains,          │ │ rules:  Target.make       │ │   (p) => Effect.gen(...) })   │ │ Plugin.make({ flows, commands, │
│   platforms, cache })  │ │ impl:   Target.toLayer    │ │ Action.make + .toLayer        │ │   triggers: Trigger.bind(…) }) │
└───────────┬────────────┘ └─────────────┬─────────────┘ └───────────────┬───────────────┘ └───────────────┬────────────────┘
            │ smthrs loads: trusted, on a laptop or in a job container   │ registry reads text            │ projection; lint = drift
            ▼                            ▼                               ▼                                ▼
COMPILED DATA (committed; read without running repository code)
            target-index.json                                    flow descriptors        factory.json, plugin.json (Plugin.Manifest)
                                                                                                          │ plugin/refresh: compare-and-set,
EVENTS                                                                                                    │ tombstones, last-known-good
  cron tick · GitHub webhook · manual · run events ──▶ admission: dedupe, match the base's snapshot, claim ◀┘
                                                                  │ starts a run
                                                                  ▼
ONE ENGINE: @smthrs/plan Node IR → @smthrs/flow journal   (browser OPFS · FlowExecution Durable Object · Node CLI)
  a flow run: body (Effect.gen under Plan) ─▶ Node graph ─▶ actions ─▶ journal
  build/run:  round 1 build/load ─▶ BuildPlan ─▶ round 2 Node.all(targets, { after: deps }) ─▶ one build/<Rule> action each
                                                                  │ each action receives
                                                                  ▼
SANDBOX = a Layer built from the declaration
  FileSystem (WorkspaceSandbox) · ChildProcessSpawner (bubblewrap | strict seatbelt | Docker | container) · HttpClient (egress) · Toolchains
  placed on: a laptop (in place) · a job container (phase A) · an executor with a staged input root (phase B) · a branch box (never cached)
                                                                  │
                                                                  ▼
STORAGE: action cache (@smthrs/step-cache) + CAS (@smthrs/artifacts), local .flows/ and build.smithers.sh /ac + /cas
  key = rule + implementation + attrs + input digests + producers' OUTPUT digests + toolchain identity + network + platform
```

## 2. The Bazel model, and how we copy it

Smithers' build package says it outright: smithers build is "a Bazel-style build orchestrator for TypeScript workspaces" (`packages/smithers/build/README.md:9-10`). Bazel's core is five ideas. A **label** names one target. A **rule** turns attrs into **actions** with declared inputs and outputs. Actions run **sandboxed**, so an undeclared input can't leak in. A **content-addressed cache**, keyed on everything that can change an output, replays results anywhere. **Remote execution** ships an action and its input root to another machine. Query, affected, toolchains and visibility serve those five.

### 2.1 Concept by concept

| Bazel concept | Ours today (file:line) | In the proposal | Divergence, and why |
|---|---|---|---|
| `MODULE.bazel` / `WORKSPACE` | `S.Workspace(name, {...})` in `.smithers/WORKSPACE.ts`; loaded first (`B/Cli.ts:383-389`); exactly one `Workspace` export (`B/WorkspaceLoader.ts:25-79`); `.smithers/` first, root file as fallback (`B/PackageDiscovery.ts:112-127`) | unchanged; gains `platforms` | Toolchains are values declared once, not repository rules fetched from a registry. No bzlmod |
| `BUILD` file | `PACKAGE.ts` exporting `S.Package({ targets })` (`T/Package.ts:96-162`); 122 files, 92 outside test fixtures | unchanged | Loading is TypeScript, not Starlark: purity is a checked rule (no load-time reads) instead of a language guarantee |
| Label `//pkg:name` | the package path plus the map key, "the only source of target labels" (`T/Package.ts:2-3`; `B/Label.ts`) | unchanged | none |
| Visibility | "Omission from the map is the entire privacy mechanism" (`T/Package.ts:7-8`) | unchanged | Coarser than Bazel's lists; nobody has asked for finer |
| Rule | `Target.make(id, options)` (`T/Target.ts:1397`; options `:831-884`) | widened; implemented by `Target.toLayer` | Alchemy's provider-as-Layer. A third party adds a rule through the same public interface (PLUGIN-1) |
| Macro | plain functions: `BuildAndCheckTypeScriptPackage` (57 packages), `SdkRules` | unchanged | none |
| `srcs`, `deps`, `data` | per-rule Schema attrs; the attr walk turns targets into edges and inputs into key material (`T/Target.ts:886-944`) | plus `Artifact` values | JavaScript references instead of label strings: a typo is a compile error |
| Action | the `Exec` action for "flow body" rules; native spawns and a 70-case switch for the rest (`BI/PackageRunner.ts:2108-3130`) | exactly one durable action per target, or one child flow | One action per target keeps the graph and the cache one to one; macros make more targets |
| Providers (`DefaultInfo`) | none: "smithers build has no output-file model yet" (`T/Filegroup.ts:33-34`); a consumer gets every transitive dependency's `outDirs` (`BI/PackageRunner.ts:164-183`) | `target.outputs` is a record of typed `Artifact`s | Files only now; metadata providers wait for a second consumer |
| depset | `Filegroup`'s transitive union | unchanged | none |
| Analysis vs execution | plan (`BI/PackagePlanner.ts`) vs run (`BI/PackageRunner.ts`); `Target.plan` lowers a body (`T/Target.ts:414-440`) | round 1 (`build/load`) and round 2 (`build/execute`) of one durable flow | One IR for builds and flows (FLOW-2) |
| Sandboxing | bubblewrap, seatbelt, Docker (`PS:918-1207`); fail closed when unenforceable (`T/Exec.ts:1374-1384`); Smithers opts out (`.smithers/WORKSPACE.ts:62-69`) | on by default; strict seatbelt; an opt-out carries a reason | Bazel sandboxes by default; so will we |
| Execroot | none: tools run in place under a path allowlist (`BI/PackageRunner.ts:125-236`) | in place locally; a staged input root remotely | Staging `node_modules` per local action costs time and changes nothing in the key |
| Action cache and CAS | local result store and local CAS; remote `/ac` only; the server's `/cas` is never called (`B/Cache.ts:1306-1429`; `B/PackageTree.ts:1621-1622`; `packages/smithers/build/infra/worker/protocol.ts:1709`) | `@smthrs/step-cache` (AC) and `@smthrs/artifacts` (CAS), local and remote | Bazel's split, completed |
| Remote execution | none for builds; flows have `Placement` (`P/Placement.ts`) and `Hosts` (`packages/smithers/flows/engine/src/Hosts.ts`) | phase A: a job container per build; phase B: an executor per action | Reuses flow placement; no gRPC REAPI server |
| Toolchains and platforms | `S.Runtime`, `S.PackageManager`, `S.Rust.Toolchain`, `S.Nix.Environment`; `workspaceAttrs` (`T/Target.ts:841-843`) | complete toolchain identity in the key; named `platforms` | We key measured bytes and image digests; no constraint resolution |
| Tags | `manual` (`T/Target.ts:874`), `exclusive` (`:55-64`), `cache`, `sandbox: "none"`, `sandbox.network` | same, plus `S.Sandbox.None({ reason })` | same meanings |
| `bazel query`, `aquery` | `smthrs query` deps, rdeps, owners (`B/Cli.ts:403-475`); `explain` prints `keyInputs` and `remote: "not-probed"` (`B/Cli.ts:1215-1217`) | `explain` prints the full key material and its first difference from the stored key | aquery's job |
| `bazel-diff` | `smthrs affected` (`B/Affected.ts`) | unchanged; trigger path filters call it | Bazel has none built in |
| `genrule` + `write_source_files` + `diff_test` | `S.Generate`: writes under `run`, drift-checks under `lint` (`T/Compose.ts:158-185`, `:938`) | gains a `flow` selector | none |
| Stamping | resolved just before spawn, never keyed (`B/StampExec.ts:1-5`) | unchanged | same as Bazel |
| Aspects | none; cross-cutting rules are macros (`SdkRules`, `SecurityReview`) | none | No consumer needs them |
| External repositories | `Install`, `Cargo.Fetch`, `Go.ModDownload` targets; `Repo.Target` into a child workspace (`T/RepoTarget.ts`) | unchanged | ordinary targets, not a separate phase |
| `.bazelrc --config` | workspace `flags` (`T/WorkspaceDeclaration.ts:150-165`) | unchanged; plus Effect `Config` | none |
| Build Event Protocol | `--results-file` JSON (`.github/workflows/ci.yml:126-132`) | the run journal and the run page | a durable journal instead of an event stream |
| Hermetic loading | "Target calls perform no filesystem reads and start no processes" (`packages/smithers/build/targets/README.md:7-11`), contradicted by the root `PACKAGE.ts:12`, `:21-34` and `.smithers/flows/PACKAGE.ts:486-497` | lazy `//` globs; no load-time reads; a lint rule | Effect can't make TypeScript pure; the lint and the realm do |

### 2.2 What we copy, adapt and refuse, in one list

**Copied as Bazel has it.**
- A label names one target; patterns select subtrees; the label is the package path plus the map key, never a `name` attribute.
- A rule turns validated attrs into work with declared inputs and outputs; a macro is a plain function that returns targets.
- Content-addressed caching keyed on everything that can change an output, split into an action cache and a CAS.
- Fail closed: no key, no cache; no enforcement, no sharing.
- `manual` and `exclusive` tags with Bazel's meanings.
- `genrule` plus `write_source_files` plus `diff_test` as one rule: `S.Generate` writes under `run` and fails on drift under `lint`.
- Stamping resolved after the key, so a version string never misses the cache.

**Copied, then adapted.**
- **Providers become typed artifacts.** `target.outputs.dist` is a value; putting it in another target's attrs is the edge and its digest is key material (early cutoff). Bazel's provider registry and metadata structs wait for a second consumer.
- **Loading is TypeScript, not Starlark.** A declaration is trusted repository code evaluated by `smthrs`. Purity is a rule we check (no load-time reads, lazy globs) instead of a language guarantee. On Cloudflare a declaration never loads inside the Worker.
- **One action per target.** Bazel lets a rule register many actions. Here a target is exactly one durable action, or one child flow when its work is several durable steps. Macros make more targets when more granularity is needed. The graph and the cache stay one to one.
- **Toolchains are declared once per workspace and keyed by measured bytes**, not resolved per platform by constraints. Remotely, the container image digest is the toolchain.
- **Execroot only remotely.** Locally a tool runs in the real tree under bubblewrap or strict seatbelt, which hides every undeclared workspace path. Remote executors stage an input root from the CAS. The key is identical in both places.
- **Remote execution reuses flow placement** (`Placement`, `Hosts`), not a gRPC REAPI server.
- **CI is one build over `//...`**, as Bazel teaches, but started by a trigger and journaled as a run.

**Deliberately not copied.**
- Starlark and its sandboxed loading phase. TypeScript plus Effect is the authoring language; VibeLang removes the boilerplate later.
- Bazel's REAPI wire protocol. A later adapter can add it; nobody needs it now.
- Aspects, bzlmod, visibility lists, and configuration transitions. No consumer has asked; macros and package exports cover today's needs.
- A separate external-repository fetch phase. `Install`, `Cargo.Fetch` and `Go.ModDownload` are ordinary targets.

### 2.3 What Bazel doesn't have, and we add

A durable journal per run, so a crashed `smthrs ci` resumes; triggers (cron, GitHub events, manual dispatch, other runs' events); a person's approval as a step (`HumanTask`); model steps whose nondeterministic results are sealed in the journal and never shared through the cache; plugins that add rules, flows and triggers through one public interface (PLUGIN-1); and placement on a person's browser.

### 2.4 What we take from Alchemy, and what we refuse

We use Alchemy 2.0.0-beta.83, which is Effect-native. `A/` below is `node_modules/.pnpm/alchemy@2.0.0-beta.83…/node_modules/alchemy/src/`.

| Alchemy idea | Where | Smithers |
|---|---|---|
| Resources are values; reading an attribute returns an `Output`, and the planner derives edges from those references | `A/Output.ts:708-755`; `A/Plan.ts:387-394`, `:1068-1102` | A target's attrs reference other targets and artifacts; the attr walk derives edges (`T/Target.ts:886-944`). A trigger references an imported flow |
| A logical id per resource; the fully qualified name is namespace plus id | `A/FQN.ts:50-54` | Labels `//pkg:key`; plugin contribution ids `<plugin>/<key>` |
| A provider is a Layer with `reconcile` and `delete` | `A/Provider.ts:72`, `:327-364` | A rule is implemented by a Layer (`Target.toLayer`), as an action is (`Action.toLayer`) |
| Plan is a dry-run apply; each resource diffs to noop, update or replace | `A/Cli/commands/deploy.ts:289-290`; `A/Diff.ts:10-35` | `smthrs definitions plan` diffs the compiled manifest against a stage's active snapshot |
| State keyed by stack, stage and name | `A/State/State.ts:29-129` | Installation snapshots per repository and stage (0017 §10): SQLite locally, Postgres on Smithers cloud |
| A stack is one Effect program | `apps/mvp/alchemy.run.ts:59-91` | Not taken for declarations (row 3 of section 12); taken for implementations, which are Effects |

**Refused.**
- **First declaration wins on a duplicate id.** Alchemy returns the existing resource and ignores the second's props (`A/Resource.ts:349-376`, "TODO(sam): check if props are different and die"). Our declarations are maps, so a duplicate id can't be written.
- **Secret values in state.** Alchemy's local state persists a `Redacted` value in clear under `__redacted__` (`A/State/StateEncoding.ts:81-84`). Our state and manifests hold secret names only (ARCH-16).
- **Keys from `JSON.stringify`.** `Alchemy.Action` re-runs when `sha256(JSON.stringify(input))` changes (`A/Util/sha256.ts:15-22`), which skips the body's code and doesn't sort keys. `ChatMigrations` hashes migration *file names* (`apps/mvp/infra/ChatDatabase.ts:25-29`), so an edited migration doesn't re-run. Our keys hash content through an injective encoding.
- **Alchemy itself in definitions.** `apps/mvp/docs/rules.md:173-174` confines `alchemy` imports to the Worker entries, `alchemy.run.ts` and `infra/`. Alchemy deploys our infrastructure; it is not a second flow engine.

## 3. Today's system, explained

### 3.1 Four kinds of definition file

```
.smithers/WORKSPACE.ts      export const Workspace = S.Workspace("smithers", { runtime, packageManager, toolchains, cache, sandboxes, repos, … })
  loaded first, alone        (B/Cli.ts:383-389; B/WorkspaceLoader.ts:25-79: exactly one export named Workspace)
  found at .smithers/ first, root WORKSPACE.ts as fallback (B/PackageDiscovery.ts:112-127); Smithers has no root file
        │ bounds discovery: cache directory, child repositories, prune list
        ▼
<dir>/PACKAGE.ts × 122      export const Package = S.Package({ targets: { lib, test, … } })
  (92 outside test fixtures) found by an ignore-blind walk; one module instance per file; labels //dir:key
        ▼
.smithers/FACTORY.ts        export const factory = S.Factory({ flows, on, github }); export const home = S.Factory.Home(...)
  projected to .smithers/factory.json and home.json by //:factoryProjection (FACTORY.ts:6-8)
        ▼
.smithers/flows/<name>/flow.ts × 53, flow.mdx × 31     export default Flow.make("<tag>", { … })
  discovered from source text, never imported (packages/smithers/agent/registry/src/Discovery.ts:62)
```

### 3.2 How a target declares inputs, outputs, toolchain and environment

A rule is `Target.make(id, options)` (`T/Target.ts:1397`; options at `:831-884`): `attrs` (an Effect Schema), `kinds`, `workspaceAttrs`, `success`, `error`, `implementation`, `inputs`, `outputs`, `cache`, `hosts`, `manual`, `verbGate`, `attrsForKind`. Calling the rule with attrs validates them, walks them for edges and inputs, and freezes the target's metadata. A concrete declaration, from the package that defines flows:

```ts
// packages/smithers/flows/flow/PACKAGE.ts (abridged)
const lib = Smithers.TsBuild({
  srcs: [sources],                                    // a glob: expanded and digested at plan time
  entries: [Smithers.file("src/index.ts")],
  deps: [plan, crypto, keys, canonical, capability],   // targets: dependency edges; their keys enter this key
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },   // the program is a declared file
  format: "dual", outDir: "dist", cwd                  // outDir is a declared output root
})
const test = Smithers.Vitest({ tests: [tests], sources: [sources, examples], deps: [lib, plan, crypto, keys, canonical, capability], config: Smithers.file("vitest.config.ts"), environment: "node", passWithNoTests: false, cwd })
```

- **Inputs** are inert values: `File`, `Glob`, `GitDiff`, `PnpmWorkspace`. "Constructors in this module only create values, so declaration evaluation remains pure" (`T/Input.ts:1-7`). A `//` prefix anchors a path at the workspace root; otherwise it is package-relative (`T/Input.ts:356-387`).
- **Outputs** are `DeclaredOutputs { cwd, paths }`, validated when the target is built so "an untrusted cache entry must never get to choose which paths are verified" (`T/Target.ts:80`, `:87`, `:159-196`).
- **The toolchain is never spelled in a package.** A rule names `workspaceAttrs: ["packageManager", "runtime"]` and the planner fills them from `WORKSPACE.ts` (`T/Target.ts:841-843`).
- **The environment** can be a Nix closure (`S.Nix.Environment({ flake })`, `.smithers/WORKSPACE.ts:24`).
- **Secrets are names.** A tool receives an unguessable per-run placeholder, and a loopback proxy swaps in the value only while building a request for one of the secret's origins (`T/Secret.ts:10-19`; `T/SecretProxy.ts`, 957 lines).
- **The cache is opt-in.** `cache` defaults to false: "A target opts in only after its implementation has a complete deterministic input contract" (`T/Target.ts:858-864`).

### 3.3 How file dependencies pass between targets

The attr walk does all of it (`T/Target.ts:886-944`): every `Target` value anywhere in attrs is a dependency, every `DependencySelector` is a subtree edge, and every declared input is key material. Proxies and accessors are refused, so nobody can key one value and run another.

```
                  ┌─ key ─────────────▶ consumer's key material   (B/Planner.ts:816-820: a target in attrs becomes {_tag:"Target", key})
producer target ──┤
                  └─ outDirs/outFiles ─▶ consumer's sandbox read set (BI/PackageRunner.ts:164-183, every transitive dependency)
Filegroup ───────── source rows ───────▶ consumer's read set and key
```

Two facts follow:

1. **There is no output model.** `Filegroup` says so: "smithers build has no output-file model yet" (`T/Filegroup.ts:33-34`). A consumer gets a producer's files by sandbox side effect, and it gets every transitive dependency's, not the one it needs.
2. **A dependency keys by its action key, not its output.** Three rules key on content instead (`ImportClosure`, `Cargo.Fetch`, a bundler resolve; the runner swaps settled keys at `BI/PackageRunner.ts:2068-2094`). Everywhere else, a comment-only edit upstream rebuilds everything downstream:

```
today:   tanstackDb.lib ──key k1──▶ effect-electric.lib key = H(…, k1, …)
         a comment edit in tanstack-db/src changes k1 → effect-electric rebuilds even if dist/ is byte-identical
Bazel:   tanstackDb.lib ──outputs (digest d1)──▶ effect-electric.lib key = H(…, d1, …)
         same dist/ bytes → d1 unchanged → cache hit ("early cutoff")
```

Dependencies arrive four ways: importing another package and reading a target (`deps: [tanstackDb.lib]`, `packages/effect-electric/PACKAGE.ts:9-13`); a subtree selector, used to dodge import cycles; a `//`-rooted file input; and a label string in a CI step.

### 3.4 How actions run in sandboxes that contain only what they declared

**What a target declares.** Its `sandbox` attr: closed network by default, `{ network: true | "loopback" }`, or `"none"`. The workspace picks the mechanism: `S.Sandbox.Bubblewrap`, `Docker`, `Microsandbox` or `None` (`T/WorkspaceDeclaration.ts:274-282`, `:329-372`). With no declaration "the platform decides: bubblewrap on Linux, seatbelt on macOS, and a refusal elsewhere" (`T/ExecSandbox.ts:235-239`).

**What the sandbox contains.** `sandboxRequest` builds it (`BI/PackageRunner.ts:125-236`):

```
reads  = package manager files + the package directory + every expanded declared input
       + outDirs/outFiles of every transitive dependency (:164-183) + every node_modules above cwd (:184-193)
       + the cache's scratch and store + host runtime trees (/usr, /bin, /nix/store, Xcode, …)
writes = the cache directory + declared outputs + clean outputs + the write set (`changes`) + Cargo's target/
env    = an allowlist (PATH, HOME, SDKROOT, DEVELOPER_DIR, CI, …, T/Exec.ts:479-497) + declared env; secrets as placeholders
```

**How it's enforced** (`PS` = `packages/smithers/flows/platform-node/src/ProcessSandbox.ts`):
- **Linux:** bubblewrap hides the workspace and binds back only declared paths, so an undeclared read is `ENOENT` (`PS:918-1007`).
- **macOS:** seatbelt starts from `(allow default)` because builds never set `strict`, then denies file reads and writes outside the declared sets (`PS:1040`, `:1075`, `:1084`).
- **Docker:** read-only root, declared mounts, `--network none` or bridge (`PS:1166-1207`).
- **Undeclared writes** are reverted and fail the run for write-mode rules: `Generate`, `Shell.Diff`, `Go.Lint`, `Foundry.Fmt`, `Cargo.*`, agent candidates (`BI/PackageRunner.ts:1182-1317`).
- **Fail closed where declared.** An unenforceable mechanism is `sandbox_unenforceable` (`T/Exec.ts:1374-1384`); Docker with secrets, and a closed network with secrets, are refused (`:1386-1415`).

**Smithers turns it off.** `.smithers/WORKSPACE.ts:62-69` declares `default: S.Sandbox.None()` because "the fail-closed Nix resolver would refuse every host without `nix` on PATH". The chain that follows:

```
.smithers/WORKSPACE.ts:67      default: S.Sandbox.None()
BI/PackageRunner.ts:229        every target's mechanism = workspace.sandboxes["default"]
T/ExecSandbox.ts:251           SandboxNone selects { _tag: "none" }
T/ExecSandbox.ts:297-300       enforceable(...) is false for "none"
BI/PackageRunner.ts:662-676    publishable(node) is false → store.put(..., { shared: false })
CACHE-TRUST.md:83-85           "No job publishes today: … no result is shareable while every target runs unsandboxed."
```

So in Smithers today "hermetic" describes a capability the flagship repository has switched off, and no Smithers build result reaches the remote cache. Tevm confines by default with bubblewrap (`~/tevm-monorepo/WORKSPACE.ts:86`).

**What "only what they declared" means for flows.** A flow action can declare a `fileBoundary` (`F/Action/FileBoundary.ts:26-58`). On the Node runtime, `@smthrs/engine-store` runs it against "an isolated workspace seeded with exactly its declared read set", with writes as a diff that reaches the host only through an explicit materialize step (`packages/smithers/flows/engine-store/src/WorkspaceSandbox.ts:6-9`). It is "a deterministic transaction model, not a security boundary" (`:24`): a spawned process escapes it. The Node runtime wires it (`packages/smithers/flows/platform-node/src/NativeRuntime.ts:21`, `:202`); the Cloudflare runtime provides `WorkspaceSandbox.layerUnsupported` (`packages/smithers/flows/platform-cloudflare/src/CloudflareRuntime.ts:65-66`), and no `apps/mvp` production code uses it. On those hosts the boundary is only key material (`packages/smithers/flows/engine/src/FlowEngine/ActionKey.ts:33-35`, `:144-157`).

**The old JSX `<Sandbox>` never had declared inputs.** Its request bundle was one `README.md` holding `{ status, sandboxId, provider, runtime, input }` plus egress certificate files (`186e86d85b96:packages/sandbox/src/execute.js:604-620`). Its props named host `volumes` and a named `workspace` snapshot (`186e86d85b96:packages/components/src/components/SandboxProps.ts:34`, `:38`), never a digested file set; files came back as a reviewed diff bundle (`186e86d85b96:docs/components/sandbox.mdx:229-231`). Declared, digested inputs that a process can't read past exist only on the `PACKAGE.ts` path.

### 3.5 Caching and content identity, and when caching is refused

```
key = sha256("smithers-build-key/1\0" + injective({                      (BI/PackagePlanner.ts:2977-3019)
  body:   flow tag, rule, schema identity, mode (write | check), cwd, declared outputs, format versions,
  inputs: ambient { node version, platform, arch, lockfile digest, toolchain manifests, a digest of the build system's own sources },
          attrs (a target → its key, an input → its digest), expanded input rows, dependency { label, key },
          tool identities (bytes + shebang chain, BI/PackagePlanner.ts:565-640), environment digest, overlays, repository state,
  layers: [],                ← BI/PackagePlanner.ts:3017; B/Planner.ts:76-80 documents a "nix:<hash>" layer that NixExec.layer
                               (B/NixExec.ts:467) would produce, but nothing calls it
  capabilities: what the rule may do }))
```

**Refused (fail closed):** a rule that didn't opt in; a planned write (`BI/PackagePlanner.ts:2882-2893`); a tool that can't be identified; a tool whose bytes changed since planning, checked before every store (`BI/PackageRunner.ts:434`, `:678-700`); a malformed entry; a declared output missing on a hit; an outward effect: "**Never cached.** An outward effect has no result to replay: the second invocation is a second publish" (`T/Outward.ts:8-10`).

**Open:** every undeclared inherited variable is keyed by presence, not value (`BI/PackagePlanner.ts:2904-2911`); the sandbox mechanism isn't keyed, so an unconfined local result satisfies a confined lookup; declared inputs are not re-digested before a store, so an edit made during the run is stored under the stale key (`BI/PackageRunner.ts:678-700`).

**Stores.**

```
<cache>/cache/…           result records { key, target, label, exitOk, output }    (B/Cache.ts:462-470)
<cache>/cas/<sha256>      output blobs, local only                                (B/PackageTree.ts:1621-1622)
remote GET/PUT /ac/{key}  results; read-through on a local miss                   (B/Cache.ts:1306-1429)
server /cas, findMissing  exist (packages/smithers/build/infra/worker/protocol.ts:1643-1655, :1709); the CLI never calls them
```

So even a published result would miss on another machine for any target with output files: its blobs never leave the first one.

### 3.6 Planning and running: two routes, neither durable

```
smthrs build|test|lint|docs|run|review|ci <patterns>
  ▼ plan: select roots by verb and pattern; visit deps → inputs → tools → argv → sandbox → cacheable → key
  ▼ Executor.scheduleEffect: dependency-first, bounded, keep-going      (B/Executor.ts:276-360; ends in Effect.runPromise at :400)
  ├── native rule (NativeRules.get)  → spawned directly                 (BI/PackageRunner.ts:2108-2122; BI/CoreRuleSelection.ts)
  ├── in-runner rule                 → a 70-case switch                 (BI/PackageRunner.ts:2123-3130)
  └── "flow body" rule               → Flow.make(tag, { body: () => Target.plan(t) }) on FlowEngine.layerMemory,
                                        one fresh in-memory engine per target   (B/TargetExecution.ts:48-111)
```

About half the catalog's rules run on each route (`packages/smithers/build/targets/docs/rules.md`, its route column); a package-executor rule plans "a typed NotImplemented refusal" when lowered by `Target.plan` (`T/Target.ts:414-440`), which is why 67 `notImplemented(` calls exist in `T/`. Neither route is durable: a crashed `smthrs ci` starts over from the cache, and a target run leaves no journal for the app's run page. The build core is Promise code with Effect escapes (`BI/PackagePlanner.ts`: 3,745 lines, `Effect.runPromise` at `:2717`; `B/Cache.ts`: 1,492 lines).

### 3.7 Verbs, `affected`, `query`, ImportRules, Jev rubrics, docs and generated files

- **Verbs** are `build | test | lint | run | docs | review`; `ci` plans lint, build, test and docs over one graph; `run` and `review` never join `ci`.
- **`affected`** treats root files, `.smithers/**`, any `PACKAGE.ts`, lockfiles and the build system's sources as global, runs everything when a changed path is global or unowned, and always selects uncacheable targets (`B/Affected.ts:102-104`, `:231-244`, `:265-271`). It shells out to `git` for changed paths (`:51-91`), which the jj-only rule makes a migration item.
- **`query`** answers labels, `deps`, `rdeps` and `owners` (`B/Cli.ts:403-475`). `explain` prints `keyInputs` and `remote: "not-probed"` (`B/Cli.ts:1215-1217`), not the full key.
- **ImportRules** is a macro in `@smthrs/repo-targets`: a `NodeTest` that reads imports with the TypeScript compiler API (`packages/repo-targets/src/ImportRules.ts:91-107`). `SdkRules` packages the SDK's rules.
- **Jev rubrics** (`T/JevLint.ts:1-12`): one yes-or-no question per rule per file, a threshold, manual by default, never cached (`:549-557`). `apps/mvp/PACKAGE.ts` holds the app's rules, catalogued in `apps/mvp/docs/rules.md`.
- **`smthrs docs //pkg:docs`** runs `DocsParity` (a README title and a 120-character prose floor, `T/DocsParity.ts:1-9`, `:31`) and `Docs.Check`, a freshness stamp over inputs (`T/DocsCheck.ts:1-26`). `Docs.Page` is the attended, model-written rule.
- **Generated files.** `S.Generate` has four selectors (`emit`, `script`, `bin`, `command`), `data` and `changes`; it writes under `run` and checks drift under `lint` (`T/Compose.ts:158-185`, `:938`). The root `projectCopy` is the pattern FLOW-9 names: one data file, one `S.Generate` target (`PACKAGE.ts:218-230`). `.smithers/target-index.json` (1,273 targets, 301 cacheable) is committed and drift-checked because smithers.sh reads it signed out (`PACKAGE.ts:281-285`).
- **Load-time I/O exists despite the rule.** The targets README says "Target calls perform no filesystem reads and start no processes" (`packages/smithers/build/targets/README.md:7-11`). The root `PACKAGE.ts` globs at load (`:21-34`) and imports `project.json` (`:12`); `.smithers/flows/PACKAGE.ts` walks directories (`:3`, `:7`, `:486-497`).
- **`@smthrs/targets` isn't platform-neutral.** 33 of its files import `node:*`, a known violation (`docs/libraries.md:158`).

### 3.8 Flows, hosts and machines

`Flow.make(tag, { description, capabilities, effects, modelInvocable, payload, success, error, body | prompt, maxRounds, deadline, budget })` (`F/Flow/make.ts:35-120`). The body is "the pure plan-time body", `(payload) => Node` (`:124-135`); "the code that does the work attaches separately, as an Effect layer" (`packages/smithers/flows/flow/README.md:13-15`). A prompt flow lowers to one action (`F/Flow/make.ts:257-273`). `budget` is accepted and then dropped (`:95-100`, `:275-296`). `Action.make` declares a step with `payload`, `success`, `error`, `implementationVersion`, `tier`, `idempotencyKey`, `retryPolicy`, `attemptTimeoutMs`, `heartbeatTimeoutMs` and `fileBoundary` (`F/Action/make.ts:79-147`); `.call` records a node and `.toLayer` implements it (`F/Action/Action.ts:160-162`, `:190-208`).

```
body(payload) ─▶ Node (all :336, map :464, andThen :485, bindPlanned :523, branch :606, catch :655, capture :971)   P/Node.ts
             ─▶ Graph.build ─▶ Plan { nodes: { id, key, material, effects, dependsOn, conflicts, priority } }   P/Plan.ts:154-166
             ─▶ engine: journal, step cache, durable waits (DurableClock, WaitFor, Poll, ExternalJob, HumanTask)
                rounds: Done, To, Park (F/Flow/Outcome.ts:87-145) under maxRounds
```

The body is continuation passing: `Node.bindPlanned(node, build)` hands `build` a reference, and the release flow types its requirement union by hand (`.smithers/flows/release/flow.ts:22-36`, `bindPlanned` at `:47`, `:57-58`, `:89-95`). A `Planned` is "a placeholder … [that] does not exist yet"; `Boolean()` and `===` on it can't be trapped, so a run-time decision is `Node.branch` (`P/Planned.ts:3-8`, `:18-22`). `Node.all` takes no concurrency option; the plan scheduler has a plan-wide admission bound (`P/Scheduling.ts:105-109`) and every plan node carries `dependsOn` (`P/Plan.ts:160`).

| Host | What runs there |
|---|---|
| Browser engine: the leader tab's worker, SQLite on OPFS (decision 0011) | every client flow, the agent included (`M/src/flows/engine.worker.ts:15-41`) |
| `FlowExecution` Durable Object, one per execution, Postgres through Hyperdrive | 18 server flows merged by hand into one list (`M/worker/ExecutionHost.ts:44-164`); child flows route to their own objects (`packages/smithers/flows/platform-cloudflare/src/ExecutionObject.ts:539-546`), so `M/docs/features/remote-flows.md:95` is stale |
| Node CLI | `smthrs flow start`; the build executor's per-target memory engines |
| Branch sandbox container | tool calls only, never flow code (`M/worker/flows/TodoAgent.ts:16-20`); a Debian image with bash, git, less and tmux (`M/infra/sandbox/Dockerfile:8-10`); `sandbox/run` is capped at 600 s and 64 KiB per stream (`M/docs/features/sandbox-tools.md:19`) |
| QuickJS realm | the agent's cells and views; repository flow code is 0017 slice 5 (`0017-everything-is-a-plugin.md:733`) |

Three sandbox tiers already exist in the SDK:
1. **Capability decoration.** `@smthrs/kernel` decorates `FileSystem`, `Path`, `ChildProcessSpawner`, `HttpClient` and `Jj` in place, so every side effect is checked against the run's ceiling (`packages/smithers/flows/kernel/README.md:11-16`).
2. **Workspace transactions.** `WorkspaceSandbox` (3.4), on Node.
3. **Code on a machine.** `SandboxedFlow` bundles a child flow and runs it in a guest (`packages/smithers/flows/platform-node/src/SandboxedFlow.ts:1-16`); `Sandbox.layerHost` provides `FileSystem`, `Path` and `ChildProcessSpawner` backed by a sandbox session (`packages/smithers/flows/sandbox/src/Sandbox/layerHost.ts:70-117`). Its only caller outside tests is an example (`packages/smithers/flows/examples/41-sandboxed-flow.ts`).

Repository flows aren't discovered or run by the app yet (`M/docs/features/flows.md:202`).

### 3.9 Triggers and the factory

Three carriers, no runner:

| Carrier | What it is | Who applies it |
|---|---|---|
| `S.Cron({ schedule, run })` in a `PACKAGE.ts` | an inert record (`T/CronTarget.ts:15-31`) | the GitHub renderer turns it into an `on: schedule` workflow (`B/GithubRender.ts:817-850`). No `PACKAGE.ts` uses it |
| `.smithers/FACTORY.ts`'s `on` table: `"schedule:0 2 * * *": { flow: "security-audit" }`, `"issue.labeled:todo": …` | strings (`FACTORY.ts:63-89`), "never a live registration" (`:58`). Flows are named by string (`S.Flow({ flow: "review" })`, `:19-48`) | nothing. Five strings name flows absent from `factory.json`'s 83: `improve.suggest`, `issue.implement`, `prs.triage`, `wiki.ask`, `triggers.register`. `apps/mvp` reads `home.json` (`M/src/features/home/actions.ts:29`) and never `factory.json` |
| `@smthrs/triggers` | a real claim-once scheduler: `Trigger` (`src/Trigger.ts:59-65`), overlap `skip | buffer-one | supersede` and catch-up `none | one | all` (`src/Schedule.ts:20-76`), claim key `${triggerId}:${occurrence}` (`src/Scheduler.ts:439-440`), `SqlTriggerStore`, `Webhook.make`. Its `flowId` is a string: "This package never resolves it" (`docs/api.md:66`). `Scheduler.layer` forks a forever loop (`src/Scheduler.ts:1124-1146`) | `smthrs triggers register`; the app doesn't run it: "a cron replaces that trigger once `@smthrs/triggers` runs on the Cloudflare host" (`M/worker/github/Reconcile.ts:19-20`) |

The webhook route verifies GitHub deliveries and serves one synced repository (`M/worker/github/Config.ts:5-7`): issue and pull request events start `github/Apply`, an opened issue starts `triage/Run`, and a push to the default branch becomes a notification (`M/worker/Notifications.ts:268`). Pull request checks (`checks/Run`) run `.smithers/checks/<name>.sh` on a TODO attempt's machine, and "Checks never gate the merge" (`M/worker/flows/Checks.ts:34-35`). No code writes a GitHub commit status; `@smthrs/integrations` exports a `CheckRun` writer (`packages/smithers/agent/integrations/src/github/Actions.ts:513-539`) that the app's rules ban (`M/docs/rules.md:436-443`).

### 3.10 The old APIs, from the jj history

Read with `jj --ignore-working-copy file show`. Revisions: `186e86d85b96` (last full JSX tree), `2716e9855855` ("phase1: remove the superseded JSX/reconciler execution architecture"), `378c182a752f` ("phase2: import the Smithers Flows workspace wholesale"), `47856c851f8f` and `47ea32cbd86d` (targets move into `PACKAGE.ts` modules exporting one `Package`), `f860e80c0c3e` ("integrate declarative rules and safe execution contracts"), `c2f81942dbbb` ("declare the factory in .smithers/FACTORY.ts").

**The JSX `createSmithers` API.** Its surface was React elements over a Bun SQLite handle: `Workflow`, `Task`, `Sequence`, `Parallel`, `Branch`, `Loop`, `Approval`, `Signal`, `Timer`, `Worktree`, `Sandbox`, `MergeQueue` and more, `smithers: (build: (ctx) => React.ReactElement)`, `db: BunSQLiteDatabase` (`186e86d85b96:packages/smithers/src/CreateSmithersApi.ts:36-78`, `:55-59`). "Direct children run sequentially" (`186e86d85b96:docs/components/workflow.mdx:41`). The driver "does not re-execute your workflow code against an event log; it re-*renders* the workflow tree against persisted state" (`docs/capabilities/durability.mdx:39`). A task was agent, compute or static by its children's shape (`docs/components/task.mdx:141-173`); throwing in a compute function failed the task (`:184-185`); dependencies were string ids, and a mismatch was `DEPENDENCY_DEADLOCK` (`:296`). Effect ran underneath: `runEffect(effect) { return this.runtime.runPromise(effect); }` (`packages/driver/src/WorkflowDriver.js:947-949`). A second, builder-style API (`Smithers.workflow`, `G.step`, `docs/effect/overview.mdx:38-63`) compiled to a React tree and ran through `Effect.promise(async () => await Effect.runPromise(…))` (`packages/engine/src/effect/builder.js:1206-1218`): a DSL over a Promise bridge over Effect.

**Why it was removed.** "Hiding Effect requires a new abstraction layer and is not a wholesale import" (`186e86d85b96:PLAN.md:132`); "This migration replaces the old Effect-based Smithers architecture; it does not remove Effect from Smithers" (`:40-41`); "Do not add adapters whose only purpose is to preserve JSX or old engine contracts" (`:70-71`); partial compatibility "will pull the old graph, loader, renderer, and data model back into the new design" (`:141`). The cost showed in the parity audit: a short JSX `<Sequence>` became two `Action.make`s, a `Flow.make` and a `Layer.mergeAll` composition root (`378c182a752f:FEATURE_PARITY_AUDIT.md:82-139`).

**The `PACKAGE.ts` API moved the other way.** At the flows import a target *was* a flow: `Flow.Flow<Id, Attrs, Success, Error, Requires> & { readonly [TargetTypeId]: Metadata }` (`378c182a752f:packages/targets/src/Target.ts:231-239`), and a `PACKAGE.ts` could import `ExecLive`, `WriteFileLive` and the other implementation Layers (`9f972fb873b4:packages/targets/src/Smithers.ts:112-225`). `f860e80c0c3e` deleted every `*Live` export and made targets opaque declarations with an explicit `Target.plan` lowering. Since then confinement, Nix keying, subtree selectors, `S.Flow` and `S.Factory` arrived; nothing hermetic was removed.

| Era | Wrapper (hid or bridged Effect) | Real pattern (kept) |
|---|---|---|
| JSX | React elements and re-rendering; Zod schemas lowered to Drizzle tables; `async` callbacks and thrown errors; Promise round trips around Effect; string `dependsOn` | stable step ids; durable waits (approval, signal, timer); retries and heartbeats; a step placed on a named runtime with a reviewed diff back; children in order by default |
| `PACKAGE.ts` | none: it was data from the start | labels; rules; declared inputs and outputs; content keys; confinement; fail-closed caching; generated files with drift checks |
| `FACTORY.ts` | string flow ids and a string event table that nothing applies | one file for a repository's featured flows, triggers, GitHub policy and home |

**The lesson.** Making targets opaque was right: a declaration is data and its evaluation stays pure. Hiding the Layer seam entirely went one step too far, because it is what forces VibeLang to write a composition root by hand (8.1). This design reopens exactly that door: a rule is implemented by a Layer (`Target.toLayer`), and a generator can be a flow.

### 3.11 The numbers that frame the design

| Measure | Value | Source |
|---|---|---|
| `PACKAGE.ts` files | 122 in Smithers (92 outside test fixtures); 68 in Tevm outside `vendor/` | `find`, excluding `node_modules`, `dist`, `.flows` |
| Targets | 1,273; 301 cacheable, 972 not | `.smithers/target-index.json` |
| Build system source | 78,689 lines (`T/` 40,454; `B/` 38,235) | `wc -l` |
| `ci.yml` | 1,773 lines, 15 jobs, setup rendered into each | `.github/workflows/ci.yml` |
| Flow files | 53 `flow.ts`, 31 `flow.mdx` under `.smithers/flows` | `find` |
| `@smthrs/patterns` | 35 files, 11,481 lines | `packages/smithers/flows/patterns/src` |
| Macro use | `BuildAndCheckTypeScriptPackage` in 57 `PACKAGE.ts` files | `grep` |

## 4. What's wrapper and what's real

FLOW-9's test, applied to every abstraction in scope. Three verdicts:
- **Delete:** it only wraps Effect or the engine to look simpler, or it is a second implementation of something that exists (SDK-11).
- **Keep thin:** a direct, typed use of Effect or the engine; change only what this design needs.
- **Library:** an orchestration pattern Effect doesn't have; it earns its own package (section 7).

A fourth note, **rewrite**, marks code whose behavior stays but whose Promise-and-`node:*` implementation keeps it off Effect and out of the browser.

### 4.1 The build system

| Abstraction | Where | Verdict | Reason |
|---|---|---|---|
| Labels, patterns, discovery, loader, index | `B/Label.ts`, `B/PackageDiscovery.ts`, `B/PackageLoader.ts`, `B/PackageIndex.ts` | **Library** (build graph) | Bazel's addressing; one value, one label. No Effect equivalent |
| `S.Package({ targets })` | `T/Package.ts:96-162` | **Keep thin**, unchanged | It is the `BUILD` file. A generator form would carry no apply-time outputs (section 12, row 3) |
| `S.Workspace(...)` | `T/WorkspaceDeclaration.ts` | **Keep thin**, gains `platforms` | Toolchains, cache, sandboxes, repositories as values |
| `Target.make` | `T/Target.ts:1397` | **Keep thin**, widened | The rule constructor. Gains `implementationVersion`, named `outputs`, `network`, `tier`, `flow`; its implementation moves to `Target.toLayer` |
| `Target.plan`, `notImplemented` (67 calls), `NotImplementedAction` | `T/Target.ts:414-440` | **Delete** | They exist only because half the rules run on another route |
| Native and in-runner rule dispatch | `BI/CoreRuleSelection.ts`; `BI/PackageRunner.ts:2108-3130` | **Delete as a route**; each case moves into its rule's `Target.toLayer` | A second implementation of "run a target"; the bodies stay, the switch goes |
| Per-target memory engine | `B/TargetExecution.ts:48-111` | **Delete** | Wraps each target in a throwaway `Flow.make` on `FlowEngine.layerMemory`; not durable (DUR-1) |
| `Executor.scheduleEffect` | `B/Executor.ts:276-360` (857 lines) | **Delete** | A bounded dependency-first scheduler is what the engine does for `Node.all`; it ends in `Effect.runPromise` (`:400`) |
| Result store and remote client | `B/Cache.ts` (1,492 lines) | **Delete**, fold into `@smthrs/step-cache` and `@smthrs/artifacts` | Two caches for one behavior; step-cache already has a remote store (`docs/libraries.md:229`) |
| `Input.File`, `Input.Glob` | `T/Input.ts:29-32` | **Delete**, use `FileSet` | A second file model beside `@smthrs/plan`'s (`P/FileSet.ts:118-121`) |
| `expandGlob`, `digestFiles`, `SafeFs` | `T/Input.ts`, `T/SafeFs.ts` | **Rewrite** as an Effect service in `@smthrs/platform-node` | The behavior (symlink-safe, ignore-aware digests) is real; the Promise and `node:*` form keeps targets out of the browser (`docs/libraries.md:158`) |
| `PackagePlanner` | `BI/PackagePlanner.ts` (3,745 lines) | **Rewrite** as `build/load`'s implementation | Key derivation and selection are real; the Promise shell and `runPromise` (`:2717`) break SDK-7 |
| `ExecSandbox`, `ProcessSandbox` | `T/ExecSandbox.ts`; `PS` | **Keep thin** | The hermeticity contract; turn strict seatbelt on |
| `Secret`, `HttpSecret`, `SecretProxy` | `T/Secret.ts` (415), `T/SecretProxy.ts` (957) | **Keep the model, delete the copy** | Placeholders plus a loopback proxy are right; `@smthrs/secrets`' `Egress` does the same job for sandboxes (`docs/libraries.md:83`). One library, two hosts (ARCH-16 is one rule) |
| `S.Generate`, `GeneratedFile`, `Docs.Check` | `T/Compose.ts:158-185`, `:986-995`; `T/GeneratedFile.ts`; `T/DocsCheck.ts` | **Library** (build graph) | Bazel's `write_source_files` plus `diff_test`; gains a `flow` selector |
| `affected`, `query`, `TargetIndex`, `TrustedReview`, `KnownRed`, `ServiceSupervisor` | `B/Affected.ts`; `B/Cli.ts:403-475`; `T/TargetIndex.ts`; `B/TrustedReview.ts`; `B/KnownRed.ts`; `B/ServiceSupervisor.ts` | **Library** (build graph) | Real policies: conservative selection, a signed-out index, review from a pinned commit, expiring mutes, scoped services |
| `ImportRules`, `JevLint`, `LlmLint`, `SecurityReview` | `packages/repo-targets/src/ImportRules.ts`; `T/JevLint.ts`; `T/LlmLint.ts`; `T/SecurityReview.ts` | **Library** (rules as targets) | PROC-4 makes every rule a lint rule. `SecurityReview` must stop reading the disk at declaration |
| `Agent.Diff`, `Agent.Lint`, `Agent.Pr`, `Docs.Page` | `T/AgentTarget.ts`; `B/AgentSession.ts` | **Library**, moving to `Target.make({ flow })` | A candidate-and-gate loop inside a confined write set is real; its model calls must become durable steps (DUR-4) |
| `S.Cron` | `T/CronTarget.ts` (43 lines) | **Delete** | An inert record rendered as a GitHub cron; unused |
| `GithubCiGen`, `GithubWorkflow`, `GithubTarget`, `CiToolchain`, `GithubRender` | 5,720 lines | **Delete** once the `ci` flow passes on Smithers | They render GitHub Actions; GH-1 bans Actions except publishing (GH-9) |
| `NpmPublish`, `JsrPublish`, `Changesets.Publish`, `Npm.Publish` | `T/NpmPublish.ts` (91), `T/JsrPublish.ts` (94) | **Delete** | Publishing stays on GitHub Actions (GH-9) |
| `S.Flow`, `S.Factory`'s `on` table, `FlowCatalog` | `T/Flow.ts` (154), `T/Factory.ts`, `T/FlowCatalog.ts` (203) | **Delete**, replaced by `Plugin.make` and `Trigger.bind` | Strings where values belong; "never a live registration" |
| `Home` | `T/Home.ts` (600) | **Delete** | Re-exports `@smthrs/views`' `Home` under old names |
| `Dev` | `T/Dev.ts` (71) | **Delete** | Unused; `Shell.Serve` covers it |
| `workspaceAttrs` | `T/Target.ts:841-843` | **Keep thin** | It works; the rule's Layer also receives `Toolchains` |

### 4.2 The flow engine and its neighbors

| Abstraction | Where | Verdict | Reason |
|---|---|---|---|
| `Flow.make`, `Action.make`, `.call`, `.toLayer` | `F/Flow/make.ts`; `F/Action/make.ts`; `F/Action/Action.ts` | **Keep thin**; `body`'s type widens | Effect Schema payloads, Layer implementations, typed errors |
| `Node` AST, `Planned`, `Plan`, `KeyMaterial`, `Placement` | `P/` | **Keep thin**; `Node` becomes an Effect | The one graph model (FLOW-2) |
| `Node.bindPlanned`, `Node.andThen` | `P/Node.ts:523`, `:485` | **Delete** | Continuation-passing spellings of `Effect.flatMap` and of two `yield*`s |
| `Node.all`, `map`, `branch`, `catch`, `capture` | `P/Node.ts:336`, `:464`, `:606`, `:655`, `:971` | **Keep thin**; `all` gains `concurrency` and `after` | Plan constructs, not Effect wrappers: `branch` is a run-time decision a plan-time `if` can't make |
| `FileBoundary` and `Effects.Declaration` | `F/Action/FileBoundary.ts:26-58`; `P/Effects.ts:147-177` | **Keep thin, merge into one shape** | Two file-boundary shapes in one engine: `readSet`/`writeSet`/`boundaryMode` (`hard`/`expected`) beside `reads`/`writes`/`mode` (`hermetic`/`expected`) |
| `StepBoundary`, `WorkspaceSandbox` | `packages/smithers/flows/engine-store/src/` | **Keep thin**; becomes the in-process half of a target's sandbox | Already seeds an isolated workspace with the declared reads |
| `RetryPolicy`, `DurableClock`, `WaitFor`, `Poll`, `ExternalJob`, `HumanTask`, deadlines | `F/*.ts` | **Library** (durable primitives) | Effect's `Schedule` and fibers die with the process; these survive it |
| `@smthrs/step-cache`, `@smthrs/artifacts` | `docs/libraries.md:229`, `:233` | **Keep thin**; become the build's action cache and CAS | Already content-addressed, local and remote |
| `Sandbox.layerHost`, `SandboxedFlow`, `@smthrs/kernel` decoration | `packages/smithers/flows/sandbox/src/Sandbox/layerHost.ts`; `SandboxedFlow.ts`; `kernel/README.md:11-16` | **Keep thin** | They already make a sandbox a Layer |
| `Interpreter.layerWithImplementations` in repository code | `~/effectscript/.smithers/flows/docs/run.ts:31-39` | **Delete from repositories** | A composition root belongs to the host; a repository never writes one |
| `WithRetry`, `WithCache`, `TryCatchFinally`, `Loop`, `WithApproval`, `Bounded` | `packages/smithers/flows/patterns/src/` (252, 272, 255, 382, 110, 218 lines) | **Delete** | Each restates a primitive (7.5). None is used by `apps/` or `.smithers/`; `WithApproval` has 3 example callers and `Bounded` 17, which migrate to `HumanTask` and `Node.all({ concurrency })` |
| Every pattern's executed `run` form | `packages/smithers/flows/patterns/README.md` | **Delete** | An executed pattern bypasses the journal (DUR-1); keep the declared form |
| `ReviewLoop`, `Escalation`, `Saga`, `MergeQueue`, `Burndown`, `Supervisor`, `Trellis`, `Panel`, `Debate`, `Sidecar`, `Runbook`, `CheckSuite` and the other policy patterns | `packages/smithers/flows/patterns/src/` | **Library** | Each encodes a policy that is domain logic, not syntax |
| `@smthrs/triggers` | `packages/smithers/agent/triggers/` | **Library**, extended | Claim-once occurrences, overlap and catch-up; needs a declaration surface, event sources and a host |
| `@smthrs/plugin` | `packages/smithers/agent/plugin/` | **Library**, extended with `Plugin.make` | 0017's one interface |
| Hand-merged server flow list | `M/worker/ExecutionHost.ts:44-164` | **Delete** | Replaced by the registry 0017 slice 5 builds from manifests |
| The parity proposal's `CiJob` | `M/docs/proposals/ci-cd-parity.md:289-305` | **Don't add** | A job is a `build/run` placed on a machine (7.7) |
| `.smithers/flows/automation/run-module.ts` | a flow action spawning a module | **Delete** after slice 6 | A bridge from a flow to a script because a flow couldn't call a target |

### 4.3 The old JSX API, for the record

Already deleted and staying deleted: the React tree and re-render loop, Zod-to-Drizzle outputs, Promise callbacks, callback cache keys, string `needs`, the builder DSL over a Promise bridge. Real and already carried forward: stable step ids, retries and heartbeats, approvals, signals, timers, compensation, the reviewed sandbox boundary (now `SandboxedFlow`). Real and still owed: "children run in order", which section 5.1 restores as `yield*`, and a step's declared machine, which `platforms` and `placement` restore.

## 5. The proposed API

Every signature here is a design contract. `exists` marks an API that works today, `widened` an existing API with a changed type or a new field, and `NEW` an API that doesn't exist.

### 5.0 Seven rules the API follows

1. **One graph, one engine.** Targets, flows and triggered runs are `@smthrs/plan` nodes run by `@smthrs/flow`. No library adds a node model (FLOW-2).
2. **Values, not strings.** A dependency, an artifact, a flow a trigger starts, a flow a plugin features: each is an imported value. A label string appears only where a person types one: a CLI pattern, or the patterns a trigger hands to `build/run`.
3. **Data where nothing happens; Effect where something does.** `WORKSPACE.ts`, `PACKAGE.ts`, `FACTORY.ts` and `plugin.ts` are maps whose keys are ids. A rule's work, an action's handler and a flow's body are Effects. Nothing wraps Effect to look simpler.
4. **A sandbox is a Layer.** What a step may touch is exactly the set of Effect services the host gives it, built from its declaration. The type (`R`) says what it needs; the host's kernel, container or realm enforces it.
5. **Fail closed.** A cache entry, a shared result, a sandbox, a trigger or an activation that can't be fully identified doesn't happen, and the output says why.
6. **Definitions are code; listings are data.** `smthrs` evaluates declaration files. The app, a signed-out visitor and the host read only the committed JSON they compile to: `target-index.json`, `factory.json`, `plugin.json`, and flow descriptors read from source text.
7. **Write the TypeScript VibeLang will erase.** VibeLang's rule is "Every function is an Effect: calls run in order, with no `yield*` or `Effect.gen`" (`~/effectscript/docs/user/llms-essentials.md:3`). So the API is plain `Effect.gen`, services, tagged errors and Layers, and a flow body's `yield*` means what VibeLang's call means: the next line waits.

**Net surface, so "thin" can be checked.**

| | Names |
|---|---|
| NEW | the `Plan` service (makes `Node` an Effect); `Node.all` options `{ concurrency, after }`; `Target.toLayer`; `Target.make({ flow })`; `Artifact`, `target.outputs`, `S.tree`; `Build.run`, `Build.target` and the `build/run` system flow; `S.Platform` and the workspace's `platforms`; `Plugin.make`; `Trigger.bind`, `On.*`, `Report.commitStatus`; `smthrs definitions plan` and `apply` |
| Widened | `Flow.make`'s `body` type; `S.Generate` gains `flow`; 0017's `Trigger` row gains `id`, `input`, filters, `concurrency`, `report`, `trust`, `secrets`; `S.Sandbox.None` gains `reason` |
| Deleted | `Node.bindPlanned`, `Node.andThen`, `Target.plan`, `Target.notImplemented` and its 67 call sites, the native rule switch, the per-target memory engine, `Executor.scheduleEffect`, `B/Cache.ts`'s private store, `Input.File` and `Input.Glob` (one file model), `S.Cron`, `S.Factory`, `S.Flow`, `FlowCatalog`, the string `on` table, `T/Home.ts`, `GithubCiGen` and the non-publishing `S.Github.*` renderers, `CiToolchain`, `GithubRender`, `SecretProxy` (into `@smthrs/secrets`), six patterns, `smthrs triggers register` |

### 5.1 Flow bodies: `Node` is an Effect

```ts
// @smthrs/plan: NEW Plan service (~80 lines); Node's AST is untouched
import { Context, Effect } from "effect"

/** The graph a body is building. Graph.build, the realm and the build executor provide it. */
export class Plan extends Context.Service<Plan, {
  /** Append `node` after the current frontier; the frontier becomes `node`. Returns its reference. */
  readonly register: <A, E, R>(node: Node<A, E, R>) => Effect.Effect<Planned<A>>
}>()("@smthrs/plan/Plan") {}

// widened: a Node is an Effect whose evaluation registers it (Effectable.Prototype, effect/Effectable.d.ts:32-35)
export interface Node<A, E = never, R = never> extends Effect.Effect<Planned<A>, E, Plan | R> {
  readonly [NodeTypeId]: { readonly ast: NodeAst }
}

// widened: the one spelling of concurrency. Members start together after the frontier;
// `after` adds ordering edges between members, which is how a DAG is written. Both lower onto
// fields the plan IR already has: `dependsOn` edges (P/Plan.ts:160) and the scheduler's
// admission bound (P/Scheduling.ts:105-109), today plan-wide, here scoped to the group.
export const all: <const M extends Readonly<Record<string, Node.Any>>>(
  members: M,
  options?: {
    readonly concurrency?: number
    readonly after?: { readonly [K in keyof M]?: ReadonlyArray<keyof M> }
  }
) => Node<{ readonly [K in keyof M]: Node.Success<M[K]> }, Node.Error<M[keyof M]>, Node.Services<M[keyof M]>>

// exists, unchanged: map (runs later on the real value), branch (a run-time decision), catch, capture
// deleted: bindPlanned (it is Effect.flatMap now), andThen (it is two yield*s)
```

```ts
// @smthrs/flow: widened. Only the body's type changes (today: (payload) => Node, F/Flow/make.ts:124-135)
export type Body<P, A, E, R> = (payload: P) =>
  Effect.Effect<Planned<A> | A | Outcome.To<P>, E, Plan | R>

// .smithers/flows/release-check/flow.ts
export default Flow.make("release-check", {
  description: "Typecheck, test and pack one commit, then publish a candidate.",
  capabilities: ["build:run"],
  payload: { sha: Schema.String },
  success: Candidate,
  body: ({ sha }) => Effect.gen(function* () {
    const checkout = yield* Checkout.call({ sha })               // Planned<Checkout>; the next line waits
    const checks = yield* Node.all({                             // concurrency has one spelling
      test: Test.call({ checkout }),
      lint: Lint.call({ checkout }),
    })
    return yield* Publish.call({ checkout, checks })             // waits for both
  }),
})
```

The rules, each enforced by the type or by `Plan.register`:

1. **The body runs once, at plan time, with no I/O.** Its only services are `Plan`, `Stage` and `Config`. A body that asks for `FileSystem` doesn't typecheck; the realm refuses it at run time (0017). This is today's rule, "the pure plan-time body", with the type now doing the enforcing.
2. **`yield*` is sequential.** The rest of the body depends on the yielded node. `Node.all` is the only concurrency, and `Node.all({ … }, { after })` writes a DAG. A registration from a forked fiber (`Effect.all` with `concurrency`) fails with `GraphBuildError`, so there is one spelling.
3. **A reference is passed, never computed on.** `if (checks.test.ok)` is a type error: `Planned<boolean>` is not `boolean`. Compute later with `Node.map`; decide with `Node.branch`. The lint rule `flow.no-planned-condition` covers untyped cases.
4. **Errors and requirements are inferred.** `Effect.gen` unions each yielded node's `E` and `R`, so hand-written requirement unions such as `.smithers/flows/release/flow.ts:22-36` disappear. A step's `E` describes run time; `Node.catch` handles it, and the lint rule `flow.no-effect-catch-on-node` refuses `Effect.catch*` on a `Node`.
5. **Work is an action.** Code that does something is `Action.make` plus `.toLayer(payload => Effect)`; a model call is a prompt flow or an agent step (DUR-4).
6. **Loops are rounds.** A shape known only at run time is the flow's `.to(next)` (`F/Flow/Flow.ts:234`) under `maxRounds` (`F/Flow/make.ts:113`); nothing calls a model to guess a plan.
7. **Identity is sealed or refused,** as today: callbacks go through `Node.capture`, and process-local identity is refused before dispatch.

**Compatibility.** A body that returns a `Node` today still typechecks, because a `Node` is now an Effect. Bodies move to `Effect.gen` by codemod, then `bindPlanned` and `andThen` are deleted.

**Why not `Flow.gen`.** It is a second name for `Effect.gen` that exists only to make `Node` look like an Effect. Once `Node` is one, `Effect.gen` does the job and VibeLang erases the `yield*`.

**Why not a replayed Effect body** (effect 4.0.5 ships `effect/workflow`, `node_modules/effect/package.json:54`). A replayed body sees real values, so `if (result.ok)` would work. It would also delete the plan: no plan diff, no step key before the run, no run graph on an approval card, no realm plan budget. It would replace the engine's model, which FLOW-2 forbids. The cost of keeping the plan is one spelling: `Node.branch` for a run-time decision.

**Falsifier.** Rewrite every `.smithers/flows/*/flow.ts` body with `Effect.gen`. A body written as a chain keeps its plan digest byte-identical (`smthrs flow plan`); a body written with `bindPlanned` shows only added ordering edges in `PlanDiff`, each listed in the change.

### 5.2 Files and artifacts

One file model, `@smthrs/plan`'s `FileSet` (exists), plus one new value.

```ts
// @smthrs/plan/FileSet: exists (P/FileSet.ts)
export type Pattern = string                      // package-relative; "//" anchors at the workspace root
export interface Glob { readonly _tag: "Glob"; readonly include: readonly [Pattern, ...Pattern[]]; readonly exclude?: ReadonlyArray<Pattern> }
export interface TreeArtifact { readonly _tag: "TreeArtifact"; readonly path: Pattern }

// @smthrs/plan/FileSet: NEW, a produced file or tree carried as a value
export interface Artifact<K extends "file" | "tree" = "file" | "tree"> {
  readonly _tag: "Artifact"
  readonly kind: K
  readonly path: Pattern                          // where the producer writes it
  readonly producer: Target.Any                   // the edge; the planner substitutes the produced digest
}
export type Read = Pattern | Glob | Filegroup | Artifact
export type Write = Pattern | Glob | TreeArtifact

// @smthrs/targets: the Smithers namespace keeps its spellings over FileSet
S.file(path): Pattern           // exists (returns Input.File today)
S.glob(include, { exclude }?): Glob   // exists (Input.Glob today)
S.tree(path): TreeArtifact      // NEW
```

- **One model.** `Input.Glob` is `{ pattern, exclude }` and `FileSet.Glob` is `{ include[], exclude? }`: two shapes for one idea. The build's `Input` file types are deleted; the expansion and digest code moves to the Node host, which also makes `@smthrs/targets` importable in a browser and a Worker (SDK-4).
- **Artifacts, not transitive grants.** Today a consumer names a producer and gets every transitive dependency's `outDirs` and `outFiles` in its read set. An `Artifact` names one output: the consumer reads exactly that path, and its key carries that path's digest. That is Bazel's `File` and `DefaultInfo` in one value.
- **Lazy cross-package globs.** `S.glob("//packages/*/src/**/*.ts")` is a declaration the planner expands with the shared ignore and symlink rules. It replaces the load-time reads in the root `PACKAGE.ts` (5.4). `.smithers/cross-package-globs.json` (today `[]`) stays the allowlist that keeps them reviewable.

### 5.3 Rules: one action per target, implemented by a Layer

```ts
// @smthrs/targets/Target: widened. Today's Target.make keeps its name and its attrs walk.
export type Kind = "build" | "test" | "lint" | "run" | "docs" | "review"
export type Outputs = Readonly<Record<string, Artifact>>

export const make: <const Tag extends string, Attrs extends Schema.Struct.Fields, Out extends Outputs = {}, A = void, E = never>(
  tag: Tag,
  options: {
    readonly attrs: Attrs                                    // Effect Schema; targets, artifacts and file sets inside are edges
    readonly kinds: ReadonlyArray<Kind>
    readonly implementationVersion: string                   // NEW here; Action's compatibility claim
    readonly outputs?: (attrs: Schema.Struct.Type<Attrs>) => Out          // NEW: named artifacts
    readonly reads?: (attrs: Schema.Struct.Type<Attrs>) => ReadonlyArray<Read>    // beyond what attrs carry
    readonly writes?: (attrs: Schema.Struct.Type<Attrs>) => ReadonlyArray<Write>  // a generator's write set
    readonly network?: "none" | "loopback" | "open"          // default "none"
    readonly cache?: boolean | ((attrs: Schema.Struct.Type<Attrs>) => boolean)   // exists; default false
    readonly tier?: "sealed" | "irreversible"                // NEW here; irreversible = never cached, at most once
    readonly flow?: Flow.Any                                 // NEW: the target runs this child flow instead of one action
    readonly success?: Schema.Schema<A>
    readonly error?: Schema.Schema<E>
    // exists, unchanged: workspaceAttrs, hosts, manual, verbGate, attrsForKind
  }
) => Rule<Tag, Attrs, Out, A, E>

export interface Rule<Tag extends string, Attrs extends Schema.Struct.Fields, Out extends Outputs, A, E> {
  /** Declare one target. A value: no I/O. */
  (attrs: Schema.Struct.Constructor<Attrs> & Presentation & Scheduling): Target<Tag, Out, A, E>
  readonly tag: Tag
  readonly action: Action.Declared<`build/${Tag}`, Schema.Struct<Attrs>, A, E>
}

export interface Target<Tag extends string = string, Out extends Outputs = Outputs, A = unknown, E = unknown> {
  readonly _tag: Tag
  readonly outputs: Out                                      // NEW: lib.outputs.dist
  readonly [TargetTypeId]: Metadata                          // exists
}

/** What a rule's implementation may use. The host builds it per target from the declaration. */
export type Sandbox =
  | FileSystem.FileSystem          // reads confined to the target's reads (read-only), writes to its writes
  | Path.Path
  | ChildProcessSpawner            // spawns under bubblewrap, strict seatbelt, Docker or a container
  | HttpClient.HttpClient          // closed unless `network`; secrets are placeholders swapped at the egress
  | Toolchains                     // the resolved runtime, package manager and bins, with their identities

/** NEW: implement a rule, as Action.toLayer implements an action and an Alchemy provider implements a resource. */
export const toLayer: <Tag extends string, Attrs extends Schema.Struct.Fields, Out extends Outputs, A, E, R>(
  rule: Rule<Tag, Attrs, Out, A, E>,
  run: (attrs: Resolved<Schema.Struct.Type<Attrs>>) => Effect.Effect<A, E, R | Sandbox>
) => Layer.Layer<Action.Requirement<`build/${Tag}`>, never, Exclude<R, Sandbox>>
```

- **One route.** Every target is exactly one action, `build/<Tag>`, implemented by `Target.toLayer`, or one child flow when the rule names `flow`. Today half the catalog runs through a name-matched native switch and half through `Target.plan` on an in-memory engine. Each native `case` moves into its rule's Layer, and `Target.plan`, `notImplemented` and the switch are deleted.
- **`Resolved<Attrs>`** is the attrs with every artifact and file set replaced by its sandbox path, plus `cwd`.
- **`flow`** is for rules whose work is several durable steps: a model call (DUR-4), a candidate-and-gate loop (`Agent.Diff`), or a repository's own generator (`S.Generate({ flow })`, 8.1). The child flow's own actions run under the same sandbox Layer, and the flow module's import closure is key material.

A catalog rule, proposed:

```ts
// @smthrs/targets/Vitest
export const Vitest = Target.make("Vitest", {
  attrs: { srcs: Schema.Array(Read), deps: Schema.optional(Schema.Array(Read)), config: Schema.optional(Pattern) },
  kinds: ["test"],
  implementationVersion: "vitest/1",
  network: "loopback",
  cache: true,
})

export const VitestLive = Target.toLayer(Vitest, ({ cwd, config }) =>
  Effect.gen(function* () {
    const tools = yield* Toolchains
    const argv = yield* tools.packageManager.exec("vitest", ["run", ...(config ? ["--config", config] : [])])
    const exit = yield* Exec.spawn(argv, { cwd })          // today's Exec.run, as an Effect over ChildProcessSpawner
    if (exit.code !== 0) return yield* new TestsFailed({ exit: exit.code })
  }))
```

The rule never spells `pnpm` or `node`: `Toolchains` supplies the argv, as `workspaceAttrs` does today. `Shell.Build`, `Shell.Test` and `Shell.Run` stay as the escape hatch with the same contract; a shell string is opaque, so `Shell.*` stays uncached unless the target declares `tools` the planner can key.

`S.Generate` keeps its selectors and gains one:

```ts
// widened: exactly one of emit | script | bin | command | flow. `run` writes; `lint` checks drift.
S.Generate({
  summary?, featured?,
  flow?: Flow.Flow<Tag, Payload, Record<string, string>, E, R>,   // NEW: the flow is the generator
  data: { [K in keyof Payload]: S.File | S.Glob | Record<string, S.File> },   // read into the payload
  changes: ReadonlyArray<string>,                                  // the write set
  // exists: emit, script, bin, command, args, env, secrets, sandbox, stdout, deps, mode
})
```

The executor reads `data` into the flow's payload, loads the flow module's exported `layer` the way the registry composes one (Sol), runs the flow, treats its success record as `{ path: contents }`, and writes it under `run` or compares it under `lint` through the existing `WriteFile` and `CheckFile` actions. The flow module's import closure is key material (`ImportClosure` exists in `T/Compose.ts`), so an edit to the renderer re-keys the target.

### 5.4 Packages: unchanged

```ts
// exists, unchanged: T/Package.ts:96
export const Package: <const T extends Readonly<Record<string, Target.Any | S.File | S.Glob>>>(options: {
  readonly targets: T
  readonly defaultVisibility?: "public"
  readonly owners?: Owners.Options | Owners.Declaration
}) => PackageValue<T>
```

`PACKAGE.ts` stays Bazel's `BUILD` file: a map whose keys are labels, targets as values, references as edges. What changes around it:
- **No load-time I/O.** The five files that glob or read the disk at load (the root `PACKAGE.ts:21-34` among them) switch to lazy `//` globs (5.2). `S.SecurityReview` stops reading files at declaration.
- **Macros are functions,** as today. A package that needs a variant of a macro's output replaces one member of the returned record.
- **A rule a repository writes for itself** lives in a module next to the `PACKAGE.ts` that uses it: `Target.make` plus `Target.toLayer`. The executor merges the rule's Layer into the target's sandbox; its module's import closure is key material, so the rule can't hit a cache its own code didn't fill.

### 5.5 The workspace

```ts
// .smithers/WORKSPACE.ts: exists; one field added
export const Workspace = S.Workspace("smithers", {
  runtime, packageManager, nodeModules, toolchains: [rust], host, cache, repos,
  sandboxes: S.Sandboxes({ microsandbox: S.Sandbox.Microsandbox({ environment }) }),   // `default` omitted: the platform decides
  platforms: {                                                                          // NEW
    "linux-x64": S.Platform.container({ machine: "standard-4", image: ciImage }),
    host: S.Platform.local(),
  },
})
```

- **Confinement on by omission.** With no `default` mechanism, the platform decides: bubblewrap on Linux, seatbelt on macOS, refusal elsewhere (`T/ExecSandbox.ts:235-239`). Smithers' `default: S.Sandbox.None()` is deleted (slice 1 of section 10). A target that truly needs the host says `sandbox: S.Sandbox.None({ reason })`; the reason shows in `explain` and the index.
- **Strict seatbelt.** macOS builds run `(deny default)`, so macOS confinement means what Linux confinement means.
- **`platforms`** names execution platforms. Each lowers to a `Placement` (`P/Placement.ts`), and a target's `placement` or a `Build.run`'s chooses one. A container platform's image digest is its toolchain identity.

### 5.6 The build as flows

```ts
// @smthrs/targets/Build: NEW. Declarations are platform-neutral; the Node host and job containers implement them.
export interface BuildRequest {
  readonly verb: Kind | "ci"
  readonly patterns: ReadonlyArray<string>                 // "//packages/..."
  readonly at?: Commit | Planned<Commit>                   // a repository and SHA; absent = the host's tree
  readonly affected?: { readonly base: string }            // smthrs affected's selection
  readonly knownRed?: Pattern                              // B/KnownRed.ts's list
  readonly placement?: Platform.Name                       // where the whole run goes (phase A)
  readonly jobs?: number
}
export interface BuildReport {
  readonly rows: ReadonlyArray<{
    readonly label: string
    readonly verdict: "passed" | "failed" | "cached" | "skipped" | "known-red"
    readonly key: string
    readonly outputs: Readonly<Record<string, Digest>>
    readonly durationMs: number
  }>
}

export const Build: {
  /** `smthrs <verb> <patterns>` as one child run of the `build/run` system flow. A red target is a row, never a failure. */
  readonly run: (request: BuildRequest) => Node.Node<BuildReport, never, Build.Requirement>
  /** One target and its closure; settles with its artifacts' digests. */
  readonly target: <T extends Target.Any>(target: T | string, options?: { readonly at?: Commit | Planned<Commit>; readonly verb?: Kind })
    => Node.Node<Built<T>, BuildFailed, Build.Requirement>
}
```

`smthrs build|test|lint|docs|run|ci` start the `build/run` system flow on the Node host. CI starts the same flow on Cloudflare; an agent starts it from a branch. One plan, one journal format, one run page. Section 6.1 shows its two rounds.

### 5.7 Triggers and events

```ts
// @smthrs/triggers: NEW declaration surface over today's Trigger, Cron, Scheduler, SqlTriggerStore and Webhook
export interface On<Event> { readonly _tag: "On"; readonly source: string; readonly event: Schema.Schema<Event> }

export const On: {
  readonly cron: (expression: string, policy?: {
    readonly timezone?: string                               // default "UTC"
    readonly overlap?: "skip" | "buffer-one" | "supersede"   // default "skip": @smthrs/triggers' own names
    readonly catchUp?: "none" | "one" | "all"                // default "none"
    readonly maxCatchUp?: number
  }) => On<CronTick>
  readonly push: (filter?: { readonly branches?: ReadonlyArray<string>; readonly tags?: ReadonlyArray<string>; readonly paths?: ReadonlyArray<string> }) => On<PushEvent>
  readonly pullRequest: (filter?: { readonly branches?: ReadonlyArray<string>; readonly actions?: ReadonlyArray<PullRequestAction>; readonly paths?: ReadonlyArray<string> }) => On<PullRequestEvent>
  readonly issue: (filter?: { readonly actions?: ReadonlyArray<IssueAction>; readonly labels?: ReadonlyArray<string> }) => On<IssueEvent>
  readonly comment: (filter?: { readonly contains?: string; readonly minimum?: Role }) => On<CommentEvent>
  readonly run: (filter: { readonly over: ReadonlyArray<Flow.Any>; readonly events: ReadonlyArray<"started" | "waiting" | "settled"> }) => On<RunEvent>
  readonly manual: () => On<ManualEvent>                     // the form is the flow's payload schema
}

/** "Config binds; code composes" (0017): bind a flow to an event. A value; validated at projection. */
export const Trigger: {
  readonly bind: <F extends Flow.Any, Ev>(options: {
    readonly flow: F                                         // an imported Flow value, never a tag string
    readonly on: On<Ev>
    readonly input?: (event: Traced<Ev>) => Flow.PayloadInput<F>   // traced once into 0017's Args: { sha: "$event.head.sha" }
    readonly concurrency?: { readonly group: (event: Traced<Ev>) => Traced<string>; readonly cancelInProgress?: boolean }
    readonly report?: Report                                 // GH-10
    readonly secrets?: ReadonlyArray<string>                 // names only; a fork's pull request gets none
    readonly trust?: "head" | "base"                         // pull requests: whose flow code runs; default "head"
    readonly enabled?: boolean
  }) => Trigger.Binding
}

export const Report: {
  /** Write-only GitHub commit statuses named smithers/<flow> (GH-10); `steps` adds smithers/<flow>/<step> (question 5). */
  readonly commitStatus: (options?: { readonly steps?: ReadonlyArray<string>; readonly description?: string }) => Report
}
```

- **`input` is traced, not called at event time.** It runs once at projection on a symbolic event. It may read fields and build records; computing on a field (a template literal, an `if`) fails with `DefinitionError`. The result is 0017's `Args` grammar, so the host never runs repository code to start a flow.
- **Matching always uses the base; `trust` picks whose code runs.** A pull request's event is matched against the default branch's active snapshot, never the head's, so a pull request can't add a trigger to itself or grant itself a secret. `trust: "head"` (the default, GitHub's `pull_request`) runs the head's flow with no secrets for a fork. `trust: "base"` (GitHub's `pull_request_target`) runs the base's flow over the head's tree and may receive the binding's secrets.
- **A flow file never says when it runs.** One flow serves several triggers with different settings (CI cancels on pull requests, not on pushes), and a plugin binds flows it doesn't own (0017 §5).
- **A trigger starts a flow, never a target.** To run targets on a schedule, bind `Build.Run` and pass patterns.

### 5.8 The repository's plugin: `FACTORY.ts`

```ts
// @smthrs/plugin: NEW authoring helper; compiles to decision 0017's Plugin.Manifest (approved)
export const make: (plugin: {
  readonly id: string                                         // "repository" for FACTORY.ts
  readonly title: string
  readonly version: string
  readonly requires: { readonly api: string }
  readonly capabilities?: ReadonlyArray<string>
  readonly flows?: Readonly<Record<string, { readonly flow: Flow.Any; readonly featured?: boolean; readonly summary?: string; readonly view?: string }>>
  readonly commands?: Readonly<Record<string, { readonly flow: Flow.Any; readonly title: string; readonly slash?: string; readonly args?: Json }>>
  readonly triggers?: Readonly<Record<string, Trigger.Binding>>
  readonly home?: Home.Blocks                                 // @smthrs/views' Home
  readonly settings?: Readonly<Record<string, Setting>>       // the GitHub policy lives here
}) => Plugin
```

- **It is data.** The keys are the contribution ids, so a duplicate can't be written; the values are typed references. The projection target writes `.smithers/factory.json` as a `Plugin.Manifest`, and `lint` fails on drift, as `//:factoryProjection` does today.
- **It is a plugin, not a second format.** PLUGIN-1 asks for "the same plugin interface anybody can use to add smithers flows … flows as config". 0017 already makes `.smithers/flows/` a repository's implicit plugin; `FACTORY.ts` is where that plugin's bindings are written. One manifest means one loader, one activation flow and one trigger row type.
- **The manifest pins what was reviewed.** For each flow it records the tag and the executable digest (the module's import closure), so activation runs exactly the reviewed code.
- A hand-written `plugin.json`, as 0017 defines, stays valid. TypeScript authoring is the recommended way because it types the references; both produce the same manifest.

### 5.9 Where definitions live and how they're discovered

| Scope | File | Holds | Discovered by | Evaluated by |
|---|---|---|---|---|
| Workspace | `.smithers/WORKSPACE.ts` (a root `WORKSPACE.ts` is the fallback) | toolchains, platforms, cache, sandboxes, child repositories | its fixed path | `smthrs`, first and alone |
| Package | `<dir>/PACKAGE.ts` | targets: build, test, lint, docs, generated files, review rules, the repository's own rules | the ignore-blind walk; labels `//dir:key` | `smthrs` (Node); on Cloudflare only inside a job container |
| Flow | `.smithers/flows/<name>/flow.ts` (M-49) | one `Flow.make`, its actions and their Layers | registry text scan, never imported | the engine that runs it; the QuickJS realm plans it on Cloudflare |
| Repository plugin | `.smithers/FACTORY.ts` | featured flows, commands, triggers, home, GitHub policy | its fixed path | the projection target, which writes `.smithers/factory.json` |
| More plugins | `.smithers/plugins/<id>/plugin.ts` or `plugin.json` | a plugin the repository ships (0017) | folder scan | a projection target per plugin |
| Organization | a separate repository, published as a plugin package | flows, commands and triggers shared across repositories | vendored per repository by `smthrs plugin add <pkg>@<version>` into `.smithers/plugins/<id>/`, digest in `.smithers/plugins.lock`, activated by a merge (`0017:469-479`); an Admin grants its secrets (0017 §10) | its own repository's build |
| Person | Postgres, `Flow.make` source per revision | a person's own flows | the app | the device while exactly as drafted (FLOW-2) |

Rules: a package never declares a trigger; a flow file never says when it runs; listing never runs a program; an organization's flow acts with the installing repository's grants, never more.

### 5.10 How it reads in VibeLang

VibeLang erases `yield*` and `Effect.gen` and has `service`, `error` and `provide` declarations (`~/effectscript/docs/user/llms-essentials.md:3-10`). Every API above is one of four shapes: a value constructor (`S.TsBuild(...)`, `Trigger.bind(...)`, `Plugin.make(...)`), a function returning an Effect (a rule's `run`, an action's handler, a flow's body), a service (`Plan`, `Toolchains`, the `Sandbox` services), or a Layer (`Target.toLayer`, `Action.toLayer`). Because a body's `yield*` is sequential, a VibeLang flow body reads like the ordinary code it is: the next line waits. The test: once VibeLang ships, `PACKAGE.ts`, `FACTORY.ts` and `flow.ts` port line for line with no Smithers change.

## 6. Execution

### 6.1 One pipeline for a laptop, CI and an agent

```
smthrs test //packages/...            (Node host)         ┐
trigger "ci-pr" → FlowExecution DO    (Cloudflare host)   ├─▶ start build/run { verb, patterns, at, affected?, placement? }
an agent's Build.run / Build.target   (browser or DO)     ┘
        │
round 1 │ build/load: one action; repository code runs here, so it is placed where repository code may run
        │   load WORKSPACE.ts, then every PACKAGE.ts once (one module instance per file, as today)
        │   select roots by verb and pattern (or by smthrs affected); close over edges
        │   expand reads, digest them, measure toolchain identities, derive one KeyMaterial per target
        │   settle: BuildPlan { targets: [{ label, rule, key, attrs, reads, writes, deps, placement }] }   (data, sealed)
        ▼   BuildExecute.to({ plan })               ← a hand-off to the next round (F/Flow/Flow.ts:225-235): the graph is data known only now
round 2 │ build/execute body: pure. Node.all(one node per target, { after: deps, concurrency: jobs })
        │   per node: build/<Rule>.call({ label, key, attrs })  →  step-cache lookup by key
        │       hit  → materialize output blobs from the CAS, verified by digest; settle "cached"
        │       miss → the host builds the target's Sandbox Layer → rule implementation → verify outputs
        │              → re-digest reads → put blobs in the CAS and { key → output digests, success } in the AC
        ▼
        BuildReport { rows: [{ label, verdict, key, outputs, durationMs }] }
```

**Two rounds is the honest shape.** The set of targets depends on files a package reads, which a pure body can't see, so the plan is a result of round 1 and the graph of round 2. That is exactly how the engine handles "a shape known only at run time" (`apps/mvp/docs/proposals/ci-cd-parity.md:17`). A plan holds at most 10,000 nodes (`P/Plan.ts:273`); Smithers has 1,273 targets.

**Why the build is a durable flow.** DUR-1 says every action runs as a durable flow step. Today a `smthrs ci` that dies at minute 170 starts over from the cache, and its runs never reach the app. As a flow, a resumed run settles finished targets from its journal, a CI run appears on the repository's run page, and run metrics count targets, durations and cache hits with no new code.

**The gate.** The executor folds into the engine only if a no-op rerun of `smthrs ci '//...'` on the 1,273-target graph adds at most 2 seconds of journal overhead and the full run stays within 10% of today's wall clock (TEST-8). Until the benchmark passes, the Node host keeps today's executor and only Cloudflare runs use `build/run`; the old executor is deleted in the same effort once it passes (SDK-11). This is question 4.

### 6.2 A hermetic run on a laptop

```
for target T (rule R, key k):
  reads(T)   = declared reads ∪ { a.path | a an Artifact in T's attrs } ∪ toolchain paths ∪ the node_modules artifact
  writes(T)  = R.outputs(attrs) ∪ R.writes(attrs)
  Sandbox(T) = Layer.mergeAll(
     FileSystem          WorkspaceSandbox seeded with reads(T); writes are a diff applied by an explicit materialize
     ChildProcessSpawner wrapped by ProcessSandbox: bubblewrap (Linux) | strict seatbelt (macOS) | Docker, over reads/writes
     HttpClient          the egress: closed unless `network`; secrets are placeholders swapped for bound origins only
     Toolchains          resolved from the workspace; identities measured once per session)
  run R's implementation with Sandbox(T)
  verify: every declared output exists; nothing outside writes(T) changed (revert and fail otherwise)
  re-digest reads(T): if any moved since planning, don't store
  put outputs in the CAS; put { key → output digests, success } in the action cache
```

Every piece of `Sandbox(T)` exists. `ProcessSandbox` confines processes today (`packages/smithers/flows/platform-node/src/ProcessSandbox.ts`). `@smthrs/engine-store`'s `WorkspaceSandbox` runs an action's in-process code against "an isolated workspace seeded with exactly its declared read set", with writes as a diff that reaches the host only through an explicit materialize step (`packages/smithers/flows/engine-store/src/WorkspaceSandbox.ts:6-9`); it is "a deterministic transaction model, not a security boundary" (`:24`), which is why spawned processes go through `ProcessSandbox`. The new work is assembling them per target from its declaration.

What changes from today:
- **On by default.** Smithers' `default: S.Sandbox.None()` (`.smithers/WORKSPACE.ts:62-69`) is deleted; a target that needs the host says `sandbox: S.Sandbox.None({ reason })`.
- **Strict seatbelt.** `(deny default)` for builds, not `(allow default)`.
- **A narrower read set.** A target reads its declared artifacts, not every transitive dependency's output directories.
- **In-process code is confined too.** A rule that reads files through `FileSystem` gets a typed failure on an undeclared read at the call, not a stderr match after a failure.
- **Reads are re-digested before a store,** so an edit made during the run is never stored under the stale key.
- **Still in place.** Locally, tools run in the real tree under an allowlist. Staging an execroot would copy or link `node_modules` per action and change nothing in the key.

**Flow steps get the same sandbox.** Nothing above is build-specific: the host reads an action's `fileBoundary`, capabilities and placement. A target is the action the build graph declares for you; any flow step that declares a `fileBoundary` runs confined to it the same way, with the same key and cache. A step without one keeps today's behavior: the run's capability-decorated services (`packages/smithers/flows/kernel/README.md:11-16`), and it is never shared through the cache.

### 6.3 Remote: four kinds of machine, one key

| Where | What runs there | How inputs arrive | Hermetic? |
|---|---|---|---|
| **Job container, phase A** | a whole `build/run`, placed by `Build.run({ placement })` | the forge checkout of the SHA, then the same local pipeline with the remote AC and CAS | yes, per target, inside the container |
| **Executor, phase B** | one target action, placed by its `placement` | an `ExecutionManifest` (Astra): the input root as `{ path → digest }`, missing blobs fetched from the CAS with `findMissing`, staged into an empty per-action root | yes, and staged: only declared inputs exist |
| **Branch sandbox** | the agent's tools on a mutable checkout | it is the working copy | no; it never caches. A proof runs on a snapshot commit (8.8) |
| **QuickJS realm** | a repository flow's plan (0017 slice 5) | the commit's tree through a read-only `FileSystem` at a SHA | plans only; runs no target |

**Phase A** is GitHub-runner parity and needs only the parity proposal's job machine, long commands and run view. **Phase B** is Bazel remote execution: the `FlowExecution` Durable Object runs round 2, and `Hosts` binds the `linux-x64` placement to an executor pool (`packages/smithers/flows/engine/src/Hosts.ts`), each executor a Durable Object that owns a container and implements `JobHost` (7.4).

```ts
// Phase B's wire format (Astra): sealed before dispatch; it is the action's key material, made concrete
interface ExecutionManifest {
  readonly version: 1
  readonly rule: { readonly tag: string; readonly implementationVersion: string; readonly bundle: Digest }
  readonly executionPlatform: Platform
  readonly targetPlatform: Platform              // a Linux tool may emit WASM; the key carries both
  readonly toolchain: { readonly root: Digest; readonly executable: RelativePath }
  readonly inputs: ReadonlyArray<{ readonly at: RelativePath; readonly tree: Digest }>
  readonly argv: ReadonlyArray<string>
  readonly cwd: RelativePath
  readonly environment: Readonly<Record<string, string>>
  readonly outputs: ReadonlyArray<{ readonly path: RelativePath; readonly kind: "file" | "tree"; readonly required: boolean }>
  readonly network: { readonly _tag: "None" } | { readonly _tag: "Loopback" } | { readonly _tag: "Egress"; readonly origins: ReadonlyArray<string>; readonly secretNames: ReadonlyArray<string> }
  readonly timeoutMs: number
}
```

**Placement keeps DUR-5.** A build runs locally unless it needs a server-held key, a machine the device lacks (`linux-x64` from a Mac), or must continue while every device is off. A person's `smthrs test` never goes remote silently; a CI trigger always does.

**Platform-specific keys.** `placement` enters the key only for rules whose outputs depend on the platform (native builds, Cargo, Go binaries). A TypeScript build's key is platform-free, so a Mac fills the cache a Linux executor reads, and the reverse.

### 6.4 How outputs feed the next target

```
packages/effect-tanstack-db/PACKAGE.ts              packages/effect-electric/PACKAGE.ts
  lib = S.TsBuild({ srcs, outDir: "dist" })          import { Package as tanstackDb } from "../effect-tanstack-db/PACKAGE.ts"
     outputs: { dist: tree("dist") }                 lib  = S.TsBuild({ srcs, deps: [tanstackDb.lib.outputs.dist] })
                                                     test = S.Vitest({ srcs: tests, deps: [lib.outputs.dist] })

key(db.lib)  = H(rule, attrs, digests(src/**), toolchains)         → produces dist @ d1
key(el.lib)  = H(rule, attrs, digests(src/**), d1, toolchains)     ← keyed on d1, not on key(db.lib)
key(el.test) = H(rule, attrs, digests(test/**), digest(el.lib.dist))

edit a comment in effect-tanstack-db/src:
  db.lib re-runs (its key moved) → dist bytes identical → d1 unchanged → el.lib and el.test are cache hits
```

The planner can't know `d1` before `db.lib` runs, so round 2 keys a consumer lazily: its node waits on the producer, then derives its key from the produced digests. Today's runner already re-keys a consumer from settled producers (`BI/PackageRunner.ts:2068-2094`); the change is to key on digests instead of the producer's key. In `KeyMaterial` terms the producer's output is a `Ref` input (`P/KeyMaterial.ts:35-39`), already part of the engine's key derivation. Keying on delivered bytes also makes a nondeterministic or uncached producer safe: equal producer keys no longer imply equal consumer inputs (Astra).

In a flow, a step's success is a `Planned<A>` the next step's payload carries, and the engine substitutes the real value at dispatch. A `Build.target` settles its artifacts' digests; a flow that needs the bytes reads them from `@smthrs/artifacts` by digest.

### 6.5 Cache identity

```
KeyMaterial (P/KeyMaterial.ts:72-83), as the build fills it
  version       "flows/key-material/v2"
  kind          the rule's tier: "sealed" (cacheable) | "irreversible" (never cached, at most once)
  body          { rule tag, implementationVersion, the rule module's import-closure digest, verb mode (write | check), cwd,
                  attrs in canonical form with every edge replaced by its digest }
  inputs        Literal { path, digest, mode } per expanded read  +  Ref { producer, path } per artifact
  layers        toolchain identities ("node 26.5.0 sha256:…", "pnpm 11.25.0 sha256:…"), the lockfile digest,
                the container image digest or Nix store path, and each allowlisted inherited variable's value
  capabilities  fs:read:<reads>, fs:write:<writes>, proc:spawn, net:<none|loopback|open>
  effects       { reads, writes, mode: "hermetic", tier }
  placement     { platform } for platform-dependent rules only
```

**Fail-closed rules, each a test.**

| Condition | Result | Today |
|---|---|---|
| the rule says `cache: false`, or the verb is `run`, or the mode is `write` | runs every time | same |
| a tool or toolchain has no identity | runs; not stored | catalog rules refuse; a shell argv is best effort |
| the sandbox mechanism was none | stored locally only, never shared; the mechanism is in the key | shared only when enforceable (`BI/PackageRunner.ts:662-676`); the mechanism isn't keyed |
| an allowlisted inherited variable (`SDKROOT`, `DEVELOPER_DIR`) | keyed by value | keyed by presence |
| a read changed while the action ran | not stored | stored under the stale key |
| a declared output is missing, or an undeclared path changed | the action fails | reverted for write-mode rules only |
| tier `irreversible` (a deploy, a publish) | never cached; started at most once per idempotency key | `Outward`: never cached |
| a Nix environment is declared | its store path is a `layers` entry | `layers: []` |
| model output (`LlmLint`, `Docs.Page`, an agent step) | sealed in the run's journal, never shared | never replayed |

**Three kinds of reuse stay separate** (Astra): *durable replay* (this run already sealed the step), *build reuse* (another authorized run produced this key's verified outputs, within a trust partition), and *download acceleration* (a package store, verified by its own integrity data). A warm directory is never a successful build result. Readers are untrusted; writers are post-merge only, with separate credentials that the server enforces (`packages/smithers/build/infra/CACHE-TRUST.md`).

`smthrs explain //pkg:t` prints this material, the stored key's material, and the first field that differs.

### 6.6 Durability

| Thing | Durable how |
|---|---|
| A build | the `build/run` journal: a resumed run settles finished targets from the journal or the cache, and re-runs in-flight sealed actions, which are safe to repeat |
| A target's side effects | sealed: confined to its write set and verified. Irreversible (a deploy): an idempotency key, never retried blindly |
| A long command (over 600 s) | `ExternalJob` over a `JobHost`: start once, poll status, collect, cancel; a lost job is reported as lost, never silently replayed |
| A cron | a `triggers/Tick` lineage: one `Scheduler.runOnce` step, a durable sleep, the next round; each occurrence starts once under its claim key (`packages/smithers/agent/triggers/src/Scheduler.ts:439-440`) |
| A webhook | verified, deduplicated by delivery id, matched against active bindings, started with `Flow.ensure` keyed by binding and delivery |
| An activation | `plugin/refresh` by compare-and-set; last-known-good kept on failure (0017 §10) |
| A concurrency group | the group is a row; a new run interrupts the old one (`cancelInProgress`) or queues behind it; an irreversible step in flight finishes first |
| Cancellation | two phases: the request is persisted, then the job's real settlement; a toast settles only on the second (root `AGENTS.md`, "Instant chat") |

Durability isn't exactly-once execution. A sealed action may run again after a crash before its result commits; that is why only sealed work is retried and irreversible work carries an idempotency key or a read-back.

## 7. Orchestration libraries that earn their place

A library earns a place above Effect when it holds a protocol or an invariant that plain Effect doesn't give you and that more than one caller needs. Five do. Everything else is Effect plus `@smthrs/flow`.

### 7.1 The build graph: `@smthrs/targets` and `@smthrs/build-cli`

**API.** `Target.make`, `Target.toLayer`, `S.Package`, `S.Workspace`, `S.file`, `S.glob`, `S.tree`, `Build.run`, `Build.target`, the catalog (`TsBuild`, `Typecheck`, `Vitest`, `NodeTest`, `EsLint`, `Dprint`, `Shell.*`, `Cargo.*`, `Go.*`, `Docker.*`, `Generate`, `Docs.Check`, `TargetIndex`, `ImportRules`, `JevLint`, `LlmLint`), and the verbs `build`, `test`, `lint`, `docs`, `run`, `ci`, `affected`, `query`, `graph`, `explain`.

**Why it isn't just Effect.**
1. **Memoization across processes and machines, keyed by file content.** `Effect.cached` lives in one fiber's memory. A build result must survive the process, cross machines, and refuse to replay when anything that could change it moved.
2. **A plan before running.** Selection by label and pattern, `affected`, `query`, `explain` and the committed index read the graph without running it. An Effect program reveals its steps only by running.
3. **A label namespace.** One value, one label; privacy by omission.
4. **Sandbox construction from declarations.** Effect supplies `FileSystem` and `ChildProcessSpawner`; deciding which paths each may touch from a target's attrs is the build graph's job.
5. **Generated files with drift checks.** Write under `run`, fail under `lint`, one convention for every generator.

### 7.2 Triggers and events: `@smthrs/triggers`

**API.** `On.*`, `Trigger.bind`, `Report.commitStatus` (5.7), over the library's existing `Trigger`, `Cron`, `Schedule`, `Scheduler.runOnce`, `SqlTriggerStore` and `Webhook`.

**What it adds now.**
- A declaration surface that takes flow values and traces `input` into `Args`.
- Event sources for every installed repository: `push`, `pull_request`, `issues`, `issue_comment` and run events. Today the webhook route serves one repository and starts no flow on a push or a pull request.
- A host: a `triggers/Tick` lineage on the `FlowExecution` Durable Object. One step calls `Scheduler.runOnce`; then a durable sleep and the flow's `.to` for the next round. `Scheduler.layer`'s forever fiber is a job loop DUR-3 forbids.
- Admission, in five steps (Sol): verify the delivery and persist a bounded envelope keyed by delivery id, and return "requested"; resolve the active snapshot and its eligible bindings (a fork can't choose trusted configuration); pin the source revision, executable digest and principal, and project `input`; claim the occurrence `(installation, binding revision, delivery or scheduled instant)` once; start or resume the run with `Flow.ensure`.
- Concurrency groups as persisted rows: `cancelInProgress` interrupts the older run and records why, and an irreversible step in flight finishes before the interrupt lands (Astra).
- `Report.commitStatus` (7.6).

**Why it isn't just Effect.** `Schedule` and `Effect.repeat` live in one process and die with it. A trigger must start each occurrence exactly once across restarts and replicas, replay missed occurrences by policy, deduplicate webhook deliveries, decide trust from the event's origin, and survive a deploy between the event and the start.

### 7.3 Plugins and activation: `@smthrs/plugin`

**API.** `Plugin.make` (5.8), compiled to 0017's `Plugin.Manifest`; `plugin/refresh` activates it.

**Why it isn't just Effect.** Activation is state, not computation: which revision of which flow and trigger is live per repository, moved by compare-and-set when a person merges, kept at last-known-good when the candidate fails a check, read by the host without running repository code, and gated by an Admin's grants for secrets (0017 §9-10). That is Alchemy's plan, apply and state per stage, and Effect has none of it.

**Plan and apply, concretely.**

```
$ smthrs definitions plan --stage main
repository smithersai/smithers   candidate 3f2a9c1 (factory.json)   active 7b96f87
  + trigger  repository/ci-pr          github.pull_request → ci   cancel in progress · trust head · status smithers/ci
  ~ flow     repository/ci             executable 41c9… → 9e07…
  ~ trigger  repository/security-audit cron "0 2 * * *" → "0 3 * * *" (UTC · overlap skip · catch-up none)
  - trigger  repository/weekly-suggest  (tombstone: a delayed delivery starts nothing)
  = home · github policy · 5 flows · 1,273 targets
1 to add, 2 to change, 1 to remove
```

| Stage | Where | State | Applied by |
|---|---|---|---|
| `local` | this machine | `SqlTriggerStore` rows in the cache directory | `smthrs definitions apply --stage local` |
| `main` | Smithers cloud | 0017's `plugin_installations` and trigger rows in Postgres | a person's merge, through `plugin/refresh`; never an agent |
| `preview` | a pull request's head | none | never; the plan shows on the pull request card |

Apply is one durable system flow (`plugin/refresh`): it builds the snapshot, checks it, swaps it by compare-and-set only when the candidate's commit descends from the active one, writes tombstones for removed triggers, and settles on a read-back receipt. A failed candidate leaves the previous snapshot active and shows `Merged · not active`.

### 7.4 External jobs: `ExternalJob` plus a `JobHost` per machine kind

**API** (Sol, Astra). `JobHost` is a service a host Layer provides; `ExternalJob` (exists: `start`, `status`, `collect`, `cancel`, `F/ExternalJob.ts:91-116`) drives it.

```ts
export class JobHost extends Context.Service<JobHost, {
  readonly start: (manifest: ExecutionManifest, idempotencyKey: string) => Effect.Effect<JobHandle, JobError>
  readonly inspect: (job: JobHandle) => Effect.Effect<JobStatus, JobError>      // running | succeeded | failed | cancelled | lost
  readonly cancel: (job: JobHandle) => Effect.Effect<void, JobError>
}>()("@smthrs/sandbox/JobHost") {}
```

**Why it isn't just Effect.** A command that outlives a dispatch needs a stable launch key, a durable wait, reconnect after the coordinator restarts, honest loss reporting, and fenced generations so a superseded job can't publish. An irreversible command whose outcome is unknown is reconciled, never replayed blindly. `ExternalJob` already owns that pattern; `JobHost` is the per-machine adapter (local process, job container, phase B executor).

### 7.5 Policy patterns: `@smthrs/patterns`, trimmed

**Keep** the declared forms of the other 21 patterns, among them `ReviewLoop`, `Escalation`, `Saga`, `MergeQueue`, `Burndown`, `Supervisor`, `Trellis`, `Panel`, `Debate`, `Sidecar`, `Runbook` and `CheckSuite`. Each encodes a policy (stall breakers, compensation order, queue fairness, a model-authored plan's envelope) and declares its worst-case graph before it runs. The rest (`MapReduce`, `Recursion`, `Kanban`, `Quarantine` and others) take the same test during migration.

**Delete** the six that restate an engine primitive: `WithRetry` (`RetryPolicy`), `WithCache` (`Action.withCache`), `TryCatchFinally` (`Node.catch` plus `Effect.ensuring` in a handler), `Loop` (`Flow.to` with `maxRounds`), `WithApproval` (`HumanTask`), `Bounded` (`Node.all({ concurrency })`). Delete every pattern's executed `run` form too: an executed pattern bypasses the journal (DUR-1).

### 7.6 Commit statuses (GH-10): a system flow, not a library

`checks/status` is one system flow over 0017's run events: it observes `run.started` and `run.settled` of a run its trigger started with `report: Report.commitStatus()`, and writes `POST /repos/{owner}/{repo}/statuses/{sha}` with context `smithers/<flow>`. It is write-only; it never reads a check run or an Actions result (M-52). Its idempotency key includes the repository, SHA, context, run generation and transition, and it refuses a write from a run older than the context's current generation, so a superseded run can't overwrite a newer result (Sol, Astra). A failed status write is retried as durable work; a passed check with an unwritten status shows as such.

### 7.7 What deliberately gets no library

- **CI jobs.** The parity proposal's `CiJob` models GitHub's job with steps. Here a job's steps are targets, its machine is a placement, and its setup is the image, so a job adds no concept. A repository with no `PACKAGE.ts` writes `Shell.*` targets (8.6).
- **A definitions engine with its own state store.** The committed manifest is the candidate, `plugin/refresh` is the apply, 0017's installation snapshot is the state.
- **Alchemy in definitions.** Its ideas are borrowed (logical ids, Layers as providers, plan before apply, stages); its package is confined to infrastructure.
- **A JSX or builder DSL, or `Flow.gen`.** Effect is the authoring contract ("Hiding Effect requires a new abstraction layer", `186e86d85b96:PLAN.md:132`); VibeLang removes the boilerplate.
- **A generic `Ci.sequence`, `Factory.parallel` or `Workflow.retry`.** Each would duplicate `Effect`, `Node` or the engine (Sol).

## 8. Worked examples, today versus proposed

Each example shows today's code with citations, then the proposal. `NEW` marks an API that doesn't exist yet. `VL/` is `~/effectscript/`; `TV/` is `~/tevm-monorepo/`.

### 8.1 VibeLang's docs generation (FLOW-9's named case)

**Today.** `VL/.smithers/flows/docs/` declares a correct flow, then hand-rolls everything a target supplies. VibeLang has no `WORKSPACE.ts` or `PACKAGE.ts`, so `smthrs` can't run it.

```ts
// VL/.smithers/flows/docs/flow.ts:11-21
export const Render = Action.make("docs/Render", { implementationVersion, payload, success })
export const layer = Render.toLayer(({ sources }) => Effect.sync(() => render(sources as Sources)), { implementationVersion })
export default Flow.make("docs", { …, effects: { reads: [], writes: [] }, body: Node.capture({ … }, (input) => Render.call(input)) })

// VL/.smithers/flows/docs/run.ts (56 lines)
export const generatorInputs = [/* the generator's own files, by hand */]                   // :16
export async function identity(sources) { /* sha256 of generatorInputs + sources, README footer stripped */ }   // :22-29
const runtime = Interpreter.layerWithImplementations(docs, layer).pipe(                     // :31-39: a composition root
  Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(Layer.succeed(Crypto.Crypto, syncCrypto)))
const outputs = await Effect.runPromise(docs.execute({ sources }, { executionId: `docs-${id.digest}` }).pipe(Effect.provide(runtime)))
// :40-44 build a manifest; :49-53 write each output; :54 write .smithers/generated.json

// VL/.smithers/package.json:6-7
"docs:generate": "bun run flows/docs/run.ts", "docs:check": "bun test ./flows/docs/check.test.ts"
```

Every part of `run.ts` re-implements a build-graph feature: the composition root (the host's job), `generatorInputs` (an import closure kept by hand, which misses any new import of `render.ts`), the digest (the cache key), `generated.json` (a second stamp format), and `check.test.ts:8-21`'s re-run-and-compare (the `lint` drift check). The flow declares `reads: []` because its I/O happens outside it.

**Proposed, slice 0: this week, with today's API.**

```ts
// VL/.smithers/WORKSPACE.ts: new file
import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Bun({ version: ">=1.4.0" })
export const Workspace = S.Workspace("vibelang", {
  repository: "<the repository's git URL>",
  runtime,
  packageManager: S.PackageManager.BunPackages({ runtime }),
  cache: S.Cache({ directory: ".flows" }),
})

// VL/PACKAGE.ts: new file
import { Smithers as S } from "@smthrs/targets"
const docs = S.Generate({
  summary: "Regenerate and drift-check CONTRIBUTING, MAINTAINERS and both AGENTS.md from project.ts.",
  featured: true,
  script: S.file(".smithers/flows/docs/run.ts"),            // run.ts cut to "read, run, write"
  data: [S.glob(".smithers/flows/docs/*.ts"), S.file(".smithers/package.json"), S.file(".smithers/bun.lock"),
         S.file("README.md"), S.file("docs/user/llms-essentials.md")],
  changes: ["README.md", "CONTRIBUTING.md", "MAINTAINERS.md", "AGENTS.md", "templates/app/AGENTS.md"],
})
export const Package = S.Package({ targets: { docs } })
```

A `script` runs under the workspace runtime (`packages/smithers/build/targets/src/Shell.ts:244-247`), so the new `WORKSPACE.ts` declares Bun. Deleted now: `run.ts`'s identity and manifest code, `generated.json`, the drift half of `check.test.ts`, and both scripts.

**Proposed, with `S.Generate({ flow })` (NEW).**

```ts
// VL/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import Docs from "./.smithers/flows/docs/flow.ts"

const docs = S.Generate({
  summary: "Regenerate and drift-check CONTRIBUTING, MAINTAINERS and both AGENTS.md from project.ts.",
  featured: true,
  flow: Docs,                                               // its exported `layer` is loaded as the registry does
  data: { sources: { "README.md": S.file("README.md"), "docs/user/llms-essentials.md": S.file("docs/user/llms-essentials.md") } },
  changes: ["README.md", "CONTRIBUTING.md", "MAINTAINERS.md", "AGENTS.md", "templates/app/AGENTS.md"],
})
export const Package = S.Package({ targets: { docs } })
```

- `smthrs run //:docs` writes the five files; `smthrs lint //:docs` fails on drift; the `ci` flow runs the lint with every other target.
- The key covers `flow.ts`'s import closure (so `render.ts` and `project.ts`) and the lockfile, so a new import can't go stale the way `generatorInputs` can.
- `README.md` is read and written. `render` strips the old footer before counting (`VL/.smithers/flows/docs/render.ts:46`, `:63`), so a second run writes identical bytes. Astra's caution holds: if a future render can't be made idempotent, split the README into a source region and a generated region.
- **Deleted:** `run.ts` (56 lines), `generated.json`, `check.test.ts`'s re-run assertions, both scripts. Its fact-strictness and template-size assertions stay, as unit tests of `render`. `project.ts`, `render.ts` and `flow.ts` stay.

### 8.2 A TypeScript package build and test, with file dependencies

**Today.**

```ts
// packages/effect-electric/PACKAGE.ts:1-13, 46-48
import { BuildAndCheckTypeScriptPackage, SdkRules } from "@smthrs/repo-targets"
import { Package as tanstackDb } from "../effect-tanstack-db/PACKAGE.ts"
const cwd = "packages/effect-electric"
const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [tanstackDb.lib], sources: Input.glob("{src,examples}/**/*.ts"), cwd
})
export const Package = Smithers.Package({ targets: { check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test, ...securityReview } })
```

`effect-electric`'s `lib` keys on `tanstackDb.lib`'s action key (`B/Planner.ts:816-820`) and reads `effect-tanstack-db`'s `dist/` because the read set includes every transitive dependency's output directories (`BI/PackageRunner.ts:164-183`). A comment edit in `effect-tanstack-db/src` rebuilds both packages and reruns every downstream test.

**Proposed.** The package file changes one line; the macro and the rule change underneath.

```ts
// packages/effect-electric/PACKAGE.ts
const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [tanstackDb.lib.outputs.dist],                      // NEW: an artifact, not a target
  sources: S.glob("{src,examples}/**/*.ts"), cwd
})

// @smthrs/targets/TsBuild: the rule now names its output (NEW field)
export const TsBuild = Target.make("TsBuild", {
  attrs: { srcs: Schema.Array(Read), deps: Schema.optional(Schema.Array(Read)), outDir: Schema.String, /* … */ },
  kinds: ["build"],
  implementationVersion: "ts-build/1",
  outputs: (attrs) => ({ dist: S.tree(attrs.outDir) }),
  cache: true,
})
```

- **The edge names an artifact.** `effect-electric`'s sandbox reads `effect-tanstack-db/dist/` and nothing else of that package.
- **Early cutoff.** The key carries `dist/`'s digest (6.4), so a comment-only edit upstream rebuilds `effect-tanstack-db` and then hits the cache for `effect-electric`'s `lib` and `test`.
- **A target still works as an edge.** `deps: [tanstackDb.lib]` keeps meaning "order and identity"; during migration it also keeps today's broad grant, marked non-shareable, until each consumer names its artifact (Sol).
- 57 `PACKAGE.ts` files call this macro; changing it changes all of them at once.

### 8.3 Smithers' `ci.yml`

**Today.** `PACKAGE.ts:580-1119` declares `Smithers.GithubCiGen({ … })`, rendered to a 1,773-line `.github/workflows/ci.yml` with 15 jobs. Each job repeats checkout, Node, pnpm, Go, Foundry, Docker, jj, ripgrep, bubblewrap and Postgres setup, then runs targets:

```yaml
# .github/workflows/ci.yml:126-132
- name: "Workspace targets"
  if: ${{ !cancelled() && steps.setup.conclusion == 'success' }}
  run: "pnpm exec smthrs ci '//packages/...' --jobs 2 --known-red '.github/ci-known-red.json' --verbose --results-file \"$RUNNER_TEMP/smthrs-results/$GITHUB_ACTION.json\""
```

It runs on pushes to `main` and on pull requests, cancels in-progress runs only for pull requests, and reads contents only (`ci.yml:1-10`). A failed step doesn't skip the next (`:127`); results upload always (`:133-139`); the `packages` matrix doesn't fail fast and its macOS and Windows legs are advisory (`:1392-1407`).

**Proposed, phase A.**

```ts
// .smithers/flows/ci/flow.ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Build, BuildReport } from "@smthrs/targets"
import { Effect, Schema } from "effect"

// Phase A only: the old jobs' label sets, so wall-clock time matches GitHub's runners. Phase B deletes this table.
const partitions = {
  packages: ["//packages/..."],
  repository: ["//.smithers/...", "//packages/repo-targets/..."],
  apps: ["//apps/..."],
  backend: ["//:backendGo", "//:backendGoAccess", "//packages/backend/..."],
  native: ["//packages/smithers/flows/jj-wasm/...", "//:nativeFfi"],
} as const

export default Flow.make("ci", {
  description: "Every target, on every push to main and every pull request.",
  capabilities: ["build:run"],
  modelInvocable: false,
  payload: { repository: Schema.String, sha: Schema.String },
  success: Schema.Record(Schema.String, BuildReport),
  body: ({ repository, sha }) => Effect.gen(function* () {
    return yield* Node.all(Object.fromEntries(Object.entries(partitions).map(([name, patterns]) => [name,
      Build.run({ verb: "ci", patterns, at: { repository, sha }, knownRed: ".github/ci-known-red.json", placement: "linux-x64" })
    ])))
  }),
})

// .smithers/FACTORY.ts (inside Plugin.make)
triggers: {
  "ci-push": Trigger.bind({ flow: Ci, on: On.push({ branches: ["main"] }),
    input: (e) => ({ repository: e.repository, sha: e.after }), report: Report.commitStatus() }),
  "ci-pr": Trigger.bind({ flow: Ci, on: On.pullRequest(),
    input: (e) => ({ repository: e.repository, sha: e.pullRequest.head.sha }),
    concurrency: { group: (e) => e.pullRequest.number, cancelInProgress: true }, report: Report.commitStatus() }),
},
```

| `ci.yml` construct | Where it goes |
|---|---|
| `on: push main / pull_request`; cancel on pull requests only (`:1-10`) | the two triggers; the group is the pull request number |
| 15 jobs | 5 partitions in phase A; none in phase B |
| setup rendered into each job | the `linux-x64` platform's image, built from `flake.nix`; its digest is toolchain identity |
| `if: !cancelled() && setup == success` | `Build.run` settles a row per target and never fails |
| `--known-red` | `knownRed` (`B/KnownRed.ts`) |
| `SMITHERS_CACHE_NAMESPACE: pr-<n>` | step-cache scope: a pull request reads `main`'s entries and writes its own namespace |
| results upload `always()` | the run journal and `BuildReport` |
| `packages` matrix, advisory macOS and Windows legs | ticket `ci-parity-advanced-runners` (FLOW-8 permits tickets) |
| required checks | `Report.commitStatus()` writes `smithers/ci` (GH-10) |

**Parity roster** (Sol). Every job needs a destination before `ci.yml` is deleted:

| Job (`ci.yml` line) | Destination |
|---|---|
| `test` (12) | partition `packages`; the 180-minute bound becomes `Build.run`'s deadline |
| `repository` (140) | partition `repository`; each check settles independently |
| `scripts` (460) | partition `repository` |
| `docs` (754) | `//...` docs targets; deterministic only, no model authoring |
| `apps-e2e` (803), `apps-browser-1..3` (920, 1010, 1100) | partition `apps`, keeping the three shards' selections |
| `rust` (1190), `rust-ffi` (1251), `wasm-repro` (1309) | partition `native` |
| `browser` (1355) | partition `packages` |
| `packages` (1392) | Linux legs in `packages`; macOS and Windows legs ticketed, shown as unsupported, never green |
| `go-backend` (1529), `go-backend-access` (1654) | partition `backend`, 190-minute bound; old-stack regression only, no new product work |

No `affected` on pull requests, deliberately. Today's pull request CI runs every target; with a shared cache an unchanged target is a hit that still reports its verdict, so the required check stays complete. **Deleted at the end:** `ci.yml`, `drift.yml`, the `GithubCiGen` declarations and the five renderer modules. Publishing stays on GitHub as one hand-written workflow (GH-9).

### 8.4 Tevm drops Nx (OTHER-5)

**Today.** Nx owns the task pipeline:

```jsonc
// TV/nx.json:41-43, 60-63, 82-86
"test":       { "dependsOn": ["^build:dist", "pretest"], … },
"typecheck":  { "dependsOn": ["^build:types"], … },
"build:dist": { "dependsOn": ["^build:dist"], "outputs": [/* dist/**/*.js, cjs, mjs */], "cache": true }
```

The `^build:*` graph lives only in `nx.json`. Tevm's 68 `PACKAGE.ts` files (outside `vendor/`) declare per-package targets, but `TV/packages/actions/PACKAGE.ts:27`, for one, declares `deps` as a `Filegroup` of its own `package.json`, with no edge to a sibling package. The root wraps the Nx scripts in aggregate targets (`TV/PACKAGE.ts:148-198`) because "Current Flows executes every package target by exact label but does not yet expose a Query value inside PACKAGE.ts" (`:134-135`). 17 `package.json` scripts call `nx` (`TV/package.json:15-93`), and `nx` is a dev dependency (`:117`). `nx.json:161` holds an Nx Cloud access token. Tevm confines with bubblewrap (`TV/WORKSPACE.ts:86`) and declares the Smithers remote cache (`:103-110`), but CI never connects it: the setup action exports cache variables only when `cache-url` is set (`TV/.github/actions/setup/action.yml:34-38`), and `ci.yml:25` passes none.

**Proposed.** The `^` edges become explicit `deps`, written once by a codemod from each `package.json`'s workspace dependencies and kept honest by a lint target.

```ts
// TV/factory/TevmPackage.ts: a macro, as repo-targets' BuildAndCheckTypeScriptPackage is
export const TevmPackage = (o: { cwd: string; deps: ReadonlyArray<TevmLib> }) => {
  const sources = S.glob("src/**/*.ts")
  const dist = S.TsBuild({ srcs: [sources], entries: [S.file("src/index.ts")], deps: o.deps.map((d) => d.dist.outputs.dist),   // was ^build:dist
                           tsconfig: S.file("tsconfig.json"), format: "dual", outDir: "dist", cwd: o.cwd })
  const types = S.DtsBuild({ srcs: [sources], deps: o.deps.map((d) => d.types.outputs.types), outDir: "types", cwd: o.cwd })  // was ^build:types
  const typecheck = S.Typecheck({ srcs: [sources, S.glob("test/**/*.ts")], deps: [types.outputs.types], cwd: o.cwd })
  const test = S.Vitest({ tests: [S.glob("src/**/*.spec.ts")], sources: [sources], deps: [dist.outputs.dist], cwd: o.cwd })
  return { dist, types, typecheck, test }
}

// TV/packages/actions/PACKAGE.ts: the codemod writes `deps` from package.json
export const Package = S.Package({ targets: { ...TevmPackage({ cwd: "packages/actions", deps: [utils, errors, evm] }) } })

// TV/PACKAGE.ts: one lint target fails when a package.json workspace dependency has no matching `deps` edge
const workspaceEdges = S.NodeTest({ /* reads every package.json and PACKAGE.ts; compares */ })
```

| Nx feature Tevm uses | Replacement |
|---|---|
| `run-many --target=X` | `smthrs build //...`, `smthrs test //...` |
| `dependsOn: ["^build:dist"]` | artifact edges from `package.json` dependencies, committed and drift-checked |
| `inputs`, `namedInputs`, `outputs`, `cache: true` | declared reads, named `outputs`, content keys; `namedInputs` become `Filegroup`s |
| local cache `.nx/` | `.flows/` (action cache and CAS) |
| Nx Cloud | `build.smithers.sh` `/ac` and `/cas`, already declared in `TV/WORKSPACE.ts:103-110` |
| `affected` | `smthrs affected` for people and agents; CI runs every target and hits the cache |

**Deleted:** `nx.json` (rotate the committed token first), the 17 `nx` scripts, the `nx` dependency, the aggregate targets (`TV/PACKAGE.ts:148-198`). Live RPC tests declare their network and secrets and stay out of the shared cache (Sol, Astra).

### 8.5 A cron flow: the canary

**Today.** `.github/workflows/canary.yml` runs on two crons, `0 * * * *` and `15,30,45 * * * *` (`:43`, `:46`), and a dispatch with two inputs, `metered` and `force_failure` (`:47-56`). It never cancels a running canary (`:62-64`), and GitHub delivers "only a fraction" of the quarter-hour ticks (`:44-45`). It opens, comments on or closes an issue with `gh` from a shell `case` (`:194-212`). Separately, `FACTORY.ts:84` declares `"schedule:0 2 * * *": { flow: "security-audit" }`, which nothing runs.

**Proposed.**

```ts
// .smithers/flows/canary/flow.ts
export const Probe = Action.make("canary/Probe", {
  implementationVersion: "canary/1",
  nondeterministic: true,                                  // the live site: never cached
  payload: { metered: Schema.Boolean, forceFailure: Schema.Boolean },
  success: ProbeReport,
  attemptTimeoutMs: 15 * 60_000,
})
export const Alert = Action.make("canary/Alert", {
  implementationVersion: "canary-alert/1",
  tier: "irreversible",
  idempotencyKey: (p) => p.report.id,                      // one issue write per run, even after a resume
  payload: { report: ProbeReport },
  success: AlertOutcome,
})
// ProbeLive runs the uptime probe and the browser canary; AlertLive opens, comments on or closes
// "Canary: smithers.sh is failing" with @smthrs/integrations' GitHub actions (CommentOnIssue at github/Actions.ts:90).
export const layer = Layer.mergeAll(Probe.toLayer(runProbe), Alert.toLayer(raiseOrClear))

export default Flow.make("ops/canary", {
  description: "Probe smithers.sh; open, update or close the canary issue.",
  capabilities: ["sandbox:job", "github:issues:write"],
  payload: { metered: Schema.Boolean, forceFailure: Schema.Boolean },
  success: AlertOutcome,
  body: (input) => Effect.gen(function* () {
    const report = yield* Probe.call(input)
    return yield* Alert.call({ report })
  }),
})

// .smithers/FACTORY.ts (inside Plugin.make)
triggers: {
  "canary-hourly":   Trigger.bind({ flow: Canary, on: On.cron("0 * * * *", { overlap: "buffer-one" }), input: () => ({ metered: true, forceFailure: false }) }),
  "canary-quarters": Trigger.bind({ flow: Canary, on: On.cron("15,30,45 * * * *", { overlap: "buffer-one" }), input: () => ({ metered: false, forceFailure: false }) }),
  "canary-manual":   Trigger.bind({ flow: Canary, on: On.manual() }),           // the form is the payload schema
  "security-audit":  Trigger.bind({ flow: SecurityAudit, on: On.cron("0 2 * * *") }),   // UTC, skip, no catch-up
},
```

- GitHub's `concurrency` without `cancel-in-progress` is `overlap: "buffer-one"` in `@smthrs/triggers`' vocabulary (`packages/smithers/agent/triggers/src/Schedule.ts:20-76`).
- The durable tick delivers every quarter-hour occurrence, and each starts once under its claim key.
- The `gh` shell `case` becomes a typed, irreversible action with an idempotency key, so a resumed run never comments twice.
- Applying `main` makes the schedules live; committing the file alone doesn't.

### 8.6 A pull request check that writes commit statuses (GH-10)

The case GH-10 exists for: `Effect-TS/effect`'s `main` requires six checks, `Build`, `Static`, `Test (Node)`, `Types`, `Test (Bun)` and `Test (Documentation)`, all bound to the GitHub Actions app (`apps/mvp/docs/proposals/ci-cd-parity.md:263`). Effect has no `PACKAGE.ts`, so this example also shows a repository with no Smithers targets reaching parity with a short one.

**Today.** Smithers' `checks/Run` runs `.smithers/checks/<name>.sh` on a TODO attempt's machine and writes `runs` rows the Checks tab reads; "Checks never gate the merge: a person reads them and merges" (`M/worker/flows/Checks.ts:34-35`). Nothing writes a commit status.

**Proposed.**

```ts
// Effect-TS/effect: .smithers/WORKSPACE.ts declares Node, pnpm and node_modules, as Smithers' does (.smithers/WORKSPACE.ts:10-30)
// Effect-TS/effect: PACKAGE.ts, the six required checks as targets
import { Smithers as S } from "@smthrs/targets"
const sources = S.glob("packages/**")
const check = (shell: string, network?: "loopback") => S.Shell.Test({ shell, data: [sources], ...(network ? { sandbox: { network } } : {}) })
export const Package = S.Package({ targets: {
  static:   check("pnpm lint && pnpm jsdocs --check && pnpm circular"),
  types:    check("pnpm check && pnpm test-types --target '>=5.9'"),
  build:    check("pnpm build && pnpm check-dist-types"),
  testNode: check("pnpm test --max-concurrency=10", "loopback"),
  testBun:  check("bun run --bun vitest run --max-concurrency=10", "loopback"),
  testDocs: check("pnpm doctest"),
} })

// .smithers/flows/check/flow.ts
export default Flow.make("check", {
  description: "Static checks, types, build and tests: the checks main requires.",
  capabilities: ["build:run"],
  payload: { repository: Schema.String, sha: Schema.String },
  success: BuildReport,
  body: (at) => Effect.gen(function* () {
    return yield* Build.run({ verb: "test", patterns: ["//:static", "//:types", "//:build", "//:testNode", "//:testBun", "//:testDocs"], at, placement: "linux-x64" })
  }),
})

// .smithers/FACTORY.ts (inside Plugin.make)
triggers: {
  "check-pr": Trigger.bind({
    flow: Check,
    on: On.pullRequest({ branches: ["main", "v4/next-minor", "v4/next-major"] }),
    input: (e) => ({ repository: e.repository, sha: e.pullRequest.head.sha }),
    concurrency: { group: (e) => e.pullRequest.headRef, cancelInProgress: true },
    report: Report.commitStatus({ steps: ["static", "types", "build", "testNode", "testBun", "testDocs"] }),
  }),
},
```

```
pull_request synchronize (head 9e07…)
  ├─ admission: match the base's active snapshot → claim "check-pr:<delivery>" → Flow.ensure(check)
  ├─ checks/status sees run.started → POST /statuses/9e07…  smithers/check = pending (and each step)
  ├─ build/run settles rows → smithers/check/static = success, smithers/check/testNode = failure, …
  └─ run.settled → smithers/check = failure, with a link to the run page
the ruleset on main requires smithers/check/static … smithers/check/testDocs → the merge button waits on Smithers
```

- **Naming.** GH-10 approves statuses "named `smithers/<flow>`". Effect's ruleset needs six names, so `steps` adds `smithers/<flow>/<step>` beside the flow's own status. That extension is question 5.
- **Write-only and fenced.** The reporter writes statuses and reads nothing from GitHub's checks API (M-52). An older run can't overwrite a newer run's status for the same SHA and context (7.6).
- **Known gap.** Effect's integration tests need Docker for testcontainers (`ci-cd-parity.md:454`); until `ci-parity-docker`, `testNode` runs without them and checks less than today's required `Test (Node)`.

### 8.7 A plugin contributing a flow

**Today.** `release-notes` is `.smithers/flows/release-notes/flow.mdx`, featured by string in `.smithers/FACTORY.ts:39-43` (`flow: "release-notes"` at `:40`). It has no command and no trigger, and no other repository can install it.

**Proposed.**

```ts
// .smithers/flows/release-notes/flow.ts: a prompt flow is a code flow (FLOW-2)
export default Flow.make("release-notes", {
  description: "Draft release notes from the commits since the last tag, grouped by package.",
  capabilities: ["fs:read:**", "proc:spawn:git"],
  payload: { range: Schema.String },
  success: Notes,
  prompt: ({ range }) => `Draft release notes for ${range}. Run git log --format='%h %s' ${range}; group by package; one line per commit.`,
})

// .smithers/plugins/release-notes/plugin.ts: NEW
import { Plugin } from "@smthrs/plugin"
import { On, Trigger } from "@smthrs/triggers"
import ReleaseNotes from "../../flows/release-notes/flow.ts"

export default Plugin.make({
  id: "release-notes", title: "Release notes", version: "1.0.0", requires: { api: "^1" },
  capabilities: ["fs:read:**", "proc:spawn:git"],
  flows: { draft: { flow: ReleaseNotes, featured: true, summary: "Draft release notes since the last tag." } },
  commands: { draft: { flow: ReleaseNotes, title: "Draft release notes", slash: "release-notes" } },
  triggers: { "on-tag": Trigger.bind({ flow: ReleaseNotes, on: On.push({ tags: ["v*"] }), input: (e) => ({ range: e.range }) }) },
})
```

A projection target beside `//:factoryProjection` writes the manifest, and `lint` fails on drift. It is a valid 0017 `Plugin.Manifest` (`0017-everything-is-a-plugin.md:296-316`), with the `Trigger` row widened by this design:

```json
{ "apiVersion": 1, "id": "release-notes", "version": "1.0.0", "title": "Release notes",
  "description": "Draft release notes since the last tag.", "requires": { "api": "^1" },
  "capabilities": ["fs:read:**", "proc:spawn:git"], "owns": ["release-notes"],
  "contributes": {
    "commands": [{ "id": "release-notes/draft", "flow": "release-notes", "title": "Draft release notes", "minimum": "member", "slash": { "name": "release-notes" } }],
    "triggers": [{ "id": "release-notes/on-tag", "on": "github.push", "tags": ["v*"], "flow": "release-notes",
                   "executable": "sha256:…", "title": "Release notes on tag", "args": { "range": "$event.range" } }] } }
```

- The host reads this JSON and never runs `plugin.ts` (0017). A merge activates it through `plugin/refresh`.
- `input: (e) => ({ range: e.range })` compiled to `"$event.range"`. Writing `` `${e.from}..${e.to}` `` would fail at projection, because the host evaluates no code; a tag push's event carries `range` precomputed.
- **Another repository** vendors the same folder, published as a package, with `smthrs plugin add`, which records its digest in `.smithers/plugins.lock` (`0017:469-479`). A merge activates it and an Admin grants its secrets (0017 §10). Its flow acts with the installing repository's grants, never more.

### 8.8 An agent flow that runs in a branch sandbox

**Today.** The `todo` run's implement step is an agent action whose tools are bound in process to the attempt's machine (`M/worker/flows/TodoAgent.ts:16-20`); then `checks/Run` runs each `.smithers/checks/<name>.sh` on the same machine (`M/worker/flows/Checks.ts`). A tool command is capped at 600 seconds (`M/docs/features/sandbox-tools.md:19`). The proof runs in the same mutable box the agent edited, isn't cached, and computes nothing CI can reuse.

**Proposed.** The agent iterates in the branch box; the proof runs hermetically on a checkpoint commit, under the key CI will compute.

```ts
// .smithers/flows/fix-target/flow.ts
export default Flow.make("fix-target", {
  description: "Make one failing target pass on a branch, then prove it on a clean machine.",
  capabilities: ["sandbox:tools", "build:run"],
  payload: { repository: Schema.String, branch: Schema.String, target: Schema.String },   // "//packages/effect-electric:test"
  success: FixReport,
  body: ({ repository, branch, target }) => Effect.gen(function* () {
    const head = yield* Branch.Head.call({ repository, branch })                          // the commit the box started from
    const before = yield* Build.run({ verb: "test", patterns: [target], at: head })      // a cache hit if CI already ran it
    const work = yield* Implement.call({ repository, branch, goal: target, evidence: before })   // agent step; tools on the box
    const checkpoint = yield* Branch.Checkpoint.call({ repository, branch })            // the box's commit plus its patch, as a commit
    const after = yield* Build.run({ verb: "test", patterns: [target], at: checkpoint, placement: "linux-x64" })
    return { before, work, after }
  }),
})
```

```
browser engine (the person's tab)            FlowExecution DO                       containers
 fix-target ─ Branch.Head ─────────────────▶ ChatApi route
            ─ Build.run(test, head) ───────▶ build/run ── step-cache hit? ─────────▶ (none if CI ran this SHA)
            ─ Implement ─ sandbox/run, read, write ─▶ sandbox/Call ───────────────▶ branch box (mutable)
            ─ Branch.Checkpoint ───────────▶ checkpoint (commit + binary patch)      (M/worker/branch/Machine.ts:8-20)
            ─ Build.run(test, checkpoint, linux-x64) ─▶ build/run ───────────────▶ job container: checkout, confine, run
                                                           └─ AC + CAS ◀── outputs, verdict
a person opens the pull request at that commit → ci-pr runs → every target the agent proved is a cache hit
```

- **Two machines, two contracts.** The branch box is mutable and shared, so nothing it computes is cached. The job container sees only the commit and the declared inputs, so its verdict is shareable.
- **The agent never claims "tests pass" from its own box.** `after` is a `BuildReport` under the key CI computes, which makes FLOW-5's "the agent acts" checkable.
- **No 600-second cap on the proof.** A target runs as long as its declared timeout, through `ExternalJob`.
- **Model calls stay durable steps through the model proxy** (DUR-4, ARCH-5); the box runs tools, never a model loop. Merging stays a person's act (M-47).
- `Implement` is today's agent step; `Branch.Head` and `Branch.Checkpoint` are small new actions over `Machine.ts`'s checkpoints, which today save "the commit and a binary patch" so the working copy outlives the machine.

## 9. Inventory: implemented, needs a tweak, missing

**Implemented** works today as this design needs it. **Tweak** exists and needs the change in the last column. **Missing** doesn't exist. "Implemented" means the source exists; nobody ran its tests for this document.

### 9.1 The build graph

| # | Feature | Status | Where | Work needed |
|---|---|---|---|---|
| 1 | Labels, patterns, discovery, loading, the target index | Implemented | `B/Label.ts`, `B/PackageDiscovery.ts`, `B/PackageLoader.ts`, `B/PackageIndex.ts` | none |
| 2 | `S.Package({ targets })` as the declaration form | Implemented | `T/Package.ts:96-162` | none |
| 3 | The attr walk: targets as edges, inputs as key material | Implemented | `T/Target.ts:886-944` | also collect `Artifact` |
| 4 | Declared outputs, validated at declaration; capture and restore | Implemented | `T/Target.ts:87-196`; `BI/PackageRunner.ts:703` | none |
| 5 | Rules implemented by a Layer (`Target.toLayer`), one action per target | Missing | `T/Target.ts:1397` is the base | wrap `Action.make`; add `implementationVersion`, `outputs`, `network`, `tier`, `flow` |
| 6 | Catalog rules on one route | Tweak: two routes | `T/*.ts`; `BI/PackageRunner.ts:2108-3130`; 67 `notImplemented(` calls | move each native and switch case into its rule's Layer, one family at a time |
| 7 | Typed outputs (`Artifact`, `target.outputs`) | Missing | `T/Filegroup.ts:33-34` says there is no output model | the value, the walk, the planner |
| 8 | Early cutoff: key on output digests | Tweak: three rules do it | `BI/PackageRunner.ts:2068-2094` | generalize to every artifact edge |
| 9 | One file model | Tweak: two | `P/FileSet.ts:118-121` vs `T/Input.ts:29-32` | delete `Input`'s file types; move expansion to the Node host |
| 10 | Lazy cross-package globs; no load-time reads | Missing | root `PACKAGE.ts:12`, `:21-34`; `.smithers/flows/PACKAGE.ts:486-497` | planner expansion; `.smithers/cross-package-globs.json` as the allowlist; a lint rule |
| 11 | `@smthrs/targets` platform-neutral | Missing: 33 files import `node:*` | `docs/libraries.md:158` | declarations neutral; expansion and executors move to `build-cli` and `platform-node` |
| 12 | Process confinement: bubblewrap, seatbelt, Docker, fail closed | Implemented | `PS:918-1207`; `T/Exec.ts:1374-1415` | strict seatbelt for builds (`PS:1040`) |
| 13 | Smithers confined by default | Missing | `.smithers/WORKSPACE.ts:62-69` | delete `default: S.Sandbox.None()`; fix undeclared reads; `None({ reason })` where real |
| 14 | In-process confinement (`WorkspaceSandbox`) for rule code | Tweak | `packages/smithers/flows/engine-store/src/WorkspaceSandbox.ts:6-9`; wired on Node only | seed it from a target's reads; part of the target's sandbox Layer |
| 15 | Write-set verification for every rule | Tweak: write-mode rules only | `BI/PackageRunner.ts:1182-1317` | apply to `Shell.Build` and `Shell.Test` |
| 16 | Re-digest reads before storing | Missing | `BI/PackageRunner.ts:678-700` checks executables only | add |
| 17 | Inherited variables keyed by value | Missing | `BI/PackagePlanner.ts:2904-2911` keys presence | key the allowlist (`T/Exec.ts:479-497`) by value |
| 18 | Nix or image identity in the key | Missing | `layers: []` at `BI/PackagePlanner.ts:2758`, `:3017`; `B/NixExec.ts:467` never called | wire it |
| 19 | Action cache | Tweak: two caches | `B/Cache.ts`; `@smthrs/step-cache` | fold the build's store into step-cache |
| 20 | Remote CAS from the CLI | Missing; the server has it | `B/Cache.ts:1306-1429`; `packages/smithers/build/infra/worker/protocol.ts:1643-1655`, `:1709` | `PUT`/`GET /cas`, `findMissing` |
| 21 | Remote publish, gated on enforcement | Implemented, never triggered in Smithers | `BI/PackageRunner.ts:662-676` | follows from row 13 |
| 22 | `build/run` as a durable flow | Missing | `B/TargetExecution.ts:48-111` | the system flow of 6.1, behind the benchmark gate |
| 23 | `explain` with full key material and a diff | Tweak | `B/Cli.ts:1173-1220`, `:1359-1370` | print and diff |
| 24 | `affected` | Implemented | `B/Affected.ts` | swap `git` (`:51-91`) for an injected changed-file service over jj |
| 25 | Generated files with drift checks | Implemented | `T/Compose.ts:158-185`, `:938`; `T/GeneratedFile.ts` | one verb convention for every generator |
| 26 | `S.Generate({ flow })` | Missing | `T/Compose.ts:171-185` | the selector; load the flow's `layer`; key its import closure |
| 27 | `target-index.json` | Implemented | `PACKAGE.ts:281-285` | none |
| 28 | ImportRules, Jev rubrics, LlmLint, SecurityReview | Implemented | `packages/repo-targets/src/ImportRules.ts:91-107`; `T/JevLint.ts`; `T/LlmLint.ts`; `T/SecurityReview.ts` | `SdkRules` for `@smthrs/targets` and `build-cli`; no reads at declaration |
| 29 | One secrets egress for builds and sandboxes | Tweak | `T/SecretProxy.ts` (957 lines) beside `@smthrs/secrets` (`docs/libraries.md:83`) | a loopback host in `@smthrs/secrets`; delete `SecretProxy` |
| 30 | `apps/mvp` build, tests, e2e and deploy as targets | Missing | `apps/mvp/package.json` scripts | `Shell.*` targets; deploy as an irreversible `run` target |

### 9.2 Flows and machines

| # | Feature | Status | Where | Work needed |
|---|---|---|---|---|
| 31 | `Flow.make`, `Action.make`, `Node`, journal, step cache, durable waits, rounds, ceilings | Implemented | `F/`; `P/` | none |
| 32 | `Node` as an Effect; the `Plan` service; `Effect.gen` bodies | Missing | `P/Node.ts`; `F/Flow/make.ts:124-135` | `Effectable.Prototype` on nodes; `Graph.build` and the realm provide `Plan`; a codemod for the 53 `flow.ts` files and `apps/mvp/worker/flows/` |
| 33 | `Node.all({ concurrency, after })` | Tweak: the IR has the fields | `P/Node.ts:336`; `P/Plan.ts:160`; `P/Scheduling.ts:105-109` | surface `dependsOn` and a group-scoped admission bound |
| 34 | One file-boundary shape | Tweak: two | `F/Action/FileBoundary.ts:26-58` vs `P/Effects.ts:147-177` | merge |
| 35 | `budget` kept on the `Flow` value | Tweak: dropped | `F/Flow/make.ts:95-100`, `:275-296` | store and enforce |
| 36 | `Build.run`, `Build.target` | Missing | none | a system flow and two step constructors |
| 37 | Placement and `Hosts` | Implemented in the SDK | `P/Placement.ts`; `packages/smithers/flows/engine/src/Hosts.ts` | bind `platforms` to container hosts |
| 38 | Child flows on Cloudflare | Implemented | `packages/smithers/flows/platform-cloudflare/src/ExecutionObject.ts:539-546` | correct the stale `apps/mvp/docs/features/remote-flows.md:95` |
| 39 | `SandboxedFlow` | Tweak: unwired | `packages/smithers/flows/platform-node/src/SandboxedFlow.ts`; only an example calls it | wire for flows that need a machine |
| 40 | QuickJS realm host for repository flow plans | Missing | decision 0017 slice 5 (`0017:733`) | as 0017 designs it; the realm provides `Plan` |
| 41 | Job container, phase A | Missing | parity gaps (`ci-cd-parity.md:98-121`) | a job container class, a CI image from `flake.nix`, the checkout |
| 42 | Executors, phase B, with `ExecutionManifest` | Missing | none | input-root staging from the CAS; executor Durable Objects implementing `JobHost` |
| 43 | Long commands as `ExternalJob` over a `JobHost` | Tweak: the pieces exist | `F/ExternalJob.ts:91-116`; `sandbox/run` caps at 600 s (`apps/mvp/docs/features/sandbox-tools.md:19`) | the `JobHost` adapters |
| 44 | Run view for Cloudflare runs | Missing | parity gap; the Runs page reads only the device's engine | an inspection route the run page reads |
| 45 | Patterns trimmed to policies | Tweak | `packages/smithers/flows/patterns/src/` | delete six; migrate `WithApproval`'s 3 and `Bounded`'s 17 example callers |

### 9.3 Triggers, plugins and repositories

| # | Feature | Status | Where | Work needed |
|---|---|---|---|---|
| 46 | Trigger engine: cron, overlap, catch-up, claims, webhooks | Implemented as a library | `packages/smithers/agent/triggers/src/` | none |
| 47 | `On.*`, `Trigger.bind` with flow values and traced `input` | Missing | `.smithers/FACTORY.ts:63-89` is the string form | the declaration surface; tracing into `Args` |
| 48 | A host for cron | Missing | `apps/mvp/worker/github/Reconcile.ts:19-20` | the `triggers/Tick` lineage on `FlowExecution` |
| 49 | GitHub events start flows, for every installed repository | Tweak: one repository; issues and pull requests only | `apps/mvp/worker/github/Api.ts`; `Config.ts:5-7` | push, tag and comment events; many repositories; admission against active bindings |
| 50 | Concurrency groups, path filters | Missing | parity gaps | persisted group rows; `affected` for paths |
| 51 | Commit statuses (GH-10) | Missing: no status code anywhere | `packages/smithers/agent/integrations/src/github/` has `CheckRun` (`Actions.ts:513-539`), which the app bans | `checks/status` system flow; `statuses: write` on the GitHub App; generation fencing |
| 52 | Manual runs with typed inputs | Tweak: a person's flow takes one string | `apps/mvp/docs/features/flows.md:149-157` | a form from the payload schema |
| 53 | `Plugin.Manifest`, loader and host contract | Missing: designed and approved | 0017 slice 1 | as 0017 builds it |
| 54 | `Plugin.make` → manifest projection | Missing | none | one projection target per plugin |
| 55 | `plugin/refresh` activation with snapshots and tombstones | Missing | 0017 §10 (`0017:452`) | 0017 slice 5 |
| 56 | `smthrs definitions plan` and `apply` | Missing | none | the CLI over `plugin/refresh` and `SqlTriggerStore` |
| 57 | `FACTORY.ts` projection | Implemented, as `S.Factory` | `.smithers/FACTORY.ts:6-8`; `T/Factory.ts` | re-target to `Plugin.Manifest`; delete `S.Factory`, `S.Flow`, `T/Home.ts` |
| 58 | VibeLang `WORKSPACE.ts` and `PACKAGE.ts` | Missing | `~/effectscript` | two files; delete `run.ts`'s digest and manifest, `generated.json`, the drift test and two scripts |
| 59 | Tevm sibling edges and Nx removal | Missing | `~/tevm-monorepo/nx.json`; `packages/*/PACKAGE.ts` | the macro, the codemod, the edge lint; delete Nx |
| 60 | Smithers' `ci` flow | Missing | `PACKAGE.ts:580-1119` renders YAML today | example 8.3 |

**Tally.** 60 rows: 15 implemented, 16 need a tweak, 29 are missing. The engine, the process sandboxes, labels, `affected`, the trigger engine, placement and the plugin manifest's design all exist. What's missing is the glue that makes them one system (a target as an action, artifacts, `build/run`, trigger declarations and hosts, the manifest loader) and the switch that makes the hermetic claims true (confinement on, the remote CAS).

## 10. Migration

### 10.1 Order

Each slice lands on `main` with its tests and docs, is useful on its own, and deletes what it replaces in the same effort (SDK-11). Slices 0 to 3 change no authoring syntax. Slices 1, 4 and 7 have no dependency on each other and run as parallel lanes.

| # | Slice | Proves | Falsifier (fails on the old build) |
|---|---|---|---|
| 0 | **VibeLang's docs as a target, today's API.** `VL/.smithers/WORKSPACE.ts` and a root `PACKAGE.ts` with `S.Generate({ script, data, changes })` (8.1) | FLOW-9's named case, this week | `smthrs lint //:docs` fails after a hand edit of `CONTRIBUTING.md`; `smthrs run //:docs` writes the bytes `bun run docs:generate` wrote |
| 1 | **Confinement on in Smithers.** Delete `default: S.Sandbox.None()`; strict seatbelt; fix undeclared reads package by package; `S.Sandbox.None({ reason })` where a target needs the host; key the mechanism and allowlisted variables' values; re-digest reads before a store | the word "hermetic" | a confined `smthrs ci //...` passes on Linux and macOS; a deliberately undeclared read fails and names the path |
| 2 | **Remote CAS and early cutoff,** inside today's executor | sharing | build on machine A, delete `.flows`, build on machine B: every build target hits. A comment-only upstream edit leaves downstream targets as hits |
| 3 | **One file model and pure loading.** `FileSet` replaces `Input`'s file types; lazy `//` globs; no load-time reads; expanders move to `@smthrs/platform-node`, so `@smthrs/targets` imports in a browser | the loading phase is pure | `target-index.json` byte-identical; `@smthrs/targets` passes the browser and Worker import check |
| 4 | **`Node` is an Effect.** The `Plan` service; `Node.all({ concurrency, after })`; codemod C1 over every flow body; delete `bindPlanned`, `andThen` and the six patterns | Effect-native bodies VibeLang can erase | every chained body keeps its plan digest; every `bindPlanned` body shows only added ordering edges in `PlanDiff` |
| 5 | **Rules implemented by Layers.** `Target.toLayer` and `Target.make({ flow })`; `S.Generate({ flow })`, proven on VibeLang; move rule families one at a time (Shell, Generate, Cargo, Go, Docker, Agent); delete `Target.plan`, the 67 `notImplemented` calls, `BI/CoreRuleSelection.ts`, `BI/RulePolicy.ts`'s routing and the switch | one route | each family's targets produce the same verdicts and keys before and after; VibeLang's `run.ts` is gone |
| 6 | **`build/run` as a durable flow,** behind the benchmark gate (6.1); then delete `Executor.scheduleEffect`, `B/TargetExecution.ts` and `B/Cache.ts`'s store | durable builds | `kill -9` at minute N of `smthrs ci`; the rerun settles finished targets from the journal with the same verdicts and hit rate |
| 7 | **The repository plugin.** `Plugin.make`; the manifest projection; codemod C3 ports `FACTORY.ts`; delete `S.Factory`, `S.Flow`, `FlowCatalog`, `T/Home.ts`. Needs 0017 slice 1 | one interface (PLUGIN-1) | `FACTORY.ts` naming a deleted flow fails to typecheck; the five dangling flow names surface as errors |
| 8 | **Triggers and statuses.** `On.*`, `Trigger.bind`, `triggers/Tick`, events for every installed repository, concurrency groups, path filters, `checks/status`, `smthrs definitions plan` and `apply`; delete `S.Cron` and `smthrs triggers register`; `SecretProxy` folds into `@smthrs/secrets` | crons and events run | a removed and merged trigger starts nothing from a delayed delivery; a fork's pull request run has no secret in its egress audit; an older run can't overwrite a newer status |
| 9 | **Phase A and the `ci` flow.** The job container and CI image; port `ci.yml` and `canary.yml`; after the `ci` flow's verdicts equal GitHub's on the same 50 SHAs, delete the YAML and the renderers | FLOW-8 parity for Smithers | the parity roster (8.3) has a passing destination for every required row |
| 10 | **Tevm and Effect ports;** Nx deleted (OTHER-5) | parity beyond Smithers | Tevm's `smthrs ci //...` runs every target `nx run-many` ran, with zero `nx` invocations |
| 11 | **Phase B executors** | Bazel remote execution | `ci` over `//...` with no partitions beats phase A's wall clock |

**Why confinement is slice 1.** Every cache-sharing claim depends on it. Until it's on, remote publish is impossible by construction (`BI/PackageRunner.ts:662-676`), and early cutoff on unconfined builds would hide undeclared inputs behind cache hits. It needs no new API, so it starts the day this is approved. Its cost is unknown until measured: one confined `smthrs ci //...` run lists every undeclared read.

### 10.2 Codemods

- **C1, flow bodies.** `node.pipe(Node.bindPlanned((x) => rest))` becomes `const x = yield* node; rest`; `Node.andThen(a, b)` becomes `yield* a; yield* b`; the body becomes `(payload) => Effect.gen(function* () { … })`; hand-written requirement unions are deleted. Over `.smithers/flows/**/flow.ts` (53 files) and `apps/mvp/worker/flows/`. A ts-morph script in `packages/smithers/migrate`.
- **C2, files.** `Input.file`, `Input.glob`, `Smithers.file`, `Smithers.glob` keep their call sites and return `FileSet` values. Mechanical; expansion and digests don't change.
- **C3, the factory.** `S.Flow({ flow: "<id>", … })` becomes a `flows` entry with the imported value; each `on` row becomes `Trigger.bind` with the imported flow and a traced `input`; rows naming no flow are deleted and listed in the change; `S.Factory.Home` becomes `home`; `S.Github.Policy` becomes a setting. The "mythical history" commentary (`FACTORY.ts:65-74`) is deleted, not ported (TODO-2).
- **C4, artifact edges.** `deps: [producer]` becomes `deps: [producer.outputs.<name>]` only where the producer's declared outputs prove which files the consumer reads; elsewhere the codemod leaves the target edge and a diagnostic. It never converts a dependency silently (Astra).
- **C5, Tevm.** Nx's `^build:*` edges become explicit `deps` from each `package.json`; the global `S` shim (`/// <reference path="./smithers.d.ts" />`, `TV/WORKSPACE.ts:1`) becomes standard imports.

No codemod touches the shape of `PACKAGE.ts` files (question 2).

### 10.3 Deleted, by slice

| Slice | Deleted | Lines |
|---|---|---|
| 0 | VibeLang: `run.ts`'s digest and manifest code, `generated.json`, the drift half of `check.test.ts`, two scripts | ~60 |
| 3 | `Input.File` and `Input.Glob` types; load-time helpers in five `PACKAGE.ts` files | ~300 |
| 4 | `Node.bindPlanned`, `Node.andThen`; `WithRetry` 252, `WithCache` 272, `TryCatchFinally` 255, `Loop` 382, `WithApproval` 110, `Bounded` 218; every pattern's `run` form | ~1,500 |
| 5 | `Target.plan`, 67 `notImplemented` stubs, `BI/CoreRuleSelection.ts` 113, `BI/RulePolicy.ts`'s routing 135, `T/Dev.ts` 71, `T/NpmPublish.ts` 91, `T/JsrPublish.ts` 94 | ~600, plus the switch's routing (its case bodies move) |
| 6 | `B/Executor.ts`'s scheduler (of 857), `B/TargetExecution.ts` 126, `B/Cache.ts` 1,492 | ~2,200 |
| 7 | `T/Flow.ts` 154, `T/FlowCatalog.ts` 203, `T/Home.ts` 600, the `S.Factory` half of `T/Factory.ts` (1,117); the hand-merged list in `apps/mvp/worker/ExecutionHost.ts:44-164` | ~1,500 |
| 8 | `T/CronTarget.ts` 43; `smthrs triggers register`; `T/SecretProxy.ts` 957 | ~1,000 |
| 9 | `T/GithubCiGen.ts` 1,827, `T/GithubWorkflow.ts` 1,165, `T/GithubTarget.ts` 522, `T/CiToolchain.ts` 1,122, `B/GithubRender.ts` 1,084; `ci.yml` (1,773 lines), `drift.yml`, `canary.yml`, and each other non-publishing workflow once a flow replaces it | 5,720 + YAML |
| 10 | Tevm: `nx.json`, 17 `nx` scripts, the `nx` dependency, the aggregate targets | other repositories |

About 12,800 lines of Smithers library source (estimates marked ~) and 1,773 lines of generated YAML go, against the net surface in 5.0. The publishing workflows stay (GH-9).

## 11. Risks and questions for Will

Five questions, each with the recommended default and a confidence score (PROC-19). Everything else is engineering, settled below and recorded in section 12.

**1. Flow bodies: does `Node` become an Effect, with bodies written as plain `Effect.gen` in which `yield*` waits?**
Today a body chains `Node.bindPlanned` callbacks and types its requirements by hand. The proposal makes a `Node` an Effect that registers itself with a `Plan` service; a body is `Effect.gen`, `yield*` runs steps in order, `Node.all` runs them together, and `Node.branch` decides on a result. No `Flow.gen`, no replayed bodies. **Default: yes. Confidence 75%.** It is the only option with no new wrapper; VibeLang's sugar then applies to every flow body; the plan, plan diffs, step keys and the run graph all stay; and existing bodies keep compiling, because a `Node` is an Effect. The cost is one spelling (`Node.branch` instead of `if` on a result) and one semantic choice: Fable argued that `yield*` should only register, with order coming from references as in Bazel and Alchemy; we chose sequential because Effect and VibeLang both read that way and it fails safe. **What would raise it:** the plan-digest falsifier passing on all 53 flow files, and your yes on sequential `yield*`.

**2. Does `PACKAGE.ts` stay a data map, with no Effect program form?**
`export const Package = S.Package({ targets })` stays Bazel's `BUILD` file. Effect enters where something happens: a rule's implementation (`Target.toLayer`), a generator flow, an action's handler. **Default: yes, it stays data; no codemod. Confidence 85%.** Three of four panelists said so. A target map has no apply-time outputs for `yield*` to carry, so the program form adds a line per target and no capability, which is the "wrapper for simplicity" FLOW-9 removes. The Alchemy ideas we take (values as references, providers as Layers, plan before apply, state per stage) all work without it. The previous proposal asked this at 55% with both forms side by side. **What would raise it to 95%:** your confirmation that "inspired by how Alchemy works" means those ideas, not a `yield*` per target.

**3. Does `.smithers/FACTORY.ts` become the repository's plugin, written as data with imported flow values and compiled to decision 0017's `Plugin.Manifest`, with triggers declared only there and in plugins?**
**Default: yes. Confidence 80%.** PLUGIN-1 and the approved 0017 make every feature a plugin over one manifest, so a separate `S.Factory` format is a private interface. One manifest means one loader, one activation flow (`plugin/refresh`) and one trigger row type. Importing flows makes a dangling name a type error (five exist today) and types each trigger's `input` against the flow's payload. A flow file never says when it runs, because one flow serves several triggers with different settings. The cost: 0017's manifest needs a settings shape for the GitHub policy and token budgets, and a reader looks in `FACTORY.ts`, not the flow file, to learn when a flow runs. **What would raise it:** the GitHub policy fitting 0017's `settings` contribution without a new field.

**4. Does the build executor fold into the flow engine, so `smthrs build|test|ci` start a durable `build/run` flow?**
Today's scheduler, the per-target in-memory engines and the build's private result store are deleted; each target becomes one durable action, keyed as today. **Default: yes, behind a benchmark gate. Confidence 70%.** SDK-11 forbids two implementations of "run a target" and "cache a result"; DUR-1 wants every action durable; a build then resumes after a crash, appears on the run page, and can be placed on another machine with no extra code. Against: `BI/PackageRunner.ts` and `BI/PackagePlanner.ts` are 7,000 lines of hardened behavior, and journaling 1,273 steps per run may cost more than it saves. **What would raise it:** the benchmark in 6.1 (a no-op rerun adds at most 2 seconds; a full run stays within 10%) passing before the second rule family moves.

**5. May a commit status be named per step, `smithers/<flow>/<step>`, beside `smithers/<flow>`?**
GH-10 approves statuses "named `smithers/<flow>`". `Effect-TS/effect`'s `main` requires six named checks. **Default: yes, when a trigger lists `steps`. Confidence 60%.** The alternative, one flow per required check, multiplies flows and triggers to fit GitHub's UI. **What would raise it:** your confirmation that GH-10's naming allows the suffix.

### 11.1 Settled without asking

Confinement on first (slice 1); a result is shared only when confinement was enforced and every identity is complete; two rounds for `build/run`; keys on output digests; strict seatbelt; in place locally, staged remotely; phase A partitions, then phase B; the remote CAS protocol; deleting the renderers only after the `ci` flow matches GitHub on 50 SHAs; `trust: "head"` as the pull request default with matching against the base; no Bazel REAPI compatibility; deleting six patterns; one secrets egress; `S.Generate({ flow })`.

### 11.2 Found along the way

Each is a small, separate fix; none needs Will.

- `apps/mvp/docs/features/remote-flows.md:95` says child flows don't run on Cloudflare; they do (`packages/smithers/flows/platform-cloudflare/src/ExecutionObject.ts:539-546`).
- `T/ExecSandbox.ts:289-292` says an opted-out request counts as enforced; `enforceable` returns false for it (`:297-300`).
- `B/Planner.ts:76-80` documents a `nix:<hash>` key layer; the planner writes `layers: []` (`BI/PackagePlanner.ts:2758`, `:3017`), and `B/NixExec.ts:467` is never called. A Nix toolchain change doesn't re-key anything.
- `T/Compose.ts:986` says a generated-output target checks by default; `Mode` defaults to `write` (`T/GeneratedFile.ts:35-37`).
- `Flow.make` accepts `budget` and drops it (`F/Flow/make.ts:95-100`, `:275-296`).
- `B/Affected.ts:51-91` shells out to `git`; the jj-only rule wants an injected changed-file service.
- `.smithers/FACTORY.ts` names five flows that don't exist and still describes "the mythical history" (`:65-74`), which TODO-2 defers.
- `~/tevm-monorepo/WORKSPACE.ts:43` names a `rust-toolchain.toml` that doesn't exist, and `:76-77` names `gpt-5.6` model tiers, which the maintainers' rules forbid.
- `~/tevm-monorepo/nx.json:161` commits an Nx Cloud access token: rotate it before deleting the file.
- `docs/libraries.md:158` counts 32 `@smthrs/targets` files importing `node:*`; there are 33.

## 12. Where the panel disagreed

Four designers worked independently: Claude Opus, Claude Fable, Codex Sol and Codex Astra. On each point below they disagreed. The merge picks one answer per row and says why; it never averages.

| # | Topic | Opus | Fable | Sol | Astra | Chosen | Why |
|---|---|---|---|---|---|---|---|
| 1 | How a flow body is written | `Flow.gen`: a new generator that lowers to `Node` | `Node` becomes an Effect; a body is plain `Effect.gen`; no new name | Keep `Node` continuation passing; no generator | Keep `Node`; no generator | **Fable** | It is the only option that adds no wrapper and lets VibeLang's sugar apply to flow bodies. `Flow.gen` is a wrapper that exists only to look simpler, which FLOW-9 rules out; keeping `bindPlanned` chains keeps the boilerplate Will named. `Effectable.Prototype` exists in effect 4.0.5 (`node_modules/effect/dist/Effectable.d.ts:32-35`), and Alchemy's `Output` already uses the same trick (`alchemy/src/Output.ts:128-136`) |
| 2 | What `yield*` means in a body | Sequential: the rest of the body waits | Registers only; edges come from references; `Node.after` orders | (n/a) | (n/a) | **Opus** | Effect's `yield*` is sequential, and VibeLang promises "calls run in order" (`~/effectscript/docs/user/llms-essentials.md:3`). Reference-only edges make `yield* Publish` after `yield* Test` run both at once unless the author remembers `after`: a fail-dangerous default. Sequential is fail-safe and only slower; `Node.all` is the one spelling of concurrency |
| 3 | `PACKAGE.ts` form | Codemod all files to `Package.make(function* () {…})` | Stays a data map | Stays a data map | Stays a data map | **Fable, Sol, Astra** | A target map has no apply-time outputs for `yield*` to carry. The program form adds a `yield*` per target and no capability, which is the "wrapper for simplicity" FLOW-9 removes. Opus's real wins (lazy globs, no load-time I/O) are kept without it (5.2). Asked as question 2 because it is the most visible authoring call |
| 4 | How a rule is implemented | `Rule.make` + `Rule.toLayer`: one action whose handler gets a sandbox Layer | `Target.make` widened: body is an Effect under `Plan`, plus a `layer` field | `rule({ analyze })` returning a plan and providers from an analysis service | `rule({ analyze })` returning a body, providers and an execution manifest | **Opus, plus Fable's flow form** | Opus's form is the thinnest: the rule's work is ordinary Effect code over `FileSystem` and `ChildProcessSpawner`, and the host confines those services. It deletes the second executor route. A rule whose work is several durable steps (a model call, rounds) names a flow instead (Fable's `S.Generate({ flow })`). Sol's and Astra's analysis service duplicates what the planner already does; it returns when an untrusted repository's `PACKAGE.ts` must be evaluated in a realm (risk 4 in 11) |
| 5 | Typed outputs between targets | `target.outputs.<name>` is an `Artifact` value | Keep today's read-set grant; nothing new | `OutputRef` plus typed `ProviderKey<A>` metadata | Output groups plus `Provider<A>` and `Executable` | **Opus now; Sol's and Astra's providers later** | Files are the only provider any example needs. Typed provider metadata (`TypeScriptInfo`) waits for its second consumer (Will's rule: two adapters before an abstraction). All three agree a consumer reads only what it names and keys on the delivered bytes |
| 6 | Local hermeticity | Confine in place (bubblewrap, strict seatbelt); stage an input root only remotely | Unchanged locally | Strict materialized input tree for every shareable action | Empty per-action root plus immutable mounts | **Opus locally, Astra remotely, Sol's sharing rule** | In place under bubblewrap, an undeclared workspace read is already `ENOENT`; staging `node_modules` per action costs time and changes no key. Remote executors stage the tree (Astra's manifest). Sol's rule decides sharing: a result is shared only when confinement was enforced and every tool and environment identity is complete |
| 7 | The build as a durable flow | Two rounds: `build/load` settles a plan, `build/execute` runs it | One body: plan action, then a `for` loop over its result | One execution owner (no shape given) | One execution owner (no shape given) | **Opus** | Fable's body iterates over a `Planned` value at plan time, which the model forbids (`if`/`for` on a reference). A graph known only after reading files is a later round (`Flow.to`), which the engine already supports |
| 8 | Remote execution | Phase A: whole `build/run` on a job container; phase B: one executor per action, input root from CAS | `SandboxedFlow` on a machine, checkout as input root | `JobSandbox` over `ExternalJob` | `JobHost` plus `ExecutionManifest` | **Opus's phases, Astra's manifest, Sol's lifecycle** | Phase A is GitHub-runner parity with the least new code. Phase B needs a wire format; Astra's manifest is the most complete. Long commands use `ExternalJob` in every design; Sol and Astra spelled out its recovery rules |
| 9 | What `FACTORY.ts` is | The repository's plugin, as an Effect program | `S.Factory` data with typed `S.Trigger` rows | `factory(id, Effect.gen(...))` over a `Definitions` service | Plain data bindings | **Opus's "it is a plugin", in Fable's and Astra's data form** | PLUGIN-1 and decision 0017 (approved) make every feature a plugin over one manifest; a private factory format is the private interface `AGENTS.md` forbids. A registration list has no effects, so it is a data map whose keys are ids, like `PACKAGE.ts` |
| 10 | How `FACTORY.ts` names a flow | Imports the flow value | `S.flow("ci")` label, checked by `lint` | `FlowRef` with an executable digest | `FlowRef` with a pinned revision | **Opus, with Sol's pinning in the output** | Only an import lets TypeScript check a trigger's `input` against the flow's payload. The compiled manifest records the tag and the executable digest (Sol, Astra), so activation pins exactly what was reviewed |
| 11 | A trigger's `input` mapping | A function traced once into 0017's `Args` grammar | `Args` strings written by hand | A pure function run at admission in the realm | A data projection `{ from: [...] }` | **Opus** | Typed like Sol's, data like Astra's: the host evaluates no code (0017), and the author still gets types |
| 12 | Plan and apply for definitions | No new engine: the manifest diff is the plan, the merge is the apply | `definitions/apply` flow, stage `local` | `smthrs definitions plan` and `apply` | `DefinitionStore.plan` and `activate` | **Merged** | The committed manifest is the candidate (Opus). `smthrs definitions plan` prints the diff against a stage's active state (Sol). Apply is 0017's `plugin/refresh`, a durable flow with compare-and-set, tombstones and a read-back receipt (all four) |
| 13 | Smithers' `ci.yml` port | Five partitions of `Build.run` in phase A, none in phase B | `jobs.ts` table rendered to YAML and run as a flow | `CI.settle` helpers and a 15-row parity roster | `Build.call` per label group | **Opus's shape, Sol's roster** | CI jobs exist only because a GitHub runner is the unit of parallelism; with targets as actions, the graph is the parallelism. Sol's row-by-row roster is the parity proof FLOW-8 needs |
| 14 | Tevm's package edges | A macro reads `package.json` at load through a `Files` service | Hand-written `deps` per package | A one-time codemod commits explicit edges from Nx's project graph | Provider-based edges | **Sol, with a drift check** | Load-time reads need the program form we rejected. A one-time codemod writes `deps`, and a lint target fails when `package.json` and `deps` disagree |
| 15 | VibeLang's docs generator | `Generate.module`: an exported Effect function | `S.Generate({ flow, layer })` | `S.Generate({ flow })`, loading the module's exported `layer` | A new `Generated` rule | **Sol, keyed as Fable said** | VibeLang already has the flow. Loading the exported `layer` the way the registry does (`packages/smithers/agent/registry/src/Executable.ts:1674-1707`) removes an argument; the module's import closure is key material |
| 16 | Patterns that restate engine primitives | Delete `WithRetry`, `WithCache`, `TryCatchFinally`, `Loop`, `WithApproval`, `Bounded` | Silent | Silent | Silent | **Opus** | Each wraps a primitive the engine has (`RetryPolicy`, `Action.withCache`, `Node.catch`, `Flow.to`, `HumanTask`, `Node.all({ concurrency })`) |
| 17 | Commit status names | `smithers/<flow>` plus `smithers/<flow>/<step>` | `smithers/ci` only | `smithers/<flow>` with generation fencing | `smithers/<flow>` with stale-attempt fencing | **Ask Will (question 5); take the fencing** | GH-10 names `smithers/<flow>`; Effect's ruleset needs six names. Fencing is engineering and is kept either way |
| 18 | Confinement in Smithers | Turn it on first, before any new API | Leave it | Strict for shareable targets | Strict; refuse missing enforcement | **Opus's order, Sol's strictness** | Every cache-sharing claim depends on it, and it needs no new API |
| 19 | Where repository code is evaluated | Locally in `smthrs`; on Cloudflare in a realm or a job container | Trusted, in-process | An isolated analysis host | An isolated realm | **Opus** | Locally the loader is trusted today and stays so. On Cloudflare repository code never runs in the Worker: flow bodies plan in the QuickJS realm (0017), and `PACKAGE.ts` loads only inside a job container |
| 20 | Bazel REAPI wire compatibility | Not adopted | Not adopted | Not adopted | Not adopted (82%) | **No** | All four agree; recorded so nobody reopens it |

**Questions the panel asked, and what happened to them.**

| Panelist's question | Panelist's default | Outcome |
|---|---|---|
| Opus: all `PACKAGE.ts` to the program form? | yes, 65% | Reversed: question 2, default **no**, 85% |
| Opus: does `FACTORY.ts` become the repository's plugin? | yes, 70% | Question 3, default yes, in data form |
| Opus: does the build executor fold into the flow engine? | yes, 70% | Question 4, with a benchmark gate |
| Opus: confinement first? | yes, 85% | Settled, not asked: it is engineering |
| Opus: per-step status names? | `/<step>` suffix, 60% | Question 5 |
| Fable: `Node` as an Effect | ship, 85% | Question 1, with Opus's sequential `yield*` |
| Fable: edges from references only | 70% | Reversed (row 2) |
| Fable: flow references by label | 75% | Reversed (row 10) |
| Sol and Astra: no `Flow.gen` | 84%, 91% | Agreed: no `Flow.gen`; question 1 covers the body |
| Sol: strict hermeticity for shared results | 95% | Settled, not asked |
| Astra: factory activation is not a general resource engine | 92% | Settled, not asked |

## Appendix A. Falsifiers in one list

1. Every chained flow body rewritten with `Effect.gen` keeps its plan digest; every `bindPlanned` body shows only added ordering edges.
2. `target-index.json` stays byte-identical through slices 3 and 5.
3. A confined `smthrs ci //...` passes on Linux and macOS, and an undeclared read fails naming the path.
4. A build on one machine, then on a second with an empty `.flows`, hits for every build target.
5. A comment-only edit upstream leaves every downstream target a cache hit.
6. `kill -9` during `smthrs ci`; the rerun settles finished targets from the journal.
7. A no-op rerun of `smthrs ci '//...'` on `build/run` adds at most 2 seconds; a full run stays within 10% of today.
8. A trigger naming a deleted flow fails to typecheck; a removed trigger starts nothing from a delayed delivery.
9. A fork's pull request run has no secret in its egress audit; an older run can't overwrite a newer commit status.
10. The `ci` flow's verdicts equal GitHub Actions' on the same 50 SHAs.
11. Tevm's CI runs with zero `nx` invocations.
12. An agent's `fix-target` proof on a checkpoint commit is a cache hit when CI runs that commit.

## Appendix B. Library catalog entries used

From [the library catalog](../../../../docs/libraries.md), as the root `AGENTS.md` requires: `@smthrs/flow`, `@smthrs/plan`, `@smthrs/engine-store` (`StepBoundary`, `WorkspaceSandbox`), `@smthrs/kernel`, `@smthrs/step-cache`, `@smthrs/artifacts`, `@smthrs/targets`, `@smthrs/build-cli`, `@smthrs/repo-targets`, `@smthrs/triggers`, `@smthrs/plugin`, `@smthrs/registry`, `@smthrs/sandbox` (`JobHost` beside `SandboxTools`), `@smthrs/secrets`, `@smthrs/integrations`, `@smthrs/agent`, `@smthrs/platform-node` (`ProcessSandbox`, `SandboxedFlow`), `@smthrs/platform-cloudflare` (`ExecutionObject`). No new package is proposed.


## Will's answer

2026-10-21 about 01:15: approved as recommended (option 1), with each of the five questions at its recommended default:
- the flow body model;
- PACKAGE.ts stays data;
- FACTORY.ts becomes the repository's plugin;
- the build executor folds into the flow engine behind a benchmark gate;
- per-step commit status names.
Implementation follows the Migration section, phase by phase, after the round-4 deploy.
