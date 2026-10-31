// Drives one gate on the proof stage (decision 0128 "Proof"; worker/test/gates/Harness.ts): plans the commit's
// .smithers/flows/gate/flow.ts with the realm `repo/Plan` uses, starts `ci/graph` through the harness door, polls the
// run, and writes what each job did and how long the whole took.
// usage: node --import vibelang/register worker/test/gates/drive.ts <url file> <token file> <sha> <flow.ts> <out.json>
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import { QuickJSVariant } from "@smthrs/harness"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import * as Realm from "../../ci/Realm.ts"

const [urlFile, tokenFile, sha, flowFile, out] = process.argv.slice(2) as [string, string, string, string, string]
const url = readFileSync(urlFile, "utf8").trim()
const token = readFileSync(tokenFile, "utf8").trim()
const run = `gate:${sha.slice(0, 12)}:${Date.now()}`
const target = { run, repo: "smithersai/smithers", sha, ref: "refs/heads/main" }
const planned = await Effect.runPromise(
  Realm.plan("gate", readFileSync(flowFile, "utf8"), { ...target, event: "push" }).pipe(
    Effect.provide(QuickJSVariant.layerVariant(wasmfile as unknown as QuickJSSyncVariant)),
  ),
)
if (planned._tag !== "planned") throw new Error(`gate not planned: ${JSON.stringify(planned)}`)
// For a commit older than this gate (the proof before it lands), each job's `install` step first unpacks GATE_FILES
// (paths relative to the repository root, comma-separated, as one gzipped tarball) into the checkout and applies
// GATE_OVERLAY (a patch). Both are labelled in the run's record; a proof of record gates a commit that holds them.
const repoRoot = new URL("../../../../../", import.meta.url).pathname
const files = (process.env.GATE_FILES ?? "").split(",").filter((path) => path !== "")
const overlay = process.env.GATE_OVERLAY
const prelude = [
  ...(files.length === 0 ? [] : [`echo ${execFileSync("tar", ["czf", "-", "-C", repoRoot, ...files]).toString("base64")} | base64 -d | tar xzf -`]),
  ...(overlay === undefined ? [] : [`echo ${gzipSync(readFileSync(overlay)).toString("base64")} | base64 -d | gunzip | git apply`]),
].join(" && ")
const jobs = prelude === "" ? planned.jobs : planned.jobs.map((job) => ({
  ...job,
  steps: job.steps.map((step) => step.name === "install" ? { ...step, run: `${prelude} && ${step.run}` } : step),
}))
const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${url}/gate-harness/${path}`, { ...init, headers: { "x-gate-harness": token, "content-type": "application/json" } })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.json() as Promise<any>
}
const started = Date.now()
await call("start", { method: "POST", body: JSON.stringify({ executionId: run, target, jobs }) })
console.log(`started ${run} with ${jobs.length} jobs`)
let read: any
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  read = await call(`run/${encodeURIComponent(run)}`).catch((error) => ({ error: String(error) }))
  const status = read.runs?.find((row: any) => row.run_id === run)?.status
  console.log(`${Math.round((Date.now() - started) / 1000)}s ${status ?? read.error ?? "no run yet"}`)
  if (status !== undefined && !["pending", "running", "waiting", "suspended"].includes(status)) break
  if (Date.now() - started > 40 * 60_000) break
}
const wallMs = Date.now() - started
// Each child job's result is the outcome of the graph's step that ran it: `{ outcome, steps }`.
const results = (read.attempts ?? []).flatMap((attempt: any) => {
  try {
    const outcome = JSON.parse(attempt.outcome_json ?? "null")
    const value = outcome?.value ?? outcome
    return value && typeof value === "object" && "outcome" in value && Array.isArray(value.steps)
      ? [{ ms: (attempt.finished_at_ms ?? 0) - attempt.started_at_ms, outcome: value.outcome, steps: value.steps }]
      : []
  } catch {
    return []
  }
})
writeFileSync(out, JSON.stringify({ run, sha, gateFiles: files, overlay: overlay ?? null, wallMs, status: read.runs?.find((row: any) => row.run_id === run)?.status, jobs: results, raw: read }, null, 1))
console.log(`settled ${read.runs?.find((row: any) => row.run_id === run)?.status} in ${Math.round(wallMs / 1000)}s; jobs ${results.length}; ${results.filter((job: any) => job.outcome === "passed").length} passed`)
