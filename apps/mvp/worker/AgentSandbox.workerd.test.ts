// worker/AgentSandbox.ts in local workerd: the `todo` run's agent evaluates one of its cells in QuickJS on Cloudflare's
// runtime. The test Worker (worker/test/workerd/agent.ts) is bundled with the bundler and plugins Alchemy bundles ChatApi
// with (rolldown and `@alchemy.run/cloudflare-runtime/rolldown`, Alchemy's own copies), and run by Miniflare with each
// output file as Cloudflare uploads it: `.js` as an ES module, `.wasm` as a compiled WebAssembly module. Node can't show
// this: only workerd refuses to compile WebAssembly from bytes, which is why the single-file build failed there.
import type { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { start } from "./test/workerd/bundle.ts"

const ENTRY = fileURLToPath(new URL("./test/workerd/agent.ts", import.meta.url))

/** The base commit the test Worker's attempt machine checks out. */
const BASE = "0f".repeat(20)

describe("the todo agent's cell sandbox on workerd", () => {
  let worker: Miniflare | undefined
  let wasm: Array<string> = []

  beforeAll(async () => {
    const started = await start(ENTRY, "agent")
    worker = started.worker
    wasm = started.wasm
  }, 120_000)

  afterAll(async () => {
    await worker?.dispose()
  })

  test("the bundle carries QuickJS as one compiled WebAssembly module", () => {
    expect(wasm).toHaveLength(1)
  })

  test("a cell reads the checkout and writes a file through the run's sandbox tools, as the TODO's committer", async () => {
    const response = await worker!.dispatchFetch("http://agent/")
    const text = await response.text()
    expect(response.status, text).toBe(200)
    expect(JSON.parse(text)).toEqual({
      outcome: { _tag: "settled", transition: { _tag: "complete", output: "README.md", value: "README.md" } },
      // The attempt's machine, checked out at its base commit, as the TODO's committer.
      calls: [`${BASE} maya list`, `${BASE} maya read`, `${BASE} maya write`],
      files: { "README.md": "# hello\nHello from T1.\n" },
    })
  }, 60_000)
})
