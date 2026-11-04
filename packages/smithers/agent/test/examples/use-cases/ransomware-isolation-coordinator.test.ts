import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import {
  approvalTask,
  layer,
  RansomwareIsolationCoordinator
} from "../../../examples/use-cases/ransomware-isolation-coordinator.vibe"

const directory = mkdtempSync(join(tmpdir(), "ransomware-isolation-coordinator-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, name: string): string => new RegExp(`\\n${name}: (.+)`).exec(asked)?.[1] ?? ""

/**
 * A detector that recommends isolation when any evidence line mentions
 * encryption, a containment operator that reports what it was told, and a
 * reporter that writes the timeline from the incident it is handed. Each
 * request is recorded in order.
 */
const script = () => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a ransomware detection specialist")) {
      const host = /Check host (\S+) for ransomware activity\./.exec(asked)?.[1] ?? ""
      const evidence: ReadonlyArray<string> = JSON.parse(field(asked, "Evidence"))
      turns.push(`detect ${host}`)
      const encrypting = evidence.some((line) => line.includes("encrypt"))
      return {
        hostId: host,
        indicators: evidence,
        severity: encrypting ? "critical" : "low",
        isolateRecommended: encrypting
      }
    }
    if (asked.includes("You are a containment operator")) {
      const order = /Contain host (\S+) \(severity (\w+)\)\. Isolation was approved by (.+)\./.exec(asked)
      turns.push(`contain ${order?.[1]} for ${order?.[3]}`)
      return {
        hostId: order?.[1],
        networkIsolated: true,
        evidenceSnapshotUrl: `s3://forensics/${order?.[1]}.img`,
        notifiedChannels: ["#incident-response", "security-oncall"]
      }
    }
    if (asked.includes("You are an incident reporter")) {
      const host = /Report the ransomware incident on (\S+)\./.exec(asked)?.[1]
      const incident = JSON.parse(field(asked, "Incident"))
      turns.push(`report ${host}`)
      return {
        incidentId: `INC-${host}`,
        timeline: [
          `detected: ${incident.indicators.join("; ")}`,
          incident.contained ? `isolated; evidence at ${incident.evidenceUrl}` : "not isolated",
          `notified: ${incident.notifiedChannels.join(", ") || "nobody"}`
        ],
        containmentStatus: incident.contained ? "contained" : "monitoring",
        summary: `${incident.severity} severity`
      }
    }
    return undefined
  }
  return { answer, turns }
}

/**
 * The operator. It waits until the run parks on the first attempt of the
 * approval question, records the prompt it was shown, and answers with
 * `decision`.
 */
const operator = (
  executionId: string,
  decision: { readonly approved: boolean; readonly approvedBy: string; readonly note: string }
) => {
  const shown: Array<string> = []
  const token = DurableDeferred.tokenFromExecutionId(HumanTask.deferred(approvalTask, 1), {
    flow: RansomwareIsolationCoordinator,
    executionId
  })
  const answering = Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const row = yield* state.waiting(executionId).pipe(
      Effect.repeat({
        until: (waiting) => Option.isSome(waiting) && waiting.value.token === token,
        schedule: Schedule.spaced(10)
      })
    )
    const { prompt } = Option.getOrThrow(row).request as { readonly prompt: string }
    shown.push(prompt)
    yield* HumanTask.answer({ token, value: decision })
  })
  return { shown, layer: Layer.effectDiscard(Effect.forkScoped(Effect.orDie(answering))) }
}

it.live("isolates a host only after the operator approves, then reports the containment", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const person = operator("ransomware-approved", { approved: true, approvedBy: "dana", note: "go" })
    const report = yield* Kit.run(
      RansomwareIsolationCoordinator,
      { host: "fs-02", evidence: ["mass rename to *.locked", "vssadmin delete shadows", "encrypt loop in svc.exe"] },
      {
        filename: join(directory, "approved.sqlite"),
        executionId: "ransomware-approved",
        script: answer,
        actions: Layer.mergeAll(layer, person.layer)
      }
    )

    // The operator saw 0.x's request title and summary, built from the detection.
    expect(person.shown).toEqual([
      "Isolate host fs-02\n\nSeverity: critical. Indicators: mass rename to *.locked, vssadmin delete shadows, encrypt loop in svc.exe"
    ])
    // Containment ran after the approval and was told who approved it.
    expect(turns).toEqual(["detect fs-02", "contain fs-02 for dana", "report fs-02"])
    expect(report).toEqual({
      incidentId: "INC-fs-02",
      timeline: [
        "detected: mass rename to *.locked; vssadmin delete shadows; encrypt loop in svc.exe",
        "isolated; evidence at s3://forensics/fs-02.img",
        "notified: #incident-response, security-oncall"
      ],
      containmentStatus: "contained",
      summary: "critical severity"
    })
  }), { timeout: 60_000 })

it.live("reports without asking anyone when isolation is not recommended", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const person = operator("ransomware-clean", { approved: true, approvedBy: "dana", note: "unused" })
    const report = yield* Kit.run(RansomwareIsolationCoordinator, { evidence: ["one failed login"] }, {
      filename: join(directory, "clean.sqlite"),
      executionId: "ransomware-clean",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    })

    // With no host given, the detector is told "unknown".
    expect(turns).toEqual(["detect unknown", "report unknown"])
    expect(person.shown).toEqual([])
    expect(report.containmentStatus).toBe("monitoring")
    expect(report.timeline).toEqual(["detected: one failed login", "not isolated", "notified: nobody"])
  }), { timeout: 60_000 })

it.live("ends the run on a denial without containing or reporting", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const person = operator("ransomware-denied", {
      approved: false,
      approvedBy: "lee",
      note: "backup host, false positive"
    })
    const failure = yield* Effect.flip(
      Kit.run(RansomwareIsolationCoordinator, { host: "bk-01", evidence: ["encrypt pass over /backups"] }, {
        filename: join(directory, "denied.sqlite"),
        executionId: "ransomware-denied",
        script: answer,
        actions: Layer.mergeAll(layer, person.layer)
      })
    )

    expect(person.shown).toHaveLength(1)
    expect(turns).toEqual(["detect bk-01"])
    expect(failure).toEqual({
      _tag: "examples/RansomwareIsolationCoordinator/ContainmentDenied",
      hostId: "bk-01",
      deniedBy: "lee",
      note: "backup host, false positive"
    })
  }), { timeout: 60_000 })
