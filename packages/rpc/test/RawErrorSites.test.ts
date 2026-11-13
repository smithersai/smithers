/**
 * No raw-text failure sites in the shared contracts (#2813).
 *
 * The app, the Worker and the CLI read these modules' failures by `_tag` and
 * `code` (UserFailure.ts); an untagged Error subclass, a throwing schema
 * `parse`, a bare string handed to `Effect.fail` or `Effect.die`, or a thrown string carries no tag, so a
 * surface can only show it as an unknown failure. Every such site under `src`
 * must be one of the reviewed exceptions below. Add a tagged error class
 * (`readonly _tag`, like `ResolverFault`) instead of extending this list.
 */
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { rawFailureLines, rawFailures, sources } from "./SourceGuards.ts"

const packageRoot = join(import.meta.dirname, "..")
const sourceRoot = join(packageRoot, "src")

/**
 * Existing validation contracts, by file and exact trimmed line. These retain
 * their documented TypeError or Zod validation behavior rather than changing a
 * public decoder's failure type as part of a source-guard repair.
 */
const reviewed: ReadonlyArray<readonly [file: string, line: string, why: string]> = [
  [
    "src/Sha256.ts",
    "if (!isWellFormed(text)) throw new TypeError(\"SHA-256 text input contains an unpaired UTF-16 surrogate\")",
    "digestSync explicitly documents TypeError for text UTF-8 cannot represent; Sha256.test.ts pins that contract."
  ],
  [
    "src/CardAction.ts",
    ": { ...action, tag: CatalogTagSchema.parse(action.tag) }",
    "The ActionSchema overwrite narrows a tag already admitted by its union after historical tags have been normalized."
  ],
  [
    "src/CardAction.ts",
    "const action = ActionSchema.parse(input)",
    "registeredAction is a Zod decoder for recorded actions; malformed records retain schema-validation failures."
  ],
  [
    "src/CardAction.ts",
    "return { ...action, tag: CatalogTagSchema.parse(action.tag) }",
    "After ActionSchema normalizes historical actions, this parse narrows the validated tag to the current catalog."
  ]
]

