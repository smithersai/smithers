import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, DurableDeferred, HumanTask, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { Ownership } from "@smthrs/run-store"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { atomDelegate } from "../coding/atoms.ts"
import { checkDelegate } from "../coding/checks.ts"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import { gather, memoryLayer } from "../coding/planning-memory.ts"
import { DraftPlan, finalize, planningPolicy, PreparePlan, ReviewRequest, type Draft, type PlanningContext } from "../coding/planning.ts"
import { layerAt } from "../coding/snapshots.ts"
import { admitSource } from "../coding/source-admission.ts"
import { operations } from "../wiki/operations.ts"
import type { PageSpec } from "../wiki/schema.ts"

const input = { prompt: "Add the next feature using the existing answer.", feedback: "" }
const revision = (index: number) => ({ changeId: `native-${index}`, commitId: `commit-${index}`, treeId: `tree-${index}`,
  operationId: "operation", parentCommitIds: [`commit-${index - 1}`], description: `✨ feat: atom ${index}` })
const context: PlanningContext = {
  head: revision(3), history: [revision(1), revision(2), revision(3)], memory: [], memoryRevision: "sha256:memory",
  implementation: "coding/atoms", implementationDigest: "sha256:implementation",
  checks: ["fast", "slow"].map(tier => ({ id: tier, target: `//:${tier}`, flow: `checks/${tier}`,
    flowDigest: `sha256:${tier}`, tier: tier as "fast" | "slow", required: true }))
}
const atom = (changeId: string | null) => ({ changeId, message: "✨ feat: small change", intent: "Implement a small change.", reads: ["src/answer.ts"], writes: ["src/next.ts"] })
const draft = (base: string, ids: ReadonlyArray<string | null>): Draft => ({ rationale: "Use captured evidence.", baseChangeId: base,
  changes: [{ id: "feature", title: "Feature", intent: "Add feature", atoms: ids.map(atom), checks: ["fast", "slow"] }] })

test("planning retains every operator-required check even when the model selects another slow check", () => {
  const check = (id: string, required: boolean, tier: "slow" | "delivery" = "slow") => ({
    id, target: `//:${id}`, flow: `checks/${id}`, flowDigest: `sha256:${id}`, tier, required
  })
  const configured: PlanningContext = { ...context,
    checks: [...context.checks, check("wiki", true), check("canary", true, "delivery"),
      check("optional", false), check("unused", false)] }
  const proposed = draft("native-3", [null])
  const first = proposed.changes[0]!
  const plan = finalize(input, configured, { ...proposed, changes: [
    { ...first, checks: [...first.checks, "optional"] },
    { ...first, id: "next", checks: [...first.checks, "wiki"] }
  ] })
  assert.deepEqual(plan.changes.map(change => change.checks.map(check => check.id)), [
    ["fast", "slow", "optional", "wiki", "canary"],
    ["fast", "slow", "wiki", "canary"]
  ])
  for (const change of plan.changes) {
    for (const required of configured.checks.filter(check => check.required)) {
      assert.equal(change.checks.find(check => check.id === required.id), required)
    }
  }
})

