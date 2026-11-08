/**
 * `docs-sync` through the flow API: the real graph, the real layer and a real
 * child process running `package-docs.mjs` against this checkout.
 *
 * A preloaded stub stands between the child and the one file the module
 * writes or compares, so no case changes the checkout.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Flow, Interpreter } from "@smthrs/flow"
import { Discovery } from "@smthrs/registry"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import DocsSync, { argv, layer, Request } from "./flow.ts"
import { pageMapOf, redirectMapOf, renderModule } from "./package-docs.mjs"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    DocsSync.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(DocsSync, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

// `stale` answers the generated module's read with old text; `capture` sends its
// write to DOCS_SYNC_OUT instead.
const stub = `
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
const generated = (path) => String(path).replaceAll("\\\\", "/").endsWith("apps/site/docs-redirect/src/docsRedirectMap.ts")
const read = fs.readFileSync
const write = fs.writeFileSync
if (process.env.DOCS_SYNC_STUB === "stale") {
  fs.readFileSync = (path, ...rest) => generated(path) ? "// stale\\n" : read(path, ...rest)
}
if (process.env.DOCS_SYNC_STUB === "capture") {
  fs.writeFileSync = (path, ...rest) => write(generated(path) ? process.env.DOCS_SYNC_OUT : path, ...rest)
}
syncBuiltinESMExports()
`

const withStub = async <A>(mode: "stale" | "capture", body: (directory: string) => Promise<A>) => {
  const directory = mkdtempSync(join(tmpdir(), "docs-sync-"))
  const preload = join(directory, "stub.mjs")
  writeFileSync(preload, stub)
  const env: Record<string, string> = {
    DOCS_SYNC_STUB: mode,
    DOCS_SYNC_OUT: join(directory, "docsRedirectMap.ts"),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    return await body(directory)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ mode: "print" }), [])
  assert.deepEqual(argv({ mode: "write" }), ["--write"])
  assert.deepEqual(argv({ mode: "check" }), ["--check"])
})

test("write renders both maps into the generated module", async () => {
  await withStub("capture", async (directory) => {
    const exit = await run({ mode: "write" }, "docs-sync-write")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
    assert.equal(
      readFileSync(join(directory, "docsRedirectMap.ts"), "utf8"),
      renderModule(redirectMapOf(), pageMapOf())
    )
  })
})

test("check refuses a stale generated module as a typed failure", async () => {
  await withStub("stale", async () => {
    const exit = await run({ mode: "check" }, "docs-sync-stale")
    assert.ok(Exit.isFailure(exit))
    const failure = JSON.stringify(exit.cause)
    assert.match(failure, /automation\/ModuleFailed/)
    assert.match(failure, /docs-sync\/package-docs\.mjs/)
    assert.match(failure, /"exitCode":1/)
  })
})

test("check passes on this checkout: the map is fresh and every published tarball carries its docs", async () => {
  const exit = await run({ mode: "check" }, "docs-sync-check")
  assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
})

// `pnpm docs:sync` and `docs:check` are repository maintenance an agent runs. `smthrs flow start` approves a plan
// itself, for the run alone, unless its envelope grants every capability ("*", which discovery substitutes for a flow
// that declares none): that one is refused until a person reviews and approves it (packages/smithers/src/commands/
// Launch.ts). So the flow's envelope, as discovery reads it from this source, is its declared capabilities.
test("an agent's flow start is approved with no person: discovery reads the declared capabilities, never every one", async () => {
  const flows = fileURLToPath(new URL("..", import.meta.url))
  const scan = await Effect.runPromise(
    Effect.gen(function*() {
      const discovery = Discovery.make(yield* FileSystem.FileSystem, yield* Path.Path)
      return yield* discovery.scan({ source: "project", root: flows, naming: "path" })
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
  )
  const entry = scan.entries.find((candidate) => candidate.name === "docs-sync")
  assert.ok(entry !== undefined, "discovery finds docs-sync")
  assert.deepEqual([...entry.capabilities], Flow.capabilityCeilings(DocsSync.annotations).flat())
  assert.ok(!entry.capabilities.includes("*"))
  assert.equal(entry.modelInvocable, false)
})
