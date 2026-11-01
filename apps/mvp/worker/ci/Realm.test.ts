// A repository flow's plan in the real QuickJS realm (worker/ci/Realm.ts), from TypeScript source as a repository
// commits it. No stand-in: the build's own QuickJS module, the separate-file build the Worker also uses.
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import { QuickJSVariant } from "@smthrs/harness"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { describe, expect, test } from "vitest"
import * as Realm from "./Realm.ts"

const payload: Realm.Payload = {
  run: "ci:delivery-1",
  repo: "acme/widgets",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  event: "push",
}

const plan = (source: string, name = "ci", input = payload) =>
  Effect.runPromise(
    Realm.plan(name, source, input).pipe(
      Effect.provide(QuickJSVariant.layerVariant(wasmfile as unknown as QuickJSSyncVariant)),
    ),
  )

/** The repository's CI as the docs show it: two jobs at once, typed, with a payload declared through Schema. */
const CI = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const versions: CiJob.Job = CiJob.make("versions", {
  steps: [{ name: "node", run: "node --version" }, { name: "pnpm", run: "pnpm --version" }],
})
const lint = CiJob.make("lint", { steps: [{ name: "lint", run: "pnpm lint", timeoutSeconds: 300 }] })

export default Flow.make("ci", {
  description: "Every push: versions and lint.",
  payload: { repo: Schema.String, sha: Schema.String },
  body: (target: { readonly sha: string }) => Node.all({ versions: versions.call(target), lint: lint.call(target) }),
})
`

describe("a repository flow's plan in the realm", () => {
  test("plans the jobs a TypeScript flow declares, in the order its body names them", async () => {
    expect(await plan(CI)).toEqual({
      _tag: "planned",
      tag: "ci",
      jobs: [
        { name: "versions", steps: [{ name: "node", run: "node --version" }, { name: "pnpm", run: "pnpm --version" }] },
        { name: "lint", steps: [{ name: "lint", run: "pnpm lint", timeoutSeconds: 300 }] },
      ],
    })
  })

  test("a body may decide from the run's payload, and return one job", async () => {
    const source = `
