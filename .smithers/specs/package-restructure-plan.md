# Smithers Package Restructure Plan

## Read Summary

I read the current source layout in `packages/react/src`, `packages/core/src`, and `src`. The important finding is that the current split is not aligned with real dependencies:

- `packages/react/src` contains real React code, but also shared protocol types, graph host types, error aliases, output helpers, stub agent classes, memory/scorer/voice type aliases, and `zod-to-example`. Those do not belong in a React package.
- `packages/core/src` is mostly an Effect state-machine core, but `graph/types.ts` and `graph/extract.ts` are not Effect-specific. They are framework-neutral workflow graph code.
- `src/agents` are AI SDK and CLI model adapters. They do not depend on React. They currently depend on Effect runtime helpers, subprocess helpers, metrics, diagnostics, and tool context.
- `src/dom/renderer.ts` is just the React reconciler export. `src/dom/extract.ts` is host-tree-to-workflow-graph extraction plus legacy runtime compute handlers for Subflow and Sandbox. Rendering React to `HostNode` and extracting `WorkflowGraph` from `HostNode` are adjacent but different concerns.
- `src/tools`, `src/voice`, `src/memory`, `src/scorers`, `src/openapi`, and `src/sandbox` are independent feature areas. Some currently import Effect or DB plumbing, but none are React concerns.
- `src/gateway` and `src/server` are leaf network integrations over the engine and DB. They should not be depended on by core packages.
- `src/db` is a real package boundary, but not clean yet because it owns or imports feature schemas and runtime-specific Effect helpers.

The recommended structure below optimizes for one-way dependencies and for packages a developer could reasonably install independently.

## Direct Answers

1. **Agents should be their own package.** They are AI model adapters around Vercel AI SDK agents/models and CLI subprocesses. They should not live in React, and they should not require the main Smithers runtime.

2. **The React reconciler should be its own package.** It is the only place that should depend on `react-reconciler` and `bippy`. `extractGraph` should move out of Effect core into a framework-neutral graph package. The reconciler produces `HostNode`; graph extraction consumes `HostNode`.

3. **Tools should be their own package.** Read, write, edit, grep, and bash are AI SDK tool factories and subprocess/file wrappers. The core implementation should be async/pure Node where possible, with Smithers logging/DB/Effect instrumentation as an adapter layer.

4. **Voice providers should be their own package.** Voice provider contracts, AI SDK voice, composite voice, and OpenAI realtime voice are independent of workflows except for error typing and the React `<Voice>` component.

5. **Gateway and server are leaf integration packages.** They wire workflows to HTTP, WebSocket, cron, webhooks, SSE, auth, metrics, approvals, and signals. They are not shared lower-level infrastructure.

6. **DB is a clean boundary after one fix.** The DB adapter, internal schema, frame codec, input/output validation, write retry, and schema signatures belong together. Memory, scorers, and time-travel should own their feature tables/migrations or register them with DB instead of DB importing feature packages.

7. **The main `smithers` package should be the facade.** It should provide `createSmithers`, JSX runtime exports, default workflow authoring API, and convenience re-exports. It should not contain primary implementations of agents, tools, graph extraction, gateway, server, voice, memory, scorers, or OpenAPI.

## Dependency Graph

