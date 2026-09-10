import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Action, DurableDeferred, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import * as Registry from "@smthrs/registry/Registry"
import { Ownership } from "@smthrs/run-store"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema, Stream } from "effect"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import { MaterializePoc, Poc, materializePoc, pocModels, sourceDigest, type PocSource, type PocDraft } from "../coding/poc.ts"
import { pocSource } from "../coding/poc-source.ts"
import { layerAt } from "../coding/snapshots.ts"
import { sameRevision, type Plan } from "../coding/schema.ts"

const revision = { changeId: "change", commitId: "commit", treeId: "tree", operationId: "operation", parentCommitIds: ["parent"] }
const captured = (files: PocSource["files"], writable: PocSource["writable"]): PocSource => {
  const value = { revision, files, writable }
  return { ...value, digest: sourceDigest(value) }
}
test("POC measures actual writes/removals, escapes the retained preview and refuses unmeasured proposals", async () => {
  const source = captured([{ path: "index.html", content: "old" }, { path: "remove.txt", content: "gone" }, { path: "new.txt", content: null }],
    ["index.html", "remove.txt", "new.txt"])
  const draft: PocDraft = { explanation: "Prototype", files: [{ path: "index.html", content: "<script>bad()</script>" },
    { path: "remove.txt", content: null }, { path: "new.txt", content: "new" }] }
  const run = (source: PocSource, draft: PocDraft) => Effect.runPromise(materializePoc({ source, draft }).pipe(Effect.provide(NodeServices.layer)))
  const result = await run(source, draft)
  assert.deepEqual(result.files.map(file => [file.path, file.before, file.after]), [
    ["index.html", "old", "<script>bad()</script>"], ["new.txt", null, "new"], ["remove.txt", "gone", null]
  ])
  assert.match(result.preview.content, /&lt;script&gt;bad\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(result.preview.content, /<script>/)
  assert.equal(result.preview.mediaType, "text/html")
  assert.deepEqual(await run(source, draft), result)
  const bom = await run(captured([{ path: "bom.txt", content: "\uFEFFold" }], ["bom.txt"]), {
    explanation: "Preserve source bytes", files: [{ path: "bom.txt", content: "\uFEFFnew" }] })
  assert.equal(bom.files[0]!.before, "\uFEFFold")
  assert.equal(bom.files[0]!.after, "\uFEFFnew")
  const long = await run(captured([{ path: "long.txt", content: "<".repeat(6000) }], ["long.txt"]), {
    explanation: "Bound the preview, retain full values", files: [{ path: "long.txt", content: ">".repeat(6000) }] })
  assert.equal(long.files[0]!.after, ">".repeat(6000))
  assert.match(long.preview.content, /Preview excerpt/)
  assert.equal(source.files[0]!.content, "old")
  for (const proposed of [ [{ path: "../escape", content: "x" }], [{ path: ".jj/meta", content: "x" }],
    [{ path: "new.txt", content: null }], [{ path: "index.html", content: "x" }, { path: "index.html", content: "y" }],
    [{ path: "outside.txt", content: "x" }], [{ path: "index.html", content: "old" }] ]) {
    await assert.rejects(run(source, { explanation: "Refuse", files: proposed }), /coding\/Error/)
  }
  await assert.rejects(run({ ...source, digest: "wrong" }, draft), /captured digest/)
  await assert.rejects(run(source, { explanation: "Too many UTF-8 bytes", files: [{ path: "index.html", content: "🌱".repeat(20_000) }] }), /bounded file-level/)
})

const adapterSource = process.env.PLUE_CODING_ADAPTER_SOURCE
const exporter = process.env.PLUE_JJ_EXPORT_BINARY
test("real native source, QuickJS drafting and SQLite replay retain a discarded POC without changing JJ", {
  skip: !adapterSource || !exporter ? "Set PLUE_CODING_ADAPTER_SOURCE and PLUE_JJ_EXPORT_BINARY to native Plue artifacts" : false,
  timeout: 600_000
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "coding-poc-acceptance-")), root = join(directory, "repo")
  let close = async () => {}, passed = false
  t.diagnostic(`POC evidence: ${directory}`)
  t.after(async () => { await close(); if (passed) await rm(directory, { recursive: true, force: true }) })
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "POC Acceptance")
  jj("config", "set", "--repo", "user.email", "poc@example.com")
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  await writeFile(join(root, "index.html"), "<h1>Original</h1>\n")
  await writeFile(join(root, "remove.txt"), "\uFEFFOriginal file\n")
  jj("describe", "-m", "🏗️ chore: stable source")
  const config = join(directory, "config.json"), reporter = join(directory, "reporter"), adapterPath = join(directory, "coding.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "poc-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(adapterPath, (await readFile(adapterSource!, "utf8")).replaceAll("/etc/smithers/workspace-coding.json", config)
    .replaceAll("/usr/local/bin/smithers-workspace-head", reporter)
    .replaceAll("/usr/local/bin/smithers-jj-export", exporter!))
  const platform = process.versions.bun
    ? (await import("../../packages/smithers/flows/platform-bun/node_modules/@effect/platform-bun/dist/BunServices.js")).layer : NodeServices.layer
  const runtime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
  const binding = nativeLayer({ sourcePublication: "local-only", repositoryPath: root, adapterPath })
  const original = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(binding), Effect.provide(platform), Effect.scoped))
  assert.equal(original.head.kind, "resolved")
  const plan: Plan = { prompt: "Prototype a new title", memoryRevision: "memory", base: original.head, observedHead: original.head, changes: [{
    id: "prototype", title: "Prototype", intent: "Learn before production", implementation: "coding/implementation", implementationDigest: "digest",
    atoms: [{ changeId: null, message: "✨ feat: proposed title", intent: "Try title", reads: ["index.html", "remove.txt"], writes: ["index.html", "remove.txt", "new.txt"] }],
    checks: ["fast", "slow"].map(tier => ({ id: tier, flow: `checks/${tier}`, flowDigest: "digest", target: tier, tier: tier as "fast" | "slow", required: true }))
  }] }
  const proposed: PocDraft = { explanation: "A deliberately unvalidated title prototype.", files: [
    { path: "index.html", content: "<h1>Prototype</h1>\n" }, { path: "remove.txt", content: null }, { path: "new.txt", content: "Prototype only\n" }
  ] }
  const requests: string[] = [], seats: string[] = [], scratches: string[] = []
  const model = Model.make({ stream: request => Stream.suspend(() => {
    const encoded = JSON.stringify(request)
    requests.push(encoded)
    const output = encoded.includes("Review this actually materialized") ? { findings: ["The measured title changed; rendering remains untested."], nextPlan: "Keep the production title change small and run real checks." } : proposed
    return Stream.fromIterable([
      ModelEvent.TextStart({ type: "text-start", id: "poc" }),
      ModelEvent.TextDelta({ type: "text-delta", id: "poc", text: "```cell\nctx.done(" + JSON.stringify(output) + ");\n```" }),
      ModelEvent.TextEnd({ type: "text-end", id: "poc" }), ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  }) })
  const resolved = SeatResolver.layer({ resolve: id => { seats.push(id); return Effect.succeed({ id, modelId: "scripted", model,
    contextWindowTokens: 100_000, route: { prepare: () => Effect.succeed({ routeId: "test", protocolId: "test", method: "POST" as const,
      url: "https://fixture.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) } }) } })
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(platform)))
  const recordingFs: FileSystem.FileSystem = { ...fs, makeTempDirectoryScoped: options => fs.makeTempDirectoryScoped(options).pipe(
    Effect.tap(path => Effect.sync(() => { scratches.push(path) }))) }
  const Gate = DurableDeferred.make("poc-acceptance-materialize", { success: Schema.Boolean })
  const registrations = Layer.mergeAll(pocSource({ repositoryPath: root, adapterPath, exporterPath: exporter, fs: recordingFs }),
    pocModels, Interpreter.layer(Poc), MaterializePoc.toLayer(input => DurableDeferred.await(Gate).pipe(Effect.andThen(materializePoc(input))))
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(binding),
    Layer.provideMerge(AgentAction.layerHost({ registry: Registry.makeNoop(), limits: { calls: 4 }, maxFrames: 2, defaultCorrections: 0 })),
    Layer.provideMerge(resolved), Layer.provideMerge(Agent.layer), Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Layer.mergeAll(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())))
  const make = () => ManagedRuntime.make(runtime.layer({ filename: join(root, ".flows", "engine.db"), workspaceRoot: root,
    owner: { hostId: "poc-acceptance" }, isAlive: Ownership.sameHostPidProbe }, StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), registrations).pipe(
      Layer.provideMerge(layerAt({ repositoryPath: root, adapterPath })), Layer.provideMerge(platform),
      Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))))
  let host = make()
  close = () => host.dispose()
  await assert.rejects(host.runPromise(Poc.execute({ plan: { ...plan, observedHead: { ...original.head, operationId: "different-observation" } },
    source: original.head }, { executionId: "poc-wrong-observation" }), { signal: t.signal }), /observed head/)
  assert.equal(requests.length, 0)
  assert.equal(scratches.length, 0)
  const input = { plan, source: original.head }, executionId = "poc-cold-reconstruction"
  await host.runPromise(Poc.execute(input, { executionId, discard: true }), { signal: t.signal })
  // discard starts asynchronously. Close only after the driver has persisted
  // and released the suspension, not midway through its settlement transaction.
  await host.runPromise(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    while ((yield* runs.get(executionId)).status !== "suspended") yield* Effect.sleep("20 millis")
  }).pipe(Effect.timeout("15 seconds")))
  assert.equal(requests.length, 1)
  assert.equal(seats[0], "coding/poc")
  assert.equal(scratches.length, 1)
  for (const scratch of scratches) await assert.rejects(access(scratch), { code: "ENOENT" })
  await host.dispose()
  host = make()
  const token = DurableDeferred.tokenFromExecutionId(Gate, { flow: Poc, executionId })
  await host.runPromise(DurableDeferred.succeed(Gate, { token, value: true }))
  const result = await host.runPromise(Poc.execute(input, { executionId }), { signal: t.signal })
  assert.equal(result.status, "drafted-unvalidated")
  assert.equal(sameRevision(result.source, original.head), true)
  assert.match(result.feedback, /No build or tests ran/)
  assert.match(result.changes.preview.content, /&lt;h1&gt;Prototype&lt;\/h1&gt;/)
  assert.deepEqual(result.changes.files.map(file => file.path), ["index.html", "new.txt", "remove.txt"])
  assert.equal(result.changes.files.find(file => file.path === "remove.txt")!.before, "\uFEFFOriginal file\n")
  assert.equal(requests.length, 2)
  assert.doesNotMatch(requests[1]!, /Content-Security-Policy/)
  assert.deepEqual(seats, ["coding/poc", "coding/poc"])
  const after = await host.runPromise(Effect.flatMap(NativeCoding, native => native.read()))
  assert.deepEqual(after.head, original.head)
  assert.equal(after.operationId, original.operationId)
  assert.equal(await readFile(join(root, "index.html"), "utf8"), "<h1>Original</h1>\n")
  assert.equal(await readFile(join(root, "remove.txt"), "utf8"), "\uFEFFOriginal file\n")
  await assert.rejects(readFile(join(root, "new.txt")), { code: "ENOENT" })
  await host.dispose()
  host = make()
  assert.deepEqual(await host.runPromise(Poc.execute(input, { executionId })), result)
  assert.equal(requests.length, 2)
  assert.equal(scratches.length, 1)
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2))
  if (process.env.SMITHERS_POC_ACCEPTANCE_RESULT) {
    await writeFile(process.env.SMITHERS_POC_ACCEPTANCE_RESULT, JSON.stringify(result, null, 2))
  }
  await writeFile(join(root, "index.html"), "Changed outside the prototype\n")
  jj("status")
  await assert.rejects(host.runPromise(Poc.execute(input, { executionId: "poc-stale" }), { signal: t.signal }), /POC source head or plan base changed/)
  assert.equal(requests.length, 2)
  assert.equal(scratches.length, 1)
  // An exported symlink must not let collection consult ambient host bytes.
  await writeFile(join(directory, "outside.txt"), "Not captured source\n")
  await symlink(join(directory, "outside.txt"), join(root, "escape.txt"))
  jj("status")
  const external = await host.runPromise(Effect.flatMap(NativeCoding, native => native.read()))
  assert.equal(external.head.kind, "resolved")
  const badPlan: Plan = { ...plan, base: external.head, observedHead: external.head, changes: [{ ...plan.changes[0]!, atoms: [{ ...plan.changes[0]!.atoms[0]!,
    reads: ["escape.txt"], writes: ["escape.txt"] }] }] }
  await assert.rejects(host.runPromise(Poc.execute({ plan: badPlan, source: external.head }, { executionId: "poc-external-link" }),
    { signal: t.signal }), /outside its immutable export/)
  assert.equal(requests.length, 2)
  assert.equal(scratches.length, 2)
  for (const scratch of scratches) await assert.rejects(access(scratch), { code: "ENOENT" })
  assert.deepEqual((await host.runPromise(Effect.flatMap(NativeCoding, native => native.read()))).head, external.head)
  passed = true
  t.diagnostic("Actual Node/Bun platform, native immutable export, QuickJS coding/poc seat, durable draft before cold materialization and completed replay; no compiler or browser was exercised.")
})