import { Flow } from "@smthrs/flow"
import { CiJob } from "@smthrs/sandbox"
export default Flow.make("ci", {
  body: (run) => CiJob.make(run.event === "push" ? "on-push" : "on-pull", { steps: [{ name: "x", run: "echo " + run.sha.slice(0, 7) }] }).call(run),
})`
    expect(await plan(source)).toEqual({
      _tag: "planned",
      tag: "ci",
      jobs: [{ name: "on-push", steps: [{ name: "x", run: "echo aaaaaaa" }] }],
    })
    expect(await plan(source, "ci", { ...payload, event: "pull_request" })).toMatchObject({ jobs: [{ name: "on-pull" }] })
  })

  test("refuses any import but the four modules, used or not: a relative file, Node's, a package, a dynamic one", async () => {
    for (const from of ["./jobs.ts", "node:child_process", "lodash"]) {
      expect(await plan(`import x from "${from}"\n${CI}`)).toEqual({ _tag: "refused", reason: "import" })
      expect(await plan(`import "${from}"\n${CI}`)).toEqual({ _tag: "refused", reason: "import" })
      expect(await plan(`export { y } from "${from}"\n${CI}`)).toEqual({ _tag: "refused", reason: "import" })
    }
    expect(await plan(`const m = import("node:fs")\n${CI}`)).toEqual({ _tag: "refused", reason: "import" })
    expect(await plan(`const m = require("node:fs")\n${CI}`)).toEqual({ _tag: "refused", reason: "import" })
    // Past the source check, the realm's own require refuses it too.
    expect(await plan(`const r = require; r("node:fs")\n${CI}`)).toEqual({ _tag: "refused", reason: "import" })
    expect(await plan(`import type { Job } from "@smthrs/sandbox"\n${CI}`)).toMatchObject({ _tag: "planned" })
  })

  test("stops a loop that never ends", async () => {
    expect(await plan(`while (true) {}\n${CI}`)).toEqual({ _tag: "refused", reason: "limit" })
  })

  test("stops a body that eats memory", async () => {
    expect(await plan(`const a = []; while (true) a.push(new Array(1e5).fill(1))\n${CI}`)).toEqual({ _tag: "refused", reason: "limit" })
  })

  test("stops a recursion that never ends", async () => {
    expect(await plan(`const f = (n: number): number => f(n + 1); f(0)\n${CI}`)).toEqual({ _tag: "refused", reason: "limit" })
  })

  test("refuses a source too large, one that doesn't parse, and one that throws", async () => {
    expect(await plan(`// ${"x".repeat(Realm.LIMITS.sourceBytes)}\n${CI}`)).toEqual({ _tag: "refused", reason: "too_large" })
    expect(await plan(`export default Flow.make("ci", {`)).toEqual({ _tag: "refused", reason: "syntax" })
    expect(await plan(`throw new Error("no")\n${CI}`)).toEqual({ _tag: "refused", reason: "evaluation" })
    expect(await plan(`throw "no"\n${CI}`)).toEqual({ _tag: "refused", reason: "evaluation" })
    // A thrown value built to break whoever reads it is never coerced outside the realm.
    expect(await plan(`throw { message: { toString: 0, valueOf: 0 } }\n${CI}`)).toEqual({ _tag: "refused", reason: "evaluation" })
    expect(await plan(`throw { get message() { throw 1 }, toJSON() { throw 2 } }\n${CI}`)).toEqual({ _tag: "refused", reason: "evaluation" })
    expect(await plan(`throw new Proxy({}, { get() { throw 3 }, ownKeys() { throw 4 }, getPrototypeOf() { throw 5 } })\n${CI}`))
      .toEqual({ _tag: "refused", reason: "evaluation" })
    // The realm has no network: there is no fetch to call.
    expect(await plan(`fetch("https://example.com")\n${CI}`)).toEqual({ _tag: "refused", reason: "evaluation" })
  })

  test("refuses what isn't a plan of jobs: no flow, a body returning anything else, a bad or repeated job", async () => {
    const flow = (body: string) => `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
const a = CiJob.make("a", { steps: [{ name: "a", run: "true" }] })
export default Flow.make("ci", { body: () => ${body} })`
    expect(await plan(`export const x = 1`)).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(flow(`"run everything"`))).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(flow(`Node.all({})`))).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(flow(`Node.all({ one: a.call(), two: a.call() })`))).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(flow(`CiJob.make("../up", { steps: [{ name: "a", run: "true" }] }).call()`))).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(flow(`CiJob.make("b", { steps: [] }).call()`))).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(flow(`Node.all({ deep: Node.all({ deeper: a.call() }) })`))).toMatchObject({ _tag: "planned", jobs: [{ name: "a" }] })
  })

  test("plans each job's machine and needs, and refuses a need on a later, undeclared or own job, or a bad machine", async () => {
    const flow = (jobs: string) => `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
const steps = [{ name: "a", run: "true" }]
export default Flow.make("ci", { body: (run) => Node.all({ ${jobs} }) })`
    const shard = `shard: CiJob.make("shard", { steps, machine: "gate" }).call()`
    const merge = (needs: string) => `merge: CiJob.make("merge", { steps, machine: "gate", needs: ${needs} }).call()`
    expect(await plan(flow(`${shard}, ${merge(`["shard"]`)}`))).toEqual({
      _tag: "planned",
      tag: "ci",
      jobs: [
        { name: "shard", steps: [{ name: "a", run: "true" }], machine: "gate" },
        { name: "merge", steps: [{ name: "a", run: "true" }], machine: "gate", needs: ["shard"] },
      ],
    })
    for (const jobs of [`${merge(`["shard"]`)}, ${shard}`, merge(`["nowhere"]`), merge(`["merge"]`), merge(`"shard"`)]) {
      expect(await plan(flow(jobs))).toEqual({ _tag: "refused", reason: "invalid_plan" })
    }
    expect(await plan(flow(`bad: CiJob.make("bad", { steps, machine: "../gate" }).call()`)))
      .toEqual({ _tag: "refused", reason: "invalid_plan" })
  })

  test("refuses a flow whose tag isn't its directory's name", async () => {
    expect(await plan(CI, "release")).toEqual({ _tag: "refused", reason: "tag" })
  })

  test("refuses a plan the flow forged by replacing JSON.stringify", async () => {
    expect(await plan(`JSON.stringify = () => 42\n${CI}`)).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(`JSON.stringify = () => "{"\n${CI}`)).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await plan(`JSON.stringify = () => "x".repeat(300000)\n${CI}`)).toEqual({ _tag: "refused", reason: "invalid_plan" })
  })

  test("plans the e2e test repository's flow as committed: a typed payload and success, inert in the realm", async () => {
    const source = readFileSync(new URL("../../e2e/fixtures/ci-repo/.smithers/flows/ci/flow.ts", import.meta.url), "utf8")
    expect(await plan(source)).toEqual({
      _tag: "planned",
      tag: "ci",
      jobs: [
        { name: "toolchain", steps: [{ name: "node", run: "node --version" }, { name: "pnpm", run: "pnpm --version" }] },
        { name: "checkout", steps: [{ name: "readme", run: "test -f README.md" }, { name: "marker", run: "test -f ci-e2e.txt" }] },
      ],
    })
  })
})

