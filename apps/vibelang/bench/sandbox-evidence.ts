// Stays .ts: Node 26's merge command reads relocated deployed Istanbul maps without a VibeLang compile step.
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { sourceCoverage } from "../test/support/workerdCoverage.ts"
import { normalizeEndColumns, type FileCoverageJSON } from "../test/support/coverageUnion.ts"

export interface SandboxDump { readonly schema: 1; readonly snapshots: ReadonlyArray<{ readonly buildId: string | null; readonly coverage: Record<string, unknown> }> }
// Vitest clears coverage/bench at the start of collection. Keep lead-collected evidence outside that directory.
export const SANDBOX_COUNTER_DIRECTORY = "bench/results/sandbox-raw"
const bindings = ["worker/SandboxAccounts.vibe", "worker/SandboxMachine.vibe", "worker/SandboxProbe.vibe"]
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const relativeSource = (path: string) => {
  const match = /(?:^|\/)apps\/vibelang\/((?:src|worker|infra)\/.+\.vibe)$/.exec(path.replaceAll("\\", "/"))
  if (!match || match[1]!.split("/").includes("..")) throw new Error(`sandbox coverage: foreign source ${path}`)
  return match[1]!
}

/** Validate source bytes before relocating Mac paths to this checkout. Never credit recordings as execution. */
export async function sandboxSourceEvidence(dump: SandboxDump, appRoot: string): Promise<Record<string, FileCoverageJSON>> {
  if (dump.schema !== 1 || !Array.isArray(dump.snapshots) || dump.snapshots.length !== 3) throw new Error("sandbox coverage: expected Worker, account and machine snapshots")
  const buildId = dump.snapshots[0]?.buildId
  if (typeof buildId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(buildId) || dump.snapshots.some((snapshot) => snapshot.buildId !== buildId)) throw new Error("sandbox coverage: missing or mixed deployment build ids")
  const raw: Record<string, unknown> = {}
  const all: Array<Record<string, FileCoverageJSON>> = []
  for (const snapshot of dump.snapshots) {
    const relocated: Record<string, unknown> = {}
    if (!snapshot.coverage || Object.keys(snapshot.coverage).length === 0) throw new Error("sandbox coverage: empty isolate counters")
    for (const [path, value] of Object.entries(snapshot.coverage)) {
      const relative = relativeSource(path)
      const local = resolve(appRoot, relative)
      const entry = structuredClone(value) as FileCoverageJSON & { inputSourceMap?: { file?: string; sourceRoot?: string; sources: string[]; sourcesContent?: string[] } }
      const map = entry.inputSourceMap
      const source = await readFile(local, "utf8")
      if (!map || map.sources.length !== 1 || map.sourcesContent?.length !== 1 || digest(map.sourcesContent[0]!) !== digest(source)) throw new Error(`sandbox coverage: source mismatch for ${relative}; redeploy this source`)
      for (const count of [...Object.values(entry.s), ...Object.values(entry.f), ...Object.values(entry.b).flat()]) {
        if (!Number.isSafeInteger(count) || count < 0) throw new Error(`sandbox coverage: invalid count for ${relative}`)
      }
      entry.path = local
      map.file = local
      map.sourceRoot = ""
      map.sources = [local]
      relocated[local] = entry
      raw[relative] = value
    }
    const sourceMap = await sourceCoverage(relocated)
    const evidence: Record<string, FileCoverageJSON> = {}
    for (const path of sourceMap.files()) evidence[path] = normalizeEndColumns(sourceMap.fileCoverageFor(path).toJSON() as unknown as FileCoverageJSON, await readFile(path, "utf8"))
    all.push(evidence)
  }
  for (const binding of bindings) if (!(binding in raw)) throw new Error(`sandbox coverage: missing ${binding}`)
  // Identical compilation within a deployment: preserve the first map's structure and add only source-position hits.
  const { mergeByPosition } = await import("../test/support/coverageUnion.ts")
  return mergeByPosition({}, all)
}

export async function sandboxEvidence(directory: string, appRoot: string): Promise<Record<string, FileCoverageJSON>> {
  const names = await readdir(directory).catch((error: { code?: string }) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const evidences = []
  for (const name of names.filter((name) => name.endsWith(".json")).sort()) evidences.push(await sandboxSourceEvidence(JSON.parse(await readFile(`${directory}/${name}`, "utf8")), appRoot))
  const { mergeByPosition } = await import("../test/support/coverageUnion.ts")
  return mergeByPosition({}, evidences)
}
