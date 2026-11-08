import { Graph } from "@smthrs/flow"
import assert from "node:assert/strict"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import todo from "../todo/flow.ts"

// A durable run records its plan's digest and refuses a resume whose rebuilt
// plan differs (plan_changed, #3906). An inline callback has a process-local
// identity that changes on every build, so a TODO that parked on a question
// failed the moment it resumed. Every plan callback is Node.capture'd.

const payload = {
  prompt: "Add a greeting to JOURNEY.md",
  feedback: "",
  maxRounds: 3,
  wiki: null,
  base: { commitId: "a".repeat(40), ref: "refs/smithers/workspaces/w/sources/" + "a".repeat(40) }
}

/** The callback identities a graph's nodes carry, in node order. */
const identities = (graph: Graph.Graph) => JSON.stringify(Graph.drafts(graph))

test("a rebuilt TODO plan keeps the recorded plan's identity", () => {
  const first = Graph.build(todo, payload)
  const rebuilt = Graph.build(todo, payload)
  assert.equal(identities(rebuilt), identities(first))
})

/**
 * A typed catch filters by an error schema whose AST holds functions. That
 * identity is the plan package's, stable within a process, not a flow callback
 * (#4212: it still differs across processes).
 */
const isCatchFilter = (diagnostic: Graph.Graph["diagnostics"][number]) =>
  diagnostic.code === "unstable_callback" && diagnostic.path.join(".") === "filter"

test("the TODO flow has no process-local plan callbacks", () => {
  const graph = Graph.build(todo, payload, { callbackIdentity: "stable" })
  const unstable = graph.diagnostics.filter((diagnostic) => !isCatchFilter(diagnostic))
  assert.deepEqual(
    unstable.map((diagnostic) => `${diagnostic.code} ${diagnostic.node} ${diagnostic.path.join(".")}`),
    []
  )
})

// Any payload: each field read is another such value, so a body builds without
// a hand-written fixture for every step flow.
const anyPayload: unknown = new Proxy({}, {
  get: (_target, key) => key === "then" || typeof key === "symbol" ? undefined : anyPayload
})

const sources = (directory: string): Array<string> =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path)
    return /\.(?:ts|vibe)$/.test(path) && !/\.(?:d|test)\.(?:ts|vibe)$/.test(path) ? [path] : []
  })

test("every coding step flow builds with stable callbacks", async () => {
  const root = new URL("../coding/", import.meta.url).pathname
  const unstable: Array<string> = []
  const built = new Set<string>()
  const flows = new Set<unknown>()
  for (const file of sources(root)) {
    // serve.ts is the host's command entry: importing it runs the command.
    if (file.endsWith("/serve.ts")) continue
    const module = await import(file)
    for (const value of Object.values(module)) {
      if (typeof value !== "function" || flows.has(value) || !("body" in value)) continue
      if (typeof value.body !== "function") continue
      flows.add(value)
      let graph: Graph.Graph
      try {
        graph = Graph.build(value as never, anyPayload, { callbackIdentity: "stable" })
      } catch {
        // A body that destructures a nested payload field needs a real payload;
        // the TODO plan above builds those steps it splices with one.
        continue
      }
      const tag = String((value as { readonly _tag?: unknown })._tag)
      built.add(tag)
      for (const diagnostic of graph.diagnostics) {
        if (isCatchFilter(diagnostic)) continue
        unstable.push(`${tag} ${diagnostic.code} ${diagnostic.node} ${diagnostic.path.join(".")}`)
      }
    }
  }
  for (const tag of ["coding/Request", "coding/CoordinateRequest", "coding/PreparePlan", "coding/RequestFeedback"]) {
    assert.ok(built.has(tag), `${tag} did not build`)
  }
  assert.deepEqual(unstable, [])
})