```text
@smithers/protocol
  -> no Smithers deps

@smithers/graph
  -> @smithers/protocol

@smithers/core
  -> @smithers/protocol
  -> @smithers/graph
  -> effect

@smithers/observability
  -> @smithers/protocol
  -> @smithers/core
  -> effect
  -> opentelemetry

@smithers/runtime
  -> @smithers/protocol
  -> @smithers/core
  -> @smithers/observability
  -> effect
  -> @effect/platform
  -> @effect/workflow

@smithers/react-reconciler
  -> @smithers/graph
  -> react
  -> react-reconciler

@smithers/react
  -> @smithers/protocol
  -> @smithers/graph
  -> @smithers/core
  -> @smithers/react-reconciler
  -> react
  -> react-dom

@smithers/db
  -> @smithers/protocol
  -> @smithers/graph
  -> @smithers/core
  -> @smithers/runtime
  -> @smithers/observability
  -> drizzle
  -> bun:sqlite

@smithers/agents
  -> @smithers/protocol
  -> @smithers/runtime
  -> @smithers/observability
  -> ai
  -> provider SDKs and CLI subprocess support

@smithers/tools
  -> @smithers/protocol
  -> @smithers/runtime
  -> @smithers/observability
  -> ai
  -> zod

@smithers/voice
  -> @smithers/protocol
  -> ai
  -> ws
  -> effect

@smithers/memory
  -> @smithers/protocol
  -> @smithers/runtime
  -> @smithers/observability
  -> @smithers/db

@smithers/scorers
  -> @smithers/protocol
  -> @smithers/runtime
  -> @smithers/observability
  -> @smithers/db
  -> @smithers/agents only as a type/protocol dependency

@smithers/openapi
  -> @smithers/protocol
  -> @smithers/runtime
  -> @smithers/observability
  -> @smithers/tools
  -> ai
  -> zod

@smithers/vcs
  -> @smithers/protocol
  -> @smithers/runtime
  -> @smithers/observability
  -> @effect/platform

@smithers/sandbox
  -> @smithers/protocol
  -> @smithers/runtime
  -> @smithers/observability
  -> @smithers/db
  -> @smithers/tools

@smithers/time-travel
  -> @smithers/protocol
  -> @smithers/graph
  -> @smithers/runtime
  -> @smithers/observability
  -> @smithers/db
  -> @smithers/vcs

@smithers/engine
  -> @smithers/protocol
  -> @smithers/graph
  -> @smithers/core
  -> @smithers/runtime
  -> @smithers/observability
  -> @smithers/react
  -> @smithers/react-reconciler
  -> @smithers/db
  -> @smithers/agents
  -> @smithers/tools
  -> @smithers/scorers
  -> @smithers/memory
  -> @smithers/sandbox
  -> @smithers/time-travel
  -> @smithers/vcs

@smithers/server
  -> @smithers/engine
  -> @smithers/db
  -> @smithers/time-travel
  -> @smithers/runtime
  -> @smithers/observability
  -> hono
  -> ws

@smithers/cli
  -> smithers
  -> @smithers/server
  -> @smithers/db
  -> @smithers/time-travel
  -> @smithers/agents

smithers
  -> public facade over the packages above
```

No package below `@smithers/engine` may depend on `@smithers/server`, `@smithers/gateway`, `@smithers/cli`, or the facade package.

## Proposed Packages

### `@smithers/protocol`

**Responsibility:** Shared public contracts, error model, and small value types used by every package.

**What goes in it:**

- `src/CachePolicy.ts`
- `src/RetryPolicy.ts`
- `src/OutputKey.ts`
- `src/OutputAccessor.ts`
- `src/RunAuthContext.ts`
- `src/RunOptions.ts`
- `src/RunResult.ts`
- `src/RunStatus.ts`
- `src/SchemaRegistryEntry.ts`
- `src/SmithersCtx.ts`, after removing React-only runtime context imports
- `src/SmithersEvent.ts`
- `src/SmithersError.ts`
- `src/errors/tagged.ts`
- `src/utils/errors.ts`
- Error catalog currently duplicated in `packages/core/src/errors/index.ts`
- Minimal `AgentLike` contract from `src/AgentLike.ts`
- Minimal shared runtime option contracts from `src/SmithersWorkflowOptions.ts`

**Depends on:** `zod` as a type dependency if `SmithersCtx` keeps Zod inference; otherwise no runtime dependency.

**Depends on it:** All Smithers packages.

**Why separate package:** Everything needs these contracts, but none of them should pull React, Effect, Drizzle, AI SDK providers, or server dependencies.

### `@smithers/graph`

**Responsibility:** Framework-neutral workflow graph model and host-tree extraction.

**What goes in it:**

- `packages/core/src/graph/types.ts`
- `packages/core/src/graph/extract.ts`
- `src/XmlNode.ts`
- `src/TaskDescriptor.ts`
- `src/GraphSnapshot.ts`
- `src/dom/extract.ts`, after removing legacy runtime compute handlers
- `src/constants.ts` for graph/component constants such as merge queue defaults and Worktree validation messages
- `src/utils/tree-ids.ts`
- `src/utils/xml.ts`

**Depends on:** `@smithers/protocol`, `node:path`.

**Depends on it:** `@smithers/core`, `@smithers/react-reconciler`, `@smithers/react`, `@smithers/db`, `@smithers/engine`, `@smithers/time-travel`.

**Why separate package:** `HostNode -> WorkflowGraph` is not React and not Effect. It is the compiler boundary between authoring surfaces and the runtime scheduler. A non-React authoring frontend should be able to produce `HostNode` and reuse this package.

