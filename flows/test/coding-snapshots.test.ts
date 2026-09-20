import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { layerAt } from "../coding/snapshots.ts"
import { failureJson } from "../../packages/smithers/agent/src/internal/FailureJson.ts"
import { failureSummary } from "../../packages/smithers/agent/src/internal/FailureSummary.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
const platform = "Bun" in globalThis
  ? (await import("../../packages/smithers/flows/platform-bun/node_modules/@effect/platform-bun/dist/BunServices.js")).layer
  : NodeServices.layer

/*
 * The guest adapter's OTHER mode. `--local` answers `flows/coding/native.ts`,
 * whose envelope is narrowed to `NativeCode`; `--engine` answers this file, and
 * its envelope used to reach a person by a second route: `codeFor` narrowed the
 * `JjError`'s own code, and then the raw envelope went to `Jj.jjErrorCause`,
 * which copies any string `code` onto the cause record. `failureSummary`
 * (`agent/src/internal/FailureSummary.ts`) prefers the INNERMOST record, so a
 * guest answering `model_failed` put `model_failed:` on the journal's first
 * line, and `apps/app RunCause.ts` read "a turn opened and the model never
 * answered" off it — for a snapshot of a working copy, with no model in the run.
 *
 * One three-line Python adapter per envelope, spawned for real.
 */
test("a code the guest engine adapter invents cannot become a code this repo answers", { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-snapshots-envelope-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const adapterPath = join(temporary, "coding.py")
  const raise = async (code: string) => {
    await writeFile(adapterPath, `import sys,json\nsys.stdin.read()\nprint(json.dumps({"error":{"code":${JSON.stringify(code)},"message":"the guest adapter said this"}}))\nsys.exit(1)\n`)
    const host = ManagedRuntime.make(layerAt({ repositoryPath: root, adapterPath }).pipe(
      Layer.provide(platform), Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))
    ))
    const error = await host.runPromise(Effect.flatMap(Jj.Jj, jj => jj.snapshot().pipe(Effect.flip)), { signal: t.signal })
    await host.dispose()
    assert.ok(Jj.isJjError(error))
    return error
  }

  const foreign = await raise("model_failed")
  assert.equal(foreign.code, "unknown")
  // Not on the record a run card reads its sentence off — not even one level
  // down. Every code on that chain is a `JjErrorCode` this repo declares.
  assert.equal(foreign.cause?.code, "unknown")
  assert.match(String(failureSummary(failureJson(foreign))), /^unknown: /)
  // The guest's own code and sentence survive, as the technical detail they are.
  assert.match(foreign.message, /does not declare \(model_failed\): the guest adapter said this/)
  assert.match(String(foreign.cause?.message), /the guest adapter said this \(model_failed\)/)

  // A word this build does admit still maps to the public taxonomy, and the
  // callers that branch on `JjError.code` keep working.
  const declared = await raise("workspace_busy")
  assert.equal(declared.code, "conflict")
  assert.equal(declared.cause?.code, "conflict")
  assert.equal(declared.message, "the guest adapter said this")
  assert.match(String(failureSummary(failureJson(declared))), /^conflict: the guest adapter said this \(workspace_busy\)$/)

  // A jj code the table does not admit is still not the guest's to spell.
  const borrowed = await raise("not_installed")
  assert.equal(borrowed.code, "unknown")
  assert.equal(borrowed.cause?.code, "unknown")
})

