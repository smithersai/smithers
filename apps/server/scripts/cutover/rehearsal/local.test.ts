import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { FenceIdentity } from "../../../src/MaintenanceFence"
import { admissionModule, fenceModule } from "../fence-module"
import { judgeRehearsal, type RehearsalPhase } from "./verify"

const bundle = async (source: string) => {
  const built = await Bun.build({ entrypoints: [new URL(`../../../src/${source}`, import.meta.url).pathname], target: "browser", format: "esm", minify: true })
  expect(built.success).toBe(true)
  return built.outputs[0]!.text()
}
test("local workerd dress rehearsal: scratch bindings answer under admission, the fence refuses, restore answers again", async () => {
  const identity: FenceIdentity = { executionID: randomUUID(), smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech", worker: "smithers-cutover-rehearsal-r1", sourceVersion: randomUUID(), sourceArtifactSHA256: "c".repeat(64) }
  const objects = [{ binding: "TURN_CANCELS", className: "TurnCancelRegistry" }]
  const child = Bun.spawn(["node", new URL("./local-workerd.mjs", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe",
    stdin: new Blob([JSON.stringify({ admission: admissionModule(identity, "index.js", objects), fence: fenceModule(identity, objects), admissionHelper: await bundle("MaintenanceAdmission.ts"), fenceHelper: await bundle("MaintenanceFence.ts") })]) })
  const [code, out, log] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) console.error(log)
  expect(code).toBe(0)
  const results = JSON.parse(out) as Record<RehearsalPhase, { status: number; body: string }>
  const baseline = judgeRehearsal("baseline", results.baseline.status, results.baseline.body, null)
  for (const phase of ["admission", "fenced", "restored"] as const) judgeRehearsal(phase, results[phase].status, results[phase].body, baseline)
}, 120_000)
