import { Miniflare } from "miniflare"
import { readFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { expect, test } from "vitest"

test("the shared object store writes exact byte views, including empty objects, to R2", async () => {
  const source = await readFile(new URL("./ObjectBytes.ts", import.meta.url), "utf8")
  const worker = new Miniflare({ workers: [{ config: {
    name: "object-bytes",
    compatibilityDate: "2026-10-01",
    manifest: { mainModule: "worker.js", modules: {
      "ObjectBytes.js": { type: "esm", contents: stripTypeScriptTypes(source) },
      "worker.js": { type: "esm", contents: `
        import { putR2Bytes, getR2Bytes } from "./ObjectBytes.js"
        export default { async fetch(request, env) {
          const bytes = new Uint8Array(await request.arrayBuffer())
          await putR2Bytes(env.ARTIFACTS, "probe", bytes.subarray(1))
          const stored = await getR2Bytes(env.ARTIFACTS, "probe")
          return stored === null ? new Response(null, { status: 404 }) : new Response(stored)
        } }
      ` },
    } },
    env: { ARTIFACTS: { type: "r2" } },
  } }] })
  try {
    for (const input of [[99, 0, 255], [99]]) {
      const response = await worker.dispatchFetch("http://artifacts.internal/probe", { method: "PUT", body: Uint8Array.from(input) })
      expect(response.status).toBe(200)
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(input.slice(1))
    }
  } finally {
    await worker.dispose()
  }
})
