/*
 * The graph card's detail drawer, fact by fact (docs/LOCAL-APP.md "Cards:
 * target graph"). The authors' suite covers the drawer's happy shape; these
 * are the plan facts a real planner emits and the branches nothing rendered:
 * a typed refusal, argv with its copy affordance, sandbox, outputs, the last
 * run's timing and reason, and the declaration source's "Open".
 *
 * Each fact is optional in the contract, so each is a branch a UI can drop
 * silently — the drawer is where an operator answers "why did this rebuild".
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { GraphNode, NodeTiming, TargetGraphResponse } from "@smthrs/rpc/TargetGraph"
import type { Card } from "../state/AppState"
import { GraphCardBody } from "./GraphCard"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const NODE: GraphNode = {
  label: "//src:typeCheck",
  package: "//src",
  name: "typeCheck",
  rule: "Shell.Test",
  kinds: ["test"],
  private: false
}

const graphOf = (node: GraphNode): TargetGraphResponse => ({
  repoId: "force",
  nodes: [node, { ...NODE, label: "//src:srcs", name: "srcs", rule: "Filegroup", kinds: [] }],
  edges: [{ from: node.label, to: "//src:srcs", kind: "deps" }],
  warnings: [],
  generatedAt: new Date(0).toISOString(),
  durationMs: 1
})

const card = (
  payload: Partial<Extract<Card, { kind: "graph" }>["payload"]>
): Extract<Card, { kind: "graph" }> => ({
  id: "graph-force",
  kind: "graph",
  title: "force graph",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: { repoId: "force", repoName: "force", status: "done", graph: graphOf(NODE), ...payload }
})

const render = (
  body: Extract<Card, { kind: "graph" }>,
  onRunCommand: (name: string, args?: string) => void = () => {}
): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => createRoot(host).render(<GraphCardBody card={body} onRunCommand={onRunCommand} />))
  return host
}

const drawer = (host: HTMLElement): HTMLElement => {
  const found = host.querySelector<HTMLElement>("[data-testid^=\"graph-drawer-\"]")
  if (found === null) throw new Error("the drawer did not open")
  return found
}

/** The named fact's rendered value, or undefined when the drawer omitted it. */
const fact = (host: HTMLElement, name: string): string | undefined => {
  for (const row of drawer(host).querySelectorAll(".graph-drawer-fact")) {
    if (row.querySelector(".graph-drawer-fact-name")?.textContent === name) {
      return row.querySelector(".graph-drawer-fact-value")?.textContent ?? ""
    }
  }
  return undefined
}

beforeEach(() => {
  document.body.innerHTML = ""
})

test("a planned node shows mode, cacheability, the key preview, sandbox and outputs", () => {
  const planned: GraphNode = {
    ...NODE,
    plan: {
      mode: "check",
      cacheable: true,
      key: "83972035f4fb7ae765630a96173ee529617cc5e3c6a249a6b083297e1306d546",
      sandbox: "loader",
      outDirs: ["dist"],
      outFiles: ["tsconfig.tsbuildinfo"]
    }
  }
  const host = render(card({ graph: graphOf(planned), focus: planned.label }))
  expect(fact(host, "mode")).toBe("check")
  expect(fact(host, "cacheable")).toBe("yes")
  /* A key is 64 hex characters; the drawer shows a preview, never the whole. */
  expect(fact(host, "key")).toBe("83972035f4fb7ae7…")
  expect(fact(host, "sandbox")).toBe("loader")
  expect(fact(host, "outputs")).toBe("dist, tsconfig.tsbuildinfo")
})

test("an uncacheable node says so rather than omitting the fact", () => {
  const host = render(card({ graph: graphOf({ ...NODE, plan: { cacheable: false } }), focus: NODE.label }))
  expect(fact(host, "cacheable")).toBe("no")
  /* Facts the plan did not carry are absent, not blank rows. */
  expect(fact(host, "mode")).toBeUndefined()
  expect(fact(host, "sandbox")).toBeUndefined()
  expect(fact(host, "outputs")).toBeUndefined()
})

test("a typed refusal is announced, not buried in a fact row", () => {
  const refusal = "Github.CiGen: approval required before writing .github/workflows"
  const host = render(card({ graph: graphOf({ ...NODE, plan: { refusal } }), focus: NODE.label }))
  const alert = drawer(host).querySelector(".graph-drawer-refusal")
  expect(alert?.getAttribute("role")).toBe("alert")
  expect(alert?.textContent).toBe(refusal)
})