test("planning binds catalog facts and preserves the entire native suffix before new atoms", () => {
  const append = finalize(input, context, draft("native-3", [null]))
  assert.deepEqual(append.base, context.head)
  assert.deepEqual(append.changes[0]!.checks, context.checks)
  assert.equal(append.changes[0]!.implementationDigest, context.implementationDigest)
  assert.equal(append.memoryRevision, context.memoryRevision)
  assert.deepEqual(append.observedHead, context.head)
  assert.deepEqual(finalize(input, context, draft("native-1", ["native-2", "native-3", null])).changes[0]!.atoms.map(a => a.changeId), ["native-2", "native-3", null])
  for (const proposed of [draft("outside", [null]), draft("native-1", ["native-3"]),
    draft("native-1", ["native-3", "native-2"]), draft("native-1", ["native-2", null, "native-3"]),
    draft("native-1", ["native-2", "native-2", "native-3"])]) {
    assert.throws(() => finalize(input, context, proposed), /coding\/Error/)
  }
  for (const path of ["/absolute", "../secret", "src/../secret", ".git/config", ".JJ/x", "src\\x", "src//x", "src/\0x"]) {
    const proposed = draft("native-3", [null])
    assert.throws(() => finalize(input, context, { ...proposed, changes: [{ ...proposed.changes[0]!, atoms: [{ ...atom(null), writes: [path] }] }] }), /relative paths/)
  }
  const proposed = draft("native-3", [null])
  for (const ids of [["missing", "slow"], ["fast", "fast"]]) assert.throws(() => finalize(input, context,
    { ...proposed, changes: [{ ...proposed.changes[0]!, checks: ids }] }), /coding\/Error/)
  assert.throws(() => finalize(input, { ...context, history: [revision(1), revision(3)] }, proposed), /linear native chain/)
})

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
test("native memory and a real SQLite clarification resume across hosts and reject changed source", {
  skip: source === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE to the native Plue adapter with history support" : false,
  timeout: 600_000
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-planning-")))
  let close = async () => {}
  t.after(async () => { await close(); await rm(temporary, { force: true, recursive: true }) })
  const root = join(temporary, "repo"), output = join(temporary, "wiki")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Planning Acceptance")
  jj("config", "set", "--repo", "user.email", "planning@example.com")
  await mkdir(join(root, "src"))
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  await writeFile(join(root, "page.md"), "# Answer\n\nThe answer is 42.\n")
  await writeFile(join(root, "src/answer.ts"), "export const answer = 42\n")
  for (const [name, delegate, body] of [["coding/atoms", "coding/Implement", "Implement the supplied atom."],
    ["checks/fast", "coding/CommandCheck", JSON.stringify({ argv: ["true"], cwd: ".", timeoutMs: 1000 })],
    ["checks/slow", "coding/CommandCheck", JSON.stringify({ argv: ["true"], cwd: ".", timeoutMs: 1000 })]]) {
    const directory = join(root, "flows", name!)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "flow.mdx"), `---\ndescription: Planning fixture.\nflows: [${delegate}]\n---\n${body}\n`)
  }
  jj("describe", "-m", "🏗️ chore: stable foundation")
  jj("new", "-m", "✨ feat: current native tip")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), adapterPath = join(temporary, "coding.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "planning-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(adapterPath, (await readFile(source!, "utf8")).replaceAll("/etc/smithers/workspace-coding.json", config)
    .replaceAll("/usr/local/bin/smithers-workspace-head", reporter))
  const platform = "Bun" in globalThis
    ? (await import("../../packages/smithers/flows/platform-bun/node_modules/@effect/platform-bun/dist/BunServices.js")).layer
    : NodeServices.layer
  const runtime = "Bun" in globalThis ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
  const runPlatform = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem | import("effect/Path").Path | import("effect/Crypto").Crypto>) => Effect.runPromise(effect.pipe(Effect.provide(platform)))
  const spec: PageSpec = { id: "answer", title: "Answer", purpose: "Find the answer.", kind: "current", document: "page.md", inputs: ["src/answer.ts"], related: [] }
  const wiki = operations({ root, output }), evidence = await runPlatform(wiki.collect(spec))
  // This fixture exercises the real verifier protocol. Its scripted citation
  // is not represented as a production model's semantic-review verdict.
  await runPlatform(wiki.write([{ evidence, reviewer: "scripted-planning-acceptance", review: {
    sections: evidence.sections.map(section => ({ id: section.id, verdict: "supported", explanation: "The exported constant is 42.",
      citations: [{ path: "src/answer.ts", line: 1, quote: "export const answer = 42" }] }))
  } }], "verified"))
  const executables = await Effect.runPromise(Effect.gen(function*() {
    const catalog = yield* (yield* Discovery.Discovery).scan({ source: "project", root: join(root, "flows"), naming: "path" })
    assert.equal(catalog.entries.length, 3)
    return yield* Effect.forEach(catalog.entries, descriptor => Executable.fromDescriptor(descriptor, { delegates: [atomDelegate, checkDelegate] }))
  }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(platform)))))
  const options = { repositoryPath: root, wikiOutput: output, pages: [spec], implementation: "coding/atoms", checks: context.checks.map(({ flowDigest: _, ...check }) => check) }
  let reviewed = 0, drafted = 0
  const registrations = Layer.mergeAll(memoryLayer(options), planningPolicy, HumanTask.layer, Interpreter.layer(PreparePlan),
    ReviewRequest.toLayer(() => Effect.sync(() => { reviewed++; return { explanation: "The current answer is 42.", clarification: "Should the next feature preserve the answer?" } })),
    DraftPlan.toLayer(({ context, answer }) => Effect.sync(() => {
      drafted++; assert.equal(answer, "Preserve 42")
      return draft(context.head.changeId, [null])
    }))
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables, refused: [] })),
    Layer.provideMerge(nativeLayer({ sourcePublication: "local-only", repositoryPath: root, adapterPath })))
  const make = () => ManagedRuntime.make(runtime.layer({ filename: join(root, ".flows", "engine.db"), workspaceRoot: root,
    owner: { hostId: "planning-acceptance" }, isAlive: Ownership.sameHostPidProbe }, StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), registrations).pipe(
      Layer.provideMerge(layerAt({ repositoryPath: root, adapterPath })), Layer.provideMerge(platform),
      Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))))
  let host = make()
  close = () => host.dispose()
  const token = (executionId: string) => DurableDeferred.tokenFromExecutionId(HumanTask.deferred("coding-clarification", 1), { flow: PreparePlan, executionId })
  const park = async (executionId: string) => {
    await host.runPromise(PreparePlan.execute(input, { executionId, discard: true }), { signal: t.signal })
    const state = await host.runPromise(Effect.flatMap(DurableEngineState.DurableEngineState, state => state.waiting(executionId)))
    assert.ok(Option.isSome(state))
    assert.equal(state.value.reason, "approval")
    assert.equal(state.value.token, token(executionId))
  }
  await park("planning-resume")
  assert.equal(reviewed, 1)
  assert.equal(drafted, 0)
  await host.dispose()
  host = make()
  await host.runPromise(HumanTask.answer({ token: token("planning-resume"), value: "Preserve 42" }))
  const plan = await host.runPromise(PreparePlan.execute(input, { executionId: "planning-resume" }), { signal: t.signal })
  assert.match(plan.memoryRevision, /^sha256:[0-9a-f]{64}$/)
  assert.equal(plan.changes[0]!.implementation, "coding/atoms")
  assert.match(plan.changes[0]!.implementationDigest, /^[0-9a-f]{64}$/)
  const native = await host.runPromise(Effect.flatMap(NativeCoding, native => native.read([], 2)))
  assert.equal(native.history?.length, 2)
  assert.equal(native.head.changeId, plan.base.changeId)
  assert.equal(plan.observedHead?.commitId, native.head.commitId)
  assert.deepEqual(await host.runPromise(admitSource(plan)), plan)
  const { observedHead: _, ...legacyPlan } = plan
  await assert.rejects(host.runPromise(admitSource(legacyPlan)), /observed native source head/)
  const counts = { reviewed, drafted }
  assert.deepEqual(await host.runPromise(PreparePlan.execute(input, { executionId: "planning-resume" })), plan)
  assert.deepEqual({ reviewed, drafted }, counts)
  assert.deepEqual(counts, { reviewed: 1, drafted: 1 })
  await park("planning-stale")
  await host.dispose()
  await writeFile(join(root, "unrelated.txt"), "changed while waiting\n")
  host = make()
  await host.runPromise(HumanTask.answer({ token: token("planning-stale"), value: "Preserve 42" }))
  await assert.rejects(host.runPromise(PreparePlan.execute(input, { executionId: "planning-stale" }), { signal: t.signal }), /Native code changed during planning/)
  await assert.rejects(host.runPromise(admitSource(plan)), /Native source changed after this plan/)
  await writeFile(join(root, "src/answer.ts"), "export const answer = 43\n")
  await assert.rejects(host.runPromise(gather(options, input)), /Stale wiki page/)
  t.diagnostic("Real JJ history, verified artifact checks, durable SQLite wait and reopened replay passed; model decisions were scripted.")
})
