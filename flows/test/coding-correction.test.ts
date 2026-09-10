import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { Journal as JournalModules } from "@smthrs/flows"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { Rule } from "../../packages/smithers/flows/capability/src/Permission.ts"
import { CapabilityPattern } from "../../packages/smithers/flows/capability/src/Capability.ts"
import { Effect, FileSystem, Layer, ManagedRuntime, Option, Schema } from "effect"
import { atomDelegate, atomFlows, atomOperations, EditAtom } from "../coding/atoms.ts"
import { catalogLayers } from "../coding/catalog.ts"
import { CheckCommand, checkDelegate, checkLayers } from "../coding/checks.ts"
import { CorrectPlan, correctionLayers, SelectRepair } from "../coding/correction.ts"
import { NativeCoding, nativeActions, nativeLayer } from "../coding/native.ts"
import { CodingError, Receipt, type Implementation, type Plan, type Revision, sameRevision } from "../coding/schema.ts"
import { ImplementPlan, policyLayers } from "../coding/workflow.ts"

// The checker supplies actual exit evidence; this fixture's reviewer assigns a
// downstream discovery to its earlier owner, as a real review delegate would.
const Review = Flow.make("fixture/OwnerReview", {
  payload: Executable.Invocation, success: Receipt, error: CodingError,
  body: invocation => CheckCommand.call(invocation).pipe(Node.map(receipt => ({ ...receipt,
    findings: receipt.findings.map(finding => ({ ...finding, owner: "owner" })) })))
})
const { EngineEvent, Journal, JournalEvent } = JournalModules
const source = process.env.PLUE_CODING_ADAPTER_SOURCE
const exporter = process.env.PLUE_JJ_EXPORT_BINARY