test("plans this repository's own gate: 16 shards on the gate machine, then the coverage job that needs them all", async () => {
  const source = readFileSync(new URL("../../../../.smithers/flows/gate/flow.ts", import.meta.url), "utf8")
  const planned = await plan(source, "gate")
  expect(planned._tag).toBe("planned")
  if (planned._tag !== "planned") return
  const shards = Array.from({ length: 16 }, (_, index) => `mvp-${index + 1}`)
  expect(planned.jobs.map((job) => job.name)).toEqual([...shards, "mvp-coverage"])
  expect(new Set(planned.jobs.map((job) => job.machine))).toEqual(new Set(["gate"]))
  expect(planned.jobs.at(-1)?.needs).toEqual(shards)
  expect(planned.jobs[2]?.steps.map((step) => step.run)).toEqual(["sh apps/mvp/ci/gate.sh install", "sh apps/mvp/ci/gate.sh shard 3 16"])
})

const describeFlow = (source: string, name = "release") =>
  Effect.runPromise(
    Realm.describe(name, source).pipe(Effect.provide(QuickJSVariant.layerVariant(wasmfile as unknown as QuickJSSyncVariant))),
  )

/** A flow a person runs by hand: inputs beside the run's own fields, typed, optional, defaulted and chosen. */
const RELEASE = `
import { Flow } from "@smthrs/flow"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const publish = CiJob.make("publish", { steps: [{ name: "publish", run: "pnpm release" }] })

export default Flow.make("release", {
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String,
    tag: Schema.String.check(Schema.isMinLength(1)).annotate({ title: "Tag", description: "The dist-tag" }),
    dryRun: Schema.Boolean.annotate({ default: true }),
    channel: Schema.Literals(["next", "latest"]),
    attempts: Schema.optionalKey(Schema.Int),
    ratio: Schema.optional(Schema.Number),
    kind: Schema.Literal("npm"),
  },
  body: (payload: { readonly dryRun: boolean }) => (payload.dryRun ? publish.call(payload) : publish.call(payload)),
})
`

