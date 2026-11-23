import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { describe, test } from "vitest"
import * as CommandTree from "../src/CommandTree.vibe"
import * as Directive from "../src/Directive.ts"
import type * as Route from "../src/Route.vibe"

const makeRoute = (name: string): Route.Route => ({
  name,
  segments: name.split("/"),
  kind: "module",
  sourcePath: `/virtual/flows/${name}/flow.ts`,
  description: Option.some(`Flow ${name}`),
  input: new Descriptor.SchemaRefModule({ path: `/virtual/flows/${name}/flow.ts`, field: "input" }),
  output: new Descriptor.SchemaRefModule({ path: `/virtual/flows/${name}/flow.ts`, field: "output" }),
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  modelInvocable: true,
  placement: Option.none(),
  ui: Option.none()
})

const routes: ReadonlyArray<Route.Route> = Array.from({ length: 100 }, (_, i) => {
  const group = `group-${Math.floor(i / 10)}`
  const sub = `sub-${i % 5}`
  const leaf = `cmd-${i}`
  return makeRoute(`${group}/${sub}/${leaf}`)
})

const tree = Effect.runSync(CommandTree.make(routes))

describe("fs command tree hot paths", () => {
  test("CommandTree.make", async ({ bench }) => {
    await bench("build frozen 100-route nested command tree", () => {
      Effect.runSync(CommandTree.make(routes))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("CommandTree.resolve and resolveExact", async ({ bench }) => {
    await bench("resolve nested command with trailing argv", () => {
      Effect.runSync(CommandTree.resolve(tree, ["group-7", "sub-2", "cmd-77", "--flag", "value"]))
      Effect.runSync(CommandTree.resolveExact(tree, ["group-3", "sub-4", "cmd-34"]))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("CommandTree.traverse and Directive.compile", async ({ bench }) => {
    await bench("traverse 100 routes + compile placement directives", () => {
      CommandTree.traverse(tree)
      Directive.compile("sandbox")
      Directive.compile("client")
    }).run({ time: 120, warmupTime: 30 })
  })
})
