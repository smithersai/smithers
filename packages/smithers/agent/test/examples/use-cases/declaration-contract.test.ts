import { expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"
import { readdirSync, readFileSync } from "node:fs"
import * as ts from "typescript"
import { Lifetimes, Probes, Tests } from "../../../examples/use-cases/bun-port-smithers.ts"

const examples = new URL("../../../examples/use-cases/", import.meta.url)
const declarations = (filename: string, factory: string) => {
  const file = ts.createSourceFile(
    filename,
    readFileSync(new URL(filename, examples), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const found: Array<{ tag: string; properties: Map<string, ts.Expression> }> = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === factory) {
      const [tag, options] = node.arguments
      if (tag && ts.isStringLiteral(tag) && options && ts.isObjectLiteralExpression(options)) {
        const properties = new Map<string, ts.Expression>()
        for (const member of options.properties) {
          if (ts.isPropertyAssignment(member)) properties.set(member.name.getText(file), member.initializer)
        }
        found.push({ tag: tag.text, properties })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

it("declares catalog metadata on every flow in the first example collection", () => {
  const files = readdirSync(examples).filter((name) => name.endsWith(".ts") && name <= "kit.ts")
  const flows = files.flatMap((file) => declarations(file, "Flow.make"))
  expect(flows.length).toBeGreaterThanOrEqual(59)
  for (const { tag, properties } of flows) {
    const description = properties.get("description")
    expect(description && ts.isStringLiteral(description) && description.text.length > 0, tag).toBe(true)
    const capabilities = properties.get("capabilities")
    expect(capabilities && ts.isArrayLiteralExpression(capabilities), tag).toBe(true)
    const effects = properties.get("effects")
    expect(effects && ts.isObjectLiteralExpression(effects), tag).toBe(true)
    if (
      tag === "examples/IncidentRunbookMemory/RatifyRule" ||
      /examples\/(BisectGuide|BranchDoctor|DefendingCode|DependencyUpdate|DocSync|DocsFixupBot|DocsPatcher|FailingTestAuthor|FailOnlyReport|Gastown)(\/|$)/
        .test(tag)
    ) {
      expect(properties.get("modelInvocable")?.kind, tag).toBe(ts.SyntaxKind.FalseKeyword)
    }
  }
})

it("keeps agent-reported command results explicit under a host claim brake", () => {
  for (
    const [file, tag] of [
      ["command-watchdog.ts", "examples/CommandWatchdog/Run"],
      ["flake-hunter.ts", "examples/FlakeHunter/Run"],
      ["bun-port-smithers.ts", "examples/BunPortSmithers/Build"],
      ["bun-port-smithers.ts", "examples/BunPortSmithers/Probe"],
      ["bun-port-smithers.ts", "examples/BunPortSmithers/CrateCheck"]
    ]
  ) {
    const declaration = declarations(file!, "AgentAction.make").find((item) => item.tag === tag)
    const cap = declaration?.properties.get("claimCap")
    expect(cap && ts.isNumericLiteral(cap) && cap.text === "0", tag).toBe(true)
  }
})

it("admits the Bun port's sampling, probe and merge callbacks with stable identity", () => {
  for (const sampleRate of [0, 1]) {
    expect(() => Graph.build(Lifetimes, { repo: ".", files: [], sampleRate }, { callbackIdentity: "stable" })).not
      .toThrow()
  }
  expect(() =>
    Graph.build(Probes, { repo: ".", probes: [{ id: "help", cmd: "--help" }], maxRounds: 1 }, {
      callbackIdentity: "stable"
    })
  ).not.toThrow()
  for (const requireGreenBeforeMerge of [false, true]) {
    for (const awaitExternalCiSignal of [false, true]) {
      expect(() =>
        Graph.build(Tests, {
          repo: ".",
          areas: [{ id: "http", glob: "test/http", crate: "http" }],
          maxIterations: 1,
          requireGreenBeforeMerge,
          awaitExternalCiSignal
        }, { callbackIdentity: "stable" })
      ).not.toThrow()
    }
  }
})

const callbackIdentities = (graph: Graph.Graph, role: "mapper" | "predicate") =>
  Graph.nodes(graph).flatMap(({ draft }) => {
    const body = draft.material.body as { readonly mapper?: unknown; readonly predicate?: unknown } | undefined
    return body?.[role] === undefined ? [] : [body[role]]
  })

it("rekeys the sampling mapper when its declared rate changes", () => {
  const build = (sampleRate: number) =>
    callbackIdentities(
      Graph.build(Lifetimes, { repo: ".", files: [], sampleRate }, { callbackIdentity: "stable" }),
      "mapper"
    )
  const first = build(0)
  expect(first.length).toBeGreaterThan(0)
  expect(build(0)).toEqual(first)
  for (const rate of [0.01, 0.12, 0.5, 1]) expect(build(rate)).not.toEqual(first)
})

it("rekeys the merge predicate when the green-check policy changes", () => {
  const build = (requireGreenBeforeMerge: boolean) =>
    callbackIdentities(
      Graph.build(Tests, {
        repo: ".",
        areas: [{ id: "http", glob: "test/http", crate: "http" }],
        maxIterations: 1,
        requireGreenBeforeMerge
      }, { callbackIdentity: "stable" }),
      "predicate"
    )
  const required = build(true)
  expect(required.length).toBeGreaterThan(0)
  expect(build(true)).toEqual(required)
  expect(build(false)).not.toEqual(required)
})
