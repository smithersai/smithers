import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Detect from "../src/Detect.ts"
import * as Inventory from "../src/Inventory.ts"
import * as Mapping from "../src/Mapping.ts"
import { copyFixture, nodeLayer } from "./fixtures/helpers.ts"

const inventory = (name: string) =>
  Effect.gen(function*() {
    const detection = yield* Detect.scan(copyFixture(name))
    const hits = yield* Inventory.scan(detection)
    return { detection, hits }
  }).pipe(Effect.provide(nodeLayer))

const count = (hits: ReadonlyArray<Inventory.InventoryEntry>, construct: string): number =>
  hits.filter((hit) => hit.construct === construct).length

describe("Inventory.scan over jsx-single", () => {
  it.effect("resolves components through a wrapped createSmithers factory", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("jsx-single")
      const workflow = hits.filter((hit) => hit.file === "simple-workflow.jsx")

      expect(count(workflow, "Workflow")).toBe(1)
      expect(count(workflow, "Sequence")).toBe(1)
      expect(count(workflow, "Task")).toBe(2)
      expect(workflow.filter((hit) => hit.construct === "Task" && hit.props.includes("agent"))).toHaveLength(2)
      expect(count(workflow, "ctx.input")).toBe(1)
      expect(workflow.filter((hit) => hit.construct === "Task" && hit.props.includes("deps"))).toHaveLength(1)
    }))

  it.effect("carries the source a mapping decision needs", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("jsx-single")
      const write = hits.find((hit) => hit.construct === "Task" && hit.detail?.["id"] === "write")

      expect(write?.detail?.["output"]).toBe("outputs.output")
      expect(write?.detail?.["deps"]).toBe("{ research: outputs.research }")
      // The zod chain behind `outputs.output`, verbatim from the source.
      expect(write?.detail?.["outputChain"]).toBe(
        "z.object({\n    article: z.string(),\n    wordCount: z.number(),\n})"
      )
      // The payload the step reads, resolved through `deps` to the fields of
      // the research schema. Nothing here is guessed.
      expect(JSON.parse(write?.detail?.["payloadFields"] ?? "null")).toEqual({
        summary: "z.string()",
        keyPoints: "z.array(z.string())"
      })
      expect(write?.detail?.["promptText"]).toContain("Write a short article based on this research")
      expect(write?.detail?.["agentProvider"]).toBe("anthropic")
      // The model the source names, not a default.
      expect(write?.detail?.["agentModel"]).toBe("claude-sonnet-5")
      expect(write?.detail?.["agentInstructions"]).toBe("You are a technical writer. Write clear, engaging content.")
      expect(write?.detail?.["children"]).toContain("(deps) =>")
    }))

  it.effect("records every read through a factory binding", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("jsx-single")

      // `outputs.research` twice (the research task's `output` and the write
      // task's `deps`) and `outputs.output` once.
      expect(count(hits, "outputs.<key>")).toBe(3)
      expect(hits.filter((hit) => hit.construct === "outputs.<key>").map((hit) => hit.detail?.["key"])).toEqual([
        "research",
        "output",
        "research"
      ])
      expect(count(hits, "smithers")).toBe(1)
      expect(count(hits, "tables.<key>")).toBe(0)
    }))

  it.effect("records the createSmithers call in the library that wraps it", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("jsx-single")

      expect(hits.filter((hit) => hit.construct === "createSmithers").map((hit) => hit.file)).toEqual([
        "_example-kit.js",
        "simple-workflow.jsx"
      ])
    }))
})

describe("Inventory.scan over plue-pack", () => {
  it.effect("finds one createSmithers per workflow file", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("plue-pack")

      expect(hits.filter((hit) => hit.construct === "createSmithers").map((hit) => hit.file)).toEqual([
        ".smithers/workflows/implement.tsx",
        ".smithers/workflows/pipelines/ci-fast.tsx",
        ".smithers/workflows/ralph.tsx",
        ".smithers/workflows/review.tsx"
      ])
    }))

  it.effect("finds the Panel, the unbounded Loop, the UI, and the outputMaybe reads", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("plue-pack")

      expect(count(hits, "Panel")).toBe(1)
      expect(count(hits, "UI")).toBe(1)
      expect(count(hits, "ctx.outputMaybe")).toBe(2)

      const ralph = hits.find((hit) => hit.construct === "Loop" && hit.file.endsWith("ralph.tsx"))
      expect(ralph?.props).toEqual(["maxIterations", "until"])
      expect(ralph?.detail?.["until"]).toBe("false")
      expect(ralph?.detail?.["maxIterations"]).toBe("Infinity")
    }))

  it.effect("counts the reads through the factory bindings", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("plue-pack")

      expect(count(hits, "outputs.<key>")).toBe(5)
      expect(count(hits, "smithers")).toBe(4)
      expect(count(hits, "tables.<key>")).toBe(0)
      expect(count(hits, "db.<member>")).toBe(0)
    }))

  it.effect("finds every agent constructor with the model it names", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("plue-pack")
      const agents = hits.filter((hit) => hit.file === ".smithers/agents.ts")

      expect(count(agents, "CodexAgent")).toBe(8)
      expect(count(agents, "ClaudeCodeAgent")).toBe(3)
      expect(count(agents, "OpenAIAgent")).toBe(1)
      expect(agents.find((hit) => hit.construct === "OpenAIAgent")?.props).toContain("baseURL")
      expect(agents[0]?.detail).toEqual({ model: "claude-fable-5" })
    }))

  it.effect("takes nothing from the workflow written against a foreign API", () =>
    Effect.gen(function*() {
      const { detection, hits } = yield* inventory("plue-pack")

      expect(hits.filter((hit) => hit.file === ".smithers/workflows/release.tsx")).toEqual([])
      expect(
        detection.warnings.filter((warning) => warning.code === "unknown-authoring-api").map((warning) => warning.file)
      ).toEqual([".smithers/workflows/release.tsx"])
    }))
})