**Important extraction rule:** `extractGraph` should only describe Subflow and Sandbox as metadata. It should not attach `computeFn` closures that import engine execution functions. Engine should interpret the metadata and call child workflow or sandbox executors.

### `@smithers/core`

**Responsibility:** Effect-based workflow state machine, scheduler, durable primitives, execution service contracts, and abstract persistence contracts.

**What goes in it:**

- `packages/core/src/session`
- `packages/core/src/scheduler`
- `packages/core/src/state`
- `packages/core/src/durables`
- `packages/core/src/execution`
- `packages/core/src/persistence`
- `packages/core/src/observability` for in-memory/catalog-level metrics and tracing services
- `packages/core/src/runtime`
- `packages/core/src/interop`

**What does not go in it:**

- React reconciler or components
- Drizzle/Bun SQLite adapter
- Concrete HTTP/WebSocket servers
- Agents, tools, voice, memory, scorers, OpenAPI
- Concrete OpenTelemetry exporters
- Shared subprocess/runtime helpers that currently import app/tool context
- Graph extraction, except as an import from `@smithers/graph`

**Depends on:** `@smithers/protocol`, `@smithers/graph`, `effect`.

**Depends on it:** Almost every runtime package.

**Why separate package:** This is the reusable runtime kernel. A developer should be able to use the scheduler/session engine without React authoring, DB, gateway, or agent provider dependencies.

### `@smithers/observability`

**Responsibility:** Concrete metrics, logging, tracing, Prometheus, and OpenTelemetry integration for Smithers runtime packages.

**What goes in it:**

- `src/observability/correlation.ts`
- `src/observability/index.ts`
- `src/effect/metrics.ts`
- `src/effect/logging.ts`
- Concrete exporter setup currently wired through `createSmithersRuntimeLayer`
- Prometheus rendering glue that reuses the core metric catalog

**Depends on:** `@smithers/protocol`, `@smithers/core`, `effect`, `@effect/opentelemetry`, `@effect/platform`, `@effect/platform-bun`, OpenTelemetry packages.

**Depends on it:** `@smithers/runtime`, `@smithers/db`, `@smithers/agents`, `@smithers/tools`, `@smithers/engine`, `@smithers/server`, `smithers`.

**Why separate package:** Observability is shared infrastructure with heavy exporter dependencies. It is not the workflow state machine and should not force OpenTelemetry into packages that only need graph or protocol types.

### `@smithers/runtime`

**Responsibility:** Concrete Effect runtime and platform helpers used by runtime packages.

**What goes in it:**

- `src/effect/runtime.ts`, after removing direct `tools/context` coupling
- `src/effect/child-process.ts`
- `src/effect/task-runtime.ts`
- `src/effect/interop.ts`, if not fully re-exported from `@smithers/core`
- Small platform/runtime helpers that are not engine-specific

**Depends on:** `@smithers/protocol`, `@smithers/core`, `@smithers/observability`, `effect`, `@effect/platform`, `@effect/workflow`.

**Depends on it:** `@smithers/db`, `@smithers/agents`, `@smithers/tools`, `@smithers/memory`, `@smithers/scorers`, `@smithers/openapi`, `@smithers/vcs`, `@smithers/sandbox`, `@smithers/time-travel`, `@smithers/engine`, `@smithers/server`.

**Why separate package:** Agents, tools, DB, VCS, and server code all need process execution and `runPromise`, but they should not depend on the full workflow engine. This package is the concrete platform layer above the abstract core.

### `@smithers/react-reconciler`

**Responsibility:** Custom React renderer that turns React elements into Smithers `HostNode` trees.

**What goes in it:**

- `packages/react/src/reconciler/index.ts`
- `src/dom/renderer.ts` re-export should point here
- `HostContainer` and `SmithersRenderer`

**Depends on:** `@smithers/graph`, `react`, `react-reconciler`, `bippy`.

**Depends on it:** `@smithers/react`, `@smithers/engine`, `smithers`.

**Why separate package:** It is the only package that should carry `react-reconciler`. Developers who want Smithers graph/runtime types should not install React renderer internals.

### `@smithers/react`

**Responsibility:** React authoring API: JSX components, workflow render context, prompt rendering, and React workflow driver.

**What goes in it:**

