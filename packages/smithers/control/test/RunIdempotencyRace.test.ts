import { Effect, Exit, type Layer } from "effect"
import { fork } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import type { Receipt } from "../src/ControlSchema.vibe"
import { durable, type DurableStack, fileBundle } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-control-race-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const over = (filename: string): Layer.Layer<DurableStack> => durable({ database: fileBundle(filename) })

const run = <A, E>(stack: Layer.Layer<DurableStack>, body: Effect.Effect<A, E, DurableStack>): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped))

describe("run idempotency across processes", () => {
  it("calls the executor once when separate processes start together", async () => {
    const filename = join(directory, "process-race.sqlite")
    const card = await run(
      over(filename),
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "process-race" } })
        yield* control.approve({ ...card.approval, idempotencyKey: "approve:process-race" })
        return card
      })
    )
    const peers = Array.from({ length: 3 }, () => {
      const child = fork(new URL("./fixtures/runIdempotencyChild.ts", import.meta.url), [
        filename,
        JSON.stringify(card)
      ], {
        execArgv: ["--no-warnings"],
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      })
      let diagnostics = ""
      child.stderr!.on("data", (chunk) => {
        diagnostics += String(chunk)
      })
      let markReady!: () => void
      const ready = new Promise<void>((resolve) => {
        markReady = resolve
      })
      const result = new Promise<Receipt>((resolve, reject) => {
        let receipt: Receipt | undefined
        child.on("message", (message: { ready?: boolean; receipt?: Receipt; error?: string }) => {
          if (message.ready) markReady()
          if (message.receipt) receipt = message.receipt
          if (message.error) diagnostics += message.error
        })
        child.on("error", reject)
        child.on("exit", (code) => {
          markReady()
          if (code === 0 && receipt !== undefined) resolve(receipt)
          else reject(new Error(`race child exited ${code}: ${diagnostics}`))
        })
      })
      return { child, ready, result }
    })
    const results = Promise.all(peers.map((peer) => peer.result))
    // Handle early failures while the remaining processes are still starting.
    void results.catch(() => {})
    const timeout = setTimeout(() => peers.forEach(({ child }) => child.kill("SIGKILL")), 20_000)
    try {
      await Promise.all(peers.map((peer) => peer.ready))
      for (const { child } of peers) if (child.connected) child.send("go")
      const receipts = await results
      expect(receipts.filter((receipt) => receipt._tag === "Accepted")).toHaveLength(1)
      expect(receipts.filter((receipt) => receipt._tag === "AlreadyApplied")).toHaveLength(2)
      expect(readFileSync(`${filename}.launches`, "utf8").trim().split("\n")).toHaveLength(1)
      expect(new Set(receipts.map((receipt) => "runId" in receipt ? receipt.runId : undefined)).size).toBe(1)
    } finally {
      clearTimeout(timeout)
      peers.forEach(({ child }) => {
        if (child.exitCode === null) child.kill("SIGKILL")
      })
    }
  })

  it("launches exactly one run when independent stacks race on one key", async () => {
    const filename = join(directory, "race.sqlite")
    const card = await run(
      over(filename),
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "race" } })
        yield* control.approve({ ...card.approval, idempotencyKey: "approve:race" })
        return card
      })
    )

    const launch = Effect.gen(function*() {
      const control = yield* Control
      return yield* Effect.exit(control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "run:race"
      }))
    })

    const results = await Promise.all(
      Array.from(
        { length: 8 },
        () => Effect.runPromise(launch.pipe(Effect.provide(over(filename)), Effect.scoped))
      )
    )
    const receipts = results.filter(Exit.isSuccess).map((result) => result.value)
    expect(receipts).toHaveLength(8)
    expect(receipts.filter((receipt) => receipt._tag === "Accepted")).toHaveLength(1)
    expect(receipts.filter((receipt) => receipt._tag === "AlreadyApplied")).toHaveLength(7)
    expect(new Set(receipts.flatMap((receipt) => "runId" in receipt ? [receipt.runId] : []))).toEqual(
      new Set(["run-1"])
    )

    const runs = await run(
      over(filename),
      Effect.gen(function*() {
        const control = yield* Control
        const listed = yield* control.list({ _tag: "runs" })
        return listed._tag === "runs" ? listed.items.map((item) => item.runId) : []
      })
    )
    expect(runs).toEqual(["run-1"])
  })
})
