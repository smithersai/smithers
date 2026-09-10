import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { NativeCoding, nativeLayer, requestIdFor, type Operation } from "../coding/native.ts"

test("native invocation UUIDs remain stable across retry and differ between durable actions", () => {
  const first = requestIdFor("execution-1", "create/database")
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(requestIdFor("execution-1", "create/database"), first)
  assert.notEqual(requestIdFor("execution-1", "create/server"), first)
  assert.notEqual(requestIdFor("execution-2", "create/database"), first)
})

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
test("Effect spawner runs the real Plue adapter: native lost-ack replay, conflicts, path identity and pending provenance", {
  skip: source === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE to the Plue-owned coding.py; requires native JJ 0.39" : false,
  timeout: 60_000
}, async t => {
  assert.match(execFileSync("jj", ["--version"], { encoding: "utf8" }), /^jj 0\.39\.0/)
  const temporary = await mkdtemp(join(tmpdir(), "coding-native-effect-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repo = join(temporary, "repo")
  execFileSync("jj", ["git", "init", repo], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", repo, ...args], { stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Native Effect Acceptance")
  jj("config", "set", "--repo", "user.email", "acceptance@example.com")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), wrapper = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "workspace-acceptance", actorId: 42, repositoryPath: repo, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  // Import Plue's exact implementation. Only provisioned paths vary in this
  // portable harness; production invokes the installed --local entrypoint.
  await writeFile(wrapper, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(source)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)})))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const host = (repositoryPath = repo) => nativeLayer({ sourcePublication: "local-only", repositoryPath, adapterPath: wrapper }).pipe(
    Layer.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))))
  )
  let original!: Operation
  let acceptedId = ""
  const accepted = await Effect.runPromise(Effect.gen(function*() {
    const native = yield* NativeCoding
    const before = yield* native.read()
    assert.equal(before.head.kind, "resolved")
    if (before.head.kind !== "resolved") throw new Error("fixture unexpectedly conflicted")
    original = { operation: "create", requestId: requestIdFor("acceptance", "first"), expectedOperationId: before.operationId, target: before.head, description: "✨ feat: literal `$(echo harmless)` unicode 雪" }
    const result = yield* native.apply(original)
    assert.equal(result.status, "accepted")
    if (result.status !== "accepted") throw new Error("fixture mutation was not accepted")
    assert.equal(result.provenance, "pending")
    assert.equal(result.parentOperationId, before.operationId)
    assert.equal(result.revision.parentCommitIds[0], before.head.commitId)
    assert.equal(result.revision.description?.trim(), original.description)
    acceptedId = result.operationId
    return result
  }).pipe(Effect.provide(host())))
  jj("describe", "-m", "later unrelated description")
  // Reopen the process service as if the owning host had crashed after native
  // commit but before storing its durable Action result.
  await Effect.runPromise(Effect.gen(function*() {
    const native = yield* NativeCoding
    const replay = yield* native.apply(original)
    assert.deepEqual(replay, { ...accepted, replayed: true })
    assert.equal(replay.operationId, acceptedId)
    const duplicate = yield* Effect.result(native.apply({ ...original, description: "different" } as Operation))
    assert.equal(duplicate._tag, "Failure")
    if (duplicate._tag === "Failure") assert.equal(duplicate.failure.code, "request_conflict")
    const stale = yield* Effect.result(native.apply({ ...original, requestId: requestIdFor("acceptance", "stale") }))
    assert.equal(stale._tag, "Failure")
    if (stale._tag === "Failure") assert.equal(stale.failure.code, "operation_conflict")
    const now = yield* native.read()
    assert.notEqual(now.operationId, acceptedId)
  }).pipe(Effect.provide(host())))
  const other = join(temporary, "other")
  await mkdir(other)
  const wrong = await Effect.runPromise(Effect.flatMap(NativeCoding, native => Effect.result(native.read())).pipe(Effect.provide(host(other))))
  assert.equal(wrong._tag, "Failure")
  if (wrong._tag === "Failure") assert.equal(wrong.failure.code, "invalid_request")
})