- `packages/react/src/components`
- `packages/react/src/aspects`
- `packages/react/src/context`
- `packages/react/src/driver`
- `packages/react/src/markdownComponents.ts`
- `packages/react/src/zod-to-example.ts`
- `packages/react/src/types.ts`
- `src/SmithersWorkflow.ts`
- `src/components`
- `src/aspects`
- `src/context.ts`
- `src/renderMdx.ts`
- `src/jsx-runtime.ts`
- `src/types/react-dom-server.d.ts`
- `src/devtools`, unless split later into a private devtools package

**What must leave it:**

- `packages/react/src/agents/*`
- `packages/react/src/core-types.ts`
- `packages/react/src/errors.ts`
- `packages/react/src/db/output.ts`
- `packages/react/src/memory/types.ts`
- `packages/react/src/scorers/types.ts`
- `packages/react/src/voice/types.ts`
- Non-React top-level protocol aliases

**Depends on:** `@smithers/protocol`, `@smithers/graph`, `@smithers/core`, `@smithers/react-reconciler`, `react`, `react-dom`, `zod`.

**Depends on it:** `@smithers/engine`, `smithers`, workflow authors using JSX.

**Why separate package:** Components and render context are React-specific. Keeping them separate lets the rest of Smithers stay usable from non-React authoring frontends.

### `@smithers/db`

**Responsibility:** Smithers SQLite/Drizzle persistence adapter, internal runtime schema, frame encoding, input/output validation, and DB retry behavior.

**What goes in it:**

- `src/db/adapter.ts`
- `src/db/ensure.ts`
- `src/db/frame-codec.ts`
- `src/db/input.ts`
- `src/db/internal-schema.ts`
- `src/db/output.ts`
- `src/db/schema-signature.ts`
- `src/db/snapshot.ts`
- `src/db/write-retry.ts`
- `src/zodToTable.ts`
- `src/zodToCreateTableSQL.ts`
- `src/unwrapZodType.ts`
- `src/utils/camelToSnake.ts`

**Depends on:** `@smithers/protocol`, `@smithers/graph`, `@smithers/core`, `@smithers/runtime`, `@smithers/observability`, `drizzle-orm`, `drizzle-zod`, `bun:sqlite`, `zod`.

**Depends on it:** `@smithers/engine`, `@smithers/server`, `@smithers/memory`, `@smithers/scorers`, `@smithers/time-travel`, `@smithers/sandbox`, `@smithers/cli`, `smithers`.

**Why separate package:** Persistence is a concrete adapter with heavy dependencies and a stable public value. Developers may want to inspect runs, build custom UIs, or use the DB adapter without importing the engine or React.

**Cleanup required:** Remove direct imports from DB into memory/scorers feature schemas. Feature packages should expose `registerTables()` or migrations that `ensureSmithersTables()` can call from the facade/engine layer.

### `@smithers/agents`

**Responsibility:** AI SDK and CLI agent adapters.

**What goes in it:**