describe("Inventory helpers", () => {
  it("collects the zod chains a file declares", () => {
    const chains = Inventory.zodChains(
      "schemas.ts",
      "import { z } from \"zod\";\nconst a = z.object({ x: z.string() });\nconst b = 1;\n"
    )

    expect(chains).toEqual([{ name: "a", chain: "z.object({ x: z.string() })" }])
  })

  it("collects the mdx prompts a workflow imports", () => {
    const found = Inventory.mdxImports(
      "flow.tsx",
      "import Research from \"./prompts/research.mdx\";\nimport { z } from \"zod\";\n"
    )

    expect(found).toEqual([{ local: "Research", specifier: "./prompts/research.mdx" }])
  })

  it("treats a local wrapper of createSmithers as a factory", () => {
    const names = Inventory.factoryNames(
      new Map([["kit.js", "export function makeKit(s) { return createSmithers(s, {}); }"]])
    )

    expect(names.has("makeKit")).toBe(true)
    expect(names.has("createSmithers")).toBe(true)
  })
})

describe("Inventory.scan over batch-issues", () => {
  it.effect("resolves the factory bindings a re-export module hands out", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("batch-issues")

      // No component in this pack calls `createSmithers`: one module does, and
      // re-exports the bindings. Without following that, every count is zero.
      expect(hits.filter((hit) => hit.construct === "createSmithers").map((hit) => hit.file)).toEqual([
        ".smithers/workflows/batch-issues/smithers.ts"
      ])
      expect(count(hits, "Workflow")).toBe(1)
      expect(count(hits, "Task")).toBe(13)
      expect(count(hits, "Sequence")).toBe(5)
      expect(count(hits, "Parallel")).toBe(4)
      expect(count(hits, "Branch")).toBe(1)
      expect(count(hits, "Ralph")).toBe(1)
      expect(count(hits, "Worktree")).toBe(1)
      expect(count(hits, "MergeQueue")).toBe(1)
    }))

  it.effect("counts every member read through a factory binding", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("batch-issues")

      expect(count(hits, "outputs.<key>")).toBe(13)
      expect(count(hits, "tables.<key>")).toBe(30)
      expect(count(hits, "smithers")).toBe(1)
      expect(
        [...new Set(hits.filter((hit) => hit.construct === "tables.<key>").map((hit) => hit.detail?.["key"]))].sort()
      ).toEqual(["ci", "fetchIssues", "geminiContext", "implement", "plan", "report", "research", "review", "validate"])
    }))

  it.effect("counts the ctx accessors the pack reads", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("batch-issues")

      expect(count(hits, "ctx.latest")).toBe(28)
      expect(count(hits, "ctx.latestArray")).toBe(6)
      expect(count(hits, "ctx.iterationCount")).toBe(2)
    }))

  it.effect("finds the CLI agents the pack constructs", () =>
    Effect.gen(function*() {
      const { hits } = yield* inventory("batch-issues")

      expect(count(hits, "ClaudeCodeAgent")).toBe(1)
      expect(count(hits, "CodexAgent")).toBe(1)
      expect(count(hits, "GeminiAgent")).toBe(1)
    }))
})

