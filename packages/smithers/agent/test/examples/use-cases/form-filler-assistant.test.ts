import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FormFillerAssistant, layer } from "../../../examples/use-cases/form-filler-assistant.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "form-filler-assistant-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The JSON a prompt rendered on its `label:` line. */
const line = (asked: string, label: string): any => JSON.parse(new RegExp(`\\n${label}: (.+)`).exec(asked)![1]!)

type Entry = { name: string; value: string; source: string; confidence: number }
type Missing = { name: string; description: string; required: boolean }

const entry = (name: string, value: string, source: string): Entry => ({ name, value, source, confidence: 1 })

/**
 * An extractor that reads `name=value` pairs from the user input and reports
 * every other field of the form schema missing, a clarifier that fills ONE
 * missing field per round from the user responses it was handed, a validator
 * that accepts a set holding every required field and an email with an `@`,
 * and a submitter that echoes what it was told. Each request is recorded in
 * order with the data it carried.
 */
const script = () => {
  const turns: Array<{ readonly step: string; readonly saw: unknown }> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a document field extractor")) {
      const input: string = line(asked, "User input")
      const form: { required: Array<string>; optional: Array<string> } = line(asked, "Form schema")
      const known = input.split(";").filter((p) => p.includes("=")).map((p) => {
        const [name, value] = p.split("=")
        return entry(name!.trim(), value!.trim(), "user-input")
      })
      const has = (name: string) => known.some((k) => k.name === name)
      turns.push({ step: "extract", saw: known.map((k) => k.name) })
      return {
        knownFields: known,
        missingFields: [
          ...form.required.filter((n) => !has(n)).map((name) => ({ name, description: name, required: true })),
          ...form.optional.filter((n) => !has(n)).map((name) => ({ name, description: name, required: false }))
        ],
        documentType: "signup",
        summary: `${known.length} known`
      }
    }
    if (asked.includes("You are a form-filling assistant")) {
      const missing: Array<Missing> = line(asked, "Missing fields")
      const previous: Array<Entry> = line(asked, "Previous answers")
      const responses: Array<{ field: string; value: string }> = line(asked, "User responses")
      turns.push({
        step: "clarify",
        saw: { missing: missing.map((m) => m.name), previous: previous.map((p) => p.name) }
      })
      const next = missing.find((m) => m.required && responses.some((r) => r.field === m.name))
      const answered = next === undefined
        ? previous
        : [...previous, entry(next.name, responses.find((r) => r.field === next.name)!.value, "user-input")]
      const stillMissing = missing.filter((m) => m !== next)
      return {
        answeredFields: answered,
        stillMissing,
        allRequiredCollected: stillMissing.every((m) => !m.required),
        summary: next === undefined ? "nothing new" : `collected ${next.name}`
      }
    }
    if (asked.includes("Validate and normalize the complete field set")) {
      const known: Array<Entry> = line(asked, "Known fields")
      const collected: Array<Entry> = line(asked, "Collected fields")
      const form: { required: Array<string> } = line(asked, "Form schema")
      turns.push({ step: "validate", saw: collected.map((c) => c.name) })
      const all = [...known, ...collected]
      const fields = all.map((f) => ({
        name: f.name,
        value: f.value,
        valid: f.name !== "email" || f.value.includes("@"),
        ...(f.name === "email" && !f.value.includes("@") ? { error: "not an email" } : {})
      }))
      const valid = form.required.every((n) => all.some((f) => f.name === n)) && fields.every((f) => f.valid)
      return {
        valid,
        fields,
        normalizedPayload: Object.fromEntries(all.map((f) => [f.name, f.value])),
        summary: valid ? "valid" : "invalid"
      }
    }
    if (asked.includes("You are a form submission agent")) {
      const payload: Record<string, string> = line(asked, "Payload")
      const target = /\nTarget: (.+)/.exec(asked)![1]!
      const dryRun = /\nDry run: (.+)/.exec(asked)![1] === "true"
      turns.push({ step: "submit", saw: { target, method: /\nMethod: (.+)/.exec(asked)![1], dryRun, payload } })
      return {
        target,
        status: dryRun ? "dry-run" : "submitted",
        fieldCount: Object.keys(payload).length,
        summary: `${Object.keys(payload).length} fields`
      }
    }
    return undefined
  }
  return { answer, turns }
}

const formSchema = { required: ["name", "email", "phone"], optional: ["fax"] }

it.effect("collects one missing field per round until every required field is in, then submits", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      FormFillerAssistant,
      {
        userInput: "name=Ada Lovelace",
        formSchema,
        userResponses: [{ field: "email", value: "ada@example.com" }, { field: "phone", value: "555-0100" }]
      },
      {
        filename: join(directory, "collected.sqlite"),
        executionId: "form-collected",
        script: answer,
        actions: layer
      }
    )

    expect(turns).toEqual([
      { step: "extract", saw: ["name"] },
      // Each round was told what the previous round left missing and had answered.
      { step: "clarify", saw: { missing: ["email", "phone", "fax"], previous: [] } },
      { step: "clarify", saw: { missing: ["phone", "fax"], previous: ["email"] } },
      { step: "validate", saw: ["email", "phone"] },
      {
        step: "submit",
        saw: {
          target: "stdout",
          method: "dry-run",
          dryRun: true,
          payload: { name: "Ada Lovelace", email: "ada@example.com", phone: "555-0100" }
        }
      }
    ])
    expect(output.validation.valid).toBe(true)
    expect(output.submission).toEqual({ target: "stdout", status: "dry-run", fieldCount: 3, summary: "3 fields" })
  }))

it.effect("skips clarification when nothing required is missing", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      FormFillerAssistant,
      {
        userInput: "name=Ada; email=ada@example.com; phone=555-0100",
        formSchema,
        target: "https://forms.example/signup",
        method: "POST",
        dryRun: false
      },
      {
        filename: join(directory, "complete.sqlite"),
        executionId: "form-complete",
        script: answer,
        actions: layer
      }
    )

    expect(turns.map((t) => t.step)).toEqual(["extract", "validate", "submit"])
    expect(turns[1]).toEqual({ step: "validate", saw: [] })
    expect(turns[2]).toMatchObject({ saw: { target: "https://forms.example/signup", method: "POST", dryRun: false } })
    expect(output.submission?.status).toBe("submitted")
  }))

it.effect("stops after maxClarifications rounds and submits nothing when validation fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      FormFillerAssistant,
      {
        userInput: "name=Ada",
        formSchema,
        userResponses: [{ field: "email", value: "ada-at-example" }],
        maxClarifications: 2
      },
      {
        filename: join(directory, "exhausted.sqlite"),
        executionId: "form-exhausted",
        script: answer,
        actions: layer
      }
    )

    // Nobody supplied a phone, so the second round collects nothing and the bound ends the loop.
    expect(turns).toEqual([
      { step: "extract", saw: ["name"] },
      { step: "clarify", saw: { missing: ["email", "phone", "fax"], previous: [] } },
      { step: "clarify", saw: { missing: ["phone", "fax"], previous: ["email"] } },
      { step: "validate", saw: ["email"] }
    ])
    expect(output.validation.valid).toBe(false)
    expect(output.validation.fields.find((f) => f.name === "email")).toEqual({
      name: "email",
      value: "ada-at-example",
      valid: false,
      error: "not an email"
    })
    expect(output.submission).toBeNull()
  }))
