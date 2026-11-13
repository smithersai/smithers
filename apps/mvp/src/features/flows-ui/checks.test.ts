// Decision 0014's static checks over a person's flow source (src/features/flows-ui/checks.ts), read through
// @smthrs/registry's `ModuleFlow` the way a repository's `flow.ts` is: every check passes for a drafted flow, a module
// written by hand is checked the same way, and each refusal names its code.
import { describe, expect, test } from "vitest"
import { checkSource, passes, readSource } from "./checks"
import { MAX_SOURCE_BYTES } from "./contract"
import { type Generated, renderSource } from "./source"

const notes: Generated = {
  name: "release-notes",
  description: "Summarize merged pull requests: since the last tag.",
  instructions: "Read the repository.\n\nThen summarize what merged.",
  flows: ["repo/read", "repo/tree"],
}

const allowed = ["repo/read", "repo/tree", "app/theme/set"]

/** The failing checks of `text`, as `check:code`. */
const failures = (text: string, name = "release-notes", calls: ReadonlyArray<string> = allowed) =>
  checkSource(text, name, calls).filter((check) => !check.ok).map((check) => `${check.check}:${check.code}`)

/** A module written by hand: the same declaration with a body of its own. */
const handWritten = (declaration: string) =>
  [
    `import { Flow } from "@smthrs/flow"`,
    `import { Schema } from "effect"`,
    `import { Notes } from "./notes.ts"`,
    "",
    declaration,
    "",
  ].join("\n")

describe("readSource", () => {
  test("reads what a drafted flow declares: its tag, description and calls, and no model or placement", () => {
    expect(readSource(renderSource(notes), "release-notes")).toEqual({
      tag: "release-notes",
      description: notes.description,
      flows: notes.flows,
      model: undefined,
      placement: undefined,
      warnings: [],
    })
  })

  test("source with no declaration reads as nothing, with the registry's warnings", () => {
    expect(readSource("export const flow = 1", "release-notes")).toEqual({
      tag: undefined,
      description: undefined,
      flows: undefined,
      model: undefined,
      placement: undefined,
      warnings: ["unsupported_module_metadata", "missing_description"],
    })
  })
})

describe("checkSource", () => {
  test("every check passes for a drafted flow, and for code written by hand that declares the same", () => {
    expect(checkSource(renderSource(notes), "release-notes", allowed)).toEqual([
      { check: "parses", ok: true },
      { check: "name", ok: true },
      { check: "description", ok: true },
      { check: "calls", ok: true },
      { check: "model", ok: true },
      { check: "size", ok: true },
    ])
    const written = handWritten([
      `export default Flow.make("release-notes", {`,
      `  description: "Notes.",`,
      `  capabilities: [],`,
      `  flows: [],`,
      `  model: "agent",`,
      `  payload: { input: Schema.String },`,
      `  success: Schema.String,`,
      `  body: ({ input }) => Notes.call({ input }),`,
      `})`,
    ].join("\n"))
    expect(failures(written)).toEqual([])
    expect(passes(checkSource(written, "release-notes", allowed))).toBe(true)
  })

  test("names: the pattern, the app's names, the name it should have, and a tag the reader can't evaluate", () => {
    expect(failures(renderSource({ ...notes, name: "Release" }), "Release")).toEqual(["name:pattern"])
    expect(failures(renderSource({ ...notes, name: "theme" }), "theme")).toEqual(["name:reserved"])
    expect(failures(renderSource(notes), "other-name")).toEqual(["name:mismatch"])
    const computed = renderSource(notes).replace(`Flow.make("release-notes", {`, "Flow.make(name, {")
    expect(failures(computed)).toEqual(["name:pattern"])
  })

  test("descriptions: none, blank, or over 1,024 characters", () => {
    expect(failures(renderSource({ ...notes, description: "x".repeat(1025) }))).toEqual(["description:length"])
    expect(failures(renderSource({ ...notes, description: "  " }))).toEqual(["description:length"])
    const missing = renderSource(notes).replace(/^ {2}description: .*\n/m, "")
    expect(failures(missing)).toEqual(["parses:missing_description", "description:length", "calls:unread"])
  })

  test("calls: at most 20, never an authoring or run act, and only the flows a person's flow may call", () => {
    const many = Array.from({ length: 21 }, (_, index) => `app/f${index}`)
    expect(failures(renderSource({ ...notes, flows: many }), "release-notes", many)).toEqual(["calls:too_many"])
    expect(failures(renderSource({ ...notes, flows: ["flow/new"] }), "release-notes", ["flow/new"]))
      .toEqual(["calls:forbidden"])
    expect(failures(renderSource({ ...notes, flows: ["run/cancel"] }))).toEqual(["calls:forbidden"])
    expect(failures(renderSource({ ...notes, flows: ["repo/write"] }))).toEqual(["calls:unknown"])
  })

  test("model: a provider's model id, or a placement of its own, is refused", () => {
    const declare = (line: string) => renderSource(notes).replace("  capabilities: [],", `  capabilities: [],\n${line}`)
    expect(failures(declare(`  model: "gpt-6",`))).toEqual(["model:model"])
    expect(failures(declare(`  model: ["agent", "fast"],`))).toEqual(["model:model"])
    expect(failures(declare(`  model: "agent",`))).toEqual([])
    expect(failures(`"use sandbox"\n${renderSource(notes)}`)).toEqual(["model:placement"])
  })

  test("parses: metadata the registry can't project; size: over 512 KiB", () => {
    const unprojectable = renderSource(notes).replace("  capabilities: [],", "  capabilities: granted,")
    expect(failures(unprojectable)).toEqual(["parses:unsupported_module_metadata"])
    const big = renderSource({ ...notes, instructions: "x".repeat(MAX_SOURCE_BYTES) })
    expect(failures(big)).toEqual(["size:too_large"])
  })
})