test("owner correction preserves native identities and prefix receipts, restacks, rechecks and replays durable rounds", {
  skip: !source || !exporter ? "Set PLUE_CODING_ADAPTER_SOURCE and PLUE_JJ_EXPORT_BINARY to existing Plue artifacts" : false,
  timeout: 1_200_000
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-correction-"))
  let disposeHost = async () => {}
  t.after(async () => { await disposeHost(); await rm(temporary, { recursive: true, force: true }) })
  const root = join(temporary, "repo"), log = join(temporary, "checks.log")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Owner Correction")
  jj("config", "set", "--repo", "user.email", "correction@example.com")
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  await writeFile(join(root, "verify.mjs"), `import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const [log,tier]=process.argv.slice(2);const stage=existsSync('server.txt')?'server':existsSync('owner.txt')?'owner':'prefix';
appendFileSync(log,stage+':'+tier+'\\n');
if(tier==='slow'&&stage==='prefix'&&existsSync(log+'.early')&&!existsSync(log+'.repair-started')) {
  appendFileSync(log+'.waiting',process.pid+':'+process.cwd()+'\\n');
  while(!existsSync(log+'.release-unrelated')) await new Promise(resolve=>setTimeout(resolve,20));
}

process.exit(tier==='fast'&&existsSync(log+'.fastfail')?9:tier==='slow'&&stage==='server'&&readFileSync('owner.txt','utf8')!=='fixed'?7:0);
`)
  for (const [name, delegate, body] of [
    ["implementation", "coding/Implement", "Implement one Change"],
    ["checks/fast", "coding/CommandCheck", JSON.stringify({ argv: [process.execPath, "verify.mjs", log, "fast"], cwd: ".", timeoutMs: 30_000 })],
    ["checks/slow", "fixture/OwnerReview", JSON.stringify({ argv: [process.execPath, "verify.mjs", log, "slow"], cwd: ".", timeoutMs: 300_000 })]
  ]) {
    await mkdir(join(root, "flows", name!), { recursive: true })
    await writeFile(join(root, "flows", name!, "flow.mdx"), `---\ndescription: Correction fixture ${name}.\nflows: [${delegate}]\ncapabilities: ['*']\n---\n${body}\n`)
  }
  jj("status")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), wrapper = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "correction-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(wrapper, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(source)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)})))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
  const native = nativeLayer({ sourcePublication: "local-only", repositoryPath: root, adapterPath: wrapper }).pipe(
    Layer.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(platform))))
  const initial = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(native)))
  assert.equal(initial.head.kind, "resolved")
  const executable = await Effect.runPromise(Effect.gen(function*() {
    const found = yield* (yield* Discovery.Discovery).scan({ source: "project", root: join(root, "flows"), naming: "path" })
    return yield* Effect.forEach(found.entries, descriptor => Executable.fromDescriptor(descriptor, { delegates: [atomDelegate, checkDelegate, Review] }))
  }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(platform)))))
  const digest = (name: string) => Descriptor.executionDigest(executable.find(entry => entry.descriptor.name === name)!.descriptor)!
  const plan: Plan = { prompt: "Fix an earlier owner discovered by its descendant", memoryRevision: "fixture", base: initial.head as Revision,
    changes: ["prefix", "owner", "server"].map(id => ({ id, title: id, intent: id, implementation: "implementation", implementationDigest: digest("implementation"),
      atoms: [...(id === "owner" ? [{ changeId: null, message: "✨ feat: add owner foundation", intent: "owner foundation", reads: [], writes: ["owner-base.txt"] }] : []),
        { changeId: null, message: `✨ feat: add ${id}`, intent: id === "owner" ? "wrong" : id, reads: [], writes: [`${id}.txt`] }],
      checks: ["fast", "slow"].map(tier => ({ id: tier, target: tier, flow: `checks/${tier}`, flowDigest: digest(`checks/${tier}`), tier: tier as "fast" | "slow", required: true })) })) }
  const edits: string[] = [], selections: string[] = []
  const before: { owner: Implementation; tip: Revision }[] = []
  let refuseSelection = false, leaveWrong = false, alterPrefix = false, earlyFeedback = false
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
  const HostRuntime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
  const runtime = () => HostRuntime.layerHost({ filename: join(root, ".flows", "engine.db"), workspaceRoot: root, owner: { hostId: "correction-test" }, signals: [],
    rules: [[new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" }) })]] },
    Layer.mergeAll(correctionLayers, atomFlows, atomOperations, nativeActions, catalogLayers, policyLayers,
      Interpreter.layer(ImplementPlan), Interpreter.layer(Review), ...executable.map(entry => entry.layer),
      checkLayers({ repositoryPath: root, exporterPath: exporter, fs }),
      SelectRepair.toLayer(context => Effect.gen(function*() {
        if (earlyFeedback) {
          assert.ok((yield* Effect.promise(() => readFile(log + ".waiting", "utf8"))).length)
          yield* Effect.promise(() => writeFile(log + ".repair-started", "started before unrelated review completed"))
        }
        selections.push(context.owner.id)
        assert.equal(context.owner.id, "owner")
        const view = yield* (yield* NativeCoding).read().pipe(Effect.orDie)
        assert.equal(view.head.kind, "resolved")
        before.push({ owner: context.implementation, tip: view.head as Revision })
        if (alterPrefix) {
          yield* Effect.sync(() => jj("describe", "-r", context.implementation.parent.changeId, "-m", "external prefix change"))
        }
        return { changeId: refuseSelection ? "not-owned" : context.implementation.atoms.at(-1)!.changeId, intent: leaveWrong ? "keep wrong" : "fixed" }
      })),
      EditAtom.toLayer(({ atom }) => Effect.gen(function*() {
        edits.push(atom.writes[0]!)
        const value = atom.intent.includes("Correction:") ? atom.intent.includes("keep wrong") ? "wrong" : "fixed" : atom.intent
        yield* Effect.promise(() => writeFile(join(root, atom.writes[0]!), value))
        return { summary: "scripted atomic edit", reads: [], writes: atom.writes }
      }))
    ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(native),
      Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables: executable, refused: [] })))).pipe(
        Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)))
  let host = ManagedRuntime.make(runtime()); disposeHost = () => host.dispose()
  const run = (id: string, maxRounds = 3, input: Plan = plan) => host.runPromise(CorrectPlan.execute({ plan: input, maxRounds }, { executionId: id }).pipe(Effect.scoped), { signal: t.signal })
  const first = await run("owner-correction")
  t.diagnostic(JSON.stringify({ status: first.status, rounds: first.rounds, blocked: first.blocked }))
  assert.equal(first.status, "validated")
  assert.equal(first.rounds, 2)
  assert.equal(first.blocked, null)
  assert.equal(first.result!.changes.length, 3)
  assert.deepEqual(edits, ["prefix.txt", "owner-base.txt", "owner.txt", "server.txt", "owner.txt"])
  assert.deepEqual(selections, ["owner"])
  const prefix = first.result!.changes[0]!.implementation
  const owner = first.result!.changes[1]!.implementation
  const server = first.result!.changes[2]!.implementation
  assert.ok(sameRevision(prefix.head, before[0]!.owner.parent), "unchanged prefix retains its original operation-pinned input")
  assert.ok(sameRevision(owner.atoms[0]!, before[0]!.owner.atoms[0]!), "earlier atom within the owner is retained exactly")
  assert.equal(owner.head.changeId, before[0]!.owner.head.changeId)
  assert.notEqual(owner.head.commitId, before[0]!.owner.head.commitId)
  assert.notEqual(owner.head.treeId, before[0]!.owner.head.treeId)
  assert.equal(server.head.changeId, before[0]!.tip.changeId, "JJ keeps descendant identity")
  assert.notEqual(server.head.commitId, before[0]!.tip.commitId, "JJ rewrites its descendant commit")
  assert.notEqual(server.head.treeId, before[0]!.tip.treeId)
  assert.deepEqual(server.head.parentCommitIds, [owner.head.commitId])
  assert.ok(sameRevision(server.parent, owner.head), "restacked parent uses a complete consistent reference")
  const checkLines = (await readFile(log, "utf8")).trim().split("\n")
  assert.equal(checkLines.filter(line => line.startsWith("prefix:")).length, 2, "unchanged prefix receipts are preserved")
  assert.equal(checkLines.filter(line => line.startsWith("owner:")).length, 4)
  assert.equal(checkLines.filter(line => line.startsWith("server:")).length, 4, "restacked descendants are rechecked")
  assert.equal(await readFile(join(root, "owner.txt"), "utf8"), "fixed")
  assert.equal(await readFile(join(root, "server.txt"), "utf8"), "server")
  const read = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(native)))
  assert.equal(read.head.changeId, first.result!.changes[2]!.implementation.head.changeId, "working copy returns to known tip")
  await host.dispose(); host = ManagedRuntime.make(runtime())
  assert.deepEqual(await run("owner-correction"), first)
  assert.equal(edits.length, 5); assert.equal(selections.length, 1)
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), checkLines, "replay runs no command again")

  // The prefix review never voluntarily returns; a descendant finding must
  // cancel it and repair its earlier owner before the unrelated review ends.
  earlyFeedback = true
  await writeFile(log + ".early", "enabled")
  const earlyStart = (await readFile(log, "utf8")).trim().split("\n").length
  const early = await run("owner-correction-early-feedback")
  assert.equal(early.status, "validated", early.blocked?.message ?? "Early feedback should complete owner correction")
  assert.equal(early.rounds, 2)
  const earlyLines = (await readFile(log, "utf8")).trim().split("\n").slice(earlyStart)
  assert.equal(earlyLines.filter(line => line === "prefix:fast").length, 1, "exact completed prefix receipt is retained")
  assert.equal(earlyLines.filter(line => line === "prefix:slow").length, 2, "cancelled missing prefix receipt is measured before validation")
  const waiting = (await readFile(log + ".waiting", "utf8")).trim().split("\n")
  for (const item of waiting) {
    const separator = item.indexOf(":"), pid = Number(item.slice(0, separator)), scratch = item.slice(separator + 1)
    assert.throws(() => process.kill(pid, 0), "obsolete checker process has exited")
    await assert.rejects(readFile(join(scratch, "verify.mjs")), /ENOENT/, "obsolete immutable scratch is released")
  }
  const earlyEdits = edits.length, earlySelections = selections.length
  await host.dispose(); host = ManagedRuntime.make(runtime())
  assert.deepEqual(await run("owner-correction-early-feedback"), early)
  assert.equal(edits.length, earlyEdits); assert.equal(selections.length, earlySelections)
  earlyFeedback = false
  await rm(log + ".early")

  leaveWrong = true
  const bounded = await run("owner-correction-bounded", 2)
  assert.equal(bounded.status, "changes-requested")
  assert.equal(bounded.rounds, 2)
  assert.equal(bounded.result!.findings[0]!.owner, "owner")
  leaveWrong = false
  refuseSelection = true
  const blocked = await run("owner-correction-invalid-owner")
  assert.equal(blocked.status, "blocked")
  assert.match(blocked.blocked!.message, /outside its owning Change/)
  assert.equal(blocked.result!.status, "changes-requested")
  const failed = await host.runPromise(Effect.flatMap(RunStore.RunStore, store => store.get(blocked.blocked!.executionId)))
  assert.equal(failed.status, "failed", "blocked output points to the actual preserved failed child")
  refuseSelection = false
  alterPrefix = true
  const stale = await run("owner-correction-stale-prefix")
  assert.equal(stale.status, "blocked")
  assert.match(stale.blocked!.message, /parent changed|earlier atom changed|history advanced/)
  alterPrefix = false

  // A real nonzero fast check stops the first pass; no later Change or repair.
  await writeFile(log + ".fastfail", "fail")
  const editCount = edits.length
  const stopped = await run("owner-correction-fast-stop")
  assert.equal(stopped.status, "blocked")
  assert.equal(stopped.rounds, 1)
  assert.equal(stopped.result, null)
  assert.equal(edits.length, editCount + 1)
  assert.match(stopped.blocked!.message, /did not pass/)
  assert.equal((await host.runPromise(Effect.flatMap(RunStore.RunStore, store => store.get(stopped.blocked!.executionId)))).status, "failed")
  const receipts = await host.runPromise(Effect.gen(function*() {
    const journal = yield* Journal.Journal, attempts = yield* AttemptStore.AttemptStore
    const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(stopped.blocked!.executionId), limit: 512 })
    assert.equal(entries.hasMore, false, "fixture failure evidence fits the bounded journal read")
    const found: Receipt[] = []
    for (const entry of entries.entries) {
      let id: AttemptStore.AttemptId | undefined
      if (entry.eventType === EngineEvent.attemptEventType) {
        const event = yield* Schema.decodeUnknownEffect(EngineEvent.AttemptPayload)(entry.payload)
        if (event.lifecycle.state === "succeeded") id = { runId: event.executionId, stepKeyDigest: event.stepKeyDigest, attempt: event.attempt }
      } else if (entry.eventType === "flows.engine.attempt-finished") {
        const event = yield* Schema.decodeUnknownEffect(Schema.Struct({ ...AttemptStore.AttemptId.fields, state: Schema.String }))(entry.payload)
        if (event.state === "succeeded") id = { runId: event.runId, stepKeyDigest: event.stepKeyDigest, attempt: event.attempt }
      }
      if (!id) continue
      const row = yield* attempts.get(id)
      if (Option.isNone(row)) continue
      const receipt = Schema.decodeUnknownOption(Receipt)(row.value.outcome)
      if (Option.isSome(receipt)) found.push(receipt.value)
    }
    return found
  }))
  const fastFailure = receipts.find(receipt => receipt.tier === "fast" && receipt.status === "failed")
  assert.ok(fastFailure, "the failed child's native attempt store retains the actual check receipt")
  assert.equal(JSON.parse(fastFailure.evidence).exitCode, 9)
  await assert.rejects(run("owner-correction-no-rounds", 0), /greater|Invalid|maxRounds/)
})
