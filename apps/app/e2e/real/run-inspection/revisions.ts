import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Page, TestInfo } from "@playwright/test"
import { attachProductionJson } from "../repositories-github/production"
import { BOOT_KINDS, expect, reloadBootTimings, type BootKind, type ReloadBootTiming } from "../support/test"
import type { JournalRow } from "./semantic"
import { moduleRows } from "./module-evidence"

export const ENRICHED_COMMIT = "3b2b9f518c"
export const MODULE_COMMIT = "0c31eb19cecf"
/** The kube context of the deployment under test; only an operator with cluster access sets it. */
export const HOST_PIN_CONTEXT_ENV = "SMITHERS_REAL_HOST_PIN_CONTEXT"
export type HostPin =
  | { _tag: "HostPinRead"; sourceCommit: string; sha256: string; object: string }
  | { _tag: "HostPinUnread"; message: string }
export type HostRevisions = { frontendRevision: string; pin: HostPin }
export type HostProducer = "HostContainsCommit" | "HostPredatesCommit" | "HostPinUnread"

/** The card sources whose deployed bytes decide the run header this tier reads. */
export const HEADER_SOURCES = ["apps/app/src/mainview/cards/RunTraceStatus.ts"] as const
/** The source whose deployed bytes decide where a pointer release commits. */
export const STRIP_SOURCES = ["apps/app/src/mainview/cards/RunTracePhaseStrip.tsx"] as const
/** The source whose deployed bytes decide whether a reader gesture is durable before it answers. */
export const GESTURE_SOURCES = ["apps/app/src/mainview/state/controller/runs.ts"] as const
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

/** One VCS command and how its output answers the question. */
type VersionedRead<T> = readonly [argv: readonly string[], answer: (stdout: string) => T]

/**
 * Answers from jj, or from git on a clone without a jj checkout. Only a
 * revision neither can read fails, naming both refusals.
 */