describe("Inventory.scan over mixed-api", () => {
  it.effect("binds the 0.x half of a file and leaves the foreign factory alone", () =>
    Effect.gen(function*() {
      // `issue-pipeline.tsx` destructures a `createSmithers` that came from
      // `@smithers-ai/workflow`. Binding it would record that project's
      // `<Workflow triggers>` and `<Task if>` against the 0.x components, which
      // declare neither prop, and would hand the rewriter tags it cannot
      // translate.
      const { hits } = yield* inventory("mixed-api")

      expect(count(hits, "Workflow")).toBe(0)
      expect(count(hits, "Task")).toBe(0)
      expect(count(hits, "outputs.<key>")).toBe(0)
      expect(count(hits, "Worktree")).toBe(1)
      expect(count(hits, "ClaudeCodeAgent")).toBe(1)
      expect(count(hits, "CodexAgent")).toBe(1)
    }))

  it.effect("keeps binding a factory of the same name that came from the old facade", () =>
    Effect.gen(function*() {
      // The guard is about where the factory came from, not what it is called.
      const source = [
        "/** @jsxImportSource smthrs */",
        "import { createSmithers } from \"smthrs\"",
        "const { Workflow, Task, smithers, outputs } = createSmithers({ value: z.object({ v: z.string() }) })",
        "const flow = smithers(() => <Workflow name=\"w\"><Task id=\"a\" output={outputs.value}>x</Task></Workflow>)"
      ].join("\n")
      const factories = Inventory.factoryNames(new Map([["w.tsx", source]]))

      const hits = Inventory.scanFile("w.tsx", source, { factories })

      expect(count(hits, "Workflow")).toBe(1)
      expect(count(hits, "Task")).toBe(1)
    }))
})

describe("Inventory.scanFile over a namespace import", () => {
  it("resolves components, agents, runtime calls, and factory bindings through the namespace", () => {
    // `import * as Old from "smthrs"` is the old public API as much as a named
    // import is. Losing it hid an unsupported `<Old.Worktree>` from the gate.
    const source = [
      "/** @jsxImportSource smthrs */",
      "import * as Old from \"smthrs\"",
      "const { Workflow, Task, outputs } = Old.createSmithers({ value: z.object({ v: z.string() }) })",
      "const agent = new Old.ClaudeCodeAgent({ model: \"claude-fable-5\" })",
      "export default <Workflow name=\"w\"><Old.Worktree path=\".\"><Task id=\"a\" output={outputs.value} agent={agent}>x</Task></Old.Worktree></Workflow>",
      "Old.runWorkflow(flow, {})"
    ].join("\n")
    const factories = Inventory.factoryNames(new Map([["w.tsx", source]]))

    const hits = Inventory.scanFile("w.tsx", source, { factories })

    expect(count(hits, "Worktree")).toBe(1)
    expect(hits.find((hit) => hit.construct === "Worktree")?.detail?.["childConstructs"]).toBe("Task:a")
    expect(count(hits, "ClaudeCodeAgent")).toBe(1)
    expect(count(hits, "runWorkflow")).toBe(1)
    expect(count(hits, "createSmithers")).toBe(1)
    expect(count(hits, "Workflow")).toBe(1)
    expect(count(hits, "Task")).toBe(1)
    expect(count(hits, "outputs.<key>")).toBe(1)
  })

  it("leaves a namespace of an unrelated package alone", () => {
    const source = [
      "import * as Other from \"other-ui\"",
      "export default <Other.Worktree path=\".\" />",
      "new Other.ClaudeCodeAgent({})"
    ].join("\n")

    expect(Inventory.scanFile("w.tsx", source, { factories: new Set(["createSmithers"]) })).toEqual([])
  })
})

describe("Inventory.scan over conditionally rendered steps", () => {
  const group = (tag: string, body: string): Inventory.InventoryEntry => {
    const source = [
      "/** @jsxImportSource smthrs */",
      `import { createSmithers, ${tag} } from "smthrs"`,
      "const { Workflow, Task, smithers, outputs } = createSmithers({ result: z.string() })",
      `const flow = smithers(() => <Workflow name="w"><${tag}>${body}</${tag}></Workflow>)`
    ].join("\n")
    const factories = Inventory.factoryNames(new Map([["w.tsx", source]]))
    const hit = Inventory.scanFile("w.tsx", source, { factories }).find((entry) => entry.construct === tag)
    if (hit === undefined) throw new Error(`no ${tag} hit`)
    return hit
  }
  const a = "<Task id=\"a\" output={outputs.result}>x</Task>"
  const b = "<Task id=\"b\" output={outputs.result}>y</Task>"

  it("leaves a sequence with a step behind `false &&` to the agent", () => {
    // The 0.x program never renders `a`. A rewrite calling it would run a
    // step the source guarded off.
    const hit = group("Sequence", `{false && ${a}}${b}`)

    expect(hit.detail?.["childConstructs"]).toBe("Task:,Task:b")
    expect(Mapping.snippet(hit)).toBeUndefined()
    expect(Mapping.classify(hit)).toBe("guided")
  })

  it("leaves a parallel group with a ternary or a repeated step to the agent", () => {
    expect(group("Parallel", `{ready ? ${a} : ${b}}`).detail?.["childConstructs"]).toBe("Task:,Task:")
    const repeated = group("Parallel", `{items.map(() => ${a})}${b}`)
    expect(repeated.detail?.["childConstructs"]).toBe("Task:,Task:b")
    expect(Mapping.classify(repeated)).toBe("guided")
  })

  it("keeps naming steps every render reaches", () => {
    const hit = group("Sequence", `<>{(${a})}</>{[${b}]}`)

    expect(hit.detail?.["childConstructs"]).toBe("Task:a,Task:b")
    expect(Mapping.classify(hit)).toBe("automatic")
  })
})