test("argv renders joined and the copy button reports it copied", () => {
  const argv = ["node", "--experimental-strip-types", "tsc", "--noEmit"]
  const written: Array<string> = []
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) }
  })
  const host = render(card({ graph: graphOf({ ...NODE, plan: { argv } }), focus: NODE.label }))
  expect(host.querySelector(".graph-drawer-argv")?.textContent).toBe(argv.join(" "))
  const copy = [...drawer(host).querySelectorAll("button")].find((button) => button.textContent === "Copy")
  expect(copy).toBeDefined()
  flushSync(() => copy!.click())
  expect(written).toEqual([argv.join(" ")])
  /* The label flips, so the human knows the click landed. */
  expect([...drawer(host).querySelectorAll("button")].some((button) => button.textContent === "Copied")).toBe(true)
})

test("an empty argv array renders no argv row", () => {
  const host = render(card({ graph: graphOf({ ...NODE, plan: { argv: [] } }), focus: NODE.label }))
  expect(host.querySelector(".graph-drawer-argv")).toBeNull()
})

test("the last run's status, duration and failure reason reach the drawer", () => {
  const timing: NodeTiming = {
    label: NODE.label,
    status: "failed",
    startedAt: 1000,
    endedAt: 3400,
    durationMs: 2400,
    reason: "tsc exited 2: 3 errors"
  }
  const host = render(card({ focus: NODE.label, runId: "run-1", run: { nodes: [timing] } }))
  const lastRun = fact(host, "last run")
  expect(lastRun).toContain("2.4s")
  expect(lastRun).toContain("tsc exited 2: 3 errors")
})

test("a node the run never touched shows no last-run fact", () => {
  const host = render(card({
    focus: NODE.label,
    runId: "run-1",
    run: { nodes: [{ label: "//src:srcs", status: "ran", durationMs: 1 }] }
  }))
  expect(fact(host, "last run")).toBeUndefined()
})

test("the declaration source opens through the command seam, with and without a line", () => {
  const commands: Array<[string, string | undefined]> = []
  const withLine = render(
    card({ graph: graphOf({ ...NODE, source: { file: "src/PACKAGE.ts", line: 42 } }), focus: NODE.label }),
    (name, args) => commands.push([name, args])
  )
  expect(fact(withLine, "source")).toContain("src/PACKAGE.ts:42")
  const open = [...drawer(withLine).querySelectorAll("button")].find((button) => button.textContent === "Open")
  flushSync(() => open!.click())
  expect(commands).toEqual([["target.source.open", "force src/PACKAGE.ts:42"]])

  document.body.innerHTML = ""
  commands.length = 0
  const noLine = render(
    card({ graph: graphOf({ ...NODE, source: { file: "src/PACKAGE.ts" } }), focus: NODE.label }),
    (name, args) => commands.push([name, args])
  )
  expect(fact(noLine, "source")).toContain("src/PACKAGE.ts")
  const openBare = [...drawer(noLine).querySelectorAll("button")].find((button) => button.textContent === "Open")
  flushSync(() => openBare!.click())
  expect(commands).toEqual([["target.source.open", "force src/PACKAGE.ts"]])
})

test("a node with no kinds renders no kinds row", () => {
  const host = render(card({ graph: graphOf({ ...NODE, kinds: [] }), focus: NODE.label }))
  expect(fact(host, "kinds")).toBeUndefined()
  expect(fact(host, "rule")).toBe("Shell.Test")
})

test("a failed graph shows the backend's error text, never an empty canvas", () => {
  const host = render(card({ status: "failed", graph: undefined, error: "The loader exited 1: no WORKSPACE.ts" }))
  const alert = host.querySelector("[role=\"alert\"]")
  expect(alert?.textContent).toBe("The loader exited 1: no WORKSPACE.ts")
  expect(host.querySelector(".graph-card")).toBeNull()
})

test("a failed graph with no error text still refuses to render a graph", () => {
  const host = render(card({ status: "failed", graph: undefined }))
  expect(host.querySelector("[role=\"alert\"]")?.textContent).toBe("The target graph did not load.")
})

test("a pending graph says it is loading rather than showing zero targets", () => {
  const host = render(card({ status: "pending", graph: undefined }))
  expect(host.textContent).toContain("Loading the target graph…")
  expect(host.querySelector(".graph-card-counts")).toBeNull()
})

test("an empty repository renders the card with zero counts and no drawer", () => {
  const empty: TargetGraphResponse = { repoId: "force", nodes: [], edges: [], warnings: [], generatedAt: "", durationMs: 0 }
  const host = render(card({ graph: empty }))
  expect(host.querySelector(".graph-card-counts")?.textContent).toBe("0 targets · 0 edges")
  expect(host.querySelector("[data-testid^=\"graph-drawer-\"]")).toBeNull()
})

test("focusing a label the graph does not contain opens no drawer", () => {
  const host = render(card({ focus: "//nope:missing" }))
  expect(host.querySelector("[data-testid^=\"graph-drawer-\"]")).toBeNull()
  /* The graph itself still renders: an unknown focus is not a failure. */
  expect(host.querySelector(".graph-card-counts")?.textContent).toBe("2 targets · 1 edges")
})
