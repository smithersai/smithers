import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Action } from "@smthrs/flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import { Rule } from "../../packages/smithers/flows/capability/src/Permission.ts"
import { CapabilityPattern } from "../../packages/smithers/flows/capability/src/Capability.ts"
import { catalogLayers } from "../coding/catalog.ts"
import { checkDelegate, checkLayers } from "../coding/checks.ts"
import { NativeCoding, NativeCodingError, nativeActions, nativeLayer } from "../coding/native.ts"
import { checkInputDigest, type Revision, type Implementation, type Plan } from "../coding/schema.ts"
import { VibeAdmission } from "../coding/vibe-schema.ts"
import { CleanVibeHistory, cleanupLayers, ReviewHistory } from "../coding/vibe-cleanup.ts"
import { policyLayers } from "../coding/workflow.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE, exporter = process.env.PLUE_JJ_EXPORT_BINARY
test("final cleanup rewrites native descriptions, preserves atom trees, runs real source checks and cold replays", {
  skip: !source || !exporter ? "Set PLUE_CODING_ADAPTER_SOURCE and PLUE_JJ_EXPORT_BINARY to native artifacts" : false, timeout: 180_000
}, async t => {
  const { platform: hostPlatform } = process.versions.bun
    ? await import("../../packages/smithers/src/internal/BunControl.ts")
    : await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const temporary = await mkdtemp(join(tmpdir(), "coding-vibe-cleanup-"))
  let passed = false, dispose = async () => {}
  t.diagnostic(`Native cleanup evidence: ${temporary}`)
  t.after(async () => { await dispose(); if (passed) await rm(temporary, { recursive: true, force: true }) })
  const root = join(temporary, "repo"), log = join(temporary, "checks.log")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString().trim()
  jj("config", "set", "--repo", "user.name", "Final Cleanup"); jj("config", "set", "--repo", "user.email", "cleanup@example.com")
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  await writeFile(join(root, "verify.mjs"), "import{readFileSync,existsSync,appendFileSync}from'node:fs';\n" +
    "if(process.argv[3]==='fast'&&existsSync(process.argv[2]+'.fail'))process.exit(9);\n" +
    "for(const name of ['first','last'])if(existsSync(name+'.txt')&&readFileSync(name+'.txt','utf8')!==name)process.exit(4);\n" +
    "appendFileSync(process.argv[2],process.argv[3]+':'+(existsSync('last.txt')?'last':'first')+'\\n');\n")
  for (const tier of ["fast", "slow"]) {
    await mkdir(join(root, "flows", "checks", tier), { recursive: true })
    await writeFile(join(root, "flows", "checks", tier, "flow.mdx"), `---\ndescription: Final source verification\nflows: [coding/CommandCheck]\ncapabilities: ['*']\n---\n${JSON.stringify({ argv: [process.execPath, "verify.mjs", log, tier], cwd: ".", timeoutMs: 30_000 })}\n`)
  }
  jj("status")
  const baseId = jj("log", "--no-graph", "-r", "@", "-T", "change_id")
  const ids: string[] = []
  for (const name of ["first", "last"]) {
    jj("new", "-m", `wip ${name}`); await writeFile(join(root, `${name}.txt`), name); jj("status")
    ids.push(jj("log", "--no-graph", "-r", "@", "-T", "change_id"))
  }
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), wrapper = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "cleanup-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(wrapper, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(source)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const platform = hostPlatform.host
  const applied: string[] = []
  let loseAcknowledgment = true
  const native = Layer.effect(NativeCoding)(Effect.map(NativeCoding, service => ({ ...service,
    apply: operation => service.apply(operation).pipe(Effect.flatMap(receipt => {
      applied.push(JSON.stringify(operation))
      if (receipt.status === "accepted" && loseAcknowledgment) {
        loseAcknowledgment = false
        return Effect.fail(new NativeCodingError({ code: "outcome_unknown", message: "Fixture lost the native acknowledgment after the real JJ write" }))
      }
      return Effect.succeed(receipt)
    }))
  }))).pipe(Layer.provide(nativeLayer({ repositoryPath: root, adapterPath: wrapper }).pipe(Layer.provide(platform))))
  const before = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read([baseId, ...ids])).pipe(Effect.provide(native)))
  const base = before.revisions.find(row => row.changeId === baseId)! as Revision
  const atoms = ids.map(id => before.revisions.find(row => row.changeId === id)! as Revision)
  const executables = await Effect.runPromise(Effect.gen(function*() {
    const found = yield* (yield* Discovery.Discovery).scan({ source: "project", root: join(root, "flows"), naming: "path" })
    return yield* Effect.forEach(found.entries, descriptor => Executable.fromDescriptor(descriptor, { delegates: [checkDelegate] }))
  }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(platform)))))
  const plan: Plan = { prompt: "Clean final descriptions", memoryRevision: "fixture", base, observedHead: base, changes: ["first", "last"].map((id, index) => ({
    id, title: id, intent: id, implementation: "unused", implementationDigest: "0".repeat(64),
    atoms: [{ changeId: atoms[index]!.changeId, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [`${id}.txt`] }],
    checks: ["fast", "slow"].map(tier => ({ id: tier, target: tier, flow: `checks/${tier}`,
      flowDigest: Descriptor.executionDigest(executables.find(entry => entry.descriptor.name === `checks/${tier}`)!.descriptor)!, tier: tier as "fast" | "slow", required: true }))
  })) }
  const implementations: Implementation[] = atoms.map((head, index) => ({ change: plan.changes[index]!.id,
    parent: index === 0 ? base : atoms[index - 1]!, atoms: [head], head, reads: [], writes: [`${plan.changes[index]!.id}.txt`] }))
  // Admission is scripted here; its separate configured-host test proves
  // actual request provenance. Every cleanup operation and new check is real.
  const admission: VibeAdmission = { requestExecutionId: "completed", controlRunId: "control", planId: "plan", planDigest: "digest", pocExecutionId: "poc",
    originalSource: base, validatedHead: before.head as Revision, request: { plan, outcome: { status: "validated", rounds: 1, blocked: null,
      result: { status: "validated", findings: [], changes: implementations.map((implementation, index) => ({ implementation,
        receipts: plan.changes[index]!.checks.map(check => ({ change: implementation.change, checkId: check.id, target: check.target, tier: check.tier,
          commitId: implementation.head.commitId, treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", findings: [], evidence: "prior fixture validation" })) })) } } } }
  let reviews = 0, wrongIdentity = false
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(platform)))
  const HostRuntime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : await import("@smthrs/flows/NodeRuntime")
  const runtime = HostRuntime.layerHost({ filename: join(root, ".flows", "engine.db"), workspaceRoot: root, owner: { hostId: "cleanup-test" }, signals: [],
    rules: [[new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" }) })]] },
    Layer.mergeAll(cleanupLayers, nativeActions, catalogLayers, policyLayers, ...executables.map(entry => entry.layer),
      checkLayers({ repositoryPath: root, exporterPath: exporter, fs }), ReviewHistory.toLayer(() => Effect.sync(() => { reviews++;
        return { summary: "✨ feat: describe the completed request", atoms: atoms.map((atom, index) => ({ changeId: wrongIdentity ? "foreign" : atom.changeId,
          description: `✨ feat: ${plan.changes[index]!.id} behavior\n\nRetain the validated source.` })) }
      }))).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(native),
        Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables, refused: [] }))))
  let host = ManagedRuntime.make(runtime); dispose = () => host.dispose()
  const result = await host.runPromise(CleanVibeHistory.execute(admission, { executionId: "cleanup" }))
  assert.equal(result.result.status, "validated")
  assert.equal(result.head.treeId, admission.validatedHead.treeId)
  assert.notEqual(result.head.commitId, admission.validatedHead.commitId)
  assert.equal(applied.length, 3, "lost acknowledgment retries one of the two actual description writes")
  assert.equal(applied[0], applied[1], "retry recovers the native receipt with the identical prepared operation")
  const after = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read([baseId, ...ids])).pipe(Effect.provide(native)))
  for (const atom of atoms) assert.equal(after.revisions.find(value => value.changeId === atom.changeId)?.kind === "resolved" &&
    (after.revisions.find(value => value.changeId === atom.changeId) as Revision).treeId, atom.treeId)
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").sort(), ["fast:first", "fast:last", "slow:first", "slow:last"])
  await host.dispose(); host = ManagedRuntime.make(runtime)
  assert.deepEqual(await host.runPromise(CleanVibeHistory.execute(admission, { executionId: "cleanup" })), result)
  assert.equal(reviews, 1)
  assert.equal(applied.length, 3, "cold replay does not invoke the native adapter again")
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4)
  assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "commit_id"), result.head.commitId)
  const fresh = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(native)))
  const repeatAdmission = { ...admission, validatedHead: fresh.head as Revision }
  const unchanged = await host.runPromise(CleanVibeHistory.execute(repeatAdmission, { executionId: "cleanup-already-described" }))
  assert.equal(unchanged.head.commitId, result.head.commitId, "native unchanged receipts do not manufacture new atoms")
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 8, "a new finalization still runs actual checks")
  const guarded = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(native)))
  wrongIdentity = true
  await assert.rejects(host.runPromise(CleanVibeHistory.execute({ ...admission, validatedHead: guarded.head as Revision }, { executionId: "cleanup-wrong-owner" })), /same ordered atoms/)
  assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "commit_id"), unchanged.head.commitId)
  wrongIdentity = false
  await writeFile(log + ".fail", "required gate fails")
  await assert.rejects(host.runPromise(CleanVibeHistory.execute({ ...admission, validatedHead: guarded.head as Revision }, { executionId: "cleanup-check-failed" })), /did not pass/)
  assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "commit_id"), unchanged.head.commitId)
  passed = true
})
