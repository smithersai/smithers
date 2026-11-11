/** Runs the test Worker in local workerd through Miniflare. */
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"

const require = createRequire(import.meta.url)

/** The Worker as one ES module, importing the QuickJS module as `./quickjs.wasm`. */
const worker = async (): Promise<string> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    plugins: [{
      name: "compiled-wasm",
      setup: (plugin) => {
        plugin.onResolve({ filter: /^@jitl\/quickjs-wasmfile-release-sync\/wasm$/ }, () => ({
          path: "./quickjs.wasm",
          external: true
        }))
      }
    }, vibelang({ root: fileURLToPath(new URL("../..", import.meta.url)) })],
    logLevel: "silent"
  })
  return result.outputFiles[0]!.text
}

/** Starts workerd with the Worker and the presentation bundle. Dispose it when done. */
export const start = async (bundle: string): Promise<Miniflare> =>
  new Miniflare({
    workers: [{
      config: {
        name: "views",
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        manifest: {
          mainModule: "worker.js",
          modules: {
            "worker.js": { type: "esm", contents: await worker() },
            "quickjs.wasm": {
              type: "wasm",
              contents: new Uint8Array(await readFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")))
            }
          }
        },
        env: { BUNDLE: { type: "text", value: bundle } }
      }
    }]
  })
