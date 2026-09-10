import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Stream } from "effect"
import { loadProject } from "../coding/project-config.ts"

const valid = () => ({ wikiOutput: "../wiki", implementation: "coding/implementation", reviewer: "product-engineering-v1",
  pages: [{ id: "runtime", title: "Runtime", purpose: "Runtime contracts", kind: "current", document: "RUNTIME.md",
    inputs: ["src/runtime.ts"], related: [] }],
  checks: [{ id: "types", target: "types", flow: "checks/types", tier: "fast", required: true }],
  historyLimit: 100, maxMemoryBytes: 48 * 1024 })

test("explicit operator JSON uses existing schemas and the injected Node/Bun filesystem", async t => {
  const directory = await mkdtemp(join(tmpdir(), "coding-project-config-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const platform = process.versions.bun
    ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
  const load = (filename: string | undefined) => Effect.runPromise(loadProject(directory, filename).pipe(Effect.provide(platform)))
  assert.equal(await load(undefined), undefined)
  // An invalid conventionally named file is never discovered implicitly.
  await writeFile(join(directory, "smithers.json"), "not json")
  assert.equal(await load(undefined), undefined)
  await writeFile(join(directory, "project.json"), JSON.stringify(valid()))
  const expected = { ...valid(), wikiOutput: join(await realpath(directory), "../wiki") }
  assert.deepEqual(await load("project.json"), expected)
  assert.deepEqual(await load(join(directory, "project.json")), expected)
  const exact = JSON.stringify(valid())
  await writeFile(join(directory, "project.json"), exact + " ".repeat(262144 - Buffer.byteLength(exact)))
  assert.deepEqual(await load("project.json"), expected)
  for (const filename of ["", "  ", "missing.json", "bad\0path"]) await assert.rejects(load(filename), /SMITHERS_CODING_PROJECT/)
  const bad = [
    { ...valid(), unknown: "refuse" }, { ...valid(), reviewer: "" }, { ...valid(), reviewer: "  " },
    { ...valid(), pages: [] }, { ...valid(), pages: [...valid().pages, ...valid().pages] },
    { ...valid(), pages: [{ ...valid().pages[0], related: ["absent"] }] },
    { ...valid(), pages: [{ ...valid().pages[0], privateKey: "do-not-print" }] },
    { ...valid(), checks: [...valid().checks, ...valid().checks] },
    { ...valid(), checks: [{ ...valid().checks[0], flowDigest: "model-supplied" }] },
    { ...valid(), checks: [{ ...valid().checks[0], argv: ["invented-command"] }] },
    { ...valid(), historyLimit: 101 }, { ...valid(), maxMemoryBytes: 92161 },
    { ...valid(), wikiOutput: "docs/wiki" }, { ...valid(), wikiOutput: ".flows/wiki" }
  ]
  for (const value of bad) {
    await writeFile(join(directory, "project.json"), JSON.stringify(value))
    await assert.rejects(load("project.json"), error => {
      assert.match(String(error), /SMITHERS_CODING_PROJECT/)
      assert.doesNotMatch(String(error), /do-not-print|model-supplied|invented-command/)
      return true
    })
  }
  for (const value of ["{", "x".repeat(262145), Buffer.from([0xff])]) {
    await writeFile(join(directory, "project.json"), value)
    await assert.rejects(load("project.json"), /SMITHERS_CODING_PROJECT/)
  }
  // Byte bounds apply to UTF-8, not JavaScript string length.
  await writeFile(join(directory, "project.json"), JSON.stringify({ ...valid(), reviewer: "🌱".repeat(70_000) }))
  await assert.rejects(load("project.json"), /256 KiB/)
})

test("project reads enforce emitted byte bounds and do not open or stat an implicit file", async () => {
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  let reads = 0
  const injected: FileSystem.FileSystem = { ...fs,
    stat: () => Effect.die(new Error("No stat-before-read size assumption")),
    readFile: () => Effect.die(new Error("No unbounded read")),
    stream: (_filename, options) => {
      reads++
      assert.equal(options?.bytesToRead, 262145)
      return Stream.fromIterable([new Uint8Array(262144), new Uint8Array(1)])
    }
  }
  const load = (filename: string | undefined) => Effect.runPromise(loadProject("/repository", filename).pipe(
    Effect.provideService(FileSystem.FileSystem, injected), Effect.provide(NodeServices.layer)))
  assert.equal(await load(undefined), undefined)
  assert.equal(reads, 0)
  await assert.rejects(load("explicit.json"), /256 KiB/)
  assert.equal(reads, 1)
})

test("configured entry loads explicit project data before host initialization; help needs no project", { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "coding-project-entry-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, "invalid.json"), JSON.stringify({ ...valid(), password: "do-not-print-this-value" }))
  const entry = process.env.SMITHERS_CODING_HOST_BINARY ?? fileURLToPath(new URL("../coding/serve.ts", import.meta.url))
  const run = (args: string[]) => spawnSync(process.execPath, [
    ...(process.versions.bun ? [] : ["--experimental-strip-types"]), entry, ...args
  ], { cwd: directory, encoding: "utf8", timeout: 75_000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SMITHERS_CODING_PROJECT: "invalid.json" } })
  const help = run(["--help"])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /SMITHERS_CODING_PROJECT/)
  const refusal = run(["serve", "--root", directory])
  assert.equal(refusal.status, 1, refusal.stderr)
  const diagnostic = refusal.stdout + refusal.stderr
  assert.match(diagnostic, /Invalid SMITHERS_CODING_PROJECT/)
  assert.doesNotMatch(diagnostic, /do-not-print-this-value|Set SMITHERS_CODING_IMPLEMENT_MODEL/)
})