describe("a repository flow's inputs in the realm", () => {
  test("reads the form a person fills: each field beyond the run's own, its type, choices, notes and default", async () => {
    expect(await describeFlow(RELEASE)).toEqual({
      _tag: "described",
      tag: "release",
      inputs: {
        type: "object",
        properties: {
          tag: { type: "string", title: "Tag", description: "The dist-tag" },
          dryRun: { type: "boolean", default: true },
          channel: { type: "string", enum: ["next", "latest"] },
          attempts: { type: "integer" },
          ratio: { type: "number" },
          kind: { type: "string", enum: ["npm"] },
        },
        required: ["tag", "channel", "kind"],
      },
    })
  })

  test("a flow with no inputs has an empty form, and its body never runs", async () => {
    const source = CI.replace("body: (target", "body: (never: unknown) => { throw new Error('ran') }, ignored: (target")
    expect(await describeFlow(source, "ci")).toEqual({
      _tag: "described",
      tag: "ci",
      inputs: { type: "object", properties: {}, required: [] },
    })
  })

  test("refuses a field no form can fill, too many inputs, a flow under another tag, and what a plan refuses", async () => {
    const nested = RELEASE.replace('kind: Schema.Literal("npm")', "kind: Schema.Struct({ a: Schema.String })")
    const mixed = RELEASE.replace('kind: Schema.Literal("npm")', "kind: Schema.Literals([])")
    const many = RELEASE.replace(
      'kind: Schema.Literal("npm"),',
      Array.from({ length: Realm.MAX_INPUTS }, (_, i) => `f${i}: Schema.String,`).join("\n"),
    )
    expect(await describeFlow(nested)).toEqual({ _tag: "refused", reason: "inputs" })
    // A payload declared as one Schema.Struct: no field of it can be read, so none would reach the body.
    const struct = RELEASE.replace("payload: {", "payload: Schema.Struct({").replace('kind: Schema.Literal("npm"),\n  },', 'kind: Schema.Literal("npm"),\n  }),')
    expect(struct).toContain("Schema.Struct({")
    expect(await describeFlow(struct)).toEqual({ _tag: "refused", reason: "inputs" })
    expect(await describeFlow(mixed)).toEqual({ _tag: "refused", reason: "inputs" })
    expect(await describeFlow(many)).toEqual({ _tag: "refused", reason: "inputs" })
    expect(await describeFlow(RELEASE, "ci")).toEqual({ _tag: "refused", reason: "tag" })
    expect(await describeFlow("export default {}")).toEqual({ _tag: "refused", reason: "invalid_plan" })
    expect(await describeFlow("import fs from 'node:fs'")).toEqual({ _tag: "refused", reason: "import" })
  })

  test("a body that throws the realm's own refusal word is no plan", async () => {
    const source = CI.replace("body: (target", "body: () => { throw new Error('__inputs__') }, ignored: (target")
    expect(await plan(source)).toEqual({ _tag: "refused", reason: "invalid_plan" })
  })

  test("a run by hand's inputs reach the body beside the run's fields", async () => {
    const source = `
import { Flow } from "@smthrs/flow"
import { CiJob } from "@smthrs/sandbox"
export default Flow.make("ci", {
  body: (payload: { readonly channel: string; readonly event: string }) =>
    CiJob.make(payload.event + "-" + payload.channel, { steps: [{ name: "s", run: "true" }] }).call(payload),
})
`
    expect(await plan(source, "ci", { ...payload, event: "manual", channel: "next" })).toMatchObject({
      _tag: "planned",
      jobs: [{ name: "manual-next" }],
    })
  })
})

test("the e2e test repository's flow run by hand: its form, and its plan quotes the greeting for the shell", async () => {
  const source = readFileSync(new URL("../../e2e/fixtures/ci-repo/.smithers/flows/hand/flow.ts", import.meta.url), "utf8")
  expect(await describeFlow(source, "hand")).toEqual({
    _tag: "described",
    tag: "hand",
    inputs: {
      type: "object",
      properties: {
        greeting: { type: "string", title: "Greeting" },
        wait: { type: "string", enum: ["1", "300"], title: "Wait", default: "1" },
      },
      required: ["greeting"],
    },
  })
  expect(await plan(source, "hand", { ...payload, event: "manual", greeting: "it's $(true)", wait: "300" })).toEqual({
    _tag: "planned",
    tag: "hand",
    jobs: [{
      name: "greet",
      steps: [
        { name: "hello", run: "echo 'it'\\''s $(true)'" },
        { name: "wait", run: "sleep 300" },
        { name: "again", run: "echo 'it'\\''s $(true)' again" },
      ],
    }],
  })
})
