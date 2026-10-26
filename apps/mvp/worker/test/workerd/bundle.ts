// Bundles a test Worker the way Alchemy bundles ChatApi (rolldown and `@alchemy.run/cloudflare-runtime/rolldown`,
// Alchemy's own copies) and runs it in local workerd (Miniflare) with each output file as Cloudflare uploads it: `.js`
// as an ES module, `.wasm` as a compiled WebAssembly module. Node can't show what only workerd refuses, such as
// compiling WebAssembly from bytes. worker/AgentSandbox.workerd.test.ts and worker/ViewRealm.workerd.test.ts use it.
import { Miniflare } from "miniflare"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { workerBuild } from "../../../infra/WorkerBuild.ts"

const MVP = fileURLToPath(new URL("../../..", import.meta.url))

/** The compatibility ChatApi runs with (worker/ChatApi.ts `props`). */
export const COMPATIBILITY = { date: "2026-10-01", flags: ["nodejs_compat", "enable_request_signal", "global_fetch_strictly_public"] }

/** The root of installed package `name`, found from the module `from` resolves to. */
const packageRoot = async (from: string, name: string): Promise<string> => {
  let dir = dirname(from)
  for (;;) {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8").catch(() => "{}")) as { name?: string }
    if (manifest.name === name) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no ${name} above ${from}`)
    dir = parent
  }
}

/** The ES module entry package `root` exports at `subpath`. */
const importEntry = async (root: string, subpath: string): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    exports: Record<string, string | { import?: string | { default: string } }>
  }
  const entry = manifest.exports[subpath]!
  const target = typeof entry === "string" ? entry : entry.import!
  return join(root, typeof target === "string" ? target : target.default)
}

/** What this test reads of rolldown's API: an app can't import rolldown's types, which only Alchemy depends on. */
interface Rolldown {
  readonly rolldown: (options: Record<string, unknown>) => Promise<{
    readonly generate: (options: Record<string, unknown>) => Promise<{
      readonly output: ReadonlyArray<
        | { readonly type: "chunk"; readonly fileName: string; readonly code: string }
        | { readonly type: "asset"; readonly fileName: string; readonly source: string | Uint8Array }
      >
    }>
    readonly close: () => Promise<void>
  }>
}

/** Alchemy's own rolldown and Cloudflare plugin set: the dependencies installed beside Alchemy (pnpm's layout). */
const alchemyBundler = async () => {
  const alchemy = await packageRoot(fileURLToPath(import.meta.resolve("alchemy")), "alchemy")
  const [rolldown, cloudflare] = await Promise.all([
    importEntry(join(alchemy, "..", "rolldown"), "."),
    importEntry(join(alchemy, "..", "@alchemy.run", "cloudflare-runtime"), "./rolldown"),
  ])
  return {
    rolldown: (await import(pathToFileURL(rolldown).href)) as Rolldown,
    cloudflare: (await import(pathToFileURL(cloudflare).href)).default as (options: {
      readonly compatibilityDate: string
      readonly compatibilityFlags: ReadonlyArray<string>
    }) => Array<unknown>,
  }
}

/** The test Worker `entry` as Alchemy's bundler emits it: each output file by name, and what it is. */
export const bundle = async (entry: string) => {
  const { rolldown, cloudflare } = await alchemyBundler()
  const build = await rolldown.rolldown({
    input: entry,
    cwd: MVP,
    external: ["lightningcss", "fsevents"],
    // Alchemy's Bundle.build puts the Worker's own build plugins (infra/WorkerBuild.ts) before its Cloudflare ones.
    plugins: [workerBuild.input.plugins, cloudflare({ compatibilityDate: COMPATIBILITY.date, compatibilityFlags: COMPATIBILITY.flags })] as never,
    checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
  })
  const { output } = await build.generate({ format: "esm", entryFileNames: "worker.js", strictExecutionOrder: true })
  await build.close()
  return output
}

/** The Worker `entry`, bundled and started in workerd as `name`; the `.wasm` files its bundle carries. */
export const start = async (entry: string, name: string) => {
  const output = await bundle(entry)
  const modules = Object.fromEntries(output.map((file) =>
    file.type === "chunk"
      ? [file.fileName, { type: "esm" as const, contents: file.code }]
      : [file.fileName, { type: "wasm" as const, contents: Buffer.from(file.source) }]
  ))
  const worker = new Miniflare({
    workers: [{
      config: {
        name,
        compatibilityDate: COMPATIBILITY.date,
        compatibilityFlags: COMPATIBILITY.flags,
        manifest: { mainModule: "worker.js", modules },
      },
    }],
  })
  return { worker, wasm: output.filter((file) => file.fileName.endsWith(".wasm")).map((file) => file.fileName) }
}

/**
 * One request to `worker`, its body read at once. Miniflare's `dispatchFetch` wraps undici's response body in a new
 * `Response` and drops the original, which undici cancels when the garbage collector reclaims it: a body still unread
 * then reads as "Body has already been read". A test that awaits many responses before reading any of them loses one
 * whenever a collection runs in between, as it did once under a loaded host (2026-10-25).
 */
export const answer = async (worker: Miniflare, url: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) => {
  const response = await worker.dispatchFetch(url, init)
  return { status: response.status, headers: response.headers, body: await response.text() }
}

/**
 * Makes Miniflare fail a test that leaves a body unread past the current turn (`MINIFLARE_ASSERT_BODIES_CONSUMED`),
 * so a late read fails every run instead of only when a collection happens to run first. Returns the restore.
 */
export const assertBodiesConsumed = () => {
  const before = process.env.MINIFLARE_ASSERT_BODIES_CONSUMED
  process.env.MINIFLARE_ASSERT_BODIES_CONSUMED = "true"
  return () => {
    if (before === undefined) delete process.env.MINIFLARE_ASSERT_BODIES_CONSUMED
    else process.env.MINIFLARE_ASSERT_BODIES_CONSUMED = before
  }
}
