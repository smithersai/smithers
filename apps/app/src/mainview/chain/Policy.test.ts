import { Author, Catalog, Chain, Journal, ScriptRunner } from "@smthrs/chain"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { createChainPolicy } from "./Policy"

const fixture = (claim = "outbound:launch") => {
  const policy = createChainPolicy()
  const counts = { deploy: 0, publish: 0 }
  const entries: ReadonlyArray<Catalog.Entry> = (["deploy", "publish"] as const).map(name => ({
    name, description: name, capabilities: [claim],
    handler: () => Effect.sync(() => { counts[name] += 1; return {} })
  }))
  // Each attempt is a fresh call, so replay cannot conceal a reused grant.
  const attempt = (runId: string, name = "deploy") => Effect.runPromise(
    Effect.gen(function*() {
      const outcome = yield* Chain.run({ goal: "exercise policy" })
      const journal = yield* Journal.Journal
      return { outcome, events: yield* journal.read }
    }).pipe(Effect.provide(Layer.mergeAll(
      policy.layerFor(runId), Journal.layerMemory(), Catalog.layer(entries),
      Author.layerMock([
        ["```flow", `await ctx.call("${name}", {})`, "return done({})", "```"].join("\n"),
        "```flow\nreturn done({ denied: true })\n```"
      ]),
      ScriptRunner.layerInProcess
    )))
  )
  return { policy, counts, attempt }
}

const expectApproval = async (attempt: ReturnType<ReturnType<typeof fixture>["attempt"]>) => {
  expect((await attempt).outcome._tag).toBe("ApprovalWait")
}

describe("chain policy grant boundaries", () => {
  test("an outbound approval authorizes exactly one handler invocation", async () => {
    const h = fixture()
    await expectApproval(h.attempt("a"))
    expect(h.policy.resolve("a", "approved")).toBe(true)
    expect(h.policy.pendingAsk("a")).toBeUndefined()
    expect((await h.attempt("a")).outcome._tag).toBe("Done")
    await expectApproval(h.attempt("a"))
    expect(h.counts).toEqual({ deploy: 1, publish: 0 })
  })

  test("unconsumed grants are isolated by both lineage and command", async () => {
    const h = fixture()
    await expectApproval(h.attempt("a", "deploy"))
    await expectApproval(h.attempt("b", "publish"))
    expect(h.policy.resolve("a", "approved")).toBe(true)
    expect(h.policy.resolve("b", "approved")).toBe(true)
    await expectApproval(h.attempt("b", "deploy"))
    await expectApproval(h.attempt("a", "publish"))
    expect(h.counts).toEqual({ deploy: 0, publish: 0 })
    expect((await h.attempt("a", "deploy")).outcome._tag).toBe("Done")
    expect((await h.attempt("b", "publish")).outcome._tag).toBe("Done")
    expect(h.counts).toEqual({ deploy: 1, publish: 1 })
    await expectApproval(h.attempt("a", "deploy"))
    await expectApproval(h.attempt("b", "publish"))
  })

  test("session grants cover their claim across commands until real revocation", async () => {
    const h = fixture("session:local")
    await expectApproval(h.attempt("a"))
    expect(h.policy.resolve("a", "approved")).toBe(true)
    expect((await h.attempt("a")).outcome._tag).toBe("Done")
    expect((await h.attempt("b", "publish")).outcome._tag).toBe("Done")
    expect(h.counts).toEqual({ deploy: 1, publish: 1 })
    h.policy.revoke()
    await expectApproval(h.attempt("a"))
    await expectApproval(h.attempt("b", "publish"))
    expect(h.counts).toEqual({ deploy: 1, publish: 1 })
    expect(h.policy.resolve("a", "approved")).toBe(true)
    expect((await h.attempt("a")).outcome._tag).toBe("Done")
    expect(h.counts.deploy).toBe(2)
  })

  test("revocation clears unconsumed approvals, denials, and pending asks", async () => {
    const h = fixture()
    for (const run of ["approved", "denied", "pending"]) await expectApproval(h.attempt(run))
    expect(h.policy.resolve("approved", "approved")).toBe(true)
    expect(h.policy.resolve("denied", "denied")).toBe(true)
    h.policy.revoke()
    expect(h.policy.pendingAsk("pending")).toBeUndefined()
    expect(h.policy.resolve("pending", "approved")).toBe(false)
    for (const run of ["approved", "denied", "pending"]) await expectApproval(h.attempt(run))
    expect(h.counts.deploy).toBe(0)
    expect(h.policy.resolve("approved", "approved")).toBe(true)
    expect((await h.attempt("approved")).outcome._tag).toBe("Done")
    expect(h.counts.deploy).toBe(1)
  })

  test("a reconstructed approval or denial is one-shot and lineage-scoped", async () => {
    for (const decision of ["approved", "denied"] as const) {
      const before = fixture()
      await expectApproval(before.attempt("parked"))
      const ask = before.policy.pendingAsk("parked")
      const after = fixture()
      expect(after.policy.resolve("missing", decision)).toBe(false)
      expect(after.policy.resolve("parked", decision, ask)).toBe(true)
      await expectApproval(after.attempt("other"))
      const resumed = await after.attempt("parked")
      expect(resumed.outcome).toEqual({ _tag: "Done", value: decision === "denied" ? { denied: true } : {} })
      expect(after.counts.deploy).toBe(decision === "approved" ? 1 : 0)
      if (decision === "denied") expect(JSON.stringify(resumed.events)).toContain("the user declined")
      await expectApproval(after.attempt("parked"))
      expect(after.counts.deploy).toBe(decision === "approved" ? 1 : 0)
    }
  })

  test("a session grant never authorizes a different claim", async () => {
    const policy = createChainPolicy()
    const ask = { name: "local", claim: "session:local" }
    expect(policy.resolve("a", "approved", ask)).toBe(true)
    let calls = 0
    // Share the approved policy with a catalog that claims a different scope.
    const outcome = await Effect.runPromise(Chain.run({ goal: "remote" }).pipe(Effect.provide(Layer.mergeAll(
      policy.layerFor("b"), Journal.layerMemory(),
      Catalog.layer([{ name: "remote", description: "remote", capabilities: ["session:remote"], handler: () => Effect.sync(() => { calls += 1; return {} }) }]),
      Author.layerMock(['```flow\nawait ctx.call("remote", {})\nreturn done({})\n```']), ScriptRunner.layerInProcess
    ))))
    expect(outcome._tag).toBe("ApprovalWait")
    expect(calls).toBe(0)
  })
})
