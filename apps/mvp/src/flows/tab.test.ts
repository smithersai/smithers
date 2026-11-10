// What the tab loads (decision 0011 §4, docs/features/flows.md#how-a-dispatch-runs): the page's module graph never
// reaches @smthrs/agent or a Node built-in, and reaches @smthrs/std only through code intelligence's LanguageServer
// seam. The agent runs in the engine worker, a bundle of its own (src/flows/engine.worker.ts →
// src/flows/registrations.ts); the tab dispatches by the registry's references. A tab that
// imports the agent fails before it renders: Vite stubs `node:` modules in the page, and the stub throws when read.
//
// The graph is esbuild's, as `packages/repo-targets/browser/browser-check.mjs` bundles the SDK's browser entry points:
// a browser bundle of src/main.tsx with the dev server's branches kept, so the end-to-end entry (`/app?faults`,
// src/test/e2e.ts) is walked too. Stylesheets are left out; the engine worker isn't imported, only started by URL.
import { build } from "esbuild"
import { isBuiltin } from "node:module"
import { join, relative } from "node:path"
import vibelang from "vibelang-unplugin/esbuild"
import { createServer } from "vite"
import { describe, expect, test } from "vitest"

const app = join(import.meta.dirname, "../..")

/** What the tab must never import: the agent, its standard tools, and Node. */
const forbidden = (specifier: string) => isBuiltin(specifier) || /^@smthrs\/(agent|std)(\/|$)/.test(specifier)

/** Every import in `entry`'s browser module graph of something {@link forbidden}, as `<specifier> <- <importer>`. */
const reached = async (entry: string): Promise<ReadonlyArray<string>> => {
  const found = new Set<string>()
  // Resolve virtual imports with the app's own Vite plugins, then walk their real code too.
  const vite = await createServer({
    root: app,
    configFile: join(app, "vite.config.ts"),
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    await build({
      entryPoints: [entry],
      absWorkingDir: app,
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
      define: { "import.meta.env.DEV": "true" },
      plugins: [{
        name: "tab-graph",
        setup: (graph) => {
          graph.onResolve({ filter: /^virtual:pwa-register$/ }, async (args) => {
            const resolved = await vite.environments.client.pluginContainer.resolveId(args.path, args.importer)
            if (!resolved) throw new Error(`Vite could not resolve ${args.path}`)
            return { path: resolved.id, namespace: "vite-pwa" }
          })
          graph.onLoad({ filter: /.*/, namespace: "vite-pwa" }, async (args) => {
            const loaded = await vite.environments.client.pluginContainer.load(args.path)
            if (!loaded) throw new Error(`Vite could not load ${args.path}`)
            return { contents: typeof loaded === "string" ? loaded : loaded.code, resolveDir: app }
          })
          graph.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, external: true }))
          graph.onResolve({ filter: /.*/ }, (args) => {
            if (forbidden(args.path)) found.add(`${args.path} <- ${relative(app, args.importer)}`)
            // A Node built-in can't resolve for a browser: keep it out of the bundle, and keep walking.
            return isBuiltin(args.path) ? { path: args.path, external: true } : undefined
          })
        },
      }, vibelang()],
    })
  } finally {
    await vite.close()
  }
  return [...found]
}

/**
 * The one door the page has into `@smthrs/std`: code intelligence binds std's `LanguageServer` seam to a language server
 * in a Web Worker (docs/design/code-intelligence/DESIGN.md). Its module graph reaches no Node built-in; any other
 * importer of std, or of the agent, fails the check.
 */
const languageServerSeam = new Set([
  "@smthrs/std <- src/features/code-intel/session.ts",
  "@smthrs/std <- ../../packages/smithers/flows/platform-browser/src/BrowserLanguageServer.ts",
])

describe("the tab's modules", () => {
  test("the page never imports the agent, its standard tools or Node; std only through the language-server seam", async () => {
    const found = await reached("src/main.tsx")
    expect(found.filter((edge) => !languageServerSeam.has(edge))).toEqual([])
    expect(found.filter((edge) => languageServerSeam.has(edge)).sort()).toEqual([...languageServerSeam].sort())
  })

  test("the check sees them where they are: the engine worker's registrations import the agent", async () => {
    expect(await reached("src/flows/registrations.ts")).toContainEqual(
      expect.stringMatching(/^@smthrs\/agent <- src\/features\/agent\//),
    )
  })
})
