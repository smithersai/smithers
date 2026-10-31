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

/** What the body receives. */
export interface Payload {
  readonly run: string
  readonly repo: string
  readonly sha: string
  readonly ref: string
  readonly event: string
}

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

export const Plan = Schema.Union([Planned, Refused])
export type Plan = typeof Plan.Type

const refused = (reason: Reason): Refused => ({ _tag: "refused", reason })

// The realm's side: `require`, the module surface, and `__plan`, which calls the body and walks what it returns into
// `{ tag, jobs }` JSON. A node is `{ kind: "job", job }` or `{ kind: "all", members }`; anything else is invalid.
const PRELUDE = String.raw`
"use strict";
const __inert = new Proxy(function () {}, { get: () => __inert, apply: () => __inert, construct: () => __inert });
const __modules = {
  "@smthrs/flow": { Flow: { make: (tag, options) => ({ __smithersFlow: true, tag, body: options && options.body }) } },
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
  "effect": { Schema: __inert },
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
`

/**
 * Every module a source names: `from "x"`, a bare `import "x"`, and `import(`, `require(` or an `import ... =` by any
 * spelling, which name no allowed module. Strings or comments that only look like one refuse too: the safe direction.
 */
const IMPORT = /\bfrom\s*["'`]([^"'`]*)["'`]|\bimport\s*["'`]([^"'`]*)["'`]|\b(?:import|require)\s*\(/g

const decodeJobs = Schema.decodeUnknownOption(Schema.Struct({ tag: Schema.String, jobs: Planned.fields.jobs }))

/**
 * Plans flow `name` from its `flow.ts` source for `payload`: the jobs its body declares, or why it couldn't be planned.
 * The flow's `Flow.make` tag must be `name`, the directory it lives in.
 */
export const plan = (name: string, source: string, payload: Payload): Effect.Effect<Plan, never, QuickJSVariant.Variant> =>
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
__plan(__module.exports, ${JSON.stringify(payload)});`
        const result = context.evalCode(code, "flow.js")
        if (result.error !== undefined) {
          // What the flow threw is its own value: `dump` copies it out as data, and only a string message is read,
          // never coerced, so nothing it built runs here.
          const error: unknown = context.dump(result.error)
          result.error.dispose()
          const thrown = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error
          const message = typeof thrown === "string" ? thrown : ""
          return refused(
            hit || /out of memory|stack overflow|interrupted/i.test(message)
              ? "limit"
              : message === "__import__"
              ? "import"
              : message === "__plan__"
              ? "invalid_plan"
              : "evaluation",
          )
        }
        const text: unknown = context.dump(result.value)
        result.value.dispose()
        if (typeof text !== "string" || text.length > LIMITS.planBytes) return refused("invalid_plan")
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          return refused("invalid_plan")
        }
        const decoded = decodeJobs(parsed)
        if (decoded._tag === "None") return refused("invalid_plan")
        if (decoded.value.tag !== name) return refused("tag")
        return { _tag: "planned", tag: decoded.value.tag, jobs: decoded.value.jobs } satisfies Planned
      } finally {
        context.dispose()
      }
    } finally {
      runtime.dispose()
    }
  }).pipe(Effect.withSpan("ci.realm.plan", { attributes: { "smithers.ci.flow": name } }))
