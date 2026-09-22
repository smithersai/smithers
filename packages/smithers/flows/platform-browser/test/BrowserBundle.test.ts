import { fileURLToPath } from "node:url"
/**
 * The browser promise, executed for this package's complete Host bundle.
 *
 * `scripts/browser-check.mjs` gates the same entry points at the repository
 * level; this test keeps the property attached to the package that owns it, so
 * a Node-only import added to `BrowserHost` — the fetch-backed `HttpClient`
 * included — fails here first.
 */
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

describe("browser bundle", () => {
  it.each([
    ["barrel", "../src/index.ts"],
    ["BrowserHost", "../src/BrowserHost.ts"]
  ])("resolves the %s dependency graph without Node built-ins", async (_name, entry) => {
    const result = await build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      external: ["effect", "effect/*"],
      format: "esm",
      logLevel: "silent",
      platform: "browser",
      write: false
    })
    const source = result.outputFiles[0]?.text ?? ""
    expect(source).not.toMatch(/node:(?:child_process|fs|http|https|net|path|process)/)
  })
})
