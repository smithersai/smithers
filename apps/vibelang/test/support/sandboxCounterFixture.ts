// Stays .ts: a build-tool fixture executes only Istanbul's generated counter initializer in a Node VM.
// Authored binding code never executes here. Synthetic hits test remapping, never establish live coverage.
import { runInNewContext } from "node:vm"
import { resolve } from "node:path"
import { parseAstAsync } from "vite"
import sandboxCoveragePlugin from "../../bench/sandbox-coverage-plugin.ts"
import type { SandboxDump } from "../../bench/sandbox-evidence.ts"

export async function sandboxCounterFixture(): Promise<SandboxDump> {
  const plugin = sandboxCoveragePlugin() as unknown as { load: (this: unknown, id: string) => Promise<{ code: string }> }
  const scope: { __coverage__?: Record<string, unknown>; __sandboxBenchBuild?: string } = {}
  for (const name of ["SandboxAccounts", "SandboxMachine", "SandboxProbe"]) {
    const output = await plugin.load.call({
      addWatchFile() {},
      warn(warning: { message?: string }) { console.warn(warning.message ?? warning) },
      error(error: unknown) { throw new Error(JSON.stringify(error)) },
    }, resolve(`worker/${name}.vibe`))
    const ast = await parseAstAsync(output.code)
    const firstImport = ast.body.find((node) => node.type === "ImportDeclaration")?.start
    if (firstImport === undefined) throw new Error("fixture: no binding imports")
    runInNewContext(output.code.slice(0, firstImport), scope, { timeout: 1000 })
  }
  if (!scope.__coverage__ || Object.keys(scope.__coverage__).length !== 3) throw new Error("fixture: missing per-module counters")
  const relocated: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(scope.__coverage__)) relocated[key.replace(/^.*\/apps\/vibelang\//, "/lead/mac/apps/vibelang/")] = value
  const snapshot = { buildId: scope.__sandboxBenchBuild ?? null, coverage: relocated }
  return { schema: 1, snapshots: [snapshot, structuredClone(snapshot), structuredClone(snapshot)] }
}

export function markFixtureHits(dump: SandboxDump) {
  for (const snapshot of dump.snapshots) for (const value of Object.values(snapshot.coverage)) {
    const entry = value as { s: Record<string, number>; f: Record<string, number>; b: Record<string, number[]> }
    for (const key of Object.keys(entry.s)) entry.s[key] = 1
    for (const key of Object.keys(entry.f)) entry.f[key] = 1
    for (const key of Object.keys(entry.b)) entry.b[key] = entry.b[key]!.map(() => 1)
  }
  return dump
}
