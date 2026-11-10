import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Node from "../src/Node.ts"
import * as Plan from "../src/Plan.vibe"
import * as PlanDiff from "../src/PlanDiff.ts"
import { compile, draft } from "../src/test/PlanFixtures.ts"
import { withCrypto, withCryptoFailure } from "./Crypto.ts"

it("refuses recursive catch arms with a typed depth error and recovers", () => {
  const loop = (): Node.Node<number> => Node.catch(Node.fail("failure"), { onFailure: loop })
  expect(loop).toThrowError(expect.objectContaining({ code: "graph_too_deep" }))
  expect(Node.catch(Node.fail("failure"), { onFailure: () => Node.succeed(1) }).ast._tag).toBe("Catch")
})

it.effect("redacts invalid identity values", () =>
  Effect.gen(function*() {
    for (const option of ["planId", "flow"] as const) {
      const error = yield* withCryptoFailure(
        Plan.compile({
          planId: "plan",
          flow: "flow",
          nodes: [],
          [option]: { token: "SECRET-IDENTITY" } as unknown as string
        })
      )
      expect(error).toMatchObject({ code: "invalid_node" })
      expect(JSON.stringify(error)).not.toContain("SECRET-IDENTITY")
    }
  }))

it.effect("bounds node identifiers in validation refusals", () =>
  Effect.gen(function*() {
    const id = "x".repeat(10000)
    for (
      const nodes of [
        [draft(id), draft(id)],
        [draft(id, { writes: ["out"], removes: ["out"] })],
        [draft(id, { inputs: [{ _tag: "Ref", from: "missing", path: [] }] })]
      ]
    ) {
      const error = yield* withCryptoFailure(compile(nodes))
      expect((error as Plan.PlanError).message.length).toBeLessThan(1000)
    }
  }))

it.effect("attributes swapped upstream keys to downstream inputs", () =>
  Effect.gen(function*() {
    const consumer = draft("consumer", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })
    const before = yield* withCrypto(compile([draft("a", { body: 1 }), draft("b", { body: 2 }), consumer]))
    const after = yield* withCrypto(compile([draft("a", { body: 2 }), draft("b", { body: 1 }), consumer]))
    expect(PlanDiff.diff(before, after).rekeyed).toEqual([
      expect.objectContaining({ id: "consumer", changed: ["input[0]"] })
    ])
  }))

it.effect("schema refusals omit rejected values", () =>
  Effect.gen(function*() {
    const node = draft("node")
    for (
      const invalid of [
        { ...node, material: { ...node.material, version: "SECRET-SCHEMA" } },
        { ...node, effects: { ...node.effects, boundaryMode: "SECRET-SCHEMA" } }
      ]
    ) {
      const error = yield* withCryptoFailure(compile([invalid as Plan.NodeDraft]))
      expect(error).toMatchObject({ code: "invalid_node" })
      expect(JSON.stringify(error)).not.toContain("SECRET-SCHEMA")
    }
  }))