- `src/AgentLike.ts`
- `src/agents/AmpAgent.ts`
- `src/agents/AnthropicAgent.ts`
- `src/agents/BaseCliAgent.ts`
- `src/agents/ClaudeCodeAgent.ts`
- `src/agents/CodexAgent.ts`
- `src/agents/ForgeAgent.ts`
- `src/agents/GeminiAgent.ts`
- `src/agents/KimiAgent.ts`
- `src/agents/OpenAIAgent.ts`
- `src/agents/PiAgent.ts`
- `src/agents/capability-registry.ts`
- `src/agents/cli-capabilities.ts`
- `src/agents/diagnostics.ts`
- `src/agents/schema.ts`
- `src/agents/sdk-shared.ts`
- `src/cli/agent-contract.ts`, because it is an agent contract, not a CLI concern

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `@smithers/observability`, `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `zod`, Node subprocess APIs.

**Depends on it:** `@smithers/engine`, `@smithers/scorers`, `@smithers/cli`, `smithers`, users who only want agent adapters.

**Why separate package:** These are installable model adapters. Their natural consumers are workflow authors, scorers, and CLIs, not React components.

**Cleanup required:** Replace direct `../tools/context` dependency with a small runtime context contract from `@smithers/protocol` or an injected execution context. Agents should not depend on the tools package.

### `@smithers/tools`

**Responsibility:** Built-in AI SDK tools and their sandboxed file/subprocess operations.

**What goes in it:**

- `src/tools/bash.ts`
- `src/tools/context.ts`
- `src/tools/defineTool.ts`
- `src/tools/edit.ts`
- `src/tools/grep.ts`
- `src/tools/index.ts`
- `src/tools/logToolCall.ts`
- `src/tools/read.ts`
- `src/tools/tools.ts`
- `src/tools/utils.ts`
- `src/tools/write.ts`

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `@smithers/observability`, `ai`, `zod`, `@effect/platform`, `diff`, Node fs/path/process APIs.

**Depends on it:** `@smithers/agents` only through an injected context if unavoidable, `@smithers/engine`, `@smithers/openapi`, `@smithers/sandbox`, workflow authors.

**Why separate package:** Tools are useful outside Smithers workflows as AI SDK `tool()` values. They also bring filesystem/subprocess behavior that should not be pulled in by React or graph packages.

**Cleanup required:** Separate pure operations from Smithers run logging. `readFileToolCore()` and `bashToolCore()` should not require Effect or DB; `read`/`bash` can wrap them with Smithers instrumentation.

### `@smithers/voice`

**Responsibility:** Voice provider contracts and concrete TTS/STT/realtime providers.

**What goes in it:**

- `src/voice/types.ts`
- `src/voice/ai-sdk-voice.ts`
- `src/voice/composite.ts`
- `src/voice/realtime.ts`
- `src/voice/effect.ts`
- `src/voice/index.ts`

**Depends on:** `@smithers/protocol`, `ai`, `ws`, `effect` for the Effect service subpath.

**Depends on it:** `@smithers/react` for the `<Voice>` prop type, `@smithers/engine` for voice execution, `smithers`.

**Why separate package:** Voice is a provider system with independent APIs and dependencies. It should be installable without React, DB, or the workflow engine.

### `@smithers/memory`

**Responsibility:** Persistent working memory, message history, semantic memory, and memory processors.

**What goes in it:**

- `src/memory/index.ts`
- `src/memory/metrics.ts`
- `src/memory/processors/index.ts`
- `src/memory/schema.ts`
- `src/memory/semantic.ts`
- `src/memory/service.ts`
- `src/memory/store.ts`
- `src/memory/types.ts`

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `@smithers/observability`, `@smithers/db`, `drizzle-orm`, `ai`, `zod`.

**Depends on it:** `@smithers/engine`, `smithers`, users who want memory without the full workflow server.

**Why separate package:** Memory has its own schema, service, and retrieval semantics. It is not a DB implementation and not a React concern.

### `@smithers/scorers`

**Responsibility:** Scorer definitions, built-in scorers, scorer execution, persistence, aggregation, and scorer schema.

**What goes in it:**

- `src/scorers/aggregate.ts`
- `src/scorers/builtins.ts`
- `src/scorers/create-scorer.ts`
- `src/scorers/index.ts`
- `src/scorers/metrics.ts`
- `src/scorers/run-scorers.ts`
- `src/scorers/schema.ts`
- `src/scorers/types.ts`

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `@smithers/observability`, `@smithers/db`, `@smithers/agents` for the judge-agent type, `zod`, Node crypto.

**Depends on it:** `@smithers/react` for `Task` scorer prop types, `@smithers/engine`, `smithers`.

**Why separate package:** Evaluation is a distinct domain. Users may want to run or aggregate scorers over existing run data without importing the workflow authoring stack.

### `@smithers/openapi`

**Responsibility:** OpenAPI spec parsing, `$ref` resolution, JSON Schema to Zod conversion, and AI SDK tool generation.

**What goes in it:**

- `src/openapi/index.ts`
- `src/openapi/metrics.ts`
- `src/openapi/ref-resolver.ts`
- `src/openapi/schema-converter.ts`
- `src/openapi/spec-parser.ts`
- `src/openapi/tool-factory.ts`
- `src/openapi/types.ts`

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `@smithers/observability`, `@smithers/tools`, `ai`, `zod`, Node fs.

**Depends on it:** `smithers`, workflow authors building tools from OpenAPI.

**Why separate package:** This is a clean utility package with a standalone value proposition: turn OpenAPI operations into AI SDK tools.

### `@smithers/vcs`

**Responsibility:** VCS discovery and jj workspace operations.

**What goes in it:**

- `src/vcs/find-root.ts`
- `src/vcs/jj.ts`

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `@smithers/observability`, `@effect/platform`, Node fs/path.

**Depends on it:** `@smithers/engine`, `@smithers/time-travel`, `smithers`.

**Why separate package:** VCS operations are shared by engine worktrees and time-travel. Keeping them outside engine prevents time-travel from depending on the full engine.

### `@smithers/sandbox`

**Responsibility:** Sandbox bundle validation/writing, sandbox execution, and sandbox transport integration.

**What goes in it:**

- `src/sandbox/bundle.ts`
- `src/sandbox/execute.ts`
- `src/sandbox/transport.ts`
- Sandbox-specific Effect bridge files from `src/effect/sandbox-entity.ts` and `src/effect/socket-runner.ts`

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `@smithers/observability`, `@smithers/db`, `@smithers/tools`, `@smithers/graph`, Node fs/path.

**Depends on it:** `@smithers/engine`, `smithers`.

**Why separate package:** Sandbox execution is a specialized runtime with bundle format, transport, limits, and persistence. It should be optional for users who do not run sandboxed workflows.

**Cleanup required:** Break the current cycle where sandbox execution calls child workflow execution in engine. Sandbox package should expose a transport/runtime abstraction; engine should provide the child-workflow executor.

### `@smithers/time-travel`

**Responsibility:** Snapshots, diffs, fork/replay, timelines, and VCS-tagged run history.

**What goes in it:**

- `src/time-travel/diff.ts`
- `src/time-travel/fork.ts`
- `src/time-travel/index.ts`
- `src/time-travel/metrics.ts`
- `src/time-travel/replay.ts`
- `src/time-travel/schema.ts`
- `src/time-travel/snapshot.ts`
- `src/time-travel/timeline.ts`
- `src/time-travel/types.ts`
- `src/time-travel/vcs-version.ts`
- `src/timetravel.ts`
- `src/revert.ts`
- `src/retry-task.ts`, if it remains primarily a run-history operation

**Depends on:** `@smithers/protocol`, `@smithers/graph`, `@smithers/runtime`, `@smithers/observability`, `@smithers/db`, `@smithers/vcs`, `drizzle-orm`, `picocolors`.

**Depends on it:** `@smithers/engine`, `@smithers/server`, `@smithers/cli`, `smithers`.

**Why separate package:** Time-travel is a coherent persistence feature that both CLI and gateway consume. It should not require HTTP/WebSocket or React authoring.

### `@smithers/engine`

**Responsibility:** Concrete workflow execution engine that wires graph/session scheduling to DB, agents, tools, sandbox, memory, scorers, alerts, worktrees, and hot reload.

**What goes in it:**

- `src/engine/index.ts`
- `src/engine/approvals.ts`
- `src/engine/alert-delivery.ts`, if present in active branch
- `src/engine/alert-rules.ts`, if present in active branch
- `src/engine/alert-runtime.ts`, if present in active branch
- `src/engine/child-workflow.ts`
- `src/engine/scheduler.ts`, until fully replaced by `@smithers/core/scheduler`
- `src/engine/signals.ts`
- Engine-specific files from `src/effect`: `activity-bridge.ts`, `builder.ts`, `compute-task-bridge.ts`, `deferred-bridge.ts`, `deferred-state-bridge.ts`, `diff-bundle.ts`, `durable-deferred-bridge.ts`, `entity-worker.ts`, `http-runner.ts`, `rpc-schema.ts`, `single-runner.ts`, `static-task-bridge.ts`, `workflow-bridge.ts`, `workflow-make-bridge.ts`, `versioning.ts`
- `src/events.ts`
- `src/human-requests.ts`
- `src/hot`
- `src/runtime-owner.ts`

**Depends on:** `@smithers/protocol`, `@smithers/graph`, `@smithers/core`, `@smithers/runtime`, `@smithers/observability`, `@smithers/react`, `@smithers/react-reconciler`, `@smithers/db`, `@smithers/agents`, `@smithers/tools`, `@smithers/scorers`, `@smithers/memory`, `@smithers/sandbox`, `@smithers/time-travel`, `@smithers/vcs`, `@smithers/voice`.

**Depends on it:** `@smithers/server`, `@smithers/cli`, `smithers`.

**Why separate package:** This is the first package that intentionally wires many features together. It is the runtime product, not a place for leaf integrations or authoring-only React components.

### `@smithers/server`

**Responsibility:** Network servers for Smithers workflows: HTTP API, Hono app, WebSocket gateway, cron, webhook, auth, SSE, and metrics endpoints.

**What goes in it:**

- `src/server/index.ts`
- `src/server/serve.ts`
- `src/gateway/index.ts`

**Depends on:** `@smithers/protocol`, `@smithers/engine`, `@smithers/db`, `@smithers/time-travel`, `@smithers/runtime`, `@smithers/observability`, `hono`, `ws`, `cron-parser`, Node http/crypto/url/path/fs.

**Depends on it:** `@smithers/cli`, `smithers`, deployment apps.

**Why separate package:** It is a leaf network integration and brings server dependencies. A local workflow author or library user should not install `ws`, `hono`, or gateway auth code by default.

### `@smithers/external`

**Responsibility:** External language/runtime workflow adapters, currently Python and JSON Schema/Pydantic interop.

**What goes in it:**

- `src/external/create-external-smithers.ts`
- `src/external/index.ts`
- `src/external/json-schema-to-zod.ts`
- `src/external/python-subprocess.ts`
- `src/external/python.ts`

**Depends on:** `@smithers/protocol`, `@smithers/react`, `@smithers/db`, `zod`, Node subprocess/fs/path.

**Depends on it:** `smithers`, users integrating non-TypeScript workflow definitions.

**Why separate package:** Python/Pydantic interop is a standalone integration with its own dependencies and lifecycle. It should not be in the core workflow engine.

### `@smithers/cli`

**Responsibility:** Command-line interface, TUI, MCP semantic server, workflow pack tooling, diagnostics commands, and local supervisor commands.

**What goes in it:**

- `src/cli`
- `src/mcp`

**Depends on:** `smithers`, `@smithers/server`, `@smithers/db`, `@smithers/time-travel`, `@smithers/agents`, `@modelcontextprotocol/sdk`, `incur`, `@opentui/core`, `@opentui/react`, `picocolors`, `react`.

**Depends on it:** No library package. Only binaries, tests, and local development workflows.

**Why separate package:** CLI and TUI dependencies are heavy, user-facing, and leaf-level. Library consumers should not install OpenTUI, MCP, or CLI command code.

**Cleanup required:** Move `src/cli/agent-contract.ts` into `@smithers/agents` because `pi-plugin/extension.ts` and non-CLI integrations need it.

### `@smithers/pi-plugin`

**Responsibility:** Pi coding agent plugin and extension integration.

**What goes in it:**

- `src/pi-plugin/index.ts`
- `src/pi-plugin/extension.ts`

**Depends on:** `@smithers/protocol`, `@smithers/agents`, `@smithers/runtime`, `@modelcontextprotocol/sdk`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`.

