/**
 * The settlement vocabulary a launching verb reports its run with, pinned at
 * the module that now owns it instead of only through `Command.cli`.
 */
import { Control, ControlError } from "@smthrs/control"
import type { ControlSchema } from "@smthrs/control"
import { Duration, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { spawnSync } from "node:child_process"
import { hostname } from "node:os"
import { describe, expect, it } from "vitest"
import * as Settlement from "../src/commands/Settlement.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.vibe"

describe("Settlement", () => {
  it("settles on a park, a declined launch, and every terminal status", () => {
    expect(
      [
        "control.run.waiting-approval",
        "control.run.pending",
        "control.run.completed",
        "control.run.failed",
        "control.run.cancelled",
        "control.run.started",
        "control.node.completed"
      ].filter(Settlement.settled)
    ).toEqual([
      "control.run.waiting-approval",
      "control.run.pending",
      "control.run.completed",
      "control.run.failed",
      "control.run.cancelled"
    ])
  })

  it("reports the launch contract's exit status for each settlement", () => {
    expect(Settlement.status({ kind: "control.run.completed" })).toBe(0)
    expect(Settlement.status({ kind: "control.run.failed" })).toBe(1)
    expect(Settlement.status({ kind: "control.run.cancelled" })).toBe(130)
    expect(Settlement.status({ kind: "control.run.waiting-approval" })).toBe(3)
    expect(Settlement.status({ kind: "control.run.parked" })).toBe(3)
    expect(Settlement.status({ kind: "control.run.pending" })).toBeUndefined()
    expect(Settlement.status(undefined)).toBeUndefined()
  })

  it("treats only a pending settlement as a declined launch", () => {
    expect(Settlement.wasDeclined({ kind: "control.run.pending" })).toBe(true)
    expect(Settlement.wasDeclined({ kind: "control.run.failed" })).toBe(false)
    expect(Settlement.wasDeclined(undefined)).toBe(false)
  })

  it("keeps the receipt and adds the run's outcome", () => {
    const receipt = { _tag: "Accepted", runId: "run-1" } as unknown as ControlSchema.Receipt

    // A bare receipt read `Accepted` for a run that passed and for one nobody
    // waited for, so a passing docs check looked unanswered (2026-10-20).
    expect(Settlement.receiptDocument(receipt, { kind: "control.run.completed" })).toEqual({
      ...receipt,
      status: "completed"
    })
    expect(Settlement.receiptDocument(receipt, { kind: "control.run.failed" })).toEqual({
      ...receipt,
      status: "failed",
      cause: "no cause recorded in the journal"
    })
    expect(Settlement.receiptDocument(receipt, { kind: "control.run.parked", cause: "Run run-1 parked" })).toEqual({
      ...receipt,
      status: "parked",
      cause: "Run run-1 parked"
    })
    expect(Settlement.receiptDocument(receipt, undefined)).toBe(receipt)
  })

  it("keeps a transport failure's own retryability when it wraps one", () => {
    // A watch that failed because the transport said so is retryable exactly
    // as that transport said; anything else is retryable by default.
    expect(
      Settlement.watchFailure(
        new ControlError.TransportError({ message: "gone", retryable: false }),
        "run-1",
        "settlement"
      ).retryable
    ).toBe(false)
    expect(Settlement.watchFailure(new Error("socket reset"), "run-1", "settlement").retryable).toBe(true)
  })

  it("keeps the highest sequence a stream carries, whatever order it arrives in", async () => {
    const sequences = (numbers: ReadonlyArray<number>) =>
      Effect.runPromise(Settlement.latestSequence(Stream.fromArray(numbers.map((sequence) => ({ sequence })))))

    expect(await sequences([])).toBeUndefined()
    expect(await sequences([7])).toBe(7)
    expect(await sequences([7, 9])).toBe(9)
    // A replay out of order must not lower the park a resume keys on.
    expect(await sequences([9, 7])).toBe(9)
  })

  it("names the run and the next commands when no executor took it", () => {
    const error = Settlement.declined("run-1", undefined)

    expect(error.message).toContain("Run run-1 was accepted but no executor took it: it is accepted")
    expect(error.message).toContain("smthrs runs cancel run-1")
  })
})

describe("settlement ownership", () => {
  const receipt = { _tag: "Accepted", receiptId: "approve-1", runId: "run-1" } as const
  const service = async (overrides: Partial<Control.Service>) =>
    Control.make({
      ...await Effect.runPromise(Control.Control.pipe(Effect.provide(Control.layerNoop))),
      ...overrides
    })
  const owner = (hostId: string, pid: number) => JSON.stringify({ hostId, pid, nonce: "owner-fence" })
  // A pid that names no process: a child that has already exited and been
  // reaped by spawnSync. The parent is a live process on this host that is
  // not this one.
  const exited = spawnSync(process.execPath, ["-e", ""]).pid

  it.each([
    { label: "another process", ownerId: owner(hostname(), process.pid + 1), waits: false },
    { label: "another host with the same PID", ownerId: owner(`${hostname()}-other`, process.pid), waits: false },
    { label: "a live peer's parked run", parkedBy: owner(hostname(), process.ppid), waits: false },
    { label: "another host's parked run", parkedBy: owner(`${hostname()}-other`, process.pid + 1), waits: false },
    // The parker exited, so the decision this process recorded is what
    // restarted the run, on this process's executor (case03): returning
    // would end the process and interrupt that driver.
    { label: "an exited peer's parked run", parkedBy: owner(hostname(), exited), waits: true },
    { label: "this process", ownerId: owner(hostname(), process.pid), waits: true },
    { label: "this process's park", parkedBy: owner(hostname(), process.pid), waits: true },
    { label: "an ownerless admission", waits: true },
    { label: "a legacy opaque owner", ownerId: "memory-owner", waits: true },
    { label: "malformed ownership", ownerId: "{", waits: true }
  ])("$label", async ({ ownerId, parkedBy, waits }) => {
    let watched = 0
    const control = await service({
      list: () =>
        Effect.succeed({
          _tag: "runs",
          items: [{ runId: "run-1", flowId: "idle", status: "running", createdAt: 0, updatedAt: 0, ownerId, parkedBy }]
        }),
      watch: () => {
        watched += 1
        return Stream.make({
          runId: "run-1",
          sequence: 1,
          occurredAt: 0,
          kind: "control.run.completed",
          payload: {}
        })
      }
    })
    const settled = await Effect.runPromise(
      Settlement.awaitOwnedRun(control, receipt, undefined, true).pipe(
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.timeout("1 second")
      )
    )
    expect(watched).toBe(waits ? 1 : 0)
    expect(settled).toEqual(waits ? { kind: "control.run.completed" } : undefined)
  })

  it("does not read or wait when the receipt explicitly hands work to another host", async () => {
    const settled = await Effect.runPromise(
      Settlement.awaitOwnedRun(
        await service({}),
        {
          ...receipt,
          handedTo: { hostId: hostname(), pid: process.pid + 1 }
        },
        undefined,
        true
      ).pipe(Effect.provide(ExecutorOwnership.layer(true)))
    )
    expect(settled).toBeUndefined()
  })

  it("preserves an ownership read failure instead of pretending the decision settled", async () => {
    const failure = new ControlError.TransportError({ message: "ownership read failed", retryable: true })
    const control = await service({ list: () => Effect.fail(failure) })
    const observed = await Effect.runPromise(
      Settlement.awaitOwnedRun(control, receipt, undefined, true).pipe(
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.flip
      )
    )
    expect(observed).toBe(failure)
  })
})

describe("awaitRun", () => {
  const service = async (overrides: Partial<Control.Service>) =>
    Control.make({
      ...await Effect.runPromise(Control.Control.pipe(Effect.provide(Control.layerNoop))),
      ...overrides
    })
  const event = (
    sequence: number,
    kind: string,
    payload: ControlSchema.ControlEvent["payload"] = {}
  ): ControlSchema.ControlEvent => ({
    runId: "run-1",
    sequence,
    occurredAt: sequence,
    kind,
    payload
  })
  // The engine's record of a lease lapse that interrupted the docs-sync step.
  const lapse = event(4, "control.engine.event", {
    executionId: "child-1",
    eventType: "flows.engine.run-decision",
    payload: {
      decision: "interrupt-released",
      cause: { kind: "lease-lapsed", unconfirmedMs: 19_001 },
      executionFact: { observation: { flowName: "registry/entry/abc/docs-sync" } }
    }
  })
  const summary = (status: string, waitingReason?: string) => ({
    _tag: "runs" as const,
    items: [{
      runId: "run-1",
      flowId: "docs-sync",
      status,
      createdAt: 0,
      updatedAt: 0,
      ...(waitingReason === undefined ? {} : { waitingReason })
    }]
  })
  /** Runs `awaitRun` under a test clock, advancing it by `advance` once it is waiting. */
  const settle = (control: Control.Service, advance: Duration.Input) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.result(Settlement.awaitRun(control, "run-1", undefined, true)))
        yield* TestClock.adjust(advance)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )

  it("reports a park on released once no host re-drives it, naming the lapse and the resume", async () => {
    let reads = 0
    const control = await service({
      list: () => Effect.sync(() => (reads++, summary("parked", "released")) as never),
      // A park leaves the run with no further event: the follow never ends.
      watch: () => Stream.concat(Stream.make(lapse, event(5, "control.run.parked")), Stream.never)
    })
    const result = await settle(control, Duration.sum(Settlement.releasedParkGrace, Duration.seconds(1)))
    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.success.kind).toBe("control.run.parked")
    expect(result.success.cause).toBe(
      "Run run-1 parked: docs-sync was interrupted when its host's run lease went unconfirmed for 19.0 s. " +
        "Nothing restarts it; `smthrs runs resume run-1` re-runs the interrupted step."
    )
    expect(Settlement.status(result.success)).toBe(3)
    expect(reads).toBeGreaterThan(1)
  })

  it("keeps waiting while a released park is re-driven, then reports the run's settlement", async () => {
    // A keyed step is retried on the owner's next sweep: the run leaves the
    // park, and the wait must report how it then ended, not the park.
    let reads = 0
    const control = await service({
      list: () => Effect.sync(() => (reads++ === 0 ? summary("parked", "released") : summary("running")) as never),
      watch: () =>
        Stream.concat(
          Stream.make(lapse, event(5, "control.run.parked"), event(9, "control.run.completed")),
          Stream.never
        )
    })
    const result = await settle(control, Duration.seconds(2))
    expect(result).toMatchObject({ _tag: "Success", success: { kind: "control.run.completed" } })
  })

  it("keeps following a park on anything but released", async () => {
    // A durable timer or an event wait is this host's to wake.
    const control = await service({
      list: () => Effect.succeed(summary("parked", "timer") as never),
      watch: () =>
        Stream.concat(
          Stream.make(event(5, "control.run.parked"), event(9, "control.run.failed", { cause: "red" })),
          Stream.never
        )
    })
    const result = await settle(control, Duration.seconds(1))
    expect(result).toMatchObject({ _tag: "Success", success: { kind: "control.run.failed", cause: "red" } })
  })

  it.each([
    { status: "completed", kind: "control.run.completed" },
    { status: "failed", kind: "control.run.failed" },
    { status: "cancelled", kind: "control.run.cancelled" }
  ])("reads a $status run's status when the follow ends without its settlement", async ({ status, kind }) => {
    const control = await service({
      list: () => Effect.succeed(summary(status) as never),
      watch: () => Stream.make(event(1, "control.run.running"))
    })
    expect(await settle(control, Duration.zero)).toMatchObject({ _tag: "Success", success: { kind } })
  })

  it("refuses to report a run whose follow ended while it still runs", async () => {
    // Reporting nothing printed the bare admission receipt and exited 0.
    const control = await service({
      list: () => Effect.succeed(summary("running") as never),
      watch: () => Stream.make(event(1, "control.run.running"))
    })
    const result = await settle(control, Duration.zero)
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure).toBeInstanceOf(ControlError.TransportError)
    expect(result.failure.message).toBe(
      "The event stream for run \"run-1\" ended before the run settled; it is running. " +
        "Read it with `smthrs runs show run-1`."
    )
  })

  it.each([
    {
      status: "parked",
      waitingReason: "released",
      outcome: { _tag: "Success", success: { kind: "control.run.parked" } }
    },
    { status: "completed", outcome: { _tag: "Success", success: { kind: "control.run.completed" } } },
    { status: "running", outcome: { _tag: "Failure" } }
  ])(
    "reads a $status run when the host interrupts the wait from inside",
    async ({ status, waitingReason, outcome }) => {
      // A lapsed lease interrupted the host's fibers; the command printed only
      // "All fibers interrupted without error" and exited 1 (2026-10-20).
      const control = await service({
        list: () => Effect.succeed(summary(status, waitingReason) as never),
        watch: () => Stream.concat(Stream.make(lapse), Stream.fromEffect(Effect.interrupt))
      })
      const result = await settle(control, Duration.zero)
      expect(result).toMatchObject(outcome)
      if (result._tag === "Failure") expect(result.failure.message).toContain("it is running")
    }
  )

  it("reports a released park the follow ended on", async () => {
    const control = await service({
      list: () => Effect.succeed(summary("parked", "released") as never),
      watch: () => Stream.make(lapse)
    })
    const result = await settle(control, Duration.zero)
    expect(result).toMatchObject({ _tag: "Success", success: { kind: "control.run.parked" } })
  })
})
