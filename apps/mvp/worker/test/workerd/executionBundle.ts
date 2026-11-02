// worker/test/workerd/worker.ts, the harness Worker over worker/ExecutionHost.ts, bundled as one ES module for local
// workerd. worker/ExecutionHost.workerd.test.ts runs the bundle; worker/ExecutionHost.bundle.test.ts checks its imports.
// ExecutionHost.ts's graph is bundled with plain esbuild, not Alchemy's bundler, so a module only Alchemy's bundle can
// resolve (`alchemy/Cloudflare`, whose entry is Alchemy's Node deploy code) must stay out of it.
import { build, type BuildOptions } from "esbuild"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"

export const entry = fileURLToPath(new URL("./worker.ts", import.meta.url))

/** How the harness Worker is bundled: workerd's own modules (`node:*` under nodejs_compat, `cloudflare:*`) left to it. */
export const options = {
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
  // Workspace packages export their source, which can hold `.vibe` modules.
  plugins: [vibelang()],
} satisfies BuildOptions

/** The harness Worker as one ES module. */
export const bundle = async () => (await build(options)).outputFiles[0]!.text
