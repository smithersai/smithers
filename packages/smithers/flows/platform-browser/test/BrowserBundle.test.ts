import { fileURLToPath } from "node:url"
/**
 * The browser promise, executed for this package's complete Host bundle.
 *
 * `packages/repo-targets/browser/browser-check.mjs` gates the same entry points at the repository
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

  /**
   * A tab imports the package's root for `BrowserEngine` and `SharedSqlite`;
   * only the engine worker builds an engine. Split the way an app's bundler
   * splits at `import()`, what the tab loads eagerly is the entry chunk and
   * every chunk it imports statically.
   */
  it("a tab importing BrowserEngine and SharedSqlite carries no engine or SQLite", async () => {
    const result = await build({
      bundle: true,
      splitting: true,
      metafile: true,
      stdin: {
        contents: `export { BrowserEngine, SharedSqlite } from "./index.ts"`,
        resolveDir: fileURLToPath(new URL("../src", import.meta.url)),
        sourcefile: "tab.ts"
      },
      external: ["effect", "effect/*"],
      format: "esm",
      logLevel: "silent",
      outdir: "/out",
      platform: "browser",
      write: false
    })
    const outputs = result.metafile.outputs
    const entry = Object.keys(outputs).find((file) => outputs[file]!.entryPoint !== undefined)!
    const eager = new Set([entry])
    for (const file of eager) {
      // `effect` is external: no output of this build.
      for (const { kind, path } of outputs[file]!.imports) {
        if (kind === "import-statement" && path in outputs) eager.add(path)
      }
    }
    const loaded = [...eager].flatMap((file) => Object.keys(outputs[file]!.inputs))
    const lazy = Object.values(outputs).flatMap((output) => Object.keys(output.inputs))
    const engine =
      /(?:^|\/)(?:engine-store|run-store|journal|database)\/src\/|flows\/src\/Runtime|wa-sqlite|internal\/(?:Engine|Leader|SqlConnection)\.ts$/
    expect(loaded.filter((input) => engine.test(input))).toEqual([])
    // Worker composition is not part of a tab importing the client services.
    expect(lazy.some((input) => input.endsWith("internal/Engine.ts"))).toBe(false)
    // The package never imports the build itself: the worker hands it over.
    expect(lazy.filter((input) => /wa-sqlite\/dist\//.test(input))).toEqual([])
  })
})
