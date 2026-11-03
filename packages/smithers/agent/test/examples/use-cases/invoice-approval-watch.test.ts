import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InvoiceApprovalWatch, layer } from "../../../examples/use-cases/invoice-approval-watch.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "invoice-approval-watch-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The text a prompt rendered on its `label:` line. */
const text = (asked: string, label: string): string => new RegExp(`\\n${label}: (.+)`).exec(asked)![1]!

/**
 * An extractor that reads one invoice per file named `<vendor>-<amount>.pdf`
 * (omitting the currency of every vendor but `globex`), a rule checker that
 * flags an invoice above the threshold it was told, and a router that queues
 * every flagged invoice it was handed. Each request is recorded in order with
 * the data it carried.
 */
const script = () => {
  const turns: Array<{ readonly step: string; readonly saw: unknown }> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are an invoice data extractor")) {
      const files: Array<string> = JSON.parse(text(asked, "Files"))
      turns.push({ step: "extract", saw: { source: text(asked, "Source"), files } })
      return {
        invoices: files.map((file, i) => {
          const [, vendor, amount] = /(\w+)-(\d+)\.pdf/.exec(file)!
          return {
            id: `inv-${i + 1}`,
            invoiceNumber: `N-${amount}`,
            vendorName: vendor,
            amount: Number(amount),
            ...(vendor === "globex" ? { currency: "EUR" } : {}),
            lineItems: [{ description: "services", quantity: 1, unitPrice: Number(amount), total: Number(amount) }],
            sourceFile: file
          }
        })
      }
    }
    if (asked.includes("You are an invoice validation agent")) {
      const threshold = Number(text(asked, "Approval threshold"))
      const invoices: Array<
        { id: string; invoiceNumber: string; vendorName: string; amount: number; currency: string }
      > = JSON.parse(text(asked, "Invoices"))
      turns.push({
        step: "validate",
        saw: { threshold, window: text(asked, "Duplicate window"), currencies: invoices.map((i) => i.currency) }
      })
      return {
        results: invoices.map((invoice) => {
          const high = invoice.amount > threshold
          return {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            amount: invoice.amount,
            flags: high ? ["high-value"] : ["none"],
            riskScore: high ? 0.7 : 0.1,
            needsApproval: high,
            reasoning: high ? "above threshold" : "clean"
          }
        })
      }
    }
    if (asked.includes("You are an approval queue coordinator")) {
      const totalProcessed = Number(text(asked, "Total processed"))
      const flagged: Array<{ invoiceId: string; invoiceNumber: string; vendorName: string; amount: number }> = JSON
        .parse(text(asked, "Flagged invoices"))
      turns.push({ step: "route", saw: { totalProcessed, flagged: flagged.map((f) => f.invoiceId) } })
      return {
        totalProcessed,
        autoApproved: totalProcessed - flagged.length,
        queuedForApproval: flagged.length,
        rejected: 0,
        queue: flagged.map((f) => ({
          invoiceId: f.invoiceId,
          invoiceNumber: f.invoiceNumber,
          vendorName: f.vendorName,
          amount: f.amount,
          flags: ["high-value"],
          riskScore: 0.7,
          assignedApprover: f.amount > 20000 ? "cfo" : "controller",
          priority: f.amount > 20000 ? "urgent" : "standard",
          recommendedAction: "review",
          reasoning: "above threshold"
        })),
        summary: `${flagged.length} of ${totalProcessed} queued`
      }
    }
    return undefined
  }
  return { answer, turns }
}

const files = ["inbox/acme-1200.pdf", "inbox/globex-9800.pdf", "inbox/initech-30000.pdf"]

it.effect("routes only the invoices above the default threshold", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const queue = yield* Kit.run(InvoiceApprovalWatch, { files }, {
      filename: join(directory, "flagged.sqlite"),
      executionId: "invoice-flagged",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      { step: "extract", saw: { source: "email", files } },
      // The rule checker got the 0.x defaults, and USD where the extractor omitted a currency.
      { step: "validate", saw: { threshold: 5000, window: "30d", currencies: ["USD", "EUR", "USD"] } },
      // The router got only the flagged invoices, and the count of all of them.
      { step: "route", saw: { totalProcessed: 3, flagged: ["inv-2", "inv-3"] } }
    ])
    expect(queue.queuedForApproval).toBe(2)
    expect(queue.autoApproved).toBe(1)
    expect(queue.queue.map((q) => [q.invoiceId, q.assignedApprover, q.priority])).toEqual([
      ["inv-2", "controller", "standard"],
      ["inv-3", "cfo", "urgent"]
    ])
  }))

it.effect("still asks the router, with nothing flagged, when every invoice is under the threshold", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const queue = yield* Kit.run(InvoiceApprovalWatch, { files, approvalThreshold: 50_000, duplicateWindow: "7d" }, {
      filename: join(directory, "clean.sqlite"),
      executionId: "invoice-clean",
      script: answer,
      actions: layer
    })

    expect(turns[1]).toEqual({
      step: "validate",
      saw: { threshold: 50_000, window: "7d", currencies: ["USD", "EUR", "USD"] }
    })
    expect(turns[2]).toEqual({ step: "route", saw: { totalProcessed: 3, flagged: [] } })
    expect(queue).toEqual({
      totalProcessed: 3,
      autoApproved: 3,
      queuedForApproval: 0,
      rejected: 0,
      queue: [],
      summary: "0 of 3 queued"
    })
  }))
