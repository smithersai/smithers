# Pinned flows in a QuickJS realm

`RealmFlow.step` evaluates a pinned TypeScript module, a repository's flow or a
person's own, in a fresh bounded QuickJS realm using the actual `@smthrs/flow`
interpreter and `@smthrs/plan` nodes.
It returns an `Action` request or a schema-validated `Complete` result.
The host executes each request through its durable engine, persists the receipt,
and supplies all receipts to the next evaluation. Restarting the host rebuilds
the same source and replays receipts; a completed action is never dispatched by
this library. Pin the source, module bundle version, payload and action ceiling
in the durable run before evaluation. `RealmFlow.version` identifies the committed
SDK bundle and realm policy.

```ts
import { RealmFlow } from "@smthrs/harness"
import { Effect } from "effect"

const evaluation = RealmFlow.step({
  source: pinnedSource,
  expectedTag: "example",
  payload: { value: 4 },
  allowedActions: ["read"],
  receipts: savedReceipts
}).pipe(Effect.provide(RealmFlow.layerDefaultVariant))
```

Node and browsers use `layerDefaultVariant`. Cloudflare Workers supply the
existing `QuickJSVariant.layerVariant` over their statically compiled WASM build.
Imports are restricted to `Flow` and `Action` from `@smthrs/flow`, `Node` from
`@smthrs/plan`, `AgentAction` from `@smthrs/agent`, and `Schema` from `effect`
or `effect/Schema`. Any other module, a Smithers package subpath or a relative
file included, refuses the evaluation with `forbidden_import`, even when the
module catches the error. TypeScript's type stripping drops an import nothing
uses, so only a module the code loads is refused.
These are the library catalog entries for durable workflows, plan composition,
and identity (`@smthrs/crypto` and `@smthrs/canonical`); there is no replacement
flow model. The action export delegates to actual `Action.make` and retains its
schemas for validating action requests and receipts.

Raw callbacks work: the flow body and deferred callbacks may be plain
functions. The realm interprets with process-local callback identity, which is
reproducible here because every evaluation is a fresh realm with a fixed
process nonce, no clock and no randomness, so the same pinned source, payload
and receipts identify every callback the same way. `Node.capture` remains
available for identities that must also agree outside the realm. Only names
listed in `allowedActions` resolve, including names in an untaken branch; any
other refuses the evaluation with `action_not_allowed`. Receipts bind
canonical node identity, action name and canonical payload, and reject duplicate
or unused entries. Success and failure values must satisfy the action's schemas.
The host still authorizes every action against the caller's effective ceiling.
No action implementation or host reference crosses into QuickJS.

The realm exposes no clock, randomness, Proxy, weak references, timers, network,
filesystem, process or arbitrary module imports. Private SDK intrinsics support
planned references and inert capture admission. Their Proxy constructor tracks
all SDK proxies so the restricted clone probe rejects them, and their clock and
process nonce are fixed. These private bindings are inaccessible to repository
code, which is compiled in a separate global lexical environment.
Shared intrinsics and public SDK exports are frozen before repository code runs;
global intrinsic bindings are immutable. Repository code cannot replace JSON
transport, collection methods, receipt checks, or the SDK's public functions.

Each evaluation is limited to 64 MiB of QuickJS heap, a 128 KiB QuickJS stack,
one second and 2,000 interpreter interrupt polls. Source, emitted node records
and serialized output are bounded to 256 KiB; exceeding any bound refuses with
`limit_exceeded`. Errors expose only a refusal code (`invalid_source`,
`execution_failed`, `limit_exceeded`, `runtime_failed`, `forbidden_import` or
`action_not_allowed`);
source, values and exception details are never logged. These bounds do not claim
to bound WebAssembly compilation or the TypeScript compiler's host allocation.

## Agent steps

`AgentAction.make(tag, { payload, output, seat, prompt })` declares a
model-backed step the way `@smthrs/agent` does, with the same `.call()` and
`errorSchema`. When the step dispatches, its `prompt` function runs inside the
realm on the step's decoded payload, and the step crosses as a request for the
host action `RealmFlow.agentAction` (`"@smthrs/agent/AgentAction"`) whose payload
is `RealmFlow.AgentPayload`: `{ step, seat, prompt }`. A host offers agent steps
by listing `RealmFlow.agentAction` in `allowedActions`, runs its own agent on
the rendered prompt, and journals the answer as the step's receipt; the
declared `output` schema decodes it, so declare `Schema.String` for a text
answer. The receipt binds the rendered prompt, so a replay whose prompt would
differ refuses. The step declares nothing else: system teaching, catalog,
model, limits and failure handling are the host's. Any other option, a blank
seat or a prompt that isn't text refuses with `execution_failed`. The step's
error schema is `Schema.Never`: a host that can't finish the step fails its own
run rather than return a failure receipt.

```ts
import { AgentAction } from "@smthrs/agent"
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"

const Agent = AgentAction.make("ready/answer", {
  payload: { input: Schema.String },
  output: Schema.String,
  seat: "agent",
  prompt: ({ input }) => `Answer with the word ready. Input: ${input}`
})

export default Flow.make("ready", {
  description: "Says ready.",
  capabilities: [],
  payload: { input: Schema.String },
  success: Schema.String,
  error: Agent.errorSchema,
  body: ({ input }) => Agent.call({ input })
})
```

## What the realm interprets

Composition, maps, branches, joins with `Node.all`, sequences and typed catches
use the real interpreter. Engine-owned child executions, trampoline handoffs,
durable waits and race decisions are not provided by this realm's restricted
runtime and refuse execution. Express those operations as named host actions;
the caller's durable engine owns their scheduling and recovery.

`realm/build.mjs` reproducibly generates the committed
`src/internal/RealmFlowBundle.ts` from the workspace's actual SDK sources using
esbuild. `node realm/build.mjs --check` rebuilds and verifies the committed bytes. Regenerate it whenever the authoring libraries or entry change. The
QuickJS tests execute the generated SDK bundle; V8 coverage cannot instrument
code executed by the WASM interpreter, so its behavioral evidence is the realm
suite rather than V8 statement counts inside that bundle.
