import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, ReceiptStreamWatcher } from "../../../examples/use-cases/receipt-stream-watcher.vibe"

const directory = mkdtempSync(join(tmpdir(), "receipt-stream-watcher-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The text a prompt rendered on its `label:` line. */
const text = (asked: string, label: string): string => new RegExp(`\\n${label}: (.+)`).exec(asked)![1]!

type Field = { readonly value: string | null; readonly confidence: number }

/**
 * An extractor that reads receipt text written `name=value@confidence;...`, a
 * consumer that counts the fields at or above the threshold it was told, and
 * a router that sends totals over 100 to audit. Each request is recorded in
 * order with the data it carried.
 */
const script = () => {
  const turns: Array<{ readonly step: string; readonly saw: unknown }> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a receipt extraction agent")) {
      const receipt: string = JSON.parse(text(asked, "Text"))
      turns.push({ step: "extract", saw: { file: JSON.parse(text(asked, "File")), receipt } })
      const fields: Record<string, Field> = {}
      for (const part of receipt.split(";")) {
        const [, name, value, confidence] = /(\w+)=(.*)@([\d.]+)/.exec(part)!
        fields[name!] = { value: value === "" ? null : value!, confidence: Number(confidence) }
      }
      return { ...fields, iterationsUsed: 1, complete: true }
    }
    if (asked.includes("You are a partial-state consumer")) {
      const threshold = Number(text(asked, "Threshold"))
      const minFields = Number(text(asked, "Minimum fields"))
      const extraction: Record<"merchant" | "total" | "date" | "currency", Field> = JSON.parse(
        text(asked, "Extraction")
      )
      const confident = Object.values({
        merchant: extraction.merchant,
        total: extraction.total,
        date: extraction.date,
        currency: extraction.currency
      }).filter((f) => f.value !== null && f.confidence >= threshold).length
      turns.push({ step: "consume", saw: { threshold, minFields, confident } })
      return {
        merchant: extraction.merchant.value,
        total: extraction.total.value === null ? null : Number(extraction.total.value),
        date: extraction.date.value,
        currency: extraction.currency.value,
        highConfidenceCount: confident,
        readyForRouting: confident >= minFields,
        summary: `${confident} confident fields`
      }
    }
    if (asked.includes("You are a receipt routing agent")) {
      const fields: { merchant: string; total: string; currency: string; date: string } = JSON.parse(
        text(asked, "Fields")
      )
      turns.push({ step: "route", saw: { fields, count: Number(text(asked, "High-confidence fields")) } })
      const total = Number(fields.total)
      return {
        destination: total > 100 ? "audit-review" : "expense-report",
        merchant: fields.merchant,
        total,
        currency: fields.currency,
        date: fields.date,
        reasoning: total > 100 ? "high value" : "business meal",
        summary: `routed ${fields.merchant}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("routes a receipt once enough fields are confident", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      ReceiptStreamWatcher,
      { text: "merchant=Cafe@0.99;total=12.50@0.98;date=2026-07-27@0.6;currency=USD@0.96" },
      {
        filename: join(directory, "ready.sqlite"),
        executionId: "receipt-ready",
        script: answer,
        actions: layer
      }
    )

    expect(turns).toEqual([
      {
        step: "extract",
        saw: { file: null, receipt: "merchant=Cafe@0.99;total=12.50@0.98;date=2026-07-27@0.6;currency=USD@0.96" }
      },
      { step: "consume", saw: { threshold: 0.85, minFields: 3, confident: 3 } },
      // The router got the extractor's raw values and the consumer's count.
      {
        step: "route",
        saw: { fields: { merchant: "Cafe", total: "12.50", currency: "USD", date: "2026-07-27" }, count: 3 }
      }
    ])
    expect(output.consumed.readyForRouting).toBe(true)
    expect(output.routing).toEqual({
      destination: "expense-report",
      merchant: "Cafe",
      total: 12.5,
      currency: "USD",
      date: "2026-07-27",
      reasoning: "business meal",
      summary: "routed Cafe"
    })
  }))

it.effect("stops without routing when too few fields are confident", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      ReceiptStreamWatcher,
      { file: "receipts/blurry.jpg", text: "merchant=@0.2;total=480.00@0.9;date=2026-07-27@0.4;currency=USD@0.97" },
      {
        filename: join(directory, "not-ready.sqlite"),
        executionId: "receipt-not-ready",
        script: answer,
        actions: layer
      }
    )

    expect(turns.map((t) => t.step)).toEqual(["extract", "consume"])
    expect(turns[0]!.saw).toMatchObject({ file: "receipts/blurry.jpg" })
    expect(turns[1]).toEqual({ step: "consume", saw: { threshold: 0.85, minFields: 3, confident: 2 } })
    expect(output).toEqual({
      consumed: {
        merchant: null,
        total: 480,
        date: "2026-07-27",
        currency: "USD",
        highConfidenceCount: 2,
        readyForRouting: false,
        summary: "2 confident fields"
      },
      routing: null
    })
  }))
