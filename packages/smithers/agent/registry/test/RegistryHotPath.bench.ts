import * as Option from "effect/Option"
import { describe, test } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Disclosure from "../src/Disclosure.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"

const provenance = new Descriptor.Provenance({ source: "project", root: "/workspace/.smithers/flows" })

const sampleSkill = [
  "---",
  "name: review-pr",
  "description: Review a pull request for correctness, security, and test coverage",
  "capabilities:",
  "  - fs:read:/workspace/**",
  "  - net:github",
  "---",
  "# Review Instructions",
  "",
  "Inspect the changed files and verify every public contract.",
  "Arguments: $ARGUMENTS",
  "",
  "Check edge cases, resource bounds, and regression tests."
].join("\n")

const parsedFlow = Option.getOrThrow(
  MarkdownFlow.fromMarkdown({
    text: sampleSkill,
    path: "/workspace/.smithers/flows/review-pr/SKILL.md",
    baseDirectory: "/workspace/.smithers/flows/review-pr",
    naming: "frontmatter",
    name: Option.some("review-pr"),
    dirBasename: "review-pr",
    provenance
  }).descriptor
)

const flowBody = MarkdownFlow.loadBody(sampleSkill, "/workspace/.smithers/flows/review-pr")

const fiftyDescriptors: ReadonlyArray<Descriptor.FlowDescriptor> = Array.from({ length: 50 }, (_, i) =>
  Option.getOrThrow(
    MarkdownFlow.fromMarkdown({
      text: `---\nname: flow-${i}\ndescription: Execute durable workflow step ${i} across workspace\n---\nRun task ${i}.`,
      path: `/workspace/.smithers/flows/flow-${i}/SKILL.md`,
      baseDirectory: `/workspace/.smithers/flows/flow-${i}`,
      naming: "frontmatter",
      name: Option.some(`flow-${i}`),
      dirBasename: `flow-${i}`,
      provenance
    }).descriptor
  ))

describe("registry hot paths", () => {
  test("MarkdownFlow.fromMarkdown", async ({ bench }) => {
    await bench("parse SKILL.md frontmatter into FlowDescriptor", () => {
      MarkdownFlow.fromMarkdown({
        text: sampleSkill,
        path: "/workspace/.smithers/flows/review-pr/SKILL.md",
        baseDirectory: "/workspace/.smithers/flows/review-pr",
        naming: "frontmatter",
        name: Option.some("review-pr"),
        dirBasename: "review-pr",
        provenance
      })
    }).run({ time: 120, warmupTime: 30 })
  })

  test("MarkdownFlow.loadBody and renderPrompt", async ({ bench }) => {
    await bench("load prompt body and render arguments", () => {
      const body = MarkdownFlow.loadBody(sampleSkill, "/workspace/.smithers/flows/review-pr")
      MarkdownFlow.renderPrompt(body, { args: "PR #4242 --strict" })
      MarkdownFlow.renderPrompt(flowBody, { args: parsedFlow.name })
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Disclosure.toXml", async ({ bench }) => {
    await bench("render XML disclosure for 50 flow descriptors", () => {
      Disclosure.toXml(fiftyDescriptors)
    }).run({ time: 120, warmupTime: 30 })
  })
})
