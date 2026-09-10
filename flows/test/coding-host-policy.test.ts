import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Stream } from "effect"
import { bundle } from "../coding/build.mjs"
import { runningWikiPolicy } from "../coding/wiki-policy.ts"
import { separateWikiOutput } from "../coding/wiki-output.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer

test("source reviewer identity reads the running recipe, changes with its policy and bounds source reads", async () => {
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(platform)))
  const inputs: string[] = []
  const captured = { ...fs, stream: (file: string, options: Parameters<typeof fs.stream>[1]) => {
    inputs.push(file)
    return fs.stream(file, options)
  } }
  const original = await Effect.runPromise(runningWikiPolicy.pipe(Effect.provideService(FileSystem.FileSystem, captured)))
  assert.match(original, /^source:[a-f0-9]{64}$/)
  assert(inputs.includes(fileURLToPath(new URL("../wiki/workflow.ts", import.meta.url))))
  assert(inputs.includes(fileURLToPath(new URL("../wiki/operations.ts", import.meta.url))))
  const changed = await Effect.runPromise(runningWikiPolicy.pipe(Effect.provideService(FileSystem.FileSystem, {
    ...fs, stream: (file, options) => file.endsWith("/wiki/workflow.ts")
      ? Stream.make(new TextEncoder().encode("a changed host review task; target sources are unchanged")) : fs.stream(file, options)
  })))
  assert.notEqual(changed, original)
  assert.equal(await Effect.runPromise(runningWikiPolicy.pipe(Effect.provideService(FileSystem.FileSystem, fs))), original)
  await assert.rejects(Effect.runPromise(runningWikiPolicy.pipe(Effect.provideService(FileSystem.FileSystem, {
    ...fs, stream: () => Stream.make(new Uint8Array(2 * 1024 * 1024 + 1))
  }))), /exceeds 2 MiB/)
})

test("wiki publication cannot resolve into the coding workspace, including through external symlinks", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-wiki-output-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  await mkdir(root)
  const verify = (output: string) => Effect.runPromise(separateWikiOutput(root, output).pipe(Effect.provide(platform)))
  for (const output of [root, ".", "docs/wiki", ".flows/wiki", "../repo/nested/wiki"]) {
    await assert.rejects(verify(output), /outside the source workspace/)
  }
  await symlink(root, join(temporary, "linked"), "dir")
  await assert.rejects(verify("../linked/new/wiki"), /outside the source workspace/)
  assert.equal(await verify("../separate/wiki"), join(await realpath(temporary), "separate/wiki"))
  assert.equal(await verify("../repo-wiki"), join(await realpath(temporary), "repo-wiki"))
  await symlink(join(root, "future"), join(temporary, "dangling"), "dir")
  await assert.rejects(verify("../dangling/wiki"), /dangling symlink/)
  const alias = join(temporary, "alias")
  await symlink(root, alias, "dir")
  await assert.rejects(Effect.runPromise(separateWikiOutput(alias, join(root, "wiki")).pipe(Effect.provide(platform))), /outside the source workspace/)
})

test("deployment embeds its exact compiled identity and needs no policy source filesystem", { timeout: 120_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-policy-bundle-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const entry = fileURLToPath(new URL("./fixtures/coding-policy-entry.ts", import.meta.url))
  const output = join(temporary, "host.mjs")
  const verify = async () => {
    const source = await readFile(output, "utf8")
    const match = source.match(/^const __SMITHERS_CODING_ARTIFACT_DIGEST__ = "([a-f0-9]{64})";\n/m)
    assert(match)
    assert.equal(createHash("sha256").update(source.replace(match[0], "")).digest("hex"), match[1])
    return match[1]
  }
  await bundle(entry, output)
  const first = await verify()
  assert.equal(execFileSync(process.execPath, [output], { encoding: "utf8", timeout: 60_000 }).trim(), `artifact:${first}`)
  const changed = join(temporary, "changed.ts")
  await writeFile(changed, `import ${JSON.stringify(entry)};\nconsole.log("changed host code");\n`)
  await bundle(changed, output)
  assert.notEqual(await verify(), first)
})
