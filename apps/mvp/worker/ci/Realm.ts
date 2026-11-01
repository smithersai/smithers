import { QuickJSLifecycle, QuickJSVariant } from "@smthrs/harness"
import { CiJob } from "@smthrs/sandbox"
import { Effect, Schema } from "effect"
import { transform } from "sucrase"

// A repository flow's plan, built in a QuickJS realm (docs/features/ci.md#repository-flows; the CI/CD parity proposal,
// Design 2: orchestration in the realm, commands in containers). The flow's `flow.ts` is the repository's code, so it
// never runs in the Worker or on the engine: sucrase strips its types and turns its imports into `require` calls, and a
// fresh QuickJS runtime with a memory, stack and step budget evaluates it against a small module surface that builds a
// graph as data:
//
//   @smthrs/flow     Flow.make(tag, { body, ...rest })   the flow; only its tag and body are read
//   @smthrs/plan     Node.all({ key: node, ... })        jobs that run at once
//   @smthrs/sandbox  CiJob.make(name, { steps, machine?, needs? }).call()
//                                                        one job, which `ci/job` runs on its own machine: the
//                                                        deployment's machine `machine` names, after its `needs` pass
//   effect           Schema                              inert: a payload declaration reads, but decides nothing
//
// The body is called once with the run's payload `{ run, repo, sha, ref, event }`; what it returns is checked as
// `CiJob.Jobs` here, outside the realm (unique names, each need declared before its job), and nothing the realm says is trusted further: the run's commit, repository and
// machine come from the event, never from the flow. Any other import, a relative one included, is refused.

/** The modules a repository flow may import. */
export const MODULES = ["@smthrs/flow", "@smthrs/plan", "@smthrs/sandbox", "effect"] as const

/** The realm's bounds: the source's size, memory, stack, interrupt polls (each a few thousand steps) and the plan's size. */
export const LIMITS = {
  sourceBytes: 64 * 1024,
  memoryBytes: 8 * 1024 * 1024,
  stackBytes: QuickJSLifecycle.stackBytes,
  polls: 2_000,
  planBytes: 256 * 1024,
  jobs: CiJob.limits.jobs,
} as const

/** A value a person gives a flow run by hand: what its form takes. */
export type InputValue = string | number | boolean

/** What the body receives: the run's own fields, and, for a run by hand, the person's inputs beside them. */
export interface Payload {
  readonly run: string
  readonly repo: string
  readonly sha: string
  readonly ref: string
  readonly event: string
  readonly [input: string]: InputValue
}

/** The payload fields every run has: a flow's inputs are its other fields. */
export const RUN_FIELDS = ["run", "repo", "sha", "ref", "event"] as const

/** Why a flow couldn't be planned. */
export const Reason = Schema.Literals(["too_large", "syntax", "import", "evaluation", "limit", "invalid_plan", "tag", "machine"])
export type Reason = typeof Reason.Type

/** A plan: the flow's tag and its jobs, in the order the body named them. */
export const Planned = Schema.Struct({
  _tag: Schema.Literal("planned"),
  tag: Schema.String,
  jobs: CiJob.Jobs,
})
export type Planned = typeof Planned.Type

/** A flow that couldn't be planned, and why. Never carries the source or the realm's message. */
export const Refused = Schema.Struct({ _tag: Schema.Literal("refused"), reason: Reason })
export type Refused = typeof Refused.Type

/**
 * A flow's inputs as JSON Schema, the form a person fills to run it by hand: an object whose properties are the flow's
 * payload fields beyond `RUN_FIELDS`, each a string, number, integer or boolean, with an `enum` from `Schema.Literals`,
 * and `title`, `description` and `default` from its annotations. A field is required unless optional or defaulted.
 */
export const InputProperty = Schema.Struct({
  type: Schema.Literals(["string", "number", "integer", "boolean"]),
  enum: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
})
export const Inputs = Schema.Struct({
  type: Schema.Literal("object"),
  properties: Schema.Record(Schema.String, InputProperty),
  required: Schema.Array(Schema.String),
})
export type Inputs = typeof Inputs.Type

/** A flow's inputs, read in the realm. */
export const Described = Schema.Struct({ _tag: Schema.Literal("described"), tag: Schema.String, inputs: Inputs })
export type Described = typeof Described.Type

/** Why a flow's inputs couldn't be read: as a plan's, or `inputs`, a field no form can fill. */
export const InputsRefused = Schema.Struct({
  _tag: Schema.Literal("refused"),
  reason: Schema.Union([Reason, Schema.Literal("inputs")]),
})
export type InputsRefused = typeof InputsRefused.Type

/** Most input fields a flow may declare. */
export const MAX_INPUTS = 32

export const Plan = Schema.Union([Planned, Refused])
export type Plan = typeof Plan.Type

const refused = (reason: Reason): Refused => ({ _tag: "refused", reason })

