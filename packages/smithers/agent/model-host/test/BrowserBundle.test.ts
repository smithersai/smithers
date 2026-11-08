/**
 * The root entry runs on every platform: Node, Bun, a browser and a
 * Cloudflare Worker (apps/mvp/worker imports it). What only one platform can
 * do is injected by the host composition — the Node model host passes
 * `FetchTransport.observe` from `@smthrs/platform-node` — so nothing this root
 * reaches may import a `node:` or `bun:` built-in.
 *
 * `packages/repo-targets/browser/browser-check.mjs` gates the same entry at
 * the repository level; this test keeps the property attached to the package
 * that owns it, so a Node-only import added here fails here first.
 */
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"
import { describe, expect, it } from "vitest"

describe("the root entry", () => {
  it("bundles for the browser without a node: or bun: built-in", async () => {
    const result = await build({
      plugins: [vibelang({ root: fileURLToPath(new URL("..", import.meta.url)) })],
      bundle: true,
      entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      external: ["effect", "effect/*"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "browser",
      write: false
    })
    const builtins = Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports.map((entry) => entry.path).filter((path) => /^(?:node|bun):/.test(path))
    )
    expect(builtins).toEqual([])
  })
})