const versioned = <T>(root: string, jj: VersionedRead<T>, git: VersionedRead<T>): T => {
  const refusals: string[] = []
  for (const [[command, ...args], answer] of [jj, git]) {
    try {
      return answer(execFileSync(command!, args, { encoding: "utf8", cwd: root, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }))
    } catch (error) { refusals.push(`${command}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  throw new Error(`Neither jj nor git in ${root} could answer: ${refusals.join("; ")}`)
}

/**
 * Compares the deployed bundle's sources with this working copy's, by exact
 * bytes at the deployed revision. A commit id would stop naming this lane's
 * own fix the moment it is rebased; the file contents keep saying what the
 * browser under test is actually running.
 */
export const deployedSource = (frontendRevision: string, sources: readonly string[], root = repositoryRoot()): DeployedSourceFact => {
  if (!/^[0-9a-f]{40}$/.test(frontendRevision)) throw new Error("Invalid deployed frontend revision")
  const differing = sources.filter(path => {
    const bytes = (stdout: string) => stdout
    const deployed = versioned(root,
      [["jj", "file", "show", "--ignore-working-copy", "-r", frontendRevision, path], bytes],
      [["git", "show", `${frontendRevision}:${path}`], bytes])
    return deployed !== readFileSync(resolve(root, path), "utf8")
  })
  return differing.length === 0
    ? { _tag: "DeployedSourceMatchesWorkingCopy", frontendRevision, files: sources }
    : { _tag: "DeployedSourcePredatesWorkingCopy", frontendRevision, files: differing,
      message: `the deployed frontend ${frontendRevision} does not carry this working copy's ${differing.join(", ")}` }
}

export const deployedHeaderSource = (frontendRevision: string): DeployedSourceFact =>
  deployedSource(frontendRevision, HEADER_SOURCES)
export type ProducerFact =
  | { _tag: "HostPinUnread"; producingCommit: string; message: string; observed: number }
  | { _tag: "HostPredatesCommit"; hostRevision: string; producingCommit: string; message: string; observed: number }
  | { _tag: "EnrichedPayloadsVerified"; hostRevision: string; producingCommit: string; observed: number }
  | { _tag: "EventNotRecorded"; hostRevision: string; producingCommit: string; message: string; observed: 0 }
  | { _tag: "EnrichedPayloadMissing"; hostRevision: string; producingCommit: string; message: string; observed: number; sequences: number[] }

/**
 * The API image's coding host pin, read from the cluster an operator names.
 * Nothing in the product surface serves the pin, so without that context the
 * pin is unread: the tier says so instead of guessing a cluster or failing a
 * contributor's run for want of cluster credentials.
 */
export const readHostPin = (context: string | undefined): HostPin => {
  if (context === undefined || context === "") return { _tag: "HostPinUnread",
    message: `${HOST_PIN_CONTEXT_ENV} is unset, so the coding host pin and every claim that depends on it are unexercised` }
  const manifest = JSON.parse(execFileSync("kubectl", [
    "--context", context, "exec", "-n", "smithers", "deploy/smithers-api", "-c", "api", "--",
    "cat", "/usr/local/lib/smithers/coding-host.json"
  ], { encoding: "utf8", timeout: 30000 })) as { sourceCommit: string; sha256: string; object: string }
  return { _tag: "HostPinRead", sourceCommit: manifest.sourceCommit, sha256: manifest.sha256, object: manifest.object }
}

/** The served frontend revision, and the API image's host pin when an operator can read it. */
export const captureRevisions = async (page: Page, testInfo: TestInfo, attachment = "timeline-revisions"): Promise<HostRevisions> => {
  const response = await page.request.get(new URL("/__build.json", page.url()).toString())
  expect(response.status()).toBe(200)
  const frontend = await response.json() as { gitSha?: unknown; builtAt?: unknown }
  expect(frontend.gitSha).toMatch(/^[0-9a-f]{40}$/)
  const pin = readHostPin(process.env[HOST_PIN_CONTEXT_ENV])
  if (pin._tag === "HostPinRead") {
    expect(pin.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
  } else if (!testInfo.annotations.some(({ type }) => type === pin._tag)) {
    testInfo.annotations.push({ type: pin._tag, description: pin.message })
  }
  await attachProductionJson(testInfo, attachment, { frontend, host: pin, capturedAt: new Date().toISOString() })
  return { frontendRevision: frontend.gitSha as string, pin }
}

const hostContains = (revision: string, producingCommit: string, root: string): boolean => {
  // Revsets use only validated hexadecimal revisions, with no shell interpolation.
  if (!/^[0-9a-f]{10,40}$/.test(revision) || !/^[0-9a-f]{10,40}$/.test(producingCommit)) throw new Error("Invalid evidence revision")
  // jj prints the producer when it is an ancestor; git prints it only when it is not.
  return versioned(root,
    [["jj", "log", "--ignore-working-copy", "-r", `${producingCommit} & ancestors(${revision})`, "--no-graph", "-T", "commit_id"],
      stdout => stdout.trim() !== ""],
    [["git", "rev-list", "--max-count=1", `${producingCommit}^{commit}`, "--not", `${revision}^{commit}`],
      stdout => stdout.trim() === ""])
}

/** Whether the pinned host carries the commit that produces a payload, or the pin is unread. */
export const hostProducer = (pin: HostPin, producingCommit: string, root = repositoryRoot()): HostProducer =>
  pin._tag === "HostPinUnread" ? "HostPinUnread"
    : hostContains(pin.sourceCommit, producingCommit, root) ? "HostContainsCommit" : "HostPredatesCommit"

/** A live boundary this tier compared the card at, and the run status it was compared under. */
export type LiveBoundary = { readonly status: string; readonly seq: number }
export type LiveInspectionFact =
  | { _tag: "LiveInspectionObserved"; samples: number; firstSampleStatus: string; sampledAtSeq: number }
  | {
    _tag: "LiveInspectionUnexercised"
    reason: "run-terminal-before-first-sample" | "run-terminal-before-second-sample"
    samples: number; firstSampleStatus: string; sampledAtSeq: number; message: string
  }

/**
 * Whether this run exercised the live claim, or only ended before it could.
 *
 * The claim `inspectRunning` makes is that the card follows a GROWING journal
 * while the run is still running, so it takes two live boundaries to make.
 * A subject that finishes first proves nothing about a live card, and a pass
 * that depended on the subject staying slow would be luck rather than
 * coverage, so the shortfall is named here instead of being counted.
 */
export const liveInspectionFact = (
  observed: readonly LiveBoundary[], stopped?: LiveBoundary
): LiveInspectionFact => {
  const first = observed[0] ?? stopped
  const firstSampleStatus = first?.status ?? "unobserved"
  const sampledAtSeq = first?.seq ?? -1
  if (observed.length >= 2) return { _tag: "LiveInspectionObserved", samples: observed.length, firstSampleStatus, sampledAtSeq }
  return {
    _tag: "LiveInspectionUnexercised",
    reason: observed.length === 0 ? "run-terminal-before-first-sample" : "run-terminal-before-second-sample",
    samples: observed.length, firstSampleStatus, sampledAtSeq,
    message: `the run read ${stopped?.status ?? "no further boundary"} at #${stopped?.seq ?? sampledAtSeq} after ${observed.length} live ${
      observed.length === 1 ? "boundary" : "boundaries"}; the live comparison is not this run's evidence`
  }
}

export type ReloadBootFact =
  | {
    _tag: "ReloadBootMeasured"; samples: ReadonlyArray<ReloadBootTiming>
    minMs: number; medianMs: number; maxMs: number; counts: Readonly<Record<BootKind, number>>
  }
  | { _tag: "ReloadBootUnmeasured"; samples: ReadonlyArray<ReloadBootTiming>; counts: Readonly<Record<BootKind, number>> }

/**
 * Summarise the boots `awaitBoot` measured.
 *
 * Every boot wait is held to one budget, so one distribution is what that
 * budget is chosen from; `counts` says how many of each kind went into it, and
 * each sample carries its own kind for a reader who wants them apart. A run
 * that booted nothing is reported as unmeasured: `Math.min` of no samples is
 * `Infinity`, which JSON writes as `null`, and a null minimum reads like a
 * measured zero. A count of zero is a real count, so it stays a number.
 */
export const reloadBootFact = (samples: ReadonlyArray<ReloadBootTiming>): ReloadBootFact => {
  const counts = Object.fromEntries(BOOT_KINDS.map((kind) =>
    [kind, samples.filter((sample) => sample.kind === kind).length])) as Record<BootKind, number>
  if (samples.length === 0) return { _tag: "ReloadBootUnmeasured", samples, counts }
  const sorted = samples.map(({ ms }) => ms).sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return {
    _tag: "ReloadBootMeasured", samples, counts, minMs: sorted[0]!, maxMs: sorted[sorted.length - 1]!,
    medianMs: sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
  }
}

/** Archive this worker's measured boots, so the boot budget is evidence rather than a number someone picked. */
export const reloadBootEvidence = async (testInfo: TestInfo): Promise<void> => {
  await attachProductionJson(testInfo, "timeline-reload-boot-ms", reloadBootFact(reloadBootTimings()))
}

export const enrichedEvidence = async (testInfo: TestInfo, pin: HostPin, rows: readonly JournalRow[]): Promise<void> => {
  const observed = moduleRows(rows).filter(({ kind: journalKind }) => journalKind === "control.agent.steering-drained" || journalKind === "control.agent.sufficiency-observed")
  const missing = observed.filter(({ kind: journalKind, payload }) => {
    const p = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {}
    return journalKind === "control.agent.steering-drained" ? !Array.isArray(p.messages) : p.failed === undefined || p.passed === undefined
  }).map(row => Number(row.sequence))
  const producer = hostProducer(pin, ENRICHED_COMMIT)
  const fact: ProducerFact = pin._tag === "HostPinUnread"
    ? { _tag: "HostPinUnread", producingCommit: ENRICHED_COMMIT, message: pin.message, observed: observed.length }
    : producer === "HostPredatesCommit"
    ? { _tag: "HostPredatesCommit", hostRevision: pin.sourceCommit, producingCommit: ENRICHED_COMMIT,
      message: `host predates ${ENRICHED_COMMIT}; enriched steering and sufficiency payloads are not release evidence`, observed: observed.length }
    : observed.length === 0
    ? { _tag: "EventNotRecorded", hostRevision: pin.sourceCommit, producingCommit: ENRICHED_COMMIT, message: "No steering drain or sufficiency event was recorded", observed: 0 }
    : missing.length > 0
    ? { _tag: "EnrichedPayloadMissing", hostRevision: pin.sourceCommit, producingCommit: ENRICHED_COMMIT,
      message: "The producing revision is present, but required payload fields are missing", observed: observed.length, sequences: missing }
    : { _tag: "EnrichedPayloadsVerified", hostRevision: pin.sourceCommit, producingCommit: ENRICHED_COMMIT, observed: observed.length }
  await attachProductionJson(testInfo, "timeline-producer-capability", { fact, events: observed, inventory: demandInventory(rows) })
  if (fact._tag !== "EnrichedPayloadsVerified") testInfo.annotations.push({ type: fact._tag, description: fact.message })
  if (fact._tag === "HostPinUnread" || fact._tag === "HostPredatesCommit") return
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

export const moduleEvidence = async (testInfo: TestInfo, pin: HostPin, rows: readonly JournalRow[]): Promise<void> => {
  const events = rows.filter(row => (row.payload as Record<string, unknown> | undefined)?.eventType === "flows.harness.step-fact.v1")
  const producer = hostProducer(pin, MODULE_COMMIT)
  const fact = pin._tag === "HostPinUnread"
    ? { _tag: "HostPinUnread", producingCommit: MODULE_COMMIT, observed: events.length, message: pin.message }
    : producer === "HostPredatesCommit"
    ? { _tag: "HostPredatesCommit", hostRevision: pin.sourceCommit, producingCommit: MODULE_COMMIT, observed: events.length,
      message: `host predates ${MODULE_COMMIT}; module step frames are not release evidence` }
    : { _tag: events.length > 0 ? "ModuleStepTrailRecorded" : "ModuleStepTrailMissing", hostRevision: pin.sourceCommit,
      producingCommit: MODULE_COMMIT, observed: events.length, message: events.length > 0 ? "Recorded module checkpoints" : "The module agent recorded no checkpoints" }
  await attachProductionJson(testInfo, "timeline-module-capability", { fact, events })
  testInfo.annotations.push({ type: fact._tag, description: fact.message })
  if (producer === "HostContainsCommit") expect(events.length, fact.message).toBeGreaterThan(0)
}
