import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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

/*
 * The sweep. `failureSummary` prefixes the code of the innermost rendered
 * record that carries a `message`, off ANY record, so every failure class in
 * this repo shaped `{ code: <closed set>, message: string }` can put its own
 * code on a run's first journal line. That shape is what this walk looks for,
 * and the tag it is declared under is the author the line does not carry.
 *
 * Nothing here is a list somebody maintains: the roots are walked, the classes
 * are read out of source, and a package that starts spelling one of the two
 * vocabularies' codes tomorrow changes the result of this function without
 * anyone editing it.
 */
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url))
const ROOTS = ["packages", "flows", "apps"]
const SKIP_DIR = /^(node_modules|dist|build|coverage|\.git|\.jj)$/
const TAGGED = /TaggedError<[^>]*>\(\)\(\s*"([^"]+)"\s*,\s*\{/g
const CODE_FIELD = /(^|\n)[\t ]*code:[\t ]*/
const CODE_LITERAL = /"([a-z][a-z0-9_]*)"/g

const sources = (dir: string, found: Array<string> = []): Array<string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIR.test(entry.name)) sources(join(dir, entry.name), found) }
    else if (/\.tsx?$/.test(entry.name)) found.push(join(dir, entry.name))
  }
  return found
}

/** The text between the bracket at `open` and the one that closes it. */
const bracketed = (source: string, open: number): string => {
  const close = source[open] === "{" ? "}" : "]"
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === source[open]) depth++
    else if (source[index] === close && --depth === 0) return source.slice(open + 1, index)
  }
  return ""
}

/** Every code a `code:` field admits, or `undefined` when the field is not a closed set. */
const admitted = (source: string, expression: string, at: number): ReadonlyArray<string> | undefined => {
  const trimmed = expression.trimStart()
  if (trimmed.startsWith("Schema.Literals(")) {
    const paren = source.indexOf("Schema.Literals(", at) + "Schema.Literals(".length
    const open = paren + source.slice(paren).search(/\S/)
    if (source[open] === "[") return [...bracketed(source, open).matchAll(CODE_LITERAL)].map((match) => match[1]!)
    const array = /^[A-Za-z_$][\w$]*/.exec(source.slice(open))?.[0]
    const declared = array === undefined ? null : new RegExp(`(?:const|let) ${array}\\s*=\\s*\\[`).exec(source)
    return declared === null ? undefined
      : [...bracketed(source, source.indexOf("[", declared.index)).matchAll(CODE_LITERAL)].map((match) => match[1]!)
  }
  /* A named schema: `code: ProviderErrorCode`. Anything with a call or a string in it is open. */
  const name = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/.exec(trimmed)?.[0]
  if (name === undefined || /[("]/.test(trimmed.slice(0, name.length + 1))) return undefined
  const declared = new RegExp(`(?:const|let) ${name.split(".").at(-1)!}\\s*=\\s*Schema\\.Literals\\(`).exec(source)
  return declared === null ? undefined : admitted(source, "Schema.Literals(", declared.index)
}

/** Every code a tagged failure class in this repo can carry, to the tags that carry it. */
const vocabularies = (): ReadonlyMap<string, ReadonlySet<string>> => {
  const owners = new Map<string, Set<string>>()
  for (const root of ROOTS) {
    for (const file of sources(join(ROOT, root))) {
      const source = readFileSync(file, "utf8")
      for (const declaration of source.matchAll(TAGGED)) {
        const at = declaration.index + declaration[0].length - 1
        const fields = bracketed(source, at)
        /* `failureSummary` reads a record's code only when that record also carries the message. */
        if (!/(^|\n)[\t ]*message:/.test(fields)) continue
        const field = CODE_FIELD.exec(fields)
        if (field === null) continue
        const from = field.index + field[0].length
        for (const code of admitted(source, fields.slice(from), at + 1 + from) ?? []) {
          owners.set(code, (owners.get(code) ?? new Set()).add(declaration[1]!))
        }
      }
    }
  }
  return owners
}

test("every code the harness and the model declare is answered here, and only those", () => {
  const harness = literals(HARNESS, "HarnessErrorCode")
  const model = literals(MODEL, "ModelErrorCode")
  expect(harness.length).toBeGreaterThan(0)
  expect(model.length).toBeGreaterThan(0)
  const answered: ReadonlyArray<string> = HARNESS_CODES
  const provider: ReadonlyArray<string> = MODEL_CODES
  expect([...answered].sort()).toEqual([...harness].sort())
  expect([...provider].sort()).toEqual([...model].sort())
  expect(Object.keys(RUN_CAUSE_COPY).sort()).toEqual([...harness, ...model].filter((code) => !isSharedCode(code)).sort())
  const table: ReadonlyArray<string> = ANSWERED_CODES
  expect([...table].sort()).toEqual(Object.keys(RUN_CAUSE_COPY).sort())
})

/*
 * The claim this file used to make, and the one it makes now. The two
 * vocabularies are disjoint from each other — that much was true and is still
 * checked — but disjointness from EACH OTHER never made a code identify its
 * author, because the line a card reads is `<code>: <message>` and any tagged
 * failure in this repo can write one. That is what the sweep decides, and a
 * new foreign raiser fails here rather than reaching a person as the model's
 * sentence and waiting for a reviewer to notice.
 */
test("a code this table answers is one no other failure vocabulary in the repo spells", () => {
  const harness = literals(HARNESS, "HarnessErrorCode")
  const model = literals(MODEL, "ModelErrorCode")
  expect(harness.filter((code) => model.includes(code))).toEqual([])

  const owners = vocabularies()
  /* The sweep finds the two declarations it is judging, so a walk that read nothing cannot pass. */
  for (const code of [...harness, ...model]) expect([...owners.get(code) ?? []]).not.toEqual([])

  const shared = Object.fromEntries(
    [...harness, ...model]
      .filter((code) => (owners.get(code)?.size ?? 0) > 1)
      .map((code) => [code, [...owners.get(code)!].sort()])
  )
  /* Every code more than one vocabulary spells, and every vocabulary that spells it. */
  expect(shared).toEqual(
    Object.fromEntries(Object.entries(SHARED_CODES).map(([code, tags]) => [code, [...tags].sort()]))
  )
  for (const code of Object.keys(shared)) expect(runCause(code)).toBeUndefined()
  for (const code of ANSWERED_CODES) expect(owners.get(code)?.size).toBe(1)
  /* Two the sweep has to place exactly, so a walk that found only its own file cannot pass either. */
  expect(owners.get("model_failed")).toEqual(new Set(["/harness/HarnessError"]))
  expect(owners.get("context_overflow")).toEqual(new Set(["flows/model/ModelError"]))
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
