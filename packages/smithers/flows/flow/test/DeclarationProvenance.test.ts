/**
 * Where a declaration was written, and the one property that makes carrying it
 * safe: it is not identity.
 *
 * A monitor that offers to show the code behind a node needs the author's file
 * and line. A plan key that moved when a declaration moved would re-key every
 * step on every edit and invalidate every approval bound to the old digest, so
 * the whole feature rests on provenance staying OUT of key material. The cases
 * below prove it directly — the same declaration written on two different
 * lines compiles to the same key, byte for byte — and then prove the parser
 * that captures it never throws, whatever a runtime hands it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Node, Plan } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as DeclarationSite from "../src/internal/DeclarationSite.ts"
import * as Sleep from "../src/Sleep.ts"
import { withCrypto } from "./Crypto.ts"

const Declared = Action.make("provenance/declared", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Same = Action.make("provenance/same", { payload: { value: Schema.Number }, success: Schema.Number })

// Deliberately the same declaration, written lower down the file. Its key must
// not be able to tell.
const Moved = Action.make("provenance/same", { payload: { value: Schema.Number }, success: Schema.Number })

const flowOf = (action: { readonly call: (payload: { readonly value: number }) => Node.Node<number, never, any> }) =>
  Flow.make("provenance/flow", {
    payload: {},
    success: Schema.Number,
    body: () => action.call({ value: 1 })
  })

const compile = (built: Parameters<typeof Graph.build>[0], payload?: unknown) =>
  withCrypto(
    Plan.compile({
      planId: "provenance-plan",
      flow: "provenance/flow",
      nodes: Graph.drafts(Graph.build(built, payload))
    })
  )

describe("declaration provenance", () => {
  it("names the author's file and the line the declaration was written on", () => {
    const site = Graph.nodes(Graph.build(flowOf(Declared), {}))
      .find((node) => node.ast._tag === "ActionCall")?.declaredAt

    expect(site?.path.endsWith("test/DeclarationProvenance.test.ts")).toBe(true)
    expect(site?.line).toBe(21)
  })

  it("carries a flow's own declaration site", () => {
    const flow = flowOf(Declared)
    const entry = Graph.nodes(Graph.build(flow, {})).find((node) => node.ast._tag === "FlowCall")

    expect(entry?.declaredAt?.path.endsWith("test/DeclarationProvenance.test.ts")).toBe(true)
    // The flow is constructed at this call, rather than at flowOf's definition.
    expect(entry?.declaredAt?.line).toBe(58)
  })

  it.effect("keys the same declaration identically wherever it was written", () =>
    Effect.gen(function*() {
      // The call nodes directly, not a flow around them: a flow body is a
      // closure, and two closures have two ephemeral identities whatever the
      // declarations inside them are. What is under test is the declaration.
      const here = yield* compile(Same.call({ value: 1 }))
      const there = yield* compile(Moved.call({ value: 1 }))

      // Byte for byte: the keys, the plan digest an approval binds to, and the
      // key material itself.
      expect(there.nodes.map((node) => node.key)).toEqual(here.nodes.map((node) => node.key))
      expect(there.digest).toBe(here.digest)
      expect(JSON.stringify(there.nodes.map((node) => node.material)))
        .toBe(JSON.stringify(here.nodes.map((node) => node.material)))
    }))

  it.effect("keeps the source position out of everything a digest can see", () =>
    Effect.gen(function*() {
      const plan = yield* compile(flowOf(Declared), {})
      const encoded = JSON.stringify(plan)

      expect(encoded).not.toContain("declaredAt")
      expect(encoded).not.toContain("DeclarationProvenance.test.ts")
      // Nor anywhere an enumeration of the declaration would reach it.
      expect(Object.keys(Declared)).not.toContain("declaredAt")
      expect(JSON.stringify(Declared)).not.toContain("DeclarationProvenance.test.ts")
    }))

  it("reports nothing for a node with no declaration to read", () => {
    const bare = Graph.nodes(Graph.build(Node.succeed(1)))

    expect(bare.every((node) => node.declaredAt === undefined)).toBe(true)
  })
})

describe("declaration provenance parsing", () => {
  it("reads both engines' frame spellings", () => {
    expect(DeclarationSite.parseFrame("    at declare (/repo/flows/build.ts:12:5)")).toEqual({
      path: "/repo/flows/build.ts",
      line: 12
    })
    expect(DeclarationSite.parseFrame("    at /repo/flows/build.ts:12:5")).toEqual({
      path: "/repo/flows/build.ts",
      line: 12
    })
    expect(DeclarationSite.parseFrame("declare@/repo/flows/build.ts:7:1")).toEqual({
      path: "/repo/flows/build.ts",
      line: 7
    })
    expect(DeclarationSite.parseFrame("@/repo/flows/build.ts:7:1")).toEqual({
      path: "/repo/flows/build.ts",
      line: 7
    })
    expect(DeclarationSite.parseFrame("    at declare (file:///repo/a%20b/build.ts:3:1)")).toEqual({
      path: "/repo/a b/build.ts",
      line: 3
    })
  })

  /*
   * A host that verifies a flow's source evaluates the bytes it measured, and
   * evaluating bytes here means writing them somewhere and importing that
   * path. The scratch file is removed when the load is over, so a declaration
   * captured in it would name a file nothing holds. The loader says which
   * entry the bytes came from and a capture answers with that instead — and
   * only for that file: every other frame reports itself, including one that
   * merely sits beside it.
   */
  it("answers with the entry a host evaluated measured bytes from", () => {
    const scratch = "/repo/flows/review/.smithers-8d9-b-3ktz.ts"
    expect(DeclarationSite.parseFrame(`    at declare (${scratch}:9:3)`)).toEqual({ path: scratch, line: 9 })
    // Through the public module, which is the one a host holds.
    Graph.evaluatedFrom(scratch, "/repo/flows/review/flow.ts")
    expect(DeclarationSite.parseFrame(`    at declare (${scratch}:9:3)`)).toEqual({
      path: "/repo/flows/review/flow.ts",
      line: 9
    })
    // A url frame for the same file is the same file.
    expect(DeclarationSite.parseFrame(`    at declare (file://${scratch}:4:1)`)).toEqual({
      path: "/repo/flows/review/flow.ts",
      line: 4
    })
    expect(DeclarationSite.parseFrame("    at declare (/repo/flows/review/other.ts:9:3)")).toEqual({
      path: "/repo/flows/review/other.ts",
      line: 9
    })
  })

  it("reports nothing rather than guessing at a frame it cannot read", () => {
    expect(DeclarationSite.parseFrame("Error: boom")).toBeUndefined()
    expect(DeclarationSite.parseFrame("    at native")).toBeUndefined()
    expect(DeclarationSite.parseFrame("")).toBeUndefined()
  })

  it("skips the framework's own frames and answers with the author's", () => {
    expect(DeclarationSite.isFrameworkPath("/repo/node_modules/@smthrs/flow/dist/esm/make.js")).toBe(true)
    expect(DeclarationSite.isFrameworkPath("/repo/packages/smithers/flows/flow/src/Action/make.ts")).toBe(true)
    expect(DeclarationSite.isFrameworkPath("/repo/flows/coding/build.ts")).toBe(false)
    expect(DeclarationSite.isFrameworkPath("C:\\repo\\flows\\build.ts")).toBe(false)
    // Windows spells the same two directories with backslashes, and a
    // framework frame read as an author's would name `make.js` as the site
    // every node of that run was declared at.
    expect(DeclarationSite.isFrameworkPath("C:\\repo\\node_modules\\@smthrs\\flow\\dist\\esm\\make.js")).toBe(
      true
    )
    expect(
      DeclarationSite.isFrameworkPath("C:\\repo\\packages\\smithers\\flows\\flow\\src\\Action\\make.ts")
    ).toBe(true)
    // A declaration made inside the framework is reached through the module
    // loader, so the first frame under it is a runtime internal. It names no
    // file, and answering with it would attribute `system/sleep` to Node.
    expect(DeclarationSite.isFrameworkPath("node:internal/process/task_queues")).toBe(true)
    expect(DeclarationSite.isFrameworkPath("<anonymous>")).toBe(true)

    expect(DeclarationSite.parseStack(
      [
        "Error",
        "    at capture (/repo/packages/smithers/flows/flow/src/internal/DeclarationSite.ts:1:1)",
        "    at make (/repo/node_modules/@smthrs/flow/dist/esm/Action/make.js:2:2)",
        "    at author (/repo/flows/coding/build.ts:42:7)"
      ].join("\n")
    )).toEqual({ path: "/repo/flows/coding/build.ts", line: 42 })
  })

  it("reports nothing for a declaration the framework itself made", () => {
    // `system/sleep` is declared inside this package. Its capture walks past
    // every framework frame and finds only the module loader, which names no
    // file: nothing is the honest answer, and a Node internal would not be.
    expect(DeclarationSite.declaredAt(Sleep.action)).toBeUndefined()
  })

  it("reports nothing when no frame is an author's, when there is no stack, and when a path is malformed", () => {
    expect(DeclarationSite.parseStack(undefined)).toBeUndefined()
    expect(DeclarationSite.parseStack("Error\n    at make (/repo/node_modules/@smthrs/flow/dist/esm/a.js:2:2)"))
      .toBeUndefined()
    // A percent escape no decoder accepts is an unparseable stack, never a
    // throw out of a declaration.
    expect(DeclarationSite.parseStack("    at make (file:///repo/%E0%A4%A/build.ts:2:2)")).toBeUndefined()
  })

  it("keeps the first site a value was annotated with, and reads none off a primitive", () => {
    const value = DeclarationSite.annotate({ name: "declaration" }, { path: "/repo/a.ts", line: 1 })
    DeclarationSite.annotate(value, { path: "/repo/b.ts", line: 2 })

    expect(DeclarationSite.declaredAt(value)).toEqual({ path: "/repo/a.ts", line: 1 })
    expect(DeclarationSite.declaredAt(DeclarationSite.annotate({}, undefined))).toBeUndefined()
    expect(DeclarationSite.declaredAt("a string")).toBeUndefined()
  })
})
