// The real Alchemy bundle, shared by the deterministic startup test and the standalone performance benchmark.
import { readFile as readFileAsync } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { workerBuild } from "../../../infra/WorkerBuild.ts"

const MVP = fileURLToPath(new URL("../../..", import.meta.url))
const ENTRY = join(MVP, "worker/ChatApi.ts")
const COMPATIBILITY = { date: "2026-10-01", flags: ["nodejs_compat", "enable_request_signal", "global_fetch_strictly_public"] }

/** The root of installed package `name`, found from the module `from` resolves to. */
const packageRoot = async (from: string, name: string): Promise<string> => {
  let dir = dirname(from)
  for (;;) {
    const manifest = JSON.parse(await readFileAsync(join(dir, "package.json"), "utf8").catch(() => "{}")) as { name?: string }
    if (manifest.name === name) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no ${name} above ${from}`)
    dir = parent
  }
}

/** The ES module entry package `root` exports at `subpath`. */
const importEntry = async (root: string, subpath: string): Promise<string> => {
  const manifest = JSON.parse(await readFileAsync(join(root, "package.json"), "utf8")) as {
    exports: Record<string, string | { import?: string | { default: string } }>
  }
  const entry = manifest.exports[subpath]!
  const target = typeof entry === "string" ? entry : entry.import!
  return join(root, typeof target === "string" ? target : target.default)
}

export interface Output {
  readonly type: "chunk" | "asset"
  readonly fileName: string
  readonly imports?: ReadonlyArray<string>
  readonly dynamicImports?: ReadonlyArray<string>
  readonly modules?: Readonly<Record<string, unknown>>
  readonly code?: string
  readonly source?: string | Uint8Array
}

/** ChatApi as Alchemy's bundler emits it. */
export const bundle = async (): Promise<ReadonlyArray<Output>> => {
  const alchemy = await packageRoot(fileURLToPath(import.meta.resolve("alchemy")), "alchemy")
  const [rolldownEntry, cloudflareEntry] = await Promise.all([
    importEntry(join(alchemy, "..", "rolldown"), "."),
    importEntry(join(alchemy, "..", "@alchemy.run", "cloudflare-runtime"), "./rolldown"),
  ])
  const rolldown = (await import(pathToFileURL(rolldownEntry).href)) as {
    rolldown: (options: Record<string, unknown>) => Promise<{
      generate: (options: Record<string, unknown>) => Promise<{ output: ReadonlyArray<Output> }>
      close: () => Promise<void>
    }>
  }
  const cloudflare = (await import(pathToFileURL(cloudflareEntry).href)).default as (options: {
    readonly compatibilityDate: string
    readonly compatibilityFlags: ReadonlyArray<string>
  }) => Array<unknown>
  const build = await rolldown.rolldown({
    input: ENTRY,
    cwd: MVP,
    external: ["lightningcss", "fsevents"],
    // Alchemy's Bundle.build puts the Worker's own build plugins (infra/WorkerBuild.ts) before its Cloudflare ones.
    plugins: [workerBuild.input.plugins, cloudflare({ compatibilityDate: COMPATIBILITY.date, compatibilityFlags: COMPATIBILITY.flags })] as never,
    checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
  })
  const { output } = await build.generate({ format: "esm", entryFileNames: "ChatApi.js", strictExecutionOrder: true })
  await build.close()
  return output
}

