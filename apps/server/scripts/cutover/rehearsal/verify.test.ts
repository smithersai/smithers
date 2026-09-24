import { expect, test } from "bun:test"
import { judgeRehearsal, readRehearsalBaseline, type SelfTest } from "./verify"

const good: SelfTest = { d1: "d1-ok", r2: "r2-ok", kv: "kv-ok", queue: "sent", ratelimit: "boolean", assets: "assets-ok", plainText: "rehearsal", secretSHA256: "a".repeat(64) }
test("rehearsal judge: each binding type must answer through the re-sent bindings, the secret must survive, the fence must refuse", () => {
  const baseline = judgeRehearsal("baseline", 200, JSON.stringify(good), null)!
  expect(judgeRehearsal("admission", 200, JSON.stringify(good), baseline)).toEqual(good)
  for (const [key, code] of [["d1", "D1"], ["r2", "R2"], ["kv", "KV"], ["queue", "QUEUE"], ["ratelimit", "RATELIMIT"], ["assets", "ASSETS"], ["plainText", "PLAINTEXT"]] as const)
    expect(() => judgeRehearsal("admission", 200, JSON.stringify({ ...good, [key]: null }), baseline)).toThrow(`REHEARSAL_BINDING_${code}_BROKEN`)
  expect(() => judgeRehearsal("admission", 200, JSON.stringify({ ...good, secretSHA256: "b".repeat(64) }), baseline)).toThrow("REHEARSAL_SECRET_CHANGED")
  expect(() => judgeRehearsal("restored", 500, "", baseline)).toThrow("REHEARSAL_SELFTEST_FAILED_500")
  expect(judgeRehearsal("fenced", 503, JSON.stringify({ code: "cutover_maintenance" }), baseline)).toBeNull()
  expect(() => judgeRehearsal("fenced", 200, JSON.stringify(good), baseline)).toThrow("REHEARSAL_FENCE_NOT_REFUSING")
  expect(() => judgeRehearsal("admission", 200, JSON.stringify(good), null)).toThrow("REHEARSAL_BASELINE_MISSING")
})

// The CLI persists a receipt envelope, not raw SelfTest facts. Exercise the file
// seam too: pure judge calls cannot catch a writer/reader shape disagreement.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
test("the persisted baseline receipt drives admission and restore", () => {
  const directory = mkdtempSync(join(tmpdir(), "sf-binding-baseline-"))
  const path = join(directory, "baseline.json")
  try {
    writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), status: 200, facts: judgeRehearsal("baseline", 200, JSON.stringify(good), null) }))
    const baseline = readRehearsalBaseline(path)
    expect(judgeRehearsal("admission", 200, JSON.stringify(good), baseline)).toEqual(good)
    expect(judgeRehearsal("restored", 200, JSON.stringify(good), baseline)).toEqual(good)
    expect(() => judgeRehearsal("admission", 200, JSON.stringify({ ...good, secretSHA256: "b".repeat(64) }), baseline)).toThrow("REHEARSAL_SECRET_CHANGED")
    writeFileSync(path, JSON.stringify({ status: 503, facts: good }))
    expect(() => readRehearsalBaseline(path)).toThrow("REHEARSAL_SELFTEST_FAILED_503")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