**Depends on it:** `smithers` facade if preserving current exports, Pi plugin users.

**Why separate package:** It is a vendor-specific integration and currently pulls Pi and MCP dependencies. It should not live in the main runtime.

### `@smithers/ide`

**Responsibility:** Smithers IDE service integration and IDE-specific tools.

**What goes in it:**

- `src/ide/SmithersIdeService.ts`
- `src/ide/index.ts`
- `src/ide/tools.ts`

**Depends on:** `@smithers/protocol`, `@smithers/runtime`, `incur`, Node process APIs.

**Depends on it:** `smithers` facade if preserving current exports, Smithers IDE app.

**Why separate package:** IDE integration is an integration surface, not core runtime behavior. This keeps desktop app dependencies out of headless packages.

### `smithers`

**Responsibility:** Public facade and workflow authoring convenience package.

**What goes in it:**

- `src/create.ts`
- `src/index.ts`
- `src/examples-entry.ts`
- `src/mdx-plugin.ts`
- Public `jsx-runtime` exports that delegate to `@smithers/react`
- Compatibility re-exports for `./gateway`, `./server`, `./tools`, `./voice`, `./memory`, `./openapi`, `./scorers`
- Main package docs and migration aliases

**Depends on:** The public packages above. It is allowed to be a convenience package with broad dependencies.

