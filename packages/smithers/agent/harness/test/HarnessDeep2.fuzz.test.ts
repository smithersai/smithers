import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DoneText from "../src/DoneText.ts"
import * as FailedCall from "../src/FailedCall.ts"
import * as demandText from "../src/internal/demandText.ts"
import * as Notifications from "../src/Notifications.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261133")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/harness Deep2 Fuzz (FailedCall, DoneText, demandText, Notifications)", () => {
  it("FailedCall (reason, inspects, find, demand, state) & demandText fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        flowName: Schema.Literals(["read", "write", "tests/run", "bash", "grep"]),
        hasInspect: Schema.Boolean,
        acknowledgedInClaim: Schema.Boolean,
        multipleFailures: Schema.Boolean,
        msgPrefix: Schema.Literals(["", "Flow read failed: ", "Error: "])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const failure: FailedCall.Failure = {
              flow: c.flowName,
              message: `${c.msgPrefix}permission denied on /etc/shadow`
            }
            const r = FailedCall.reason(failure)
            if (r.length === 0) return false

            const src = c.hasInspect
              ? `const res = await ctx.call("${c.flowName}", {}); if (!res.ok) console.log(res.error); ctx.done("done")`
              : `await ctx.call("${c.flowName}", {}); ctx.done("all good")`
            void FailedCall.inspects(src, c.flowName)
            void FailedCall.inspects(src)

            const calls = [
              {
                call: { flowName: c.flowName, input: {} },
                result: { outcome: "failure" as const, message: failure.message, code: "flow_failed" }
              },
              ...(c.multipleFailures
                ? [
                  {
                    call: { flowName: "bash", input: {} },
                    result: { outcome: "failure" as const, message: "exit code 1", code: "flow_failed" }
                  }
                ]
                : [])
            ] as any

            const claim = c.acknowledgedInClaim
              ? `${c.flowName} failed with permission denied on /etc/shadow`
              : "Everything succeeded cleanly!"
            const found = FailedCall.find(calls, claim, src)
            if (found.length > 0) {
              const dem = FailedCall.demand(found)
              const st = FailedCall.state(claim, found)
              if (!dem.includes(FailedCall.heading) && dem.length === 0) return false
              if (!st.includes(FailedCall.stated)) return false
            }

            // All demandText helpers produce non-empty guidance strings
            const texts = [
              demandText.readOnly(3, 5),
              demandText.repeat(4, 2),
              demandText.unmoved("hash-a", "hash-a"),
              demandText.unresolved(c.flowName, "test A", "test B"),
              demandText.narrowed(c.flowName, "all tests", "unit test"),
              demandText.narrowOnly(c.flowName, "vitest", ["a.test.ts", "b.test.ts"]),
              demandText.claim()
            ]
            return texts.every((t) => typeof t === "string" && t.length > 10)
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("DoneText.project & Notifications.text/precedence fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        replyKind: Schema.Literals([
          "plain",
          "codeBlock",
          "doneCall",
          "fencedDone",
          "empty",
          "multiline",
          "jsonLike"
        ]),
        notifKind: Schema.Literals(["child", "approval", "steer", "budget"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const reply = c.replyKind === "plain"
              ? "I fixed the bug in `foo.ts`."
              : c.replyKind === "codeBlock"
              ? "```js\nctx.done(\"finished cleanly\")\n```"
              : c.replyKind === "doneCall"
              ? "ctx.done(`Summary: 42 tests passed.`)"
              : c.replyKind === "fencedDone"
              ? "Let me wrap up:\n```ts\nconst out = \"ok\";\nctx.done(out);\n```"
              : c.replyKind === "empty"
              ? "   \n  "
              : c.replyKind === "multiline"
              ? "Line 1\nLine 2\n\n- bullet A\n- bullet B"
              : "{\"status\":\"ok\",\"count\":3}"

            const projected = DoneText.project(reply)
            if (Option.isSome(projected) && projected.value.trim().length === 0) return false

            const notif: any = {
              id: "n-1",
              _tag: c.notifKind === "child" ? "system-event" : "user-message",
              payload: c.notifKind === "steer" ? { body: "focus on tests" } : { count: 3 },
              provenance: {
                sourceActor: "agent-1",
                sourceLineageId: "lin-1",
                sourceTurn: 2,
                ...(c.notifKind === "approval" ? { attribution: { actor: "will" } } : {})
              }
            }
            const txt = Notifications.text(notif)
            return typeof txt === "string" && txt.includes("[notification n-1") && typeof Notifications.precedence === "string"
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })
})
