import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as AgentTarget from "../src/AgentTarget.ts"
import * as DocsPage from "../src/DocsPage.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Smithers from "../src/Smithers.ts"
import * as Target from "../src/Target.ts"
import * as Verb from "../src/Verb.vibe"
import { plannedCalls } from "./plan.ts"

const context: Target.ImplementationContext = { sourceFile: undefined, packageDirectory: "apps/site" }
const brief = Input.file("pages/flow/brief.md")
const prompt = Input.file("//apps/site/prompts/reference.md")
const style = Input.file("//apps/site/prompts/style.md")
const references = Filegroup.Filegroup({ srcs: [Input.glob("references/**")] })
const sources = Input.glob("//packages/smithers/flows/flow/src/**/*.ts")
const gate = Filegroup.Filegroup({ srcs: [Input.glob("src/content/**/*.mdx")] })
const output = "src/content/docs/docs/reference/packages/flow.mdx"

const page = () =>
  DocsPage.Page({
    agent: AgentTarget.Agents["default"],
    brief,
    prompt,
    references: [style, references],
    inputs: [sources],
    output,
    gates: [gate],
    maxRounds: 3
  })

describe("Docs.Page attrs", () => {
  it("decodes the docs-shaped subset and rejects the Agent.Diff-only attrs", () => {
    const decode = Schema.decodeUnknownSync(DocsPage.PageAttrs)
    const decoded = decode({ brief, prompt, references: [], inputs: [], output, gates: [], maxRounds: 1 })
    expect(decoded.output).toBe(output)
    expect(decoded.brief).toEqual(brief)
    expect(() => decode({ prompt, references: [], inputs: [], output, gates: [], maxRounds: 1 })).toThrow()
    expect(() => decode({ brief, prompt, references: [], inputs: [], output: "", gates: [], maxRounds: 1 })).toThrow()
    expect(() => decode({ brief, prompt, references: [], inputs: [], output, gates: [], maxRounds: 0 })).toThrow()
    expect(() => decode({ brief, prompt, references: [], inputs: [], output, gates: [], maxRounds: 1.5 })).toThrow()
    // A page has one output and no free-form write-set, payload spec, or MCP
    // surface: the struct carries none of those keys.
    expect(Object.keys(DocsPage.PageAttrs.fields).sort()).toEqual(
      ["agent", "approval", "brief", "gates", "inputs", "maxRounds", "output", "prompt", "references", "sandbox"]
    )
  })

  it("declares the brief, prompt, references, and inputs as the target's file inputs", () => {
    const declared = Target.metadata(page()).inputs
    expect(declared).toContainEqual(brief)
    expect(declared).toContainEqual(prompt)
    expect(declared).toContainEqual(style)
    expect(declared).toContainEqual(sources)
    expect(Target.metadata(page()).dependencies).toContain(references)
  })
})

describe("Docs.Page projection", () => {
  it("projects to the payload the equivalent Agent.Diff declaration projects to", () => {
    const attrs = {
      agent: AgentTarget.Agents["default"],
      brief,
      prompt,
      references: [style, references],
      inputs: [sources],
      output,
      gates: [gate],
      maxRounds: 3
    }
    const equivalent = {
      agent: AgentTarget.Agents["default"],
      prompt,
      data: [brief, style, references, sources],
      changes: [output],
      gates: [gate],
      maxRounds: 3
    }
    expect(DocsPage.pagePayload(attrs, context)).toEqual(AgentTarget.diffPayload(equivalent, context))
    expect(DocsPage.pagePayload(attrs, context).changes).toEqual([output])
    expect(DocsPage.pagePayload(attrs, context).gateIdentities).toEqual([AgentTarget.targetIdentity(gate)])
  })

  it("plans the sealed agent-diff action, so the existing diff lane executes it", () => {
    const call = plannedCalls(page())[0]
    expect(call?.action).toBe("smithers-build/agent-diff")
    expect(call?.payload).toMatchObject({
      promptPath: "//apps/site/prompts/reference.md",
      payloadSpec: {},
      mcp: [],
      diffs: [],
      changes: [output],
      maxRounds: 3
    })
  })

  it("refuses a fractional round count the Agent.Diff payload could not carry", () => {
    const attrs = {
      brief,
      prompt,
      references: [],
      inputs: [],
      output,
      gates: [],
      maxRounds: 1.5
    }
    expect(() => DocsPage.Page(attrs)).toThrow()
    expect(() => DocsPage.Page({ ...attrs, maxRounds: 2 })).not.toThrow()
    expect(DocsPage.pagePayload({ ...attrs, maxRounds: 2 }, context).maxRounds).toBe(2)
  })
})

describe("Docs.Page confinement", () => {
  it("carries sandbox and approval into the diff attrs the executor reads", () => {
    const attrs = {
      brief,
      prompt,
      references: [style],
      inputs: [sources],
      output,
      gates: [],
      sandbox: { network: "loopback" } as const,
      approval: "required" as const,
      maxRounds: 1
    }
    expect(DocsPage.asDiffAttrs(attrs)).toEqual({
      prompt,
      data: [brief, style, sources],
      changes: [output],
      gates: [],
      sandbox: { network: "loopback" },
      approval: "required",
      maxRounds: 1
    })
    expect(DocsPage.dataOf(attrs)).toEqual([style, sources])
  })
})

describe("Docs.Page verbs", () => {
  it("participates in docs alone and is never cached", () => {
    const metadata = Target.metadata(page())
    expect(metadata.target).toBe("Docs.Page")
    expect(metadata.kinds).toEqual(["docs"])
    expect(metadata.kinds).toContain(Verb.kind(Verb.Docs))
    expect(metadata.kinds).not.toContain("run")
    expect(metadata.cacheable).toBe(false)
  })

  it("is reachable as Smithers.Docs.Page", () => {
    expect(Smithers.Docs.Page).toBe(DocsPage.Page)
  })
})
