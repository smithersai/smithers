import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Page, TestInfo } from "@playwright/test"
import { attachProductionJson } from "../repositories-github/production"
import { expect } from "../support/test"
import type { JournalRow } from "./semantic"
import { moduleRows } from "./module-evidence"

export const ENRICHED_COMMIT = "3b2b9f518c"
export const MODULE_COMMIT = "0c31eb19cecf"
export type HostManifest = { sourceCommit: string; sha256: string; object: string; frontendRevision: string }

/** The card sources whose deployed bytes decide the run header this tier reads. */
export const HEADER_SOURCES = ["apps/app/src/mainview/cards/RunTraceStatus.ts"] as const
/** Playwright transpiles this tier without import.meta, so the root is the first ancestor that owns the app. */
export const repositoryRoot = (): string => {
  for (let directory = process.cwd(), previous = ""; directory !== previous; previous = directory, directory = resolve(directory, "..")) {
    if (existsSync(resolve(directory, HEADER_SOURCES[0]))) return directory
  }
  throw new Error(`No repository root above ${process.cwd()} owns ${HEADER_SOURCES[0]}`)
}

export type DeployedSourceFact =
  | { _tag: "DeployedSourceMatchesWorkingCopy"; frontendRevision: string; files: readonly string[] }
  | { _tag: "DeployedSourcePredatesWorkingCopy"; frontendRevision: string; message: string; files: readonly string[] }

/**
 * Compares the deployed bundle's sources with this working copy's, by exact
 * bytes at the deployed revision. A commit id would stop naming this lane's
 * own fix the moment it is rebased; the file contents keep saying what the
 * browser under test is actually running.
 */
export const deployedHeaderSource = (frontendRevision: string): DeployedSourceFact => {
  if (!/^[0-9a-f]{40}$/.test(frontendRevision)) throw new Error("Invalid deployed frontend revision")
  const root = repositoryRoot()
  const differing = HEADER_SOURCES.filter(path => {
    const deployed = execFileSync("jj", ["file", "show", "--ignore-working-copy", "-r", frontendRevision, path],
      { encoding: "utf8", cwd: root, timeout: 30000 })
    return deployed !== readFileSync(resolve(root, path), "utf8")
  })
  return differing.length === 0
    ? { _tag: "DeployedSourceMatchesWorkingCopy", frontendRevision, files: HEADER_SOURCES }
    : { _tag: "DeployedSourcePredatesWorkingCopy", frontendRevision, files: differing,
      message: `the deployed frontend ${frontendRevision} does not carry this working copy's ${differing.join(", ")}` }
}
export type ProducerFact =
  | { _tag: "HostPredatesCommit"; hostRevision: string; producingCommit: string; message: string; observed: number }
  | { _tag: "EnrichedPayloadsVerified"; hostRevision: string; producingCommit: string; observed: number }
  | { _tag: "EventNotRecorded"; hostRevision: string; producingCommit: string; message: string; observed: 0 }
  | { _tag: "EnrichedPayloadMissing"; hostRevision: string; producingCommit: string; message: string; observed: number; sequences: number[] }

/** Ask the live API image for its pin, not the developer checkout's manifest. */
export const captureRevisions = async (page: Page, testInfo: TestInfo, attachment = "timeline-revisions"): Promise<HostManifest> => {
  const response = await page.request.get(new URL("/__build.json", page.url()).toString())
  expect(response.status()).toBe(200)
  const frontend = await response.json() as { gitSha?: unknown; builtAt?: unknown }
  expect(frontend.gitSha).toMatch(/^[0-9a-f]{40}$/)
  const manifest = JSON.parse(execFileSync("kubectl", [
    "--context", "gke_plue-prod-1771780303_us-central1_plue-cluster", "exec", "-n", "smithers", "deploy/smithers-api", "-c", "api", "--",
    "cat", "/usr/local/lib/smithers/coding-host.json"
  ], { encoding: "utf8", timeout: 30000 })) as HostManifest
  expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
  expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
  await attachProductionJson(testInfo, attachment, { frontend, host: manifest, capturedAt: new Date().toISOString() })
  return { ...manifest, frontendRevision: frontend.gitSha as string }
}

export const hostContains = (revision: string, producingCommit: string): boolean => {
  // Revsets use only validated hexadecimal revisions, with no shell interpolation.
  if (!/^[0-9a-f]{10,40}$/.test(revision) || !/^[0-9a-f]{10,40}$/.test(producingCommit)) throw new Error("Invalid evidence revision")
  return execFileSync("jj", ["log", "--ignore-working-copy", "-r", `${producingCommit} & ancestors(${revision})`, "--no-graph", "-T", "commit_id"],
    { encoding: "utf8", timeout: 30000 }).trim() !== ""
}

