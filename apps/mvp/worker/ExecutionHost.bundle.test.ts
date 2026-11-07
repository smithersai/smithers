// worker/ExecutionHost.ts's module graph bundles for workerd: no module in it imports a bare Node built-in (`fs`, `url`,
// `path`, ...), which workerd doesn't provide and esbuild can't resolve for it. `node:*` imports are workerd's own under
// nodejs_compat (worker/ChatApi.ts `compatibility`; @effect/sql-pg opens its sockets with node:net), so they may stay.
// A bare built-in means Node-only code reached the graph, as `@alchemy.run/cloudflare` (Alchemy's Node deploy code) did
// through worker/flows/RedactFeed.ts. worker/ExecutionHost.workerd.test.ts then fails to build, but only where its
// Postgres runs; this test needs none and names the import chain.
import { build, type Metafile, type Plugin } from "esbuild"
import { builtinModules } from "node:module"
import { relative } from "node:path"
import { expect, test } from "vitest"
import { entry, options } from "./test/workerd/executionBundle.ts"

const BARE = new RegExp(
  `^(${builtinModules.filter((name) => !name.startsWith("node:")).join("|").replace(/\//g, "\\/")})(\\/.*)?$`
)

/** The importer chain from the entry to `target`, shortest first, as the metafile's input paths. */
const chainTo = (metafile: Metafile, start: string, target: string): Array<string> => {
  const parent = new Map<string, string>([[start, ""]])
  const queue = [start]
  while (queue.length > 0) {
    const at = queue.shift()!
    if (at === target) break
    for (const next of metafile.inputs[at]?.imports ?? []) {
      if (next.external || parent.has(next.path)) continue
      parent.set(next.path, at)
      queue.push(next.path)
    }
  }
  const chain: Array<string> = []
  for (let at: string | undefined = target; at; at = parent.get(at)) chain.unshift(at)
  return chain
}

test("ExecutionHost's workerd bundle imports no bare Node built-in", { timeout: 120_000 }, async () => {
  const hits: Array<{ readonly name: string; readonly importer: string }> = []
  // Records each bare built-in, and each import the bundle can't resolve, and leaves it external, so the build completes
  // and every importer is named.
  const record: Plugin = {
    name: "record-node-imports",
    setup(build) {
      build.onResolve({ filter: BARE }, (args) => {
        hits.push({ name: args.path, importer: args.importer })
        return { path: args.path, external: true }
      })
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === "record-node-imports" || args.kind === "entry-point") return undefined
        const resolved = await build.resolve(args.path, {
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          kind: args.kind,
          with: args.with,
          pluginData: "record-node-imports"
        })
        // Resolved: esbuild resolves it again itself, keeping what a `browser` field disables empty.
        if (resolved.errors.length === 0) return undefined
        hits.push({ name: `${args.path} (unresolved)`, importer: args.importer })
        return { path: args.path, external: true }
      })
    }
  }
  const result = await build({ ...options, metafile: true, plugins: [record, ...options.plugins] })
  const start = relative(process.cwd(), entry)
  const report = [...new Map(hits.map((hit) => [relative(process.cwd(), hit.importer), hit.name])).entries()]
    .slice(0, 5)
    .map(([importer, name]) => `${name} <- ${chainTo(result.metafile, start, importer).join(" -> ")}`)
  expect(report).toEqual([])
})
