import { execFileSync } from "node:child_process"
import type { Page, TestInfo } from "@playwright/test"
import { attachProductionJson } from "../repositories-github/production"
import { expect } from "../support/test"
import type { JournalRow } from "./semantic"

export const ENRICHED_COMMIT = "3b2b9f518c"
export type HostManifest = { sourceCommit: string; sha256: string; object: string }
export type ProducerFact =
  | { _tag: "HostPredatesCommit"; hostRevision: string; producingCommit: string; message: string; observed: number }
  | { _tag: "EnrichedPayloadsVerified"; hostRevision: string; producingCommit: string; observed: number }
  | { _tag: "EventNotRecorded"; hostRevision: string; producingCommit: string; message: string; observed: 0 }

/** Ask the live API image for its pin, not the developer checkout's manifest. */
export const captureRevisions = async (page: Page, testInfo: TestInfo): Promise<HostManifest> => {
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
  await attachProductionJson(testInfo, "timeline-revisions", { frontend, host: manifest, capturedAt: new Date().toISOString() })
  return manifest
}

export const hostContains = (revision: string, producingCommit: string): boolean => {
  // Revsets use only validated hexadecimal revisions, with no shell interpolation.
  if (!/^[0-9a-f]{10,40}$/.test(revision) || !/^[0-9a-f]{10,40}$/.test(producingCommit)) throw new Error("Invalid evidence revision")
  return execFileSync("jj", ["log", "--ignore-working-copy", "-r", `${producingCommit} & ancestors(${revision})`, "--no-graph", "-T", "commit_id"],
    { encoding: "utf8", timeout: 30000 }).trim() !== ""
}

export const enrichedEvidence = async (testInfo: TestInfo, host: HostManifest, rows: readonly JournalRow[]): Promise<void> => {
  const observed = rows.filter(({ kind: journalKind }) => journalKind === "control.agent.steering-drained" || journalKind === "control.agent.sufficiency-observed")
  const fact: ProducerFact = !hostContains(host.sourceCommit, ENRICHED_COMMIT)
    ? { _tag: "HostPredatesCommit", hostRevision: host.sourceCommit, producingCommit: ENRICHED_COMMIT,
      message: `host predates ${ENRICHED_COMMIT}; enriched steering and sufficiency payloads are not release evidence`, observed: observed.length }
    : observed.length === 0
    ? { _tag: "EventNotRecorded", hostRevision: host.sourceCommit, producingCommit: ENRICHED_COMMIT, message: "No steering drain or sufficiency event was recorded", observed: 0 }
    : { _tag: "EnrichedPayloadsVerified", hostRevision: host.sourceCommit, producingCommit: ENRICHED_COMMIT, observed: observed.length }
  await attachProductionJson(testInfo, "timeline-producer-capability", { fact, events: observed })
  if (fact._tag !== "EnrichedPayloadsVerified") testInfo.annotations.push({ type: fact._tag, description: fact.message })
  if (fact._tag === "HostPredatesCommit") return
  for (const row of observed) {
    const p = row.payload as Record<string, unknown>
    const { kind: journalKind } = row
    if (journalKind === "control.agent.steering-drained") expect(Array.isArray(p.messages), `enriched steering at #${row.sequence}`).toBe(true)
    else { expect(p.failed, `failed check at #${row.sequence}`).toBeDefined(); expect(p.passed, `passed check at #${row.sequence}`).toBeDefined() }
  }
}