describe("raw failure sites under src", () => {
  const files = sources(sourceRoot).map((path) => ({ file: path, text: readFileSync(path, "utf8") }))
  const failures = rawFailures(files)
  const found = files.flatMap(({ file, text }) => {
    const lines = text.split("\n")
    return (failures.get(file) ?? []).map((at) => ({
      file: relative(packageRoot, file).replaceAll("\\", "/"),
      line: lines[at - 1]!.trim(),
      at
    }))
  })

  it("are all reviewed exceptions", () => {
    const allowed = new Set(reviewed.map(([file, line]) => `${file}\n${line}`))
    const unreviewed = found.filter((site) => !allowed.has(`${site.file}\n${site.line}`))
    expect(unreviewed.map((site) => `${site.file}:${site.at}: ${site.line}`)).toEqual([])
  })

  it("keeps no stale exception", () => {
    const present = new Set(found.map((site) => `${site.file}\n${site.line}`))
    expect(reviewed.filter(([file, line]) => !present.has(`${file}\n${line}`))).toEqual([])
  })

  it("scans the sources it guards", () => {
    expect(sources(sourceRoot).map((path) => relative(packageRoot, path))).toEqual(
      expect.arrayContaining([
        join("src", "AgentTurnJournal.ts"),
        join("src", "AgentRoles.ts")
      ])
    )
  })

  it.each([
    "throw new Error(\"x\")",
    "throw new TypeError(\"x\")",
    "throw new globalThis.TypeError(\"x\")",
    "throw new z.ZodError([])",
    "throw new RangeError (\"x\")",
    "throw new AggregateError([], \"x\")",
    "throw new CustomError(\"x\")",
    "class Rejected extends Error {}; throw new Rejected()",
    "class Rejected extends TypeError {}; throw new Rejected()",
    "class Rejected extends globalThis.Error {}; throw new Rejected()",
    "class Rejected extends Error {}; class Child extends Rejected {}; throw new Child()",
    "throw new Error",
    "throw new\nTypeError(\"x\")",
    "Effect.fail(\"x\")",
    "Effect.fail(\"x\" + value)",
    "throw (\"x\")",
    "Effect.die(`x`)",
    "Effect.fail(`x ${value}`)",
    "throw \"x\"",
    "throw `x`",
    "throw `x ${value}`",
    "FrameSchema.parse(frame)",
    "schema.parse(value)",
    "schema.parseAsync(value)",
    "schema[\"parse\"](value)",
    "values.map(FrameSchema.parse)",
    "const Rejected = class extends Error {}; throw new Rejected()",
    "class Rejected extends Error { static _tag = \"Rejected\" }; throw new Rejected()",
    "wire.FrameSchema.parse(value)",
    "FrameSchema\n  .parse(value)"
  ])("detects raw failure: %s", (source) => {
    expect(rawFailureLines(source)).toEqual([1])
  })

  it.each([
    "throw new ApplicationTargetRefused(\"origin_not_http\", \"x\")",
    "throw new ResolverFault(\"status 500\")",
    "FrameSchema.safeParse(frame)",
    "JSON.parse(text)",
    "Date.parse(text)",
    "Effect.fail(new ResolverFault(\"x\"))",
    "// throw new TypeError(\"x\")",
    "const example = 'FrameSchema.parse(input)'",
    "class TaggedError extends Error { readonly _tag = \"TaggedError\"; readonly code = \"invalid\" }; throw new TaggedError()",
    "class Tagged extends Error { readonly _tag = \"Tagged\" }; throw new Tagged()",
    "class Tagged extends Error { constructor(readonly _tag = \"Tagged\") { super() } }; throw new Tagged()",
    "class Tagged extends Error { readonly _tag = \"Tagged\" }; class Child extends Tagged {}; throw new Child()",
    "class First extends Second {}; class Second extends First {}; new First()",
    "new URL(\"https://example.com\")"
  ])("accepts tagged failures and non-failure syntax: %s", (source) => {
    expect(rawFailureLines(source)).toEqual([])
  })

  it.each([
    "class UntaggedError extends Error {}; throw new UntaggedError()",
    "class IncompleteError extends Error { readonly code = \"invalid\" }; throw new IncompleteError()"
  ])("requires a tag on error classes: %s", (source) => {
    expect(rawFailureLines(source)).toEqual([1])
  })

  it("checks exported error declarations and preserves imported or inherited tags", () => {
    expect(rawFailures([
      { file: "a.ts", text: "export class Rejected extends Error {}" },
      { file: "b.ts", text: "import { Rejected } from \"./a.ts\"; throw new Rejected()" }
    ])).toEqual(new Map([["a.ts", [1]], ["b.ts", [1]]]))
    expect(rawFailures([
      { file: "a.ts", text: "export class TaggedError extends Error { readonly _tag = \"Tagged\" }" },
      { file: "b.ts", text: "import { TaggedError } from \"./a.ts\"; throw new TaggedError()" },
      {
        file: "c.ts",
        text:
          "import { TaggedError as AliasError } from \"./a.ts\"; class Child extends AliasError {}; throw new Child()"
      }
    ])).toEqual(new Map([["a.ts", []], ["b.ts", []], ["c.ts", []]]))
  })

  it("resolves competing import aliases in their own modules in either file order", () => {
    const files = [
      { file: "tagged.ts", text: "export class TaggedError extends Error { readonly _tag = \"Tagged\" }" },
      { file: "safe.ts", text: "import { TaggedError as Failure } from \"./tagged.ts\"; throw new Failure()" },
      { file: "raw.ts", text: "import { ZodError as Failure } from \"zod\"; throw new Failure([])" }
    ]
    for (const input of [files, [...files].reverse()]) {
      const found = rawFailures(input)
      expect(found.get("tagged.ts")).toEqual([])
      expect(found.get("safe.ts")).toEqual([])
      expect(found.get("raw.ts")).toEqual([1])
    }
  })

  it("finds failures inside JSX and VibeLang effect functions", () => {
    expect(rawFailureLines("const view = <p>{FrameSchema.parse(value)}</p>", "view.tsx")).toEqual([1])
    expect(rawFailureLines("export effect function reject() { throw new TypeError(\"x\") }", "reject.vibe")).toEqual([
      1
    ])
  })

  it("reports actual source lines and finds multiple shapes on one line once", () => {
    expect(rawFailureLines("const ok = 1;\nthrow new TypeError(\"x\");\nFrameSchema.parse(value); Effect.fail(\"x\")"))
      .toEqual([2, 3])
  })
})
