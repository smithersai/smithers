/**
 * The factory projection's executor half, run in process against a real
 * temporary workspace: discovery reduces each entry to its catalog fields,
 * an entry kind the projection does not know is refused by name, a render
 * failure that is not already a catalog error is reported as one, and a stale
 * home pane that cannot be removed is a typed write failure.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Factory from "@smthrs/targets/Factory"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { layerNonInteractiveNodeServices } from "../src/engine.ts"
import { discoverFlows, discoverWorkflows, renderProjection } from "../src/FactoryProjectionExec.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-factory-discovery-")))
})
afterEach(async () => {
  await Fs.chmod(NodePath.join(root, "pane"), 0o700).catch(() => undefined)
  await Fs.rm(root, { recursive: true, force: true })
})

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layerNonInteractiveNodeServices>>) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provide(layerNonInteractiveNodeServices))))

const lintFlow = "---\ndescription: Lints the named files.\nbudget:\n  tokens: 500\n---\n\n# Lint\n"
const moduleFlow = (id: string) =>
  `export default Flow.make(${JSON.stringify(id)}, { description: "Runs ${id}.", capabilities: [] })\n`
const skill = "---\nname: deploy\ndescription: Deploys the service.\n---\n\n# Deploy\n"

const payload = (overrides: Partial<Factory.Payload>): Factory.Payload => ({
  root: "flows",
  workflows: "workflows",
  output: "out/factory.json",
  homeOutput: "pane/home.json",
  mode: "write",
  factory: S.Factory({ summary: "Builds itself.", flows: [] }),
  home: null,
  ...overrides
})

describe("discoverFlows", () => {
  it("reduces Markdown flows and skills to catalog rows, carrying only the budget ceilings declared", async () => {
    await write("flows/lint/flow.mdx", lintFlow)
    await write("flows/deploy/SKILL.md", skill)
    await write("flows/typed/flow.ts", moduleFlow("typed"))
    await write("flows/timed/flow.mdx", lintFlow.replace("tokens: 500", "milliseconds: 60000"))
    const result = await run(discoverFlows(root, "flows"))
    if (result._tag === "Failure") throw new Error(String(result.failure))
    const byId = new Map(result.success.map((flow) => [flow.id, flow]))
    expect(byId.get("lint")).toMatchObject({ kind: "mdx", path: "flows/lint/flow.mdx", budget: { tokens: 500 } })
    expect(Object.keys(byId.get("lint")!.budget!)).toEqual(["tokens"])
    expect(byId.get("deploy")).toMatchObject({ kind: "skill", path: "flows/deploy/SKILL.md" })
    expect(byId.get("deploy")).not.toHaveProperty("budget")
    expect(byId.get("timed")!.budget).toEqual({ milliseconds: 60000 })
    expect(byId.get("typed")).toMatchObject({ kind: "ts", path: "flows/typed/flow.ts", description: "Runs typed." })
    expect(byId.get("typed")).not.toHaveProperty("inputSchema")
    expect(byId.get("lint")!.inputSchema).toBeDefined()
  })

  it("refuses an entry kind the projection does not know, naming the flow and the entry file", async () => {
    await write("flows/native/flow.vibe", moduleFlow("native"))
    const result = await run(discoverFlows(root, "flows"))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        message: expect.stringMatching(/^discovery reported "native" from an entry the projection does not know: /)
      })
    }
  })
})

const gateFlow = (description: string) =>
  `import { Flow } from "@smthrs/flow"\nimport { Schema } from "effect"\nexport default Flow.make("gate", { description: ${
    JSON.stringify(description)
  }, modelInvocable: false, payload: { sha: Schema.String }, body: () => undefined })\n`

describe("discoverWorkflows", () => {
  it("reads <name>.vibe as a module workflow with its declared metadata", async () => {
    await write("workflows/gate.vibe", gateFlow("Runs the gate."))
    const result = await run(discoverWorkflows(root, "workflows"))
    if (result._tag === "Failure") throw new Error(String(result.failure))
    expect(result.success).toHaveLength(1)
    expect(result.success[0]).toMatchObject({
      id: "gate",
      kind: "ts",
      path: "workflows/gate.vibe",
      description: "Runs the gate.",
      modelInvocable: false
    })
    expect(result.success[0]!.inputSchema).toBeDefined()
  })

  it("reads <name>.vibe before <name>.ts and keeps a .ts with no .vibe", async () => {
    await write("workflows/gate.vibe", gateFlow("From vibe."))
    await write("workflows/gate.ts", gateFlow("From ts."))
    await write("workflows/typed.ts", moduleFlow("typed"))
    const result = await run(discoverWorkflows(root, "workflows"))
    if (result._tag === "Failure") throw new Error(String(result.failure))
    expect(result.success.map((flow) => [flow.id, flow.path, flow.description])).toEqual([
      ["gate", "workflows/gate.vibe", "From vibe."],
      ["typed", "workflows/typed.ts", "Runs typed."]
    ])
  })

  it("skips declarations, tests, invalid names, and a script that declares no Flow.make", async () => {
    await write("workflows/gate.d.ts", "export default {}\n")
    await write("workflows/gate.test.ts", moduleFlow("gate"))
    await write("workflows/Bad.vibe", moduleFlow("Bad"))
    await write("workflows/ci.tsx", moduleFlow("ci"))
    await write("workflows/fast-check.ts", "import { spawnSync } from \"node:child_process\"\nspawnSync(\"true\")\n")
    const result = await run(discoverWorkflows(root, "workflows"))
    if (result._tag === "Failure") throw new Error(String(result.failure))
    expect(result.success).toEqual([])
  })

  it("holds no workflows when the directory is missing", async () => {
    const result = await run(discoverWorkflows(root, "workflows"))
    expect(result).toMatchObject({ _tag: "Success", success: [] })
  })

  it("refuses a workflow whose Flow.make tag is not its file name, by path", async () => {
    await write("workflows/gate.vibe", moduleFlow("other"))
    const result = await run(discoverWorkflows(root, "workflows"))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.message).toMatch(
        /^the workflow workflows\/gate\.vibe declares Flow\.make\("other"\); a workflow's tag is its file name, "gate"/
      )
    }
  })

  it("refuses a declared workflow the module reader cannot read rather than dropping it", async () => {
    await write("workflows/gate.vibe", "export default Flow.make(\"gate\", { capabilities: [] })\n")
    const result = await run(discoverWorkflows(root, "workflows"))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.message).toMatch(/^the workflow workflows\/gate\.vibe could not be read: .*description/)
    }
  })

  it("refuses a workflow entry that is not a regular file", async () => {
    await Fs.mkdir(NodePath.join(root, "workflows", "gate.vibe"), { recursive: true })
    const result = await run(discoverWorkflows(root, "workflows"))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.message).toBe("the workflow workflows/gate.vibe is not a regular file")
    }
  })

  it("refuses a workflows path that is a file, not a directory", async () => {
    await write("workflows", "not a directory\n")
    const result = await run(discoverWorkflows(root, "workflows"))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.message).toMatch(/^could not list the workflows under workflows: /)
    }
  })
})

describe("renderProjection", () => {
  it("projects the workflow in place of the flows/<name>/flow.ts of the same id", async () => {
    await write("flows/gate/flow.ts", gateFlow("From the older layout."))
    await write("flows/review/flow.mdx", "---\ndescription: Reviews the change.\n---\n\n# Review\n")
    await write("workflows/gate.vibe", gateFlow("From the workflows directory."))
    const result = await run(renderProjection(root, payload({})))
    if (result._tag === "Failure") throw new Error(String(result.failure))
    const projected = JSON.parse(await Fs.readFile(NodePath.join(root, "out", "factory.json"), "utf8"))
    expect(
      projected.flows.map((
        flow: { id: string; path: string; description: string }
      ) => [flow.id, flow.path, flow.description])
    )
      .toEqual([
        ["gate", "workflows/gate.vibe", "From the workflows directory."],
        ["review", "flows/review/flow.mdx", "Reviews the change."]
      ])
  })

  it("reports a render failure that is not a catalog error as a catalog error and writes nothing", async () => {
    await write("flows/review/flow.mdx", "---\ndescription: Reviews the change.\n---\n\n# Review\n")
    // A declaration that bypassed its constructor: the projection schema, not the catalog, rejects it.
    const declared = S.Factory({ summary: "Builds itself.", flows: [] })
    const factory = {
      ...declared,
      github: { ...declared.github, mirror: "sideways" }
    } as unknown as Factory.Declaration
    const result = await run(renderProjection(root, payload({ factory })))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("smithers-build/FlowCatalogError")
    }
    await expect(Fs.access(NodePath.join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the write when a stale home pane cannot be removed, after publishing the factory projection",
    async () => {
      await write("flows/lint/flow.mdx", lintFlow)
      await write("pane/home.json", "{\"blocks\":[]}\n")
      await Fs.chmod(NodePath.join(root, "pane"), 0o500)
      const result = await run(renderProjection(root, payload({})))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({ _tag: "smithers-build/WriteFileError", path: "pane/home.json" })
        expect(result.failure.message).toMatch(/EACCES|EPERM/)
      }
      expect(await Fs.readFile(NodePath.join(root, "pane", "home.json"), "utf8")).toBe("{\"blocks\":[]}\n")
      expect(JSON.parse(await Fs.readFile(NodePath.join(root, "out", "factory.json"), "utf8"))).toMatchObject({
        summary: "Builds itself."
      })
    }
  )
})
