import * as Digest from "@smthrs/core/Digest"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as ModuleFlow from "../src/ModuleFlow.ts"

// A module flow read from its source text alone, as Discovery reads a `flow.ts` and as a host reads source it keeps
// outside a file system: the descriptor, the declared tag, and each warning, without importing the module.

const provenance = new Descriptor.Provenance({ source: "person", root: "." })

const fromModule = (text: string, overrides: Partial<ModuleFlow.FromModuleOptions> = {}) =>
  ModuleFlow.fromModule({
    text,
    path: "release-notes/flow.ts",
    naming: "frontmatter",
    name: Option.none(),
    dirBasename: "release-notes",
    provenance,
    ...overrides
  })

const module = [
  "import { Flow } from \"@smthrs/flow\"",
  "import { Schema } from \"effect\"",
  "",
  "export default Flow.make(\"release-notes\", {",
  "  description: \"Summarize merged pull requests.\",",
  "  capabilities: [],",
  "  flows: [\"repo/read\", \"repo/tree\"],",
  "  payload: { input: Schema.String },",
  "  success: Schema.String,",
  "  body: ({ input }) => Notes.call({ input }),",
  "})",
  ""
].join("\n")

describe("ModuleFlow.fromModule", () => {
  it("reads the declaration: its description, calls, schemas and tag, with the text's own digest", () => {
    const result = fromModule(module)
    const descriptor = Option.getOrThrow(result.descriptor)
    expect(result.warnings).toEqual([])
    expect(result.tag).toEqual(Option.some("release-notes"))
    expect(descriptor).toMatchObject({
      name: "release-notes",
      description: "Summarize merged pull requests.",
      body: { _tag: "Module", path: "release-notes/flow.ts", contentDigest: Digest.digest(module) },
      input: { _tag: "Module", field: "input" },
      output: { _tag: "Module", field: "output" },
      flows: ["repo/read", "repo/tree"],
      capabilities: [],
      modelInvocable: true,
      frontmatter: {},
      provenance
    })
    expect(descriptor.body).not.toHaveProperty("imports")
    expect(descriptor.body).not.toHaveProperty("hostImports")
    expect(Option.isNone(descriptor.model)).toBe(true)
    expect(Option.isNone(descriptor.placement)).toBe(true)
  })

  it("records a given digest and what the module loads beside itself", () => {
    const imports = [{ path: "release-notes/src/notes.ts", contentDigest: Digest.digest("notes") }]
    const descriptor = Option.getOrThrow(
      fromModule(module, { contentDigest: "f".repeat(64), imports, hostImports: ["@smthrs/flow"] }).descriptor
    )
    expect(descriptor.body).toMatchObject({ contentDigest: "f".repeat(64), imports, hostImports: ["@smthrs/flow"] })
  })

  it("names a path-named flow by its path, and warns when its declared name says otherwise", () => {
    const named = module.replace("  description:", "  name: \"notes\",\n  description:")
    const result = fromModule(named, { naming: "path", name: Option.some("team/release-notes") })
    expect(Option.getOrThrow(result.descriptor).name).toBe("team/release-notes")
    expect(result.warnings.map((warning) => [warning.code, warning.name])).toEqual([
      ["name_field_ignored", "team/release-notes"]
    ])
    // A path-named source without a path name falls back to the directory; a frontmatter-named one never warns.
    expect(Option.getOrThrow(fromModule(module, { naming: "path" }).descriptor).name).toBe("release-notes")
    expect(fromModule(named).warnings).toEqual([])
  })

  it("records a prompt declaration, a flow with no schemas, and a payload it can't project", () => {
    const prompt = fromModule([
      "export default Flow.make(\"release-notes\", {",
      "  description: \"Notes.\",",
      "  prompt: () => \"Summarize.\"",
      "})"
    ].join("\n"))
    expect(Option.getOrThrow(prompt.descriptor)).toMatchObject({
      body: { _tag: "Module", prompt: true },
      input: { _tag: "None" },
      output: { _tag: "None" }
    })
    const opaque = fromModule(module.replace("  payload: { input: Schema.String },", "  payload: Payload,"))
    const input = Option.getOrThrow(opaque.descriptor).input
    expect(input).toMatchObject({ _tag: "Module", field: "input" })
    expect(input).not.toHaveProperty("document")
  })

  it("has no descriptor without a literal description, and keeps the tag it read", () => {
    const result = fromModule(module.replace("  description: \"Summarize merged pull requests.\",\n", ""))
    expect(Option.isNone(result.descriptor)).toBe(true)
    expect(result.tag).toEqual(Option.some("release-notes"))
    expect(result.warnings.map((warning) => warning.code)).toEqual(["missing_description"])
  })

  it("warns about metadata it can't read, with the line when it has one, and reads a budget", () => {
    const unreadable = fromModule("export const flow = 1")
    expect(unreadable.tag).toEqual(Option.none())
    expect(unreadable.warnings.map((warning) => warning.code)).toEqual([
      "unsupported_module_metadata",
      "missing_description"
    ])
    expect(unreadable.warnings[0]!.message).toBe("Could not statically read the default Flow.make declaration")

    const budgeted = fromModule(
      module.replace("  capabilities: [],", "  capabilities: [],\n  budget: { tokens: 1000 },")
    )
    expect(Option.getOrThrow(budgeted.descriptor).budget).toEqual({ tokens: 1000 })

    const lined = fromModule(module.replace("  capabilities: [],", "  capabilities: granted,"))
    expect(lined.warnings.map((warning) => [warning.code, warning.message])).toEqual([[
      "unsupported_module_metadata",
      "Capabilities must be a string-literal array for discovery; using the conservative wildcard at " +
      "release-notes/flow.ts:6"
    ], [
      "unsupported_module_metadata",
      "Flow authority cannot be projected statically; using the conservative wildcard at release-notes/flow.ts:7"
    ]])
  })

  // The inputs MarkdownLimitsSafety.test.ts refuses in frontmatter, declared as a Flow.make literal.
  it.each([
    ["budget: soon", "Flow.make budget must be a statically projectable object literal; flow refused"],
    ["budget: []", "Flow.make budget must be a statically projectable object literal; flow refused"],
    ["budget: {}", "Flow.make budget must declare at least one ceiling; flow refused"],
    ["budget: { tokens: \"soon\" }", "Flow.make budget.tokens must be a positive safe integer; flow refused"],
    ["budget: { tokens: 0 }", "Flow.make budget.tokens must be a positive safe integer; flow refused"],
    ["budget: { milliseconds: -1 }", "Flow.make budget.milliseconds must be a positive safe integer; flow refused"],
    ["budget: { usd: \"free\" }", "Flow.make budget.usd must be a positive dollar amount; flow refused"],
    ["budget: { token: 500 }", "Flow.make budget has an unknown key: token"],
    ["budget: { onExceeded: \"park\" }", "Flow.make budget must declare at least one ceiling; flow refused"],
    [
      "budget: { tokens: 500, milliseconds: \"soon\" }",
      "Flow.make budget.milliseconds must be a positive safe integer; flow refused"
    ],
    ["budget: { tokens: 500, token: 1 }", "Flow.make budget has an unknown key: token"],
    ["budget: limits", "Flow.make budget must be a statically projectable object literal; flow refused"],
    [
      "budget: { ...limits, tokens: 100 }",
      "Flow.make budget must be a statically projectable object literal; flow refused"
    ]
  ])("refuses an invalid declared budget, never running it unbounded: %s", (declaration, message) => {
    const result = fromModule(module.replace("  capabilities: [],", `  capabilities: [],\n  ${declaration},`))
    expect(Option.isNone(result.descriptor)).toBe(true)
    expect(result.tag).toEqual(Option.some("release-notes"))
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_budget", message }))
  })
})
