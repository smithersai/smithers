import { expect, it } from "@effect/vitest"
import { build } from "esbuild"
import { webcrypto } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createContext, runInContext } from "node:vm"
import vibelang from "vibelang-unplugin/esbuild"

it("keeps the public package browser import and unchanged work independent of the Node host adapter", async () => {
  const bundle = await build({
    plugins: [vibelang({ root: fileURLToPath(new URL("..", import.meta.url)) })],
    stdin: {
      contents: `
        import * as Effect from "effect/Effect"
        import * as Sandbox from "./src/index.ts"
        globalThis.runBrowserProbe = async () => {
          const work = new Sandbox.Sandbox.Unchanged({ session: "browser", base: "base" })
          const result = await Effect.runPromise(Sandbox.SandboxMerge.apply(work, {
            repository: "/unused", onto: "main", message: "unused", key: "browser"
          }))
          return JSON.stringify({
            processAbsent: typeof process === "undefined",
            modules: Object.keys(Sandbox).sort(),
            sameWork: result === work,
            result
          })
        }
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url))
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    metafile: true
  })
  expect(Object.keys(bundle.metafile.inputs).some((path) => path.endsWith("/node/NodeJj.ts"))).toBe(false)
  const context = createContext({
    AbortController,
    crypto: webcrypto,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder
  })
  // Every browser has `structuredClone`, and `Node.capture` uses it when a flow such as `CiJob`'s declares its body at
  // import. Node's would clone into Node's realm, so the probe's realm gets one of its own: enough for inert data.
  runInContext("globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value))", context)
  runInContext(bundle.outputFiles[0]!.text, context)
  const run = (context as typeof context & { runBrowserProbe: () => Promise<string> }).runBrowserProbe
  const result = JSON.parse(await run())
  expect(result.processAbsent).toBe(true)
  expect(result.modules).toContain("SandboxMerge")
  expect(result.sameWork).toBe(true)
  expect(result.result).toEqual({ _tag: "Unchanged", session: "browser", base: "base" })
})