**Depends on it:** Workflow authors who want the current batteries-included import style, examples, and backward compatibility.

**Why separate package:** The facade is where broad wiring belongs. It lets focused packages stay clean while preserving the easy `import { createSmithers, Task, ClaudeCodeAgent } from "smithers"` experience.

## Current File Moves From `packages/react/src`

These files are React-specific and stay in the React family:

- `components/*`
- `aspects/AspectContext.ts`
- `context/index.ts`
- `driver/index.ts`
- `reconciler/index.ts`, but in `@smithers/react-reconciler`
- `markdownComponents.ts`

These files should leave `packages/react/src`:

- `agents/*` -> `@smithers/agents`
- `core-types.ts` -> split between `@smithers/protocol` and `@smithers/graph`
- `AgentLike.ts`, `CachePolicy.ts`, `OutputAccessor.ts`, `OutputKey.ts`, `RetryPolicy.ts`, `RunAuthContext.ts`, `RunOptions.ts`, `RunResult.ts`, `SchemaRegistryEntry.ts`, `SmithersCtx.ts`, `SmithersWorkflowOptions.ts` -> `@smithers/protocol` or `@smithers/react` if React-bound
- `db/output.ts` -> `@smithers/db` or a tiny protocol helper if still needed by React `Signal`
- `memory/types.ts` -> `@smithers/memory`
- `scorers/types.ts` -> `@smithers/scorers`
- `voice/types.ts` -> `@smithers/voice`
- `errors.ts`, `utils/errors.ts` -> `@smithers/protocol`
- `zod-to-example.ts` -> `@smithers/react` because it exists only to render schema examples in prompts