test("engine preimages preserve JJ atoms across edits, historical diffs and reopened restores", {
  skip: source === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE to Plue coding.py" : false,
  timeout: 300_000
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-snapshots-"))
  let close = async () => {}
  t.after(async () => { await close(); await rm(temporary, { recursive: true, force: true }) })
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Engine Snapshot Acceptance")
  jj("config", "set", "--repo", "user.email", "acceptance@example.com")
  await writeFile(join(root, "hello.txt"), "before\n")
  jj("describe", "-m", "✨ feat: planned atom")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), adapterPath = join(temporary, "coding.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "snapshot-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(adapterPath, (await readFile(source!, "utf8"))
    .replaceAll("/etc/smithers/workspace-coding.json", config)
    .replaceAll("/usr/local/bin/smithers-workspace-head", reporter))
  const template = 'change_id ++ "\\n" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\n" ++ description'
  const ownership = () => jj("--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", template)
  const op = () => jj("op", "log", "--no-graph", "--limit", "1", "-T", "id")
  const beforeOwner = ownership()
  const make = () => ManagedRuntime.make(layerAt({ repositoryPath: root, adapterPath }).pipe(
    Layer.provide(platform), Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))
  ))
  let host = make()
  close = () => host.dispose()
  const call = <A, E>(f: (jj: Jj.Jj) => Effect.Effect<A, E>) => host.runPromise(Effect.flatMap(Jj.Jj, f), { signal: t.signal })
  const preimage = await call(jj => jj.snapshot("this label stays in the journal"))
  assert.match(preimage.changeId, /^[0-9a-f]{40}$/)
  assert.equal(ownership(), beforeOwner)
  assert.deepEqual(await call(jj => jj.snapshot()), preimage)
  await writeFile(join(root, "hello.txt"), "after\n")
  await writeFile(join(root, "new.txt"), "new file\n")
  const settled = await call(jj => jj.snapshot("settled"))
  assert.notEqual(settled.changeId, preimage.changeId)
  assert.equal(ownership(), beforeOwner)
  const beforeDiff = op()
  const diff = await call(jj => jj.diff(preimage.changeId, settled.changeId))
  assert.match(diff, /-before/)
  assert.match(diff, /\+after/)
  assert.match(diff, /new file/)
  assert.equal(op(), beforeDiff, "historical diffs must not snapshot or mutate the operation log")
  await host.dispose()
  host = make()
  await writeFile(join(root, "hello.txt"), "later unsnapshotted bytes\n")
  await call(jj => jj.restore(preimage.changeId))
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "before\n")
  await assert.rejects(readFile(join(root, "new.txt")), { code: "ENOENT" })
  assert.equal(ownership(), beforeOwner, "restore keeps native atom identity, parents and description")
  const stable = op()
  await call(jj => jj.restore(preimage.changeId))
  assert.equal(op(), stable, "repeating an already applied restore is a no-op")
  for (const reference of ["@", preimage.changeId.slice(0, 12), preimage.changeId.toUpperCase()]) {
    const error = await call(jj => jj.restore(reference).pipe(Effect.flip))
    assert.equal(error._tag, "@smthrs/jj/JjError")
    if (Jj.isJjError(error)) assert.equal(error.code, "invalid_ref")
    assert.equal(op(), stable, "invalid snapshot references are refused before spawning the adapter")
  }
  // A prior atom's preimage cannot redirect a later atom's working copy.
  jj("new", "-m", "✨ feat: following atom")
  const following = ownership()
  const refusal = await call(jj => jj.restore(preimage.changeId).pipe(Effect.flip))
  assert.equal(refusal._tag, "@smthrs/jj/JjError")
  assert.equal(ownership(), following)
  // JJ can exit zero while omitting a new file. The host must surface native
  // refusal rather than journal a successful but incomplete preimage.
  jj("config", "set", "--repo", "snapshot.max-new-file-size", "16")
  await writeFile(join(root, "oversized.txt"), "x".repeat(100))
  const omitted = await call(jj => jj.snapshot().pipe(Effect.flip))
  assert.equal(omitted._tag, "@smthrs/jj/JjError")
  if (Jj.isJjError(omitted)) assert.equal(omitted.code, "snapshot_refused")
  assert.equal(await readFile(join(root, "oversized.txt"), "utf8"), "x".repeat(100))
  // Preserve the native version refusal in the existing public error taxonomy.
  await writeFile(adapterPath, 'import json,sys\nprint(json.dumps({"error":{"code":"unsupported_jj","message":"requires pinned JJ"}}))\nsys.exit(1)\n')
  const version = await call(jj => jj.snapshot().pipe(Effect.flip))
  assert.ok(Jj.isJjError(version))
  assert.equal(version.code, "unsupported_version")
  // The guest's own word stays in the cause MESSAGE. The cause `code` is read
  // as this repo's vocabulary, so it holds the code this build admitted.
  assert.equal(version.cause?.code, "unsupported_version")
  assert.match(String(version.cause?.message), /requires pinned JJ \(unsupported_jj\)/)
  await writeFile(adapterPath, 'import json\nprint(json.dumps({"changeId":"@"}))\n')
  const malformed = await call(jj => jj.snapshot().pipe(Effect.flip))
  assert.ok(Jj.isJjError(malformed))
  assert.equal(malformed.code, "unknown", "an adapter cannot introduce a mutable preimage reference")
  t.diagnostic("Actual platform: " + ("Bun" in globalThis ? "BunServices" : "NodeServices"))
})
