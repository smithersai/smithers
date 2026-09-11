/**
 * The default reconciler resolves each deviating path against the owners the
 * scheduler found, and only against those: a path whose name is an inherited
 * object member must never answer for itself.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Reconciliation from "../src/Reconciliation.ts"

const deviate = (paths: ReadonlyArray<string>, declaredBy: Record<string, string>) =>
  Effect.runPromise(
    Reconciliation.makeDefault().onDeviation({
      nodeId: "node-a",
      keyDigest: "digest",
      attempt: 0,
      paths,
      diffIdentity: "diff",
      declaredBy,
      alsoDeviatedBy: []
    })
  )

describe("Reconciliation.makeDefault", () => {
  it("fails undeclared paths named after inherited object members", async () => {
    const verdict = await deviate(["toString", "constructor"], {})
    expect(verdict._tag).toBe("Fail")
  })

  it("fails an inherited member name even when the scheduler built declaredBy with Object.fromEntries", async () => {
    const verdict = await deviate(["valueOf"], Object.fromEntries([]))
    expect(verdict._tag).toBe("Fail")
  })

  it("still reorders when every path has a real owner", async () => {
    const declaredBy = Object.assign(Object.create(null) as Record<string, string>, { toString: "node-b" })
    const verdict = await deviate(["toString"], declaredBy)
    expect(verdict).toEqual({ _tag: "Reorder", dependsOn: ["node-b"], reason: "node-a wrote paths declared by node-b" })
  })
})
