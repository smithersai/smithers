import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import { ANSWERED_CODES, HARNESS_CODES, isSharedCode, MODEL_CODES, RUN_CAUSE_COPY, runCause, SHARED_CODES } from "./RunCause"

/** The literal set a package declares, read from the declaration rather than copied. */
const literals = (path: string, declaration: string): ReadonlyArray<string> => {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
  const declared = new RegExp(`export const ${declaration} = Schema\\.Literals\\(\\[([\\s\\S]*?)\\]\\)`).exec(source)?.[1] ?? ""
  return [...declared.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!)
}

const HARNESS = "../../../../../packages/smithers/agent/harness/src/HarnessError.ts"
const MODEL = "../../../../../packages/smithers/agent/model/src/ModelError.ts"

test("every code the harness and the model declare is answered here, and only those", () => {
  const harness = literals(HARNESS, "HarnessErrorCode")
  const model = literals(MODEL, "ModelErrorCode")
  expect(harness.length).toBeGreaterThan(0)
  expect(model.length).toBeGreaterThan(0)
  const answered: ReadonlyArray<string> = HARNESS_CODES
  const provider: ReadonlyArray<string> = MODEL_CODES
  expect([...answered].sort()).toEqual([...harness].sort())
  expect([...provider].sort()).toEqual([...model].sort())
  /* Disjoint from each other, which is all it ever was: see SHARED_CODES. */
  expect(harness.filter((code) => model.includes(code))).toEqual([])
  expect(Object.keys(RUN_CAUSE_COPY).sort()).toEqual([...harness, ...model].filter((code) => !isSharedCode(code)).sort())
  const table: ReadonlyArray<string> = ANSWERED_CODES
  expect([...table].sort()).toEqual(Object.keys(RUN_CAUSE_COPY).sort())
})

test("no sentence a person reads carries a code, an internal id, or a thrown message", () => {
  for (const [code, row] of Object.entries(RUN_CAUSE_COPY)) {
    expect(row.message).not.toContain(code)
    /* Every code in both vocabularies is snake_case, and no sentence spells one. */
    expect(row.message).not.toMatch(/[a-z]_[a-z]/)
    expect(row.message).not.toMatch(/\b(run-|Error|Exception|undefined|null|session ")/)
    expect(row.message[0]).toBe(row.message[0]!.toUpperCase())
    expect(row.message.endsWith(".")).toBe(true)
  }
})

test("a fault that is not the person's says so, and one that is names the act", () => {
  for (const [code, row] of Object.entries(RUN_CAUSE_COPY)) {
    expect(Object.keys(REFUSAL_COPY)).toContain(row.fault)
    if (row.fault === "user") expect(row.message).not.toContain("Not your")
    else expect(row.message).toContain("Not your")
    /* A sentence that only assigns blame tells the reader nothing to do next. */
    expect(row.message.length).toBeGreaterThan(REFUSAL_COPY.infra.lead.length / 2)
    expect(code).toBeString()
  }
})

test("the late-turn conditions are different sentences, not one lead", () => {
  const distinct = [
    /* A turn opened and nothing came back. */ "model_failed",
    /* The provider ran the account out, and the provider timed out. */ "quota_exceeded",
    "call_timeout",
    /* The brake, both halves, which mean different things since 46fcc61722f5. */ "claim_unproven",
    "completion_unjudged",
    /* No seat to run on, and a provider that failed on its own side. */ "no_route",
    "provider_internal"
  ] as const
  const said = distinct.map((code) => runCause(code)!.message)
  expect(new Set(said).size).toBe(distinct.length)
  for (const sentence of said) expect(sentence).not.toBe(REFUSAL_COPY.infra.lead)
})

test("a code this build has never heard of is answered by nothing here", () => {
  for (const code of ["", "brand_new_code", "invalid_receipt", "execution", "stale_revision"]) {
    expect(runCause(code)).toBeUndefined()
  }
  /* And neither is one another vocabulary also spells, whoever raised it this time. */
  for (const code of Object.keys(SHARED_CODES)) expect(runCause(code)).toBeUndefined()
})
