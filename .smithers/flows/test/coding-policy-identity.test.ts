import { NodeServices } from "@effect/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Path } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { bindRepositoryRegistry, provisionBuiltins, runningRepositoryPolicy } from "../coding/registry.ts"
import { systemFlows } from "./fixtures/system-flows.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer

const measuredPolicy = (changedFile?: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const source = {
      ...fs,
      readFileString: ((path: string, ...options: ReadonlyArray<unknown>) =>
        fs.readFileString(path, ...options as []).pipe(Effect.map((text) =>
          changedFile !== undefined && path.endsWith(`/${changedFile}`) ?
            changedFile === "coding/jev-rules.ts"
              ? text.replace("FLAG_PROBABILITY = 0.8", "FLAG_PROBABILITY = 0.7")
              : `${text}\n// Changed classifier policy.\n`
            : text
        ))) as typeof fs.readFileString
    }
    return yield* runningRepositoryPolicy.pipe(Effect.provideService(FileSystem.FileSystem, source))
  })

test("a judge code change changes the host policy and fences a planned built-in", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-policy-identity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    Effect.runPromise(effect.pipe(Effect.provide(platform)))
  const original = await run(measuredPolicy())
  assert.equal(await run(measuredPolicy()), original, "unchanged source keeps its identity")
  const base = await Effect.runPromise(
    Registry.make({ sources: [] }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform))
  )
  const hostAt = async (policy: string) =>
    bindRepositoryRegistry(base, (await run(provisionBuiltins(root, policy))).registry, systemFlows)

  const oldHost = await hostAt(original)
  const generated = await readFile(join(root, "builtin-flows", original, "coding", "flow.ts"), "utf8")
  assert.ok(generated.includes(`// Bundled repository policy ${original}.`), "the written bytes carry the policy")
  const approved = Descriptor.executionDigest(await Effect.runPromise(oldHost.get("coding")))
  assert.ok(approved)
  assert.equal((await Effect.runPromise(oldHost.loadBody("coding", approved)))._tag, "Module")

  for (const file of ["coding/jev-rules.ts", "coding/evaluator.ts"]) {
    const changed = await run(measuredPolicy(file))
    assert.notEqual(changed, original, `${file} must change the measured host policy`)
    const changedHost = await hostAt(changed)
    const current = Descriptor.executionDigest(await Effect.runPromise(changedHost.get("coding")))
    assert.notEqual(current, approved)
    await assert.rejects(
      Effect.runPromise(changedHost.loadBody("coding", approved)),
      /Repository host policy changed after planning/
    )
  }
})
