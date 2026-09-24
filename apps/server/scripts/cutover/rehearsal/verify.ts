/**
 * Judges one phase of the isolated binding round-trip rehearsal (see REHEARSAL.md).
 *   bun scripts/cutover/rehearsal/verify.ts PROBE_ORIGIN baseline|admission|fenced|restored OUT_DIR
 * GET-only against the scratch probe. Exit 2 prints {"refused":CODE}.
 */
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export type RehearsalPhase = "baseline" | "admission" | "fenced" | "restored"
export interface SelfTest { d1: string | null; r2: string | null; kv: string | null; queue: string; ratelimit: string; assets: string; plainText: string; secretSHA256: string }
const EXPECTED = { d1: "d1-ok", r2: "r2-ok", kv: "kv-ok", queue: "sent", ratelimit: "boolean", assets: "assets-ok", plainText: "rehearsal" }
/** Pure: the same facts must come back through the re-sent bindings, and the fence must refuse. */
export const judgeRehearsal = (phase: RehearsalPhase, status: number, body: string, baseline: SelfTest | null): SelfTest | null => {
  if (phase === "fenced") {
    let code: unknown
    try { code = (JSON.parse(body) as { code?: unknown }).code } catch { code = undefined }
    if (status !== 503 || code !== "cutover_maintenance") throw new Error("REHEARSAL_FENCE_NOT_REFUSING")
    return null
  }
  if (status !== 200) throw new Error(`REHEARSAL_SELFTEST_FAILED_${status}`)
  const facts = JSON.parse(body) as SelfTest
  for (const [key, value] of Object.entries(EXPECTED)) if (facts[key as keyof SelfTest] !== value) throw new Error(`REHEARSAL_BINDING_${key.toUpperCase()}_BROKEN`)
  if (!/^[a-f0-9]{64}$/.test(facts.secretSHA256) || facts.secretSHA256 === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") throw new Error("REHEARSAL_SECRET_MISSING")
  if (phase === "baseline") return facts
  if (!baseline) throw new Error("REHEARSAL_BASELINE_MISSING")
  // Secret value identity through keep_bindings, observed only as a scratch-secret digest.
  if (facts.secretSHA256 !== baseline.secretSHA256) throw new Error("REHEARSAL_SECRET_CHANGED")
  return facts
}

export const readRehearsalBaseline = (path: string): SelfTest => {
  const receipt = JSON.parse(readFileSync(path, "utf8")) as { status?: number; facts?: unknown }
  return judgeRehearsal("baseline", receipt.status ?? 0, JSON.stringify(receipt.facts), null)!
}

if (import.meta.main) {
  const [origin, phase, out] = process.argv.slice(2)
  try {
    if (!origin || !/^https:\/\/smithers-cutover-rehearsal-p1\.[a-z0-9-]+\.workers\.dev$/.test(origin) || !["baseline", "admission", "fenced", "restored"].includes(phase ?? "") || !out) throw new Error("REHEARSAL_USAGE")
    const dir = resolve(out), st = lstatSync(dir)
    if (!st.isDirectory() || (st.mode & 0o077) !== 0) throw new Error("REHEARSAL_DIRECTORY_NOT_PRIVATE")
    const baselinePath = resolve(dir, "baseline.json")
    const baseline = phase !== "baseline" && existsSync(baselinePath) ? readRehearsalBaseline(baselinePath) : null
    const response = await fetch(`${origin}/selftest`, { redirect: "error", signal: AbortSignal.timeout(30_000) })
    const body = await response.text()
    const facts = judgeRehearsal(phase as RehearsalPhase, response.status, body, baseline)
    writeFileSync(resolve(dir, `${phase}.json`), JSON.stringify({ at: new Date().toISOString(), status: response.status, facts }), { mode: 0o600, flag: "wx" })
    console.log(JSON.stringify({ phase, passed: true }))
  } catch (error) {
    console.log(JSON.stringify({ refused: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "REHEARSAL_UNCLASSIFIED_FAILURE" }))
    process.exit(2)
  }
}
