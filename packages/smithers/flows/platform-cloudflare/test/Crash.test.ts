import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { ExecutionObject } from "../src/index.ts"
import { Answer } from "./fixtures/AnswerFlow.ts"
import * as Postgres from "./fixtures/Postgres.ts"

const fixture = fileURLToPath(new URL("./fixtures/incarnation.ts", import.meta.url))

/**
 * Runs one incarnation in its own process and collects its marked lines. In
 * `block` mode it is killed with SIGKILL once it is inside its second step.
 */
const incarnation = (
  mode: "block" | "finish",
  target: Postgres.Target,
  schema: string,
  hostId: string,
  intent: ExecutionObject.Intent
) =>
  Effect.promise(() =>
    new Promise<{ readonly steps: ReadonlyArray<string>; readonly outcome: unknown; readonly signal: string | null }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ["--import=vibelang/register", fixture, mode, target.url, schema, hostId, JSON.stringify(intent)], {
          stdio: ["ignore", "pipe", "pipe"]
        })
        const steps: Array<string> = []
        let outcome: unknown
        let stderr = ""
        child.stderr.on("data", (chunk) => (stderr += chunk))
        child.stdout.on("data", (chunk: Buffer) => {
          // The child's own log lines share stdout; its marks are prefixed.
          for (const line of String(chunk).split("\n")) {
            if (line.startsWith("step:")) steps.push(line.slice("step:".length))
            if (line.startsWith("outcome:")) outcome = JSON.parse(line.slice("outcome:".length))
          }
          if (mode === "block" && steps.includes("answer")) child.kill("SIGKILL")
        })
        child.once("exit", (code, signal) =>
          code === 0 || signal === "SIGKILL"
            ? resolve({ steps, outcome, signal })
            : reject(new Error(`incarnation exited with ${code}: ${stderr}`)))
      }
    )
  )

const run = (schema: string, executionId: string) =>
  Effect.promise(() =>
    Postgres.admin(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly status: string; readonly owner_host_id: string | null }>`
        SELECT status, owner_host_id FROM ${sql(schema)}.flows_runs WHERE run_id = ${executionId}`
      return row
    }))
  )

for (const target of Postgres.targets) {
  describe.skipIf(!target.available)(`a killed incarnation over ${target.label}`, () => {
    it.live("the next incarnation of the same object takes the run at once and does not repeat the recorded step", () => {
      const schema = Postgres.freshSchema()
      const executionId = `answer-${randomUUID()}`
      const hostId = `object-${executionId}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Answer, { executionId, payload: { question: "hi", pauseMs: 0 } })
        const a = yield* incarnation("block", target, schema, hostId, intent)
        expect(a).toMatchObject({ steps: ["ask:hi", "answer"], signal: "SIGKILL" })
        expect(yield* run(schema, executionId)).toEqual({ status: "running", owner_host_id: hostId })

        const b = yield* incarnation("finish", target, schema, hostId, intent)
        // A's lease was still fresh. Judged by the lease, B would park until it
        // lapsed (`Parked` at A's heartbeat plus the stale window, no step run);
        // judging A an earlier incarnation of the same object, B takes the run
        // in this very alarm.
        expect(b.outcome).toEqual({ _tag: "Settled", forgetAtMs: expect.any(Number) })
        // The question step settled under A and replays; the interrupted step runs again.
        expect(b.steps).toEqual(["answer"])
        expect(yield* run(schema, executionId)).toEqual({ status: "completed", owner_host_id: null })
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(schema))))
    })
  })
}
