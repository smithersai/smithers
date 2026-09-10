import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { Effect, Layer, ManagedRuntime, SchemaIssue } from "effect"
import { atomFlows, atomOperations, EditAtom, ImplementAtoms } from "../coding/atoms.ts"
import { NativeCoding, NativeCodingError, nativeActions, nativeLayer, type Operation } from "../coding/native.ts"
import { Change, type Revision } from "../coding/schema.ts"

// Persisted schema issues have data-only ASTs; their live formatters require
// prototype methods that intentionally are not part of journal serialization.
const failureDetail = (error: unknown) => SchemaIssue.isIssue(error)
  ? new Error(JSON.stringify(error, (key, value) => key === "ast" ? { kind: value?._tag } : value))
  : error

const TwoChanges = Flow.make("acceptance/TwoChanges", {
  payload: { ...ImplementAtoms.payloadSchema.fields, next: Change },
  success: ImplementAtoms.successSchema, error: ImplementAtoms.errorSchema,
  body: ({ next, ...input }) => ImplementAtoms.call(input).pipe(Node.bindPlanned(first =>
    ImplementAtoms.call({ change: next, parent: first.head, memoryRevision: input.memoryRevision })))
})

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
test("native atom implementation persists real files, replays, and edits old JJ identities with descendant restacking", {
  skip: source === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE to the Plue-owned coding.py" : false,
  timeout: 900_000
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-atoms-"))
  let disposeHost = async () => {}
  t.after(async () => { await disposeHost(); await rm(temporary, { recursive: true, force: true }) })
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Native Atom Acceptance")
  jj("config", "set", "--repo", "user.email", "acceptance@example.com")
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  jj("status")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), wrapper = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "atoms-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(wrapper, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(source)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)})))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\nexcept (OSError, coding.subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:\n print(json.dumps({"error":{"code":"guest_failure","message":str(error)[-1000:]}}))\n sys.exit(1)\n`)
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
  const native = nativeLayer({ sourcePublication: "local-only", repositoryPath: root, adapterPath: wrapper }).pipe(
    Layer.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(platform)))
  )
  const read = (ids: ReadonlyArray<string> = []) => Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read(ids)).pipe(Effect.provide(native)))
  const initial = await read()
  assert.equal(initial.head.kind, "resolved")
  const base = initial.head as Revision
  let edits = 0
  const attempted: Array<Operation> = []
  const readAttempts: Array<ReadonlyArray<string>> = []
  let failWith: string | undefined
  const recoveringNative = Layer.effect(NativeCoding)(Effect.gen(function*() {
    const service = yield* NativeCoding
    return { ...service, read: (ids: ReadonlyArray<string> = []) => Effect.gen(function*() {
      readAttempts.push(ids)
      if (readAttempts.length === 1) return yield* new NativeCodingError({ code: "workspace_busy", message: "injected read lock contention" })
      if (readAttempts.length === 2) return yield* new NativeCodingError({ code: "guest_failure", message: "injected read subprocess failure" })
      return yield* service.read(ids)
    }), apply: (operation: Operation) => Effect.gen(function*() {
      attempted.push(operation)
      if (failWith) return yield* new NativeCodingError({ code: failWith, message: "injected admission failure" })
      if (attempted.length === 1) return yield* new NativeCodingError({ code: "workspace_busy", message: "injected native lock contention" })
      const result = yield* service.apply(operation)
      if (attempted.length === 2) return yield* new NativeCodingError({ code: "guest_failure", message: "accepted native mutation, lost response" })
      return result
    }) }
  })).pipe(Layer.provide(native))
  const runtime = () => NodeRuntime.layerHost({ filename: join(root, ".flows", "engine.db"), workspaceRoot: root, owner: { hostId: "atoms-test" }, signals: [] },
    Layer.mergeAll(atomFlows, Interpreter.layer(TwoChanges), atomOperations, nativeActions, EditAtom.toLayer(({ atom }) => Effect.gen(function*() {
      edits++
      yield* Effect.promise(() => writeFile(join(root, atom.writes[0]!), atom.intent))
      // Reproduce the normal head reporter snapshotting between the agent's
      // edit and its explicit snapshot action; native ownership must survive.
      if (edits === 1) yield* Effect.sync(() => jj("status"))
      return { summary: "scripted filesystem edit", reads: [], writes: atom.writes }
    }))).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(recoveringNative))).pipe(
      // Version probing shares this fixture's cold-host budget under CI load.
      Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))
    )
  const change: Change = {
    id: "storage", title: "Storage", intent: "Two atomic files", implementation: "coding/atoms", implementationDigest: "0".repeat(64), checks: [],
    atoms: ["schema", "query"].map(name => ({ changeId: null, message: `✨ feat(storage): add ${name}`, intent: `${name} v1\n`, reads: [], writes: [`${name}.txt`] }))
  }
  let host = ManagedRuntime.make(runtime())
  disposeHost = () => host.dispose()
  const run = (change: Change, parent: Revision, executionId: string) => host.runPromise(
    ImplementAtoms.execute({ change, parent, memoryRevision: "sha256:fixture" }, { executionId }).pipe(Effect.scoped), { signal: t.signal }
  ).catch(error => { throw failureDetail(error) })
  const first = await run(change, base, "atoms-first")
  t.diagnostic("initial two atoms completed")
  assert.deepEqual(readAttempts.slice(0, 3), [readAttempts[0], readAttempts[0], readAttempts[0]], "read retries retain the exact requested identities")
  assert.deepEqual(attempted.slice(0, 3), [attempted[0], attempted[0], attempted[0]], "lock contention and lost acknowledgement must resend the exact prepared request")
  assert.equal(edits, 2)
  assert.equal(first.atoms.length, 2)
  assert.notEqual(first.atoms[0]!.changeId, first.atoms[1]!.changeId)
  assert.equal(first.atoms[0]!.parentCommitIds[0], base.commitId)
  assert.equal(first.atoms[1]!.parentCommitIds[0], first.atoms[0]!.commitId)
  assert.equal(await readFile(join(root, "schema.txt"), "utf8"), "schema v1\n")
  assert.equal(await readFile(join(root, "query.txt"), "utf8"), "query v1\n")
  await host.dispose()
  host = ManagedRuntime.make(runtime())
  assert.deepEqual(await run(change, base, "atoms-first"), first)
  t.diagnostic("reopened replay completed")
  assert.equal(edits, 2, "reopening the runtime must reuse completed atom and agent actions")
  const amended = await run({ ...change, atoms: [{ ...change.atoms[0]!, changeId: first.atoms[0]!.changeId, intent: "schema v2\n" }] }, base, "atoms-correct-old-owner")
  t.diagnostic("older atom amendment completed")
  assert.equal(edits, 3)
  assert.equal(amended.head.changeId, first.atoms[0]!.changeId)
  assert.notEqual(amended.head.commitId, first.atoms[0]!.commitId)
  const restacked = await read([first.atoms[1]!.changeId])
  assert.equal(restacked.revisions[0]!.changeId, first.atoms[1]!.changeId)
  assert.notEqual(restacked.revisions[0]!.commitId, first.atoms[1]!.commitId)
  assert.equal(restacked.revisions[0]!.parentCommitIds[0], amended.head.commitId)
  assert.equal(jj("file", "show", "-r", restacked.revisions[0]!.commitId, "schema.txt"), "schema v2\n")
  assert.equal(jj("file", "show", "-r", restacked.revisions[0]!.commitId, "query.txt"), "query v1\n")
  const beforeRefusal = edits
  await assert.rejects(run({ ...change, atoms: [{ ...change.atoms[1]!, changeId: first.atoms[1]!.changeId }] }, base, "atoms-wrong-parent"), /not the next change/)
  assert.equal(edits, beforeRefusal)

  const twoInput = {
    change: { ...change, atoms: [{ ...change.atoms[0]!, changeId: first.atoms[0]!.changeId, intent: "schema v3\n" }] },
    next: { ...change, id: "queries", atoms: [{ ...change.atoms[1]!, changeId: first.atoms[1]!.changeId, intent: "query v2\n" }] },
    parent: base, memoryRevision: "sha256:fixture"
  }
  const twoChanges = await host.runPromise(TwoChanges.execute(twoInput, { executionId: "two-inlined-changes" }).pipe(Effect.scoped), { signal: t.signal })
    .catch(error => { throw failureDetail(error) })
  assert.equal(twoChanges.head.changeId, first.atoms[1]!.changeId)
  assert.equal(await readFile(join(root, "schema.txt"), "utf8"), "schema v3\n")
  assert.equal(await readFile(join(root, "query.txt"), "utf8"), "query v2\n")
  const attemptsBeforeRefusal = attempted.length
  failWith = "operation_conflict"
  await assert.rejects(run({ ...change, atoms: [{ ...change.atoms[0]!, changeId: first.atoms[0]!.changeId }] }, base, "atoms-native-conflict"), /injected admission failure/)
  assert.equal(attempted.length, attemptsBeforeRefusal + 1, "a revision conflict must not retry or silently refresh its fence")
  for (const [code, count] of [["outcome_unknown", 3], ["response_too_large", 1]] as const) {
    const before = attempted.length
    failWith = code
    await assert.rejects(run({ ...change, atoms: [{ ...change.atoms[0]!, changeId: first.atoms[0]!.changeId }] }, base, `atoms-native-${code}`), /injected admission failure/)
    assert.equal(attempted.length, before + count, `${code} must preserve its bounded retry decision`)
  }
})
