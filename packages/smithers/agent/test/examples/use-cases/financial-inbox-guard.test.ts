import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FinancialInboxGuard, layer } from "../../../examples/use-cases/financial-inbox-guard.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "financial-inbox-guard-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The text a prompt rendered on its `label:` line. */
const text = (asked: string, label: string): string => new RegExp(`\\n${label}: (.+)`).exec(asked)![1]!

/**
 * Agents that read a raw email written `subject|body|amount`. The classifier
 * calls a subject with "bank" risky and anything else an invoice; the risk
 * agent calls a body mentioning new bank details critical; the router
 * quarantines critical risk and queues invoices over the threshold it was
 * told. Each request is recorded in order with the data it carried.
 * `brokenRisk` makes the risk agent answer off-schema.
 */
const script = (brokenRisk = false) => {
  const turns: Array<{ readonly step: string; readonly saw: unknown }> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("Normalize this raw email")) {
      const [subject, body] = (JSON.parse(text(asked, "Raw email")) as string).split("|")
      turns.push({ step: "ingest", saw: /from the (\S+) mailbox/.exec(asked)![1] })
      return {
        messageId: "m-1",
        from: "billing@vendor.example",
        subject: subject!,
        bodyPreview: body!,
        attachments: ["invoice.pdf"],
        receivedAt: "2026-07-27T09:00:00Z"
      }
    }
    if (asked.includes("You are a financial email classifier")) {
      const email = JSON.parse(text(asked, "Email"))
      turns.push({ step: "classify", saw: email.messageId })
      const risky = /bank/i.test(email.subject)
      return {
        messageId: email.messageId,
        category: risky ? "risky-language" : "invoice",
        confidence: 90,
        flags: risky ? ["bank-change-request"] : [],
        summary: email.subject
      }
    }
    if (asked.includes("You are a financial fraud and risk detection specialist")) {
      const email = JSON.parse(text(asked, "Email"))
      turns.push({ step: "risk", saw: email.messageId })
      if (brokenRisk) return { riskLevel: "unsure" }
      const critical = /new bank details/i.test(email.bodyPreview)
      return {
        messageId: email.messageId,
        riskLevel: critical ? "critical" : "none",
        signals: critical ? [{ type: "bank-change-request", evidence: email.bodyPreview, severity: "critical" }] : [],
        recommendation: critical ? "Verify by phone before paying." : "Process normally."
      }
    }
    if (asked.includes("You are an invoice data extractor")) {
      const email = JSON.parse(text(asked, "Email"))
      turns.push({ step: "extract", saw: text(asked, "Category") })
      const amount = Number(email.bodyPreview.match(/\d+/)?.[0] ?? 0)
      return {
        messageId: email.messageId,
        invoiceNumber: "INV-42",
        vendorName: "Vendor Co",
        amount,
        currency: "USD",
        dueDate: "2026-08-27",
        lineItems: [{ description: "services", amount }],
        poMatch: true
      }
    }
    if (asked.includes("Decide the action for finance email")) {
      const messageId = /finance email (\S+)\./.exec(asked)![1]!
      const threshold = Number(text(asked, "Approval threshold"))
      const team = text(asked, "Escalation team")
      const channels: Array<string> = JSON.parse(text(asked, "Notify channels"))
      const classification = JSON.parse(text(asked, "Classification"))
      const risk = JSON.parse(text(asked, "Risk"))
      const invoice = JSON.parse(text(asked, "Invoice"))
      turns.push({
        step: "route",
        saw: { messageId, category: classification.category, risk: risk.riskLevel, amount: invoice.amount, threshold }
      })
      const quarantine = risk.riskLevel === "critical"
      return {
        messageId,
        action: quarantine ? "quarantine" : invoice.amount > threshold ? "queue-approval" : "auto-process",
        assignee: quarantine ? team : "ap-clerks",
        priority: quarantine ? "critical" : "normal",
        notifyChannels: quarantine ? channels : [],
        summary: `${classification.category} ${invoice.invoiceNumber}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("queues a large invoice for approval after classifying and assessing it in parallel", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const decision = yield* Kit.run(FinancialInboxGuard, { rawEmail: "Invoice INV-42|Amount due 12000|" }, {
      filename: join(directory, "invoice.sqlite"),
      executionId: "inbox-invoice",
      script: answer,
      actions: layer
    })

    // Ingest first, then classify and risk in either order, then extract, then route.
    expect(turns[0]).toEqual({ step: "ingest", saw: "ap@company.com" })
    expect(turns.slice(1, 3).map((t) => t.step).sort()).toEqual(["classify", "risk"])
    expect(turns.slice(1, 3).map((t) => t.saw)).toEqual(["m-1", "m-1"])
    expect(turns.slice(3)).toEqual([
      { step: "extract", saw: "invoice" },
      { step: "route", saw: { messageId: "m-1", category: "invoice", risk: "none", amount: 12000, threshold: 10_000 } }
    ])
    expect(decision).toEqual({
      messageId: "m-1",
      action: "queue-approval",
      assignee: "ap-clerks",
      priority: "normal",
      notifyChannels: [],
      summary: "invoice INV-42"
    })
  }))

it.effect("quarantines a bank-change request and alerts the configured team", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const decision = yield* Kit.run(
      FinancialInboxGuard,
      {
        rawEmail: "URGENT bank update|Please use our new bank details for 4000|",
        mailbox: "payables@company.com",
        escalationTeam: "treasury",
        notifyChannels: ["#fraud"]
      },
      {
        filename: join(directory, "risky.sqlite"),
        executionId: "inbox-risky",
        script: answer,
        actions: layer
      }
    )

    expect(turns[0]).toEqual({ step: "ingest", saw: "payables@company.com" })
    // The extractor still runs, told the email is risky language.
    expect(turns.slice(3)).toEqual([
      { step: "extract", saw: "risky-language" },
      {
        step: "route",
        saw: { messageId: "m-1", category: "risky-language", risk: "critical", amount: 4000, threshold: 10_000 }
      }
    ])
    expect(decision).toMatchObject({
      action: "quarantine",
      assignee: "treasury",
      priority: "critical",
      notifyChannels: ["#fraud"]
    })
  }))

it.effect("fails before extracting or routing when the risk check fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(FinancialInboxGuard, { rawEmail: "Invoice INV-42|Amount due 12000|" }, {
      filename: join(directory, "broken-risk.sqlite"),
      executionId: "inbox-broken-risk",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("StructuredOutput")
    const steps = turns.map((t) => t.step)
    expect(steps).toContain("risk")
    expect(steps).not.toContain("extract")
    expect(steps).not.toContain("route")
  }))
