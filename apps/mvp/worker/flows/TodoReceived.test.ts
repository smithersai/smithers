// `todo/Received` (worker/flows/Todo.ts, decision 0136): the change an external agent's runner settled, checked as
// `todo/Collect` checks a machine's. The step reads nothing but its payload.
import { Effect, Exit } from "effect"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { base64Bytes } from "../../src/features/runners/contract.ts"
import { REPOSITORY } from "../github/test/fixtures.ts"
import { testFile } from "../test/harness.ts"
import * as Todo from "./Todo.ts"

const runtime = testFile("todo_received")
const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (each) => each.database))

describe("todo/Received", () => {
  const request = { attemptId: crypto.randomUUID(), todoId: crypto.randomUUID(), repoId: REPOSITORY.id, number: 1, ordinal: 1, revision: 1 }
  const received = async (additions: ReadonlyArray<{ path: string; contents: string }>, deletions: ReadonlyArray<string> = []) => {
    const steps = Todo.steps({
      database: await database(),
      tokens: undefined as never,
      http: undefined as never,
      apiBaseUrl: "",
      start: () => Effect.void,
    })
    return Effect.runPromise(Effect.exit(steps.received({
      request,
      result: { changes: { additions, deletions }, summary: "", usage: {}, generation: 1 },
    })))
  }
  const failure = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as { error: unknown } | undefined)?.error : undefined

  test("passes a change within the commit's limits through as Collect's", async () => {
    expect(await received([{ path: "docs/NOTES.md", contents: "YWxwaGEK" }], ["OLD.md"])).toEqual(
      Exit.succeed({ additions: [{ path: "docs/NOTES.md", contents: "YWxwaGEK" }], deletions: ["OLD.md"] }),
    )
  })

  test("fails empty_change for nothing, and implement past the limits or outside the checkout", async () => {
    expect(failure(await received([]))).toEqual(new Todo.TodoFailed({ failure: "empty_change" }))
    const many = Array.from({ length: Todo.MAX_FILES + 1 }, (_, index) => ({ path: `f${index}`, contents: "" }))
    expect(failure(await received(many))).toEqual(new Todo.TodoFailed({ failure: "implement" }))
    const big = "A".repeat(Math.ceil((Todo.MAX_CHANGE_BYTES + 3) / 3) * 4)
    expect(failure(await received([{ path: "big", contents: big }]))).toEqual(new Todo.TodoFailed({ failure: "implement" }))
    for (const path of ["/etc/passwd", "../up", "a//b", "./a", ".git/config", ".jj/repo", "a\\b"]) {
      expect(failure(await received([{ path, contents: "" }])), path).toEqual(new Todo.TodoFailed({ failure: "implement" }))
    }
  })

  test("counts base64's padding when it sizes a file", () => {
    expect([base64Bytes("YQ=="), base64Bytes("YWI="), base64Bytes("YWJj")]).toEqual([1, 2, 3])
  })
})