export const enrichedEvidence = async (testInfo: TestInfo, host: HostManifest, rows: readonly JournalRow[]): Promise<void> => {
  const observed = moduleRows(rows).filter(({ kind: journalKind }) => journalKind === "control.agent.steering-drained" || journalKind === "control.agent.sufficiency-observed")
  const missing = observed.filter(({ kind: journalKind, payload }) => {
    const p = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {}
    return journalKind === "control.agent.steering-drained" ? !Array.isArray(p.messages) : p.failed === undefined || p.passed === undefined
  }).map(row => Number(row.sequence))
  const fact: ProducerFact = !hostContains(host.sourceCommit, ENRICHED_COMMIT)
    ? { _tag: "HostPredatesCommit", hostRevision: host.sourceCommit, producingCommit: ENRICHED_COMMIT,
      message: `host predates ${ENRICHED_COMMIT}; enriched steering and sufficiency payloads are not release evidence`, observed: observed.length }
    : observed.length === 0
    ? { _tag: "EventNotRecorded", hostRevision: host.sourceCommit, producingCommit: ENRICHED_COMMIT, message: "No steering drain or sufficiency event was recorded", observed: 0 }
    : missing.length > 0
    ? { _tag: "EnrichedPayloadMissing", hostRevision: host.sourceCommit, producingCommit: ENRICHED_COMMIT,
      message: "The producing revision is present, but required payload fields are missing", observed: observed.length, sequences: missing }
    : { _tag: "EnrichedPayloadsVerified", hostRevision: host.sourceCommit, producingCommit: ENRICHED_COMMIT, observed: observed.length }
  await attachProductionJson(testInfo, "timeline-producer-capability", { fact, events: observed, inventory: demandInventory(rows) })
  if (fact._tag !== "EnrichedPayloadsVerified") testInfo.annotations.push({ type: fact._tag, description: fact.message })
  if (fact._tag === "HostPredatesCommit") return
  expect(missing, "required enriched payload fields").toEqual([])
}

/**
 * Names every host payload this tier would read, and says which the run exercised.
 * An event nobody recorded is reported as unexercised, never as a silent pass.
 */
export const demandInventory = (rows: readonly JournalRow[]): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  // The journal's event names, as the harness writes them; a Map, because the
  // event name is host data and an object lookup resolves "constructor".
  const named = new Map(Object.entries({
    "control.agent.cell-call-settled": "call-rejection",
    "control.agent.read-only-demanded": "read-only-demand",
    "control.agent.read-only-demand-issued": "read-only-demand",
    "control.agent.narrow-only-demanded": "narrow-only-demand",
    "control.agent.narrowed-demanded": "narrowed-demand",
    "control.agent.steering-drained": "steering-delivery",
    "control.agent.sufficiency-observed": "sufficiency-observed",
    "control.agent.permission-required": "permission-required"
  }))
  const observed = new Map([...named.values()].map(name => [name, 0]))
  for (const row of moduleRows(rows)) {
    const name = named.get(String(row.kind))
    if (name === undefined) continue
    // A rejection is a settlement whose recorded outcome failed, not every settlement.
    if (name === "call-rejection" && (row.payload as Record<string, unknown> | undefined)?.outcome !== "failure") continue
    observed.set(name, observed.get(name)! + 1)
  }
  return [...observed].map(([name, count]) => ({ name, observed: count, _tag: count > 0 ? "Exercised" : "Unexercised" }))
}

export const moduleEvidence = async (testInfo: TestInfo, host: HostManifest, rows: readonly JournalRow[]): Promise<void> => {
  const events = rows.filter(row => (row.payload as Record<string, unknown> | undefined)?.eventType === "flows.harness.step-fact.v1")
  const fact = !hostContains(host.sourceCommit, MODULE_COMMIT)
    ? { _tag: "HostPredatesCommit", hostRevision: host.sourceCommit, producingCommit: MODULE_COMMIT, observed: events.length,
      message: `host predates ${MODULE_COMMIT}; module step frames are not release evidence` }
    : { _tag: events.length > 0 ? "ModuleStepTrailRecorded" : "ModuleStepTrailMissing", hostRevision: host.sourceCommit,
      producingCommit: MODULE_COMMIT, observed: events.length, message: events.length > 0 ? "Recorded module checkpoints" : "The module agent recorded no checkpoints" }
  await attachProductionJson(testInfo, "timeline-module-capability", { fact, events })
  testInfo.annotations.push({ type: fact._tag, description: fact.message })
  if (fact._tag !== "HostPredatesCommit") expect(events.length, fact.message).toBeGreaterThan(0)
}
