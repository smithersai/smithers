import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellPrompt from "../src/internal/cellPrompt.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import type * as Sandbox from "../src/Sandbox.ts"

// Execute the actual teaching in the production realm. The tiny in-memory
// workspace implements search/read/edit and checks its current or opening text;
// failure injection happens at the Effect handler boundary, before execution.
const example = (fault?: "grep" | "read" | "edit" | "baseline" | "after", content = "return value") =>
  Effect.gen(function*() {
    const contract = CellPrompt.make({}).find((section) => section.id === "cell-contract")!.text
    const cells = [...contract.split("Example bug fix")[1]!.matchAll(/```cell\n([\s\S]*?)```/g)]
      .map((match) => match[1]!)
    expect(cells).toHaveLength(2)
    const flows = Object.fromEntries(["grep", "read", "edit", "bash"].map((name) => [
      name,
      new Cell.FlowProjection({
        name,
        description: name,
        capabilities: [],
        tier: "sealed",
        placement: Option.none(),
        input: Option.none()
      })
    ]))
    let current = content
    const calls: Array<Sandbox.Invocation> = []
    const call: Sandbox.Handler = (invocation) =>
      Effect.sync(() => {
        calls.push(invocation)
        const phase = invocation.flow === "bash" ? invocation.at === undefined ? "after" : "baseline" : invocation.flow
        if (phase === fault) {
          return new Cell.CallResult({ outcome: "failure", value: null, message: `${phase} unavailable` })
        }
        const input = invocation.input as Record<string, Schema.Json>
        let value: Schema.Json
        switch (invocation.flow) {
          case "grep":
            value = {
              matches: current.includes(String(input.pattern))
                ? [{ file: "src/units/value.py", line: 1, text: current }]
                : []
            }
            break
          case "read":
            value = { content: current }
            break
          case "edit":
            current = current.replace(String(input.oldString), String(input.newString))
            value = { hunk: current }
            break
          case "bash": {
            const checked = invocation.at === undefined ? current : content
            value = { exitCode: checked.includes("widen(value)") ? 0 : 1, stdout: checked }
            break
          }
          default:
            throw new Error(`Unexpected example flow: ${invocation.flow}`)
        }
        return new Cell.CallResult({ outcome: "success", value })
      })
    const sandbox = yield* QuickJSSandbox.make
    const realm = yield* sandbox.openRealm!({ flows })
    const outcomes: Array<Cell.Outcome> = []
    const prints: Array<string> = []
    for (const [frame, source] of cells.entries()) {
      const evaluated = yield* realm.evaluate({ cell: Cell.source(source), frame, call })
      outcomes.push(evaluated.outcome)
      prints.push(JSON.stringify(evaluated.prints))
    }
    return { outcomes, calls, prints }
  }).pipe(Effect.scoped, Effect.runPromise)

describe("worked bug-fix example", () => {
  it("does not claim verification when the baseline call failed before running the check", async () => {
    const result = await example("baseline")
    expect(result.outcomes).toEqual([
      new Cell.Settled({ transition: new Cell.Continue({}) }),
      new Cell.Settled({ transition: new Cell.Continue({}) })
    ])
    expect(result.prints.join("\n")).toContain("baseline unavailable")
  })

  it.each(["grep", "empty"] as const)("does not dereference a search hit after %s", async (kind) => {
    const result = kind === "grep" ? await example("grep") : await example(undefined, "unrelated text")
    expect(result.outcomes.every((outcome) => outcome._tag === "settled")).toBe(true)
    expect(result.calls.map((call) => call.flow)).toEqual(["grep"])
    expect(result.prints.join("\n")).toContain(kind === "grep" ? "grep unavailable" : "No matches")
  })

  it("completes after the same check fails on the opening text and passes on the edited text", async () => {
    const result = await example()
    expect(result.outcomes[1]).toMatchObject({ _tag: "settled", transition: { _tag: "complete" } })
    const checks = result.calls.filter((call) => call.flow === "bash")
    expect(checks).toHaveLength(2)
    expect(checks[0]!.input).toEqual(checks[1]!.input)
    expect(checks[0]!.at).toBeDefined()
    expect(checks[1]!.at).toBeUndefined()
  })

  it.each(["read", "edit", "after"] as const)("reports a failed %s without claiming a fix", async (fault) => {
    const result = await example(fault)
    expect(result.outcomes.every((outcome) => outcome._tag === "settled" && outcome.transition._tag === "continue"))
      .toBe(true)
    expect(result.prints.join("\n")).toContain(`${fault} unavailable`)
  })
})
