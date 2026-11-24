import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { channel } from "node:diagnostics_channel"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bundle } from "../coding/build.mjs"

const root = fileURLToPath(new URL("../../..", import.meta.url))

test("the coding host compiles a native module with the flows project", { timeout: 300_000 }, async (t) => {
  const fixture = await mkdtemp(join(root, ".smithers/flows/coding/bundle-fixture-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const entry = join(fixture, "entry.ts")
  await writeFile(join(fixture, "answer.vibe"), "export const answer = do { 40 + 2 }\n")
  await writeFile(entry, "export { answer } from \"./answer.vibe\"\n")

  // VibeLang can recover from a missing project and still emit the right value.
  // Check which projects the bundler actually asks the compiler to emit.
  const projects = new Set<string>()
  const spawns = channel("tracing:child_process.spawn:start")
  const collect = (event: unknown) => {
    const { spawnargs } = (event as { process: ChildProcess }).process
    if (spawnargs.includes("--project-emit")) projects.add(spawnargs[spawnargs.indexOf("--project") + 1]!)
  }
  spawns.subscribe(collect)
  t.after(() => {
    spawns.unsubscribe(collect)
  })

  const output = join(fixture, "host.mjs")
  await bundle(entry, output)
  assert.deepEqual([...projects], [join(root, ".smithers/flows/tsconfig.json")])
  assert.equal((await import(pathToFileURL(output).href)).answer, 42)
})

/** Every TypeScript source the coding host may bundle. */
const sources = async function*(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield path
  }
}

// `bun:sqlite` is a Bun builtin, so the Node bundle keeps it behind a lazy
// shim that re-exports it by name. esbuild resolves an ESM named import
// against that shim's own exports: a name the shim does not list fails the
// BUILD, not the launch, and the coding host is the artifact a release
// publishes. effect 4.0.4 (#3839) added `constants` to the Bun SQLite client
// and the coding-host build broke on it.
test("the lazy bun:sqlite shim re-exports every name the bundled sources import", async () => {
  const build = await readFile(join(root, ".smithers/flows/coding/build.mjs"), "utf8")
  const shim = build.slice(build.indexOf("lazy-bun-sqlite"))
  const exported = new Set([...shim.matchAll(/export const (\w+) = native\.\1/g)].map((match) => match[1]!))
  assert.ok(exported.has("Database"), "the shim must re-export Database")
  const imported = new Map<string, string>()
  for (const scope of ["packages/smithers", ".smithers/flows"]) {
    for await (const path of sources(join(root, scope))) {
      const text = await readFile(path, "utf8")
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"bun:sqlite"/g)) {
        for (const name of match[1]!.split(",")) {
          const bare = name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()
          if (bare !== "") imported.set(bare, path.slice(root.length))
        }
      }
    }
  }
  assert.ok(imported.size > 0, "no source imports bun:sqlite; this test has stopped measuring anything")
  const missing = [...imported].filter(([name]) => !exported.has(name))
  assert.deepEqual(
    missing,
    [],
    `.smithers/flows/coding/build.mjs must re-export these bun:sqlite names: ${
      missing.map(([name, path]) => `${name} (${path})`).join(", ")
    }`
  )
})