// The realm's side: `require`, the module surface, and `__plan`, which calls the body and walks what it returns into
// `{ tag, jobs }` JSON. A node is `{ kind: "job", job }` or `{ kind: "all", members }`; anything else is invalid.
const PRELUDE = String.raw`
"use strict";
const __inert = new Proxy(function () {}, { get: () => __inert, apply: () => __inert, construct: () => __inert });
// Schema records what a form needs of a field, and is inert for anything else: a field it can't read stays unknown.
const __field = (node) => {
  const field = {
    __field: node,
    pipe: (...fns) => fns.reduce((value, fn) => (typeof fn === "function" ? fn(value) : value), field),
    check: () => field,
    annotate: (notes) => {
      const kept = {};
      for (const key of ["title", "description", "default"]) {
        if (notes && Object.prototype.hasOwnProperty.call(notes, key)) kept[key] = notes[key];
      }
      return __field(Object.assign({}, node, kept));
    },
  };
  return field;
};
const __optional = (field) => (field && field.__field ? __field(Object.assign({}, field.__field, { optional: true })) : __inert);
const __Schema = {
  String: __field({ type: "string" }),
  Number: __field({ type: "number" }),
  Int: __field({ type: "integer" }),
  Boolean: __field({ type: "boolean" }),
  Literal: (value) => __field({ type: typeof value, enum: [value] }),
  Literals: (values) => __field({ type: Array.isArray(values) && values.length > 0 ? typeof values[0] : "unknown", enum: values }),
  optional: __optional,
  optionalKey: __optional,
};
const __schema = new Proxy(__Schema, { get: (target, key) => (Object.prototype.hasOwnProperty.call(target, key) ? target[key] : __inert) });
const __modules = {
  "@smthrs/flow": {
    Flow: { make: (tag, options) => ({ __smithersFlow: true, tag, body: options && options.body, payload: options && options.payload }) },
  },
  "@smthrs/plan": { Node: { all: (members) => ({ kind: "all", members }) } },
  "@smthrs/sandbox": {
    CiJob: {
      make: (name, options) => {
        const job = {
          name,
          steps: options && options.steps,
          machine: options && options.machine,
          needs: options && options.needs,
        };
        return { job, call: () => ({ kind: "job", job }) };
      },
    },
  },
  "effect": { Schema: __schema },
};
const __require = (name) => {
  if (!Object.prototype.hasOwnProperty.call(__modules, name)) throw new Error("__import__");
  return __modules[name];
};
const __plan = (exported, payload) => {
  const flow = exported && exported.default;
  if (!flow || flow.__smithersFlow !== true || typeof flow.body !== "function") throw new Error("__plan__");
  const jobs = [];
  const walk = (node, depth) => {
    if (depth > 8 || !node || typeof node !== "object") throw new Error("__plan__");
    if (node.kind === "job") return void jobs.push(node.job);
    if (node.kind !== "all" || !node.members || typeof node.members !== "object") throw new Error("__plan__");
    for (const key of Object.keys(node.members)) walk(node.members[key], depth + 1);
  };
  walk(flow.body(payload), 0);
  return JSON.stringify({ tag: String(flow.tag), jobs });
};
const __describe = (exported, runFields) => {
  const flow = exported && exported.default;
  if (!flow || flow.__smithersFlow !== true) throw new Error("__plan__");
  // A payload is a literal of fields; anything else (a Schema.Struct, which the shim leaves inert) no form can read.
  if (flow.payload !== undefined && (flow.payload === null || typeof flow.payload !== "object")) throw new Error("__inputs__");
  const fields = flow.payload === undefined ? {} : flow.payload;
  const properties = {};
  const required = [];
  for (const name of Object.keys(fields)) {
    if (runFields.indexOf(name) >= 0) continue;
    const field = fields[name] && fields[name].__field;
    if (!field) throw new Error("__inputs__");
    const property = { type: field.type };
    for (const key of ["enum", "title", "description", "default"]) if (field[key] !== undefined) property[key] = field[key];
    properties[name] = property;
    if (!field.optional && field.default === undefined) required.push(name);
  }
  return JSON.stringify({ tag: String(flow.tag), inputs: { type: "object", properties, required } });
};
`

/**
 * Every module a source names: `from "x"`, a bare `import "x"`, and `import(`, `require(` or an `import ... =` by any
 * spelling, which name no allowed module. Strings or comments that only look like one refuse too: the safe direction.
 */
