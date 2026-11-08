// The workerd smoke (test/workerd/worker.ts), automated: esbuild bundles it as Cloudflare's bundlers do, keeping this
// package's `#quickjs.wasm` import a module of its own, and Miniflare runs it in local workerd, which refuses to
// compile WebAssembly from bytes. A cell that calls a flow and completes proves `QuickJSWorkerd.variant` loads there.
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { readFile } from "node:fs/promises"
import vibelang from "vibelang-unplugin/esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const entry = new URL("./workerd/worker.ts", import.meta.url).pathname

let worker: Miniflare | undefined
let wasmFiles: Array<string> = []

beforeAll(async () => {
  const wasm: Array<string> = []
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
    plugins: [{
      name: "wasm-modules",
      setup(bundler) {
        bundler.onResolve({ filter: /^#quickjs\.wasm$/ }, async (args) => {
          if (args.pluginData === "inner") return undefined
          const resolved = await bundler.resolve(args.path, {
            importer: args.importer,
            resolveDir: args.resolveDir,
            kind: args.kind,
            pluginData: "inner"
          })
          wasm.push(resolved.path)
          return { path: "./quickjs.wasm", external: true }
        })
      }
    }, vibelang({ root: new URL("..", import.meta.url).pathname })]
  })
  wasmFiles = wasm
  const modules: Record<string, { readonly type: "esm" | "wasm"; readonly contents: string | Uint8Array }> = {
    "worker.js": { type: "esm", contents: result.outputFiles[0]!.text }
  }
  for (const path of wasm) modules["quickjs.wasm"] = { type: "wasm", contents: await readFile(path) }
  worker = new Miniflare({
    workers: [{ config: { name: "smoke", compatibilityDate: "2026-10-01", manifest: { mainModule: "worker.js", modules } } }]
  } as unknown as ConstructorParameters<typeof Miniflare>[0])
  await worker.ready
}, 120_000)

afterAll(async () => {
  await worker?.dispose()
})

describe("QuickJSWorkerd in workerd", () => {
  it("bundles the build's .wasm as its own module and runs a cell on it", async () => {
    expect(wasmFiles).toHaveLength(1)
    expect(wasmFiles[0]).toMatch(/quickjs-wasmfile-release-sync.*\.wasm$/)
    const response = await worker!.dispatchFetch("https://smoke.invalid/")
    const body = await response.text()
    expect(response.status, body).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "README.md" } })
  })
})
