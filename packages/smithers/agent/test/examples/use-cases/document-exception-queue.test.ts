import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultFiles,
  DocumentExceptionQueue,
  layer,
  reviewTask
} from "../../../examples/use-cases/document-exception-queue.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "document-exception-queue-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The JSON a prompt rendered on its `INPUT:` line. */
const input = (asked: string): any => JSON.parse(/\nINPUT: (.+)/.exec(asked)![1]!)

const typeOf = (file: string) =>
  file.includes("invoice") ? "invoice" : file.includes("purchase") ? "purchase-order" : "receipt"

type Verdict = "pass" | "high" | "low"

/**
 * A classifier that types a file by its name, an extractor that records the
 * types it was told, a reconciler that answers the `verdicts` in order, a
 * re-extractor that corrects the first file an exception names, and an
 * exporter that passes the packet through when it reconciled or a reviewer
 * approved. Each request is recorded in order with the data it carried.
 */
const script = (verdicts: ReadonlyArray<Verdict>) => {
  const turns: Array<{ readonly step: string; readonly saw: unknown }> = []
  let round = 0
  const answer: Kit.Script = (asked) => {
    if (asked.includes("Classify the document type and confidence")) {
      const { file, packetContext } = input(asked)
      turns.push({ step: "classify", saw: { file, packetContext } })
      return { file, type: typeOf(file), confidence: 0.95, reason: "file name" }
    }
    if (asked.includes("Extract target fields and tables from the document")) {
      const { documentClasses, file, targetFields } = input(asked)
      turns.push({
        step: "extract",
        saw: { file, classes: documentClasses.map((c: { type: string }) => c.type), targetFields }
      })
      return { file, fields: { total: 100 }, tables: [], confidence: 0.8, missingFields: [] }
    }
    if (asked.includes("Reconcile extractions across the document packet")) {
      const { checks, extractions, vendorMaster } = input(asked)
      const verdict = verdicts[round++]!
      turns.push({
        step: "reconcile",
        saw: { extractions: extractions.map((e: { file: string }) => e.file), checks: checks.length, vendorMaster }
      })
      return {
        passed: verdict === "pass",
        checks: [{ name: "totals", passed: verdict === "pass", explanation: verdict }],
        exceptions: verdict === "pass"
          ? []
          : [{ severity: verdict, message: "total mismatch", files: [extractions[0].file] }]
      }
    }
    if (asked.includes("Retry only the fields or documents implicated")) {
      const { reconciliation } = input(asked)
      const file: string = reconciliation.exceptions[0].files[0]
      turns.push({ step: "reextract", saw: file })
      return { file: `${file}#retry`, fields: { total: 110 }, tables: [], confidence: 0.9, missingFields: [] }
    }
    if (asked.includes("Export normalized JSON and an exception queue")) {
      const { approval, extractions, outputDir, reconciliation } = input(asked)
      turns.push({ step: "export", saw: { extractions: extractions.length, approval } })
      return {
        normalizedJsonPath: `${outputDir}/normalized.json`,
        exceptionQueuePath: `${outputDir}/exceptions.json`,
        passThrough: reconciliation.passed || approval?.approved === true,
        summary: `${extractions.length} extractions`
      }
    }
    return undefined
  }
  return { answer, turns }
}

/**
 * The reviewer. It waits until the run parks on the review question, records
 * the prompt it was shown, and answers with `decision`.
 */
const reviewer = (
  executionId: string,
  decision: { readonly approved: boolean; readonly reviewer: string; readonly note: string }
) => {
  const shown: Array<string> = []
  const token = DurableDeferred.tokenFromExecutionId(HumanTask.deferred(reviewTask, 1), {
    flow: DocumentExceptionQueue,
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
    shown.push((Option.getOrThrow(row).request as { readonly prompt: string }).prompt)
    yield* HumanTask.answer({ token, value: decision })
  })
  return { shown, layer: Layer.effectDiscard(Effect.forkScoped(Effect.orDie(answering))) }
}

const files = ["packet/invoice.pdf", "packet/purchase-order.pdf"]

it.live("exports a packet that reconciles on the first round without asking anyone", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(["pass"])
    const person = reviewer("dxq-clean", { approved: true, reviewer: "ops", note: "unused" })
    const record = yield* Kit.run(DocumentExceptionQueue, { files, packetContext: "AP batch 7" }, {
      filename: join(directory, "clean.sqlite"),
      executionId: "dxq-clean",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    })

    // Every file is classified, then every file is extracted told both types.
    expect(turns.slice(0, 2).map((t) => t.saw)).toEqual(
      expect.arrayContaining(files.map((file) => ({ file, packetContext: "AP batch 7" })))
    )
    expect(turns.slice(2, 4).map((t) => t.saw)).toEqual(expect.arrayContaining(files.map((file) => ({
      file,
      classes: ["invoice", "purchase-order"],
      targetFields: ["vendor", "amount", "tax", "poNumber", "date", "lineItems"]
    }))))
    expect(turns.slice(4)).toEqual([
      {
        step: "reconcile",
        saw: { extractions: files, checks: 4, vendorMaster: "fixtures/document-exception-queue/vendor-master.json" }
      },
      { step: "export", saw: { extractions: 2, approval: null } }
    ])
    expect(person.shown).toEqual([])
    expect(record).toEqual({
      normalizedJsonPath: "artifacts/document-exception-queue/normalized.json",
      exceptionQueuePath: "artifacts/document-exception-queue/exceptions.json",
      passThrough: true,
      summary: "2 extractions"
    })
  }), { timeout: 60_000 })

