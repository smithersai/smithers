// Ad hoc external-agent tasks have no TODO run to steer; never open their notification writer.
import type { AgentRunner } from "@smthrs/agent"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import { testFile } from "../test/harness.ts"
import * as TodoSession from "./TodoSession.vibe"

test("a task without a TODO attempt has no pending or delivered steer and never reaches its writer", async () => {
  let opened = 0
  const down = Layer.effect(SqlClient.SqlClient, Effect.sync(() => { opened++; throw new Error("writer unavailable") }))
  const task: AgentRunner.Task = {
    agent: { name: "coder", labels: [], profile: "coder", maxHours: 1, restarts: 0 },
    repository: "github/acme/widgets", base: "a".repeat(40), system: [], prompt: "Inspect", limits: { files: 1, bytes: 100 },
  }
  const steering = TodoSession.steering(down)
  expect(await Effect.runPromise(steering.pending(task))).toEqual([])
  expect(await Effect.runPromise(steering.delivered(task, "job#g1", ["steer-1"]))).toBeUndefined()
  expect(opened).toBe(0)
})

test("a coding agent lookup maps an unavailable database to the step's retryable error", async () => {
  const database = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("database unavailable")))
  const select = TodoSession.agentStep(database)
  const failure = await Effect.runPromise(Effect.flip(select({ attemptId: "attempt-1", repoId: "github/acme/widgets" })))
  expect(failure).toEqual(new TodoSession.CodingUnavailable())
})

describe("stopping an external agent", () => {
  const runtime = testFile("todo_session_stop")

  test("stopping an attempt before it queues a job cancels zero generations", async () => {
    expect(await runtime.runPromise(TodoSession.stop(crypto.randomUUID()))).toBe(0)
  })
})
