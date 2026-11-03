import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DynamicSchemaEnricher, layer } from "../../../examples/use-cases/dynamic-schema-enricher.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "dynamic-schema-enricher-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The field specification the resolver answers with, per family. */
const fieldsFor = (family: string) =>
  family === "invoice"
    ? [
      { name: "invoiceNumber", type: "string", required: true, description: "The invoice id" },
      { name: "total", type: "number", required: true, description: "Amount due" },
      { name: "poNumber", type: "string", required: false, description: "Purchase order" }
    ]
    : [{ name: "subject", type: "string", required: true, description: "What the ticket is about" }]

/**
 * A context agent that calls documents starting with "INVOICE" invoices and
 * anything else a support ticket, a resolver that answers each family's
 * fields (or answers off-schema when `brokenResolver`), an extractor that
 * fills every field it was handed, and an output agent that validates what it
 * was handed. Each request is recorded in order.
 */
const script = (brokenResolver = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const context = /Source: (.+)\nTenant: (.+)\nDocument:\n(.*)/.exec(asked)
    if (asked.includes("Identify this document's source") && context !== null) {
      const [, source, tenant, document] = context
      const family = document!.startsWith("INVOICE") ? "invoice" : "support-ticket"
      turns.push(`context ${source}/${tenant} -> ${family}`)
      return {
        source: source!,
        tenant: tenant!,
        documentFamily: family,
        rawContent: document!,
        detectedLanguage: "en",
        summary: `a ${family}`
      }
    }
    const resolve = /Document family: (.+)\nTenant: (.+)\nSource: .+\nLanguage: .+\nSchema registry: (.+)/.exec(asked)
    if (resolve !== null) {
      const [, family, tenant, registry] = resolve
      turns.push(`resolve ${family} for ${tenant} from ${registry}`)
      if (brokenResolver) return { unexpected: true }
      return {
        schemaId: `${family}-v2`,
        schemaFamily: family!,
        fields: fieldsFor(family!),
        tenantOverrides: tenant === "acme" ? [{ field: "poNumber", rule: "required for acme" }] : [],
        confidence: 0.95,
        summary: `${family} schema`
      }
    }
    const extract = /Extract the fields of schema (.+)\.\n\nFields: (.+)\nTenant overrides: (.+)\nContent:\n(.*)/.exec(
      asked
    )
    if (extract !== null) {
      const fields: Array<{ name: string; required: boolean }> = JSON.parse(extract[2]!)
      const overrides: Array<{ field: string }> = JSON.parse(extract[3]!)
      turns.push(`extract ${extract[1]} ${fields.map((f) => f.name).join(",")}`)
      // The content carries every field but the purchase order.
      const filled = fields.filter((f) => f.name !== "poNumber")
      return {
        schemaId: extract[1]!,
        extractedFields: Object.fromEntries(filled.map((f) => [f.name, `${f.name} from ${extract[4]}`])),
        missingRequired: overrides.map((o) => o.field),
        warnings: [],
        extractionConfidence: 0.8,
        summary: `filled ${filled.length} fields`
      }
    }
    const output =
      /Schema: (.+)\nTenant: (.+)\nDocument family: (.+)\nExtracted fields: (.+)\nMissing required: (.+)\nWarnings: .+\nConfidence: (.+)/
        .exec(asked)
    if (output !== null) {
      const [, schemaId, tenant, family, fields, missing, confidence] = output
      const missingRequired: Array<string> = JSON.parse(missing!)
      turns.push(`output ${schemaId} at ${confidence}`)
      return {
        schemaId: schemaId!,
        tenant: tenant!,
        documentFamily: family!,
        payload: JSON.parse(fields!),
        valid: missingRequired.length === 0,
        validationErrors: missingRequired.map((field) => `${field} is required`),
        summary: `validated ${schemaId}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("resolves the tenant's schema for the document's family and extracts into it", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(DynamicSchemaEnricher, {
      document: "INVOICE 1042, total 99.50",
      source: "email",
      tenant: "acme",
      schemaRegistry: "registry://billing"
    }, {
      filename: join(directory, "invoice.sqlite"),
      executionId: "enricher-invoice",
      script: answer,
      actions: layer
    })

    // Each step ran on what the step before it produced.
    expect(turns).toEqual([
      "context email/acme -> invoice",
      "resolve invoice for acme from registry://billing",
      "extract invoice-v2 invoiceNumber,total,poNumber",
      "output invoice-v2 at 0.8"
    ])
    // The tenant's override made the missing purchase order a validation error.
    expect(output).toEqual({
      schemaId: "invoice-v2",
      tenant: "acme",
      documentFamily: "invoice",
      payload: {
        invoiceNumber: "invoiceNumber from INVOICE 1042, total 99.50",
        total: "total from INVOICE 1042, total 99.50"
      },
      valid: false,
      validationErrors: ["poNumber is required"],
      summary: "validated invoice-v2"
    })
  }))

it.effect("uses the default source, tenant and registry and resolves another family's fields", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(DynamicSchemaEnricher, { document: "The export button does nothing" }, {
      filename: join(directory, "ticket.sqlite"),
      executionId: "enricher-ticket",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "context unknown/default -> support-ticket",
      "resolve support-ticket for default from default",
      "extract support-ticket-v2 subject",
      "output support-ticket-v2 at 0.8"
    ])
    expect(output.valid).toBe(true)
    expect(output.payload).toEqual({ subject: "subject from The export button does nothing" })
  }))

it.effect("stops before extracting when the resolver fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(DynamicSchemaEnricher, { document: "INVOICE 7" }, {
      filename: join(directory, "broken.sqlite"),
      executionId: "enricher-broken",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("resolve invoice for default from default")
    expect(turns.some((turn) => turn.startsWith("extract"))).toBe(false)
  }))