it.live("processes every file of a packet whose names share a step id", () =>
  Effect.gen(function*() {
    // Two scans whose paths agree for 64 characters, and two names apart by case.
    const scans = "/srv/document-intake/customers/acme-corp/2026-11/packet-0042/scans"
    const alike = [
      `${scans}/invoice-page-1.pdf`,
      `${scans}/invoice-page-2.pdf`,
      "packet/Invoice.pdf",
      "packet/invoice.PDF"
    ]
    const { answer, turns } = script(["pass"])
    const record = yield* Kit.run(DocumentExceptionQueue, { files: alike }, {
      filename: join(directory, "alike.sqlite"),
      executionId: "dxq-alike",
      script: answer,
      actions: layer
    })

    expect(turns.filter((t) => t.step === "classify").map((t) => (t.saw as { file: string }).file).sort()).toEqual(
      [...alike].sort()
    )
    expect(turns.filter((t) => t.step === "extract")).toHaveLength(4)
    expect(turns.find((t) => t.step === "reconcile")?.saw).toEqual(expect.objectContaining({ extractions: alike }))
    expect(record.summary).toBe("4 extractions")
  }), { timeout: 60_000 })

it.live("re-extracts once, then exports without review when the second round passes", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(["low", "pass"])
    const record = yield* Kit.run(DocumentExceptionQueue, {}, {
      filename: join(directory, "retry.sqlite"),
      executionId: "dxq-retry",
      script: answer,
      actions: layer
    })

    // With no files given, the 0.x fixture packet is processed.
    expect(turns.filter((t) => t.step === "classify").map((t) => (t.saw as { file: string }).file).sort()).toEqual(
      [...defaultFiles].sort()
    )
    expect(turns.slice(6)).toEqual([
      expect.objectContaining({ step: "reconcile" }),
      { step: "reextract", saw: defaultFiles[0] },
      // The second round sees the re-extraction beside the originals.
      expect.objectContaining({
        step: "reconcile",
        saw: expect.objectContaining({ extractions: [...defaultFiles, `${defaultFiles[0]}#retry`] })
      }),
      { step: "export", saw: { extractions: 4, approval: null } }
    ])
    expect(record.passThrough).toBe(true)
  }), { timeout: 60_000 })

it.live("asks a reviewer after the last round still has a high-severity exception", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(["high", "high"])
    const decision = { approved: true, reviewer: "dana", note: "vendor confirmed by phone" }
    const person = reviewer("dxq-reviewed", decision)
    const record = yield* Kit.run(DocumentExceptionQueue, { files, outputDir: "out" }, {
      filename: join(directory, "reviewed.sqlite"),
      executionId: "dxq-reviewed",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    })

    // Two rounds (the 0.x default), each followed by a re-extraction.
    expect(turns.slice(4).map((t) => t.step)).toEqual(["reconcile", "reextract", "reconcile", "reextract", "export"])
    expect(person.shown).toEqual(["Review document exception queue: 1 high-severity exception(s) require review."])
    // The export saw both re-extractions and the reviewer's decision.
    expect(turns.at(-1)).toEqual({ step: "export", saw: { extractions: 4, approval: decision } })
    expect(record).toEqual({
      normalizedJsonPath: "out/normalized.json",
      exceptionQueuePath: "out/exceptions.json",
      passThrough: true,
      summary: "4 extractions"
    })
  }), { timeout: 60_000 })

it.live("fails without exporting when the reviewer denies the exceptions", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(["high"])
    const person = reviewer("dxq-denied", { approved: false, reviewer: "dana", note: "wrong vendor" })
    const exit = yield* Effect.exit(Kit.run(DocumentExceptionQueue, { files, maxReconcileIterations: 1 }, {
      filename: join(directory, "denied.sqlite"),
      executionId: "dxq-denied",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    }))

    expect(turns.slice(4).map((t) => t.step)).toEqual(["reconcile", "reextract"])
    expect(person.shown).toHaveLength(1)
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
    expect(Option.getOrUndefined(failure)).toEqual({
      _tag: "examples/DocumentExceptionQueue/ReviewDenied",
      reviewer: "dana",
      note: "wrong vendor"
    })
  }), { timeout: 60_000 })
