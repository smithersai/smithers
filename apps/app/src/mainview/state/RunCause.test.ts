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
 * this repo shaped `{ code, message: string }` can put its own code on a run's
 * first journal line. That shape is what this walk looks for, and the tag it
 * is declared under is the author the line does not carry.
 *
 * Nothing here is a list somebody maintains: the roots are walked, the classes
 * are read out of source, and a package that starts spelling one of the two
 * vocabularies' codes tomorrow changes the result of this function without
 * anyone editing it.
 *
 * Three shapes, because a class that declares a code in any of them can
 * journal it: a `code:` whose literals are written inline, a `code:` that
 * names a schema ANOTHER file declares (`librarian/ProviderUnavailable` is
 * `code: ModelErrorCode`, imported from `@smthrs/model`), and a `code:` left
 * open, whose codes are the literals its own `new` sites pass. Both spellings
 * of a tagged class count — `Schema.TaggedError<T>()("tag", {…})` and
 * `Data.TaggedError("tag")<{…}>` — since `failureSummary` reads the rendered
 * record, not the class.
 *
 * Tests are not swept. A class declared inside a `*.test.ts` or a `test/`
 * directory never crosses a seam into a person's run journal, and two such
 * fixtures (`ActionErrorCause/AdapterError`, `test/SeatRejected`) would
 * otherwise take `model_failed`, `authentication` and `quota_exceeded` off
 * this table for failures no person can be shown.
 */
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url))
const ROOTS = ["packages", "flows", "apps"]
const SKIP_DIR = /^(node_modules|dist|build|coverage|test|tests|__tests__|e2e|\.git|\.jj)$/
const SKIP_FILE = /\.(test|spec)\.tsx?$/
const TAGGED =
  /class\s+([A-Za-z_$][\w$]*)\s+extends\s+[\w$.]*TaggedError(?:<[^>]*>\(\)\(\s*"([^"]+)"\s*,\s*|\(\s*"([^"]+)"\s*\)\s*<\s*)\{/g
const NAMED = /(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*Schema\.Literals\(/g
/* A field of the record itself, not a suffix of one: `{`, `,` and a line start all open a field,
 * and a `Data.TaggedError` type argument spells its fields `readonly`. */
const CODE_FIELD = /(^|[\n,{])[\t ]*(?:readonly[\t ]+)?code:[\t ]*/
const MESSAGE_FIELD = /(^|[\n,{])[\t ]*(?:readonly[\t ]+)?message:/
const CODE_LITERAL = /"([a-z][a-z0-9_]*)"/g

const sources = (dir: string, found: Array<string> = []): Array<string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIR.test(entry.name)) sources(join(dir, entry.name), found) }
    else if (/\.tsx?$/.test(entry.name) && !SKIP_FILE.test(entry.name)) found.push(join(dir, entry.name))
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

/** The literal set the `Schema.Literals(` call at `at` admits, or `undefined` when it is computed. */
const literalsAt = (source: string, at: number): ReadonlyArray<string> | undefined => {
  const paren = source.indexOf("(", at) + 1
  const open = paren + source.slice(paren).search(/\S/)
  if (source[open] === "[") return [...bracketed(source, open).matchAll(CODE_LITERAL)].map((match) => match[1]!)
  const array = /^[A-Za-z_$][\w$]*/.exec(source.slice(open))?.[0]
  const declared = array === undefined ? null : new RegExp(`(?:const|let) ${array}\\s*=\\s*\\[`).exec(source)
  return declared === null ? undefined
    : [...bracketed(source, source.indexOf("[", declared.index)).matchAll(CODE_LITERAL)].map((match) => match[1]!)
}

/**
 * Every `Schema.Literals` set declared under a name anywhere in the sweep.
 *
 * A code schema is imported as often as it is declared in place —
 * `ProviderUnavailable` reuses `@smthrs/model`'s — so resolving a name only in
 * the file that uses it drops the class silently. Where one name is declared
 * twice with different literals, the union stands: over-crediting a class puts
 * a code in `SHARED_CODES`, which costs a sentence, and under-crediting it
 * lets a foreign raiser through, which costs a person a false one.
 */
const declarations = (texts: ReadonlyMap<string, string>): ReadonlyMap<string, ReadonlySet<string>> => {
  const named = new Map<string, Set<string>>()
  for (const source of texts.values()) {
    for (const declared of source.matchAll(NAMED)) {
      const codes = literalsAt(source, declared.index + declared[0].length - 1)
      if (codes !== undefined) named.set(declared[1]!, new Set([...(named.get(declared[1]!) ?? []), ...codes]))
    }
  }
  return named
}

/** Every code a `code:` field admits, or `undefined` when the field is not a closed set. */
const admitted = (
  source: string,
  expression: string,
  at: number,
  named: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyArray<string> | undefined => {
  const trimmed = expression.trimStart()
  if (trimmed.startsWith("Schema.Literals(")) return literalsAt(source, source.indexOf("Schema.Literals(", at))
  /* A named schema: `code: ProviderErrorCode`. Anything with a call or a string in it is open. */
  const name = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/.exec(trimmed)?.[0]
  if (name === undefined || /[("]/.test(trimmed.slice(0, name.length + 1))) return undefined
  const local = new RegExp(`(?:const|let) ${name.split(".").at(-1)!}\\s*=\\s*Schema\\.Literals\\(`).exec(source)
  if (local !== null) return literalsAt(source, local.index)
  const shared = named.get(name.split(".").at(-1)!)
  return shared === undefined ? undefined : [...shared]
}

/**
 * Every code a `new <name>({ … })` anywhere in the sweep passes as a literal.
 *
 * The fallback for a class whose `code` no declaration closes. `undefined`
 * from {@link admitted} used to mean "contributes nothing", which let an open
 * `code: Schema.String` spell an answered code at its raise site and say
 * nothing here.
 */
const raised = (texts: ReadonlyMap<string, string>, name: string): ReadonlyArray<string> => {
  const codes = new Set<string>()
  const sites = new RegExp(`new\\s+(?:[A-Za-z_$][\\w$]*\\.)*${name}\\s*\\(\\s*\\{`, "g")
  for (const source of texts.values()) {
    for (const site of source.matchAll(sites)) {
      const fields = bracketed(source, site.index + site[0].length - 1)
      const field = CODE_FIELD.exec(fields)
      if (field === null) continue
      const literal = /^"([a-z][a-z0-9_]*)"/.exec(fields.slice(field.index + field[0].length))
      if (literal !== null) codes.add(literal[1]!)
    }
  }
  return [...codes]
}

/** Every code a tagged failure class in this repo can carry, to the tags that carry it. */
const vocabularies = (): ReadonlyMap<string, ReadonlySet<string>> => {
  const texts = new Map<string, string>()
  for (const root of ROOTS) for (const file of sources(join(ROOT, root))) texts.set(file, readFileSync(file, "utf8"))
  const named = declarations(texts)
  const owners = new Map<string, Set<string>>()
  for (const source of texts.values()) {
    for (const declaration of source.matchAll(TAGGED)) {
      const at = declaration.index + declaration[0].length - 1
      const fields = bracketed(source, at)
      /* `failureSummary` reads a record's code only when that record also carries the message. */
      if (!MESSAGE_FIELD.test(fields)) continue
      const field = CODE_FIELD.exec(fields)
      if (field === null) continue
      const from = field.index + field[0].length
      const tag = declaration[2] ?? declaration[3]!
      const closed = admitted(source, fields.slice(from), at + 1 + from, named)
      for (const code of closed ?? raised(texts, declaration[1]!)) {
        owners.set(code, (owners.get(code) ?? new Set()).add(tag))
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
  /* Three the sweep has to place exactly, so a walk that found only its own file cannot pass either. */
  expect(owners.get("model_failed")).toEqual(new Set(["/harness/HarnessError"]))
  /* The cross-file resolution: `code: ModelErrorCode`, declared in a package `flows/librarian` imports. */
  expect(owners.get("context_overflow")).toEqual(new Set(["flows/model/ModelError", "librarian/ProviderUnavailable"]))
  /* And the raise-site fallback: `AlertError`'s `code` is open, and only its `new` sites close it. */
  expect(owners.get("sink_unreachable")).toEqual(new Set(["/notifications/AlertError"]))
})

/*
 * The three shapes a code can be declared in, read off source rather than off
 * the repo, so a shape stops being recognised here before it stops being
 * caught above. Each was a live blind spot: `ProviderUnavailable` occupied the
 * second one with nine of this table's codes, and the third let an open
 * `code: Schema.String` spell an answered code at its raise site.
 */
test("the sweep reads both spellings of a tagged class, an imported code schema, and an open code", () => {
  const source = [
    `export class Inline extends Schema.TaggedError<Inline>()("probe/Inline", {`,
    `  code: Schema.Literals(["inline_one"]), message: Schema.String`,
    `}) {}`,
    `export class Imported extends Schema.TaggedError<Imported>()("probe/Imported", {`,
    `  code: ImportedCode, message: Schema.String`,
    `}) {}`,
    `export class Data_ extends Data.TaggedError("probe/Data")<{`,
    `  readonly code: string`,
    `  readonly message: string`,
    `}> {}`,
    `const raise = () => new Data_({ code: "open_one", message: "" })`
  ].join("\n")
  const named = new Map([["ImportedCode", new Set(["imported_one"])]])
  const read = [...source.matchAll(TAGGED)].map((declaration) => {
    const at = declaration.index + declaration[0].length - 1
    const fields = bracketed(source, at)
    const field = CODE_FIELD.exec(fields)!
    const from = field.index + field[0].length
    return [
      declaration[2] ?? declaration[3]!,
      admitted(source, fields.slice(from), at + 1 + from, named) ?? raised(new Map([["probe", source]]), declaration[1]!)
    ]
  })
  expect(read).toEqual([
    ["probe/Inline", ["inline_one"]],
    ["probe/Imported", ["imported_one"]],
    ["probe/Data", ["open_one"]]
  ])
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
    /* The brake, both halves, which mean different things since 46fcc61722f5. */ "claim_unproven",
    "completion_unjudged",
    /* Nothing was assembled, versus a turn that could not be built to send. */ "assembly_failed",
    "render_failed",
    /* A cap this side enforced, and a wait that never ended. */ "read_only_cap",
    "suspended",
    /* A record from another build. */ "incompatible_journal"
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
