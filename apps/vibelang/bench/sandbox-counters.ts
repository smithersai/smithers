// Stays .ts: the instrumenter's global counter bridge, shared by its Node collector and Worker RPC bindings.
// Counters contain source positions and counts only; this reads no application state or environment.
import type { FileCoverageJSON } from "../test/support/coverageUnion.ts"

export interface SandboxCounters {
  readonly buildId: string | null
  readonly coverage: Record<string, FileCoverageJSON>
}

/** @throws {never} */
export function sandboxCounters(): SandboxCounters {
  const scope = globalThis as typeof globalThis & { __coverage__?: SandboxCounters["coverage"]; __sandboxBenchBuild?: string }
  // An ordinary production build has no instrumenter and exports no counters.
  return { buildId: scope.__sandboxBenchBuild ?? null, coverage: scope.__coverage__ ?? {} }
}
