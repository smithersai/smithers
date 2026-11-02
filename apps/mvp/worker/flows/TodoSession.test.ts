// Ad hoc external-agent tasks have no TODO run to steer; never open their notification writer.
import type { AgentRunner } from "@smthrs/agent"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TodoSession from "./TodoSession.ts"

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
