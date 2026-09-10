import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as CoreGraph from "@smthrs/core/Graph"
import * as Markdown from "@smthrs/core/Markdown"
import { Effect, FileSystem, Layer, Result } from "effect"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"
import * as Registry from "../src/Registry.ts"

const foreignRoot = fileURLToPath(new URL("./fixtures/foreign", import.meta.url))
const skillPath = fileURLToPath(new URL("./fixtures/foreign/pdf/SKILL.md", import.meta.url))
const skillDirectory = fileURLToPath(new URL("./fixtures/foreign/pdf", import.meta.url))
const upstreamSkillPath = fileURLToPath(new URL("./fixtures/foreign/template-skill/SKILL.md", import.meta.url))

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const discoveryLayer = Discovery.layer.pipe(
  Layer.provide(platformLayer)
)

const registryLayer = Registry.layer({
  sources: [{
    source: "foreign",
    root: foreignRoot,
    naming: "frontmatter"
  }]
}).pipe(Layer.provide(Layer.merge(discoveryLayer, platformLayer)))

describe("Skill", () => {
  it("discovers and lowers allowed-tools from Agent Skills frontmatter", async () => {
    const text = await readFile(skillPath, "utf8")
    const scan = await Effect.runPromise(
      Effect.gen(function*() {
        const discovery = yield* Discovery.Discovery
        return yield* discovery.scan({
          source: "foreign",
          root: foreignRoot,
          naming: "frontmatter"
        })
      }).pipe(Effect.provide(discoveryLayer))
    )
    const descriptor = scan.entries.find((entry) => entry.name === "pdf-processing")
    expect(descriptor).toBeDefined()
    if (descriptor === undefined) {
      return
    }

    const parsed = Markdown.parseSkill(text)
    const lowered = Markdown.lowerSkill(text)
    expect(Result.isSuccess(parsed)).toBe(true)
    expect(Result.isSuccess(lowered)).toBe(true)
    if (Result.isFailure(parsed) || Result.isFailure(lowered)) {
      return
    }

    const body = MarkdownFlow.loadBody(text, skillDirectory)
    expect(body._tag).toBe("Prompt")
    const registryFlow = Markdown.lowerMarkdown(
      MarkdownFlow.toCoreFrontmatter(descriptor),
      body.text
    )

    expect(parsed.success.name).toBe("pdf-processing")
    expect(parsed.success.description).toBe(
      "Extracts text and metadata from PDF files, repairs malformed documents, and produces accessible output."
    )
    expect(parsed.success.allowedTools).toEqual([
      "Read",
      "Write",
      "Bash(pdftotext:*)",
      "Bash(pdfinfo:*)",
      "Bash(qpdf:*)"
    ])
    expect(descriptor.flows).toEqual(parsed.success.allowedTools)
    expect(parsed.success.body).toBe(body.text)
    expect(registryFlow.body?.({ args: "" }).ast).toMatchObject({
      _tag: "Dynamic",
      prompt: body.text,
      flows: parsed.success.allowedTools
    })
    expect(lowered.success.body?.({ args: "" }).ast).toMatchObject({
      _tag: "Dynamic",
      prompt: body.text,
      flows: parsed.success.allowedTools
    })
    expect(lowered.success({ args: "report.pdf" }).ast._tag).toBe("FlowCall")
    expect(() => CoreGraph.build(lowered.success)).not.toThrow()

    const loaded = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return {
          descriptor: yield* registry.get("pdf-processing"),
          body: yield* registry.loadBody("pdf-processing"),
          prompt: yield* registry.runPrompt("pdf-processing", { args: "report.pdf" })
        }
      }).pipe(Effect.provide(registryLayer))
    )

    expect(loaded.descriptor.path).toBe(skillPath)
    expect(loaded.body).toEqual(body)
    expect(loaded.prompt).toContain(body.text)
    expect(loaded.prompt).toContain(`- Base directory: ${skillDirectory}`)
    expect(loaded.prompt).toContain("report.pdf")
  })

  it("loads an unmodified, provenance-pinned third-party SKILL.md", async () => {
    const text = await readFile(upstreamSkillPath, "utf8")
    const parsed = Result.getOrThrow(Markdown.parseSkill(text))

    expect(parsed).toMatchObject({
      name: "template-skill",
      description: "Replace with description of the skill and when Claude should use it.",
      allowedTools: [],
      body: "\n# Insert instructions below\n"
    })

    const loaded = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return {
          descriptor: yield* registry.get("template-skill"),
          body: yield* registry.loadBody("template-skill"),
          prompt: yield* registry.runPrompt("template-skill", { args: "draft" })
        }
      }).pipe(Effect.provide(registryLayer))
    )

    expect(loaded.descriptor.path).toBe(upstreamSkillPath)
    expect(loaded.body).toEqual({
      _tag: "Prompt",
      baseDirectory: fileURLToPath(new URL("./fixtures/foreign/template-skill", import.meta.url)),
      text: "\n# Insert instructions below\n"
    })
    expect(loaded.prompt).toContain("# Insert instructions below")
    expect(loaded.prompt).toContain("draft")
  })
})
