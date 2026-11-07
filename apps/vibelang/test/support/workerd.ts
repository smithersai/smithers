// Local workerd for the live suites (test/*.workerd.test.*): Miniflare runs test/workerd/worker.ts, the API Worker's
// Durable Objects over the app's real code, or the site Worker alone, each listening on a free loopback port.
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"

const api = fileURLToPath(new URL("../workerd/worker.ts", import.meta.url))
const site = fileURLToPath(new URL("../../worker/index.vibe", import.meta.url))

/** The emitted Factory CLI (`pnpm build:surfaces`). */
export const cliPath = fileURLToPath(new URL("../../dist-factory/surfaces/cli-entry.js", import.meta.url))

/** The model key the opt-in real-model case uses; unset, that case skips. */
export const modelKey = process.env.CEREBRAS_API_KEY

/** `path` as one ES module for workerd, its `.vibe` modules compiled, workerd's own modules left to it. */
async function bundle(path: string): Promise<string> {
  const result = await build({
    entryPoints: [path], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], logLevel: "silent",
    plugins: [vibelang()],
  })
  return result.outputFiles[0]!.text
}

export interface Served {
  readonly origin: string
  readonly dispose: () => Promise<void>
}

async function listen(config: Record<string, unknown>): Promise<Served> {
  const worker = new Miniflare({ host: "127.0.0.1", port: 0, workers: [{ config }] } as ConstructorParameters<typeof Miniflare>[0])
  const url = await worker.ready
  return { origin: url.origin, dispose: () => worker.dispose() }
}

let apiModule: Promise<string> | undefined

/** The API Worker with `env` as its configuration: the deployment's Config, as text bindings. */
export async function serveApi(env: Readonly<Record<string, string>> = {}): Promise<Served> {
  apiModule ??= bundle(api)
  return listen({
    name: "api",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: await apiModule } } },
    env: {
      ...Object.fromEntries(Object.entries(env).map(([name, value]) => [name, { type: "text", value }])),
      CONVERSATION: { type: "durable-object", worker: "api", exportName: "Conversation" },
      BUDGET: { type: "durable-object", worker: "api", exportName: "Budget" },
    },
    exports: {
      Conversation: { type: "durable-object", storage: "sqlite" },
      Budget: { type: "durable-object", storage: "sqlite" },
    },
  })
}

/** The site Worker with no API Worker bound: the mock deployment. */
export async function serveSite(): Promise<Served> {
  return listen({
    name: "site",
    compatibilityDate: "2026-10-01",
    manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: await bundle(site) } } },
  })
}

/**
 * A fresh conversation id, so cases share no object.
 * @throws {never}
 */
export function room(name: string): string {
  return `${name}-${crypto.randomUUID().slice(0, 8)}`
}
