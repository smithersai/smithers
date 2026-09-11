import { describe, expect, test } from "vitest"
import { LinearAuthSessionSchema } from "../src/LinearAuth.ts"

/*
 * The Linear OAuth handoff on the local origin
 * (apps/ui/docs/decisions/0005-linear-github-sync.md). The session carries no
 * token: it carries the setup key only once the handoff is authorized.
 */
describe("the Linear sign-in wire model", () => {
  test("the Linear handoff is three states and carries the setup key only once authorized", () => {
    expect(LinearAuthSessionSchema.parse({ state: "idle" })).toEqual({ state: "idle" })
    expect(LinearAuthSessionSchema.parse({ state: "waiting" }).setupKey).toBeUndefined()
    expect(LinearAuthSessionSchema.parse({ state: "authorized", setupKey: "k1" }))
      .toEqual({ state: "authorized", setupKey: "k1" })
    expect(LinearAuthSessionSchema.safeParse({ state: "done" }).success).toBe(false)
    expect(LinearAuthSessionSchema.safeParse({}).success).toBe(false)
  })
})