## Current File Moves From `packages/core/src`

Keep in `@smithers/core`:

- `durables`
- `execution`
- `interop`
- `observability` abstract/catalog services
- `persistence` interfaces and in-memory storage
- `runtime`
- `scheduler`
- `session`
- `state`

Move out:

- `graph/types.ts` -> `@smithers/graph`
- `graph/extract.ts` -> `@smithers/graph`
- Error catalog can either remain re-exported from core or move to `@smithers/protocol`; preferred final home is `@smithers/protocol`.

## Current File Moves From `src`

The current `src` tree should not become one package. Split it by ownership:

- Top-level protocol/types/errors -> `@smithers/protocol`
- `SmithersWorkflow.ts`, `components`, `aspects`, `context`, `renderMdx`, `jsx-runtime` -> `@smithers/react` or facade
- `dom/renderer.ts` -> `@smithers/react-reconciler`
- `dom/extract.ts` -> `@smithers/graph` after removing runtime closure coupling
- `agents` -> `@smithers/agents`
- `tools` -> `@smithers/tools`
- `voice` -> `@smithers/voice`
- `memory` -> `@smithers/memory`
- `scorers` -> `@smithers/scorers`
- `openapi` -> `@smithers/openapi`
- `db` and Zod table helpers -> `@smithers/db`
- `sandbox` plus sandbox-specific Effect bridge files -> `@smithers/sandbox`
- `time-travel`, `timetravel.ts`, `revert.ts`, possibly `retry-task.ts` -> `@smithers/time-travel`
- `vcs` -> `@smithers/vcs`
- `observability` and concrete metric/logging files -> `@smithers/observability`
- low-level runtime/process Effect helpers -> `@smithers/runtime`
- `engine`, engine-specific Effect bridge files, `events.ts`, `human-requests.ts`, `hot`, `runtime-owner.ts` -> `@smithers/engine`
- `server` and `gateway` -> `@smithers/server`
- `cli` and `mcp` -> `@smithers/cli`
- `external` -> `@smithers/external`
- `pi-plugin` -> `@smithers/pi-plugin`
- `ide` -> `@smithers/ide`
- `utils` should be redistributed to owning packages, not published as a kitchen-sink `@smithers/utils`

## Migration Order

1. Create `@smithers/protocol` and `@smithers/graph`; make `packages/core` and `packages/react` import from them.
2. Split `@smithers/react-reconciler` out of `packages/react`; keep `@smithers/react` for components/context/driver.
3. Extract `@smithers/observability` and `@smithers/runtime` so agents, tools, DB, and VCS do not depend on engine.
4. Move `src/agents`, `src/tools`, `src/voice`, `src/openapi`, and `src/scorers` into packages with compatibility re-exports from `smithers`.
5. Extract `@smithers/db`; remove feature-schema imports by adding feature table registration.
6. Move `@smithers/memory`, `@smithers/sandbox`, `@smithers/time-travel`, and `@smithers/vcs`.
7. Move `@smithers/engine`; replace legacy `src/dom/extract.ts` runtime closures with graph metadata interpreted by engine.
8. Move leaf packages: `@smithers/server`, `@smithers/cli`, `@smithers/external`, `@smithers/pi-plugin`, `@smithers/ide`.
9. Make root `package.json` a workspace root only, and publish `smithers` as the facade package with compatibility subpath exports.

## Non-Goals

- Do not create a public `@smithers/utils` package. Utilities should move to the package that owns the concept.
- Do not keep agents in React for convenience. The facade can re-export agents.
- Do not keep graph extraction in Effect core. Core can re-export it for compatibility during migration, but ownership should be `@smithers/graph`.
- Do not let server, gateway, or CLI leak into lower-level packages.
- Do not make DB own every feature schema forever. DB should own core runtime tables; feature packages should register their own tables.
