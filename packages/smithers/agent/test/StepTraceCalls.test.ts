import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Model from "@smthrs/model/Model"
import { RunStore } from "@smthrs/run-store"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { host } from "./fixtures/step-trace-calls-host.ts"
import { answer, facts, incarnation, Single, stores } from "./fixtures/step-trace-stack.ts"

describe("queued cell-call trace replay on SQLite", () => {
  it.each([false, true])(
    "keeps live call facts byte-identical after SIGKILL (partial=%s)",
    async (partial) => {
      const directory = await mkdtemp(join(tmpdir(), "step-trace-calls-"))
      const filename = join(directory, "engine.sqlite")
      const runId = "queued-calls"
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("./fixtures/step-trace-calls-child.ts", import.meta.url)),
        filename,
        runId,
        partial ? "partial" : "complete"
      ], {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"]
      })
      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk)
      })
      let live: { settled: Array<{ value: string }> } | undefined
      try {
        const marker = await new Promise<{ facts: number; performed: string[] }>((resolve, reject) => {
          let stdout = ""
          const timer = setTimeout(() => reject(new Error(`child did not reach pending provider: ${stderr}`)), 120_000)
          child.once("exit", (code) => {
            clearTimeout(timer)
            reject(new Error(`child exited ${code}: ${stderr}`))
          })
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk)
            const lines = stdout.split("\n")
            stdout = lines.pop()!
            for (const line of lines) {
              if (!line.startsWith("{")) continue
              const record = JSON.parse(line)
              if (record.status === "right-pending") live = record
              if (record.status === "provider-pending" || (partial && record.status === "right-pending")) {
                clearTimeout(timer)
                resolve(record)
              }
            }
          })
        })
        expect(live?.settled.map((item) => item.value)).toEqual([partial ? "same" : "left"])
        expect(marker.performed).toEqual(["left", "right"])
        const exited = once(child, "exit")
        child.kill("SIGKILL")
        expect((await exited)[1]).toBe("SIGKILL")
        await Effect.runPromise(
          Effect.scoped(Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const abandoned = yield* runs.get(runId)
            expect(abandoned.status).toBe("running")
            yield* TestClock.setTime((abandoned.heartbeatAtMs ?? 0) + 120_000)
            const before = yield* facts(runId)
            expect(before.length).toBe(marker.facts)
            const originalBytes = JSON.stringify(before)
            const calls = before.filter((row) => row.payload.eventType === "control.agent.cell-call-settled")
            expect(calls.map((row) => (row.payload.payload as { value: string }).value)).toEqual(
              partial ? ["same"] : ["left", "right"]
            )
            expect(new Set(calls.map((row) => (row.payload.payload as { callId: string }).callId)).size).toBe(
              partial ? 1 : 2
            )
            const performed: string[] = []
            let providerCalls = 0
            const second = yield* incarnation(
              Model.make({
                stream: () =>
                  Stream.suspend(() => {
                    providerCalls++
                    return answer()
                  })
              }),
              {
                host: host((text) =>
                  Effect.sync(() => {
                    performed.push(text)
                  }), partial ? "same" : undefined)
              }
            )
            expect(
              yield* Single.execute({ input: "Read both values" }, { executionId: runId }).pipe(Effect.provide(second))
            ).toBe("done")
            expect(performed).toEqual(partial ? ["right"] : [])
            expect(providerCalls).toBe(1)
            const after = yield* facts(runId)
            expect(JSON.stringify(after.slice(0, before.length))).toBe(originalBytes)
            const settled = after.filter((row) => row.payload.eventType === "control.agent.cell-call-settled")
            expect(settled).toHaveLength(2)
            expect(new Set(settled.map((row) => (row.payload.payload as { callId: string }).callId)).size).toBe(2)
            if (!partial) expect(settled).toEqual(calls)
            expect(new Set(after.map((row) => `${row.sourceId}:${row.sourceSeq}`)).size).toBe(after.length)
          })).pipe(
            Effect.provide(stores(filename)),
            Effect.provide(NodeCrypto.layer),
            Effect.provide(TestClock.layer())
          )
        )
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await rm(directory, { recursive: true, force: true })
      }
    },
    180_000
  )
})
