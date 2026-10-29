/** Builds the test presentation bundle once per process, with React's legacy static renderer, guarded. */
import { build } from "esbuild"
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Presentation } from "../../src/index.ts"

const require = createRequire(import.meta.url)

/** `react-dom/server` without its streaming half, which needs `MessageChannel` and `TextEncoder`. */
export const legacyServer = join(
  dirname(require.resolve("react-dom/package.json")),
  "cjs/react-dom-server-legacy.browser.production.js"
)

const built = new Map<string, Promise<string>>()

export const coverageBundlePath = (name: string): string => {
  const directory = process.env.PRESENTATION_COVERAGE_DIRECTORY
  if (directory === undefined) throw new Error("Presentation coverage setup is missing")
  return join(directory, `${name}.js`)
}

/** The bundle's source, as one classic script; `guarded: false` leaves React's renderer as published. */
export const bundle = (options: {
  readonly guarded?: boolean
  readonly sourcemap?: boolean
  readonly rendererFailure?: "value" | "message"
} = {}): Promise<string> => {
  const guarded = options.guarded ?? true
  const key = JSON.stringify([guarded, options.sourcemap ?? false, options.rendererFailure])
  const cached = built.get(key)
  if (cached !== undefined) return cached
  const source = build({
    entryPoints: [fileURLToPath(new URL("./bundle-entry.ts", import.meta.url))],
    bundle: true,
    write: false,
    ...(options.sourcemap ?
      {
        sourcemap: "inline" as const,
        outfile: coverageBundlePath(options.rendererFailure ?? (guarded ? "guarded" : "unguarded"))
      } :
      {}),
    // The coverage build has no synthetic IIFE statement to map onto line 1.
    // The production-shaped QuickJS tests retain the classic-script wrapper.
    format: options.sourcemap ? "esm" : "iife",
    platform: "browser",
    target: "es2020",
    minify: !options.sourcemap,
    legalComments: "none",
    define: {
      "process.env.NODE_ENV": "\"production\"",
      "__RENDERER_FAILURE__": JSON.stringify(options.rendererFailure ?? "none")
    },
    plugins: [{
      name: "legacy-static-renderer",
      setup: (plugin) => {
        plugin.onResolve({ filter: /^react-dom\/server$/ }, () => ({ path: legacyServer }))
        if (!guarded) return
        plugin.onLoad({ filter: /react-dom-server-legacy\.browser\.production\.js$/ }, async (args) => ({
          contents: Presentation.guardRenderer(await readFile(args.path, "utf8")),
          loader: "js"
        }))
      }
    }],
    logLevel: "silent"
  }).then(async (result) => {
    const output = result.outputFiles[0]!
    if (options.sourcemap) await writeFile(output.path, output.text)
    return output.text
  })
  built.set(key, source)
  return source
}