const IMPORT = /\bfrom\s*["'`]([^"'`]*)["'`]|\bimport\s*["'`]([^"'`]*)["'`]|\b(?:import|require)\s*\(/g

const decodeJobs = Schema.decodeUnknownOption(Schema.Struct({ tag: Schema.String, jobs: Planned.fields.jobs }))

/**
 * Evaluates `source` in a fresh realm and calls `invocation` (`__plan(...)` or `__describe(...)`) on its exports: the JSON
 * text it answers, parsed, or why there is none.
 */
const evaluate = (source: string, invocation: string) =>
  Effect.gen(function* () {
    if (new TextEncoder().encode(source).length > LIMITS.sourceBytes) return refused("too_large")
    // Imports are checked in the source: the type stripper drops an import nothing uses, so the realm would never see it.
    if ([...source.matchAll(IMPORT)].some((match) => !(MODULES as ReadonlyArray<string>).includes(match[1] ?? match[2] ?? ""))) {
      return refused("import")
    }
    let compiled: string
    try {
      compiled = transform(source, { transforms: ["typescript", "imports"], production: true }).code
    } catch {
      return refused("syntax")
    }
    const module = yield* Effect.orDie(QuickJSVariant.compiledModule)
    const runtime = module.newRuntime()
    const budget = QuickJSLifecycle.interruptBudget(() => Date.now())
    let hit = false
    try {
      runtime.setMemoryLimit(LIMITS.memoryBytes)
      runtime.setMaxStackSize(LIMITS.stackBytes)
      budget.arm(2_000, LIMITS.polls)
      runtime.setInterruptHandler(() => (hit = budget.poll() !== undefined))
      const context = runtime.newContext()
      try {
        const code = `${PRELUDE}
const __module = { exports: {} };
(function (module, exports, require) {
${compiled}
})(__module, __module.exports, __require);
${invocation};`
        const result = context.evalCode(code, "flow.js")
        if (result.error !== undefined) {
          // What the flow threw is its own value: `dump` copies it out as data, and only a string message is read,
          // never coerced, so nothing it built runs here.
          const error: unknown = context.dump(result.error)
          result.error.dispose()
          const thrown = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error
          const message = typeof thrown === "string" ? thrown : ""
          return hit || /out of memory|stack overflow|interrupted/i.test(message)
            ? refused("limit")
            : message === "__import__"
            ? refused("import")
            : message === "__plan__"
            ? refused("invalid_plan")
            : message === "__inputs__"
            ? { _tag: "refused" as const, reason: "inputs" as const }
            : refused("evaluation")
        }
        const text: unknown = context.dump(result.value)
        result.value.dispose()
        if (typeof text !== "string" || text.length > LIMITS.planBytes) return refused("invalid_plan")
        try {
          return { _tag: "evaluated" as const, value: JSON.parse(text) as unknown }
        } catch {
          return refused("invalid_plan")
        }
      } finally {
        context.dispose()
      }
    } finally {
      runtime.dispose()
    }
  })

/**
 * Plans flow `name` from its `flow.ts` source for `payload`: the jobs its body declares, or why it couldn't be planned.
 * The flow's `Flow.make` tag must be `name`, the directory it lives in.
 */
export const plan = (name: string, source: string, payload: Payload): Effect.Effect<Plan, never, QuickJSVariant.Variant> =>
  Effect.gen(function* () {
    const evaluated = yield* evaluate(source, `__plan(__module.exports, ${JSON.stringify(payload)})`)
    // A plan's body can't declare inputs: the realm reads them only when asked to describe the flow.
    if (evaluated._tag === "refused") return evaluated.reason === "inputs" ? refused("invalid_plan") : evaluated
    const decoded = decodeJobs(evaluated.value)
    if (decoded._tag === "None") return refused("invalid_plan")
    if (decoded.value.tag !== name) return refused("tag")
    return { _tag: "planned", tag: decoded.value.tag, jobs: decoded.value.jobs } satisfies Planned
  }).pipe(Effect.withSpan("ci.realm.plan", { attributes: { "smithers.ci.flow": name } }))

const decodeDescribed = Schema.decodeUnknownOption(Schema.Struct({ tag: Schema.String, inputs: Inputs }))

/**
 * Reads flow `name`'s inputs from its `flow.ts` source, without running its body: the form a person fills to run it by
 * hand, or why it can't be read. `inputs` when a field is one no form can fill, or there are more than `MAX_INPUTS`.
 */
export const describe = (
  name: string,
  source: string,
): Effect.Effect<Described | InputsRefused, never, QuickJSVariant.Variant> =>
  Effect.gen(function* () {
    const evaluated = yield* evaluate(source, `__describe(__module.exports, ${JSON.stringify(RUN_FIELDS)})`)
    if (evaluated._tag === "refused") return evaluated
    const decoded = decodeDescribed(evaluated.value)
    if (decoded._tag === "None" || Object.keys(decoded.value.inputs.properties).length > MAX_INPUTS) {
      return { _tag: "refused", reason: "inputs" } as const
    }
    if (decoded.value.tag !== name) return refused("tag")
    return { _tag: "described", tag: decoded.value.tag, inputs: decoded.value.inputs } satisfies Described
  }).pipe(Effect.withSpan("ci.realm.describe", { attributes: { "smithers.ci.flow": name } }))
