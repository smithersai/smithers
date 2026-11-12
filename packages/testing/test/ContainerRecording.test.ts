import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Redacted, Schema, Sink, Stream } from "effect"
import * as ContainerRecording from "../src/ContainerRecording.ts"

// A container with real state: a box that runs or not, files, snapshots of them, and commands that read and write
// them. It counts every call that reaches it, so replay can prove none does.
class BoxFailure extends Schema.TaggedError<BoxFailure>()("BoxFailure", { message: Schema.String }) {}
class NamedFailure extends Error {
  override readonly name = "NamedFailure"
}

const LIVE_TOKEN = "ghs_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
const encoder = new TextEncoder()

const liveBox = () => {
  const state = {
    up: false,
    files: new Map<string, string>(),
    snapshots: new Map<string, Map<string, string>>(),
    hits: 0
  }
  const hit = <A>(work: () => A) =>
    Effect.sync(() => {
      state.hits += 1
      return work()
    })
  type Failure = BoxFailure | NamedFailure | string
  const container: ContainerRecording.Container<Failure> = {
    running: hit(() => state.up),
    start: (options?: object) =>
      hit(() => {
        const snapshot = (options as { readonly snapshot?: string } | undefined)?.snapshot
        state.files = new Map(snapshot === undefined ? [] : state.snapshots.get(snapshot))
        state.up = true
      }),
    setInactivityTimeout: () => hit(() => undefined),
    interceptOutboundHttp: () => hit(() => undefined),
    interceptAllOutboundHttp: () => hit(() => undefined),
    interceptOutboundHttps: () => hit(() => undefined),
    snapshotContainer: () =>
      Effect.flatMap(
        hit(() => state.up),
        (up) => {
          if (!up) return Effect.fail(new BoxFailure({ message: "not running" }))
          const id = `snapshot-${state.snapshots.size + 1}`
          state.snapshots.set(id, new Map(state.files))
          return Effect.succeed({ id })
        }
      ),
    destroy: () => hit(() => void (state.up = false)),
    exec: (argv, options) =>
      Effect.flatMap(
        hit(() => argv),
        ([verb, path, content]): Effect.Effect<ContainerRecording.Process<Failure>, Failure> => {
          if (verb === "boom") return Effect.fail(new NamedFailure("exec refused"))
          if (verb === "odd") return Effect.fail("a bare string")
          if (verb === "plain") return Effect.fail({ reason: "no tag" } as unknown as string)
          const out = verb === "write"
            ? (state.files.set(path!, content!), "")
            : verb === "cat"
            ? state.files.get(path!) ?? ""
            : ""
          return Effect.succeed({
            stdin: options.stdin === "pipe" ? Sink.drain : undefined,
            stdout: options.stdout === "pipe"
              ? Stream.make(encoder.encode(out.slice(0, 2)), encoder.encode(out.slice(2)))
              : undefined,
            stderr: options.stderr === "pipe" ? Stream.make(encoder.encode(verb === "cat" ? "" : "warn")) : undefined,
            exitCode: verb === "lost"
              ? Effect.fail(new BoxFailure({ message: "exit lost" }))
              : Effect.succeed(verb === "cat" && !state.files.has(path!) ? 1 : 0)
          })
        }
      )
  }
  return { state, container }
}

const pipe = { stdout: "pipe", stderr: "pipe" } as const
type Box = ReturnType<typeof liveBox>["container"]

/** Runs one command to completion in its own scope: output, error text and exit code. */
const run = (box: Box, argv: Array<string>, options: ContainerRecording.ExecOptions = pipe) =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* box.exec(argv, options)
    const decode = (stream: Stream.Stream<Uint8Array, unknown> | undefined) =>
      stream === undefined ? Effect.succeed(undefined) : Effect.map(Stream.mkString(Stream.decodeText(stream)), String)
    const stdout = yield* decode(process.stdout)
    const stderr = yield* decode(process.stderr)
    return { stdout, stderr, code: yield* process.exitCode }
  }))

/** One journey over a box: start, write, checkpoint, destroy, restore, read, a missing file and a stop. */
const journey = (box: Box) =>
  Effect.gen(function*() {
    const before = yield* box.running
    yield* box.start({ enableInternet: false, entrypoint: ["sleep", "infinity"] })
    yield* box.setInactivityTimeout(150_000)
    yield* box.interceptOutboundHttp("forge.internal", undefined as never)
    yield* box.interceptAllOutboundHttp(undefined as never)
    yield* box.interceptOutboundHttps("*", undefined as never)
    const written = yield* run(box, ["write", "keep.txt", "saved"])
    const snapshot = (yield* box.snapshotContainer()) as { readonly id: string }
    yield* box.destroy()
    const stopped = yield* box.running
    yield* box.start({ snapshot: snapshot.id })
    const read = yield* run(box, ["cat", "keep.txt"])
    const missing = yield* run(box, ["cat", "gone.txt"], { stdout: "ignore", stderr: "ignore", stdin: "pipe" })
    yield* box.start()
    return { before, written, snapshot, stopped, read, missing }
  })

const defectOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("ContainerRecording", () => {
  it.effect("records a journey's calls in the order they began, and a replay answers it as the live box did, reaching none", () =>
    Effect.gen(function*() {
      const live = liveBox()
      const stored: Array<[number, ContainerRecording.Operation]> = []
      const recorder = ContainerRecording.record(live.container, {
        onCall: (call, index) => Effect.sync(() => void stored.push([index, call.operation]))
      })
      const recorded = yield* journey(recorder.container)
      const calls = recorder.calls()
      expect(calls.map((call) => call.operation)).toEqual([
        "running",
        "start",
        "setInactivityTimeout",
        "interceptOutboundHttp",
        "interceptAllOutboundHttp",
        "interceptOutboundHttps",
        "exec",
        "snapshotContainer",
        "destroy",
        "running",
        "start",
        "exec",
        "exec",
        "start"
      ])
      expect(stored.map(([index]) => index)).toEqual(calls.map((_, index) => index))
      expect(calls[3]).toEqual({ operation: "interceptOutboundHttp", input: { addr: "forge.internal" }, output: null })
      expect(calls[6]).toEqual({
        operation: "exec",
        input: { argv: ["write", "keep.txt", "saved"], options: pipe },
        output: { stdout: "", stderr: "warn", exitCode: 0 }
      })
      expect(calls[12]!.output).toEqual({ stdout: "", stderr: "", exitCode: 1 })
      expect(recorded.read).toEqual({ stdout: "saved", stderr: "", code: 0 })

      const text = yield* ContainerRecording.encode({ label: "journey", calls })
      const replayed = ContainerRecording.replay<Box>(ContainerRecording.decode(text))
      const hits = live.state.hits
      expect(yield* journey(replayed.container)).toEqual({
        ...recorded,
        missing: { stdout: undefined, stderr: undefined, code: 1 }
      })
      expect(recorded.missing).toEqual({ stdout: undefined, stderr: undefined, code: 1 })
      expect(replayed.remaining()).toBe(0)
      expect(live.state.hits).toBe(hits)
    }))

  it.effect("a replayed call that differs from the recording's next one, or comes after the last, dies naming the call, never its input", () =>
    Effect.gen(function*() {
      const live = liveBox()
      const recorder = ContainerRecording.record(live.container)
      yield* recorder.container.start()
      yield* run(recorder.container, ["write", "secret-path", "x"])
      const recording = { calls: recorder.calls() }

      const otherInput = ContainerRecording.replay<Box>(recording)
      yield* otherInput.container.start()
      const changed = defectOf(yield* Effect.exit(run(otherInput.container, ["write", "other-path", "x"])))
      expect(changed).toBeInstanceOf(ContainerRecording.UnrecordedCallError)
      expect(String((changed as Error).message)).toBe(
        "Container call 1 was exec with other input than recorded (exec). Record the test again."
      )

      const otherOperation = ContainerRecording.replay<Box>(recording)
      const reordered = defectOf(yield* Effect.exit(otherOperation.container.destroy()))
      expect(reordered).toMatchObject({ index: 0, operation: "destroy", recorded: "start" })
      expect(otherOperation.remaining()).toBe(2)

      const after = ContainerRecording.replay<Box>(recording)
      yield* after.container.start()
      yield* run(after.container, ["write", "secret-path", "x"])
      const past = defectOf(yield* Effect.exit(after.container.running))
      expect(String((past as Error).message)).toBe(
        "No recorded container call left for running (call 2). Record the test again."
      )
    }))

  it.effect("a replay with polled operations matches a run whose timer polled fewer or more times than the recorded run", () =>
    Effect.gen(function*() {
      // A slow live run: an alarm polled the box twice while it started. A replay answers at once, so its alarm
      // polls before the write never happen, and it polls once more after the end.
      const live = liveBox()
      const recorder = ContainerRecording.record(live.container)
      yield* recorder.container.running
      yield* recorder.container.start()
      yield* recorder.container.setInactivityTimeout(1000)
      for (const _ of [1, 2]) {
        yield* recorder.container.running
        yield* recorder.container.setInactivityTimeout(1000)
      }
      yield* run(recorder.container, ["write", "keep", "x"])
      yield* recorder.container.running
      yield* recorder.container.destroy()
      yield* recorder.container.running
      const recording = { calls: recorder.calls() }
      const polled = ["running", "setInactivityTimeout"] as const

      const strict = ContainerRecording.replay<Box>(recording)
      yield* strict.container.running
      yield* strict.container.start()
      yield* strict.container.setInactivityTimeout(1000)
      const unpolled = defectOf(yield* Effect.exit(run(strict.container, ["write", "keep", "x"])))
      expect(unpolled).toMatchObject({ index: 3, operation: "exec", recorded: "running" })

      const hits = live.state.hits
      const replayed = ContainerRecording.replay<Box>(recording, { polled })
      const answers = [yield* replayed.container.running]
      yield* replayed.container.start()
      for (const _ of [1, 2, 3, 4]) yield* replayed.container.setInactivityTimeout(1000)
      expect(replayed.remaining()).toBe(2)
      yield* run(replayed.container, ["write", "keep", "x"])
      answers.push(yield* replayed.container.running)
      answers.push(yield* replayed.container.running)
      yield* replayed.container.destroy()
      answers.push(yield* replayed.container.running, yield* replayed.container.running)
      expect(answers).toEqual([false, true, true, false, false])
      expect(replayed.remaining()).toBe(0)
      expect(live.state.hits).toBe(hits)

      // A poll is answered only by a recorded poll since the last state-changing call: never across a start.
      const stale = ContainerRecording.replay<Box>({
        calls: recording.calls.filter((call) => call.operation !== "running" || call.output === false).slice(0, 3)
      }, { polled })
      yield* stale.container.start()
      const across = defectOf(yield* Effect.exit(stale.container.running))
      expect(across).toMatchObject({ index: 2, operation: "running", recorded: "setInactivityTimeout" })
      // Nor does a poll skip a state-changing call: a write the replay never makes stays unclaimed.
      const skipped = ContainerRecording.replay<Box>(recording, { polled })
      yield* skipped.container.running
      yield* skipped.container.start()
      const past = defectOf(yield* Effect.exit(skipped.container.destroy()))
      expect(past).toMatchObject({ index: 7, operation: "destroy", recorded: "exec" })
      expect(skipped.remaining()).toBe(2)
    }))

  it.effect("record hands destroy its error and leaves every member it does not record to the live handle", () =>
    Effect.gen(function*() {
      const live = liveBox()
      const given: Array<unknown> = []
      // Alchemy's container handle: a Proxy over its own members (`monitor`) that sends any other name to the box.
      const members = {
        ...live.container,
        destroy: (error?: unknown) => Effect.sync(() => void (given.push(error), live.state.up = false)),
        monitor: () => Effect.succeed("exited")
      }
      const handle = new Proxy(members, {
        get: (target, prop) =>
          prop in target
            ? target[prop as keyof typeof target]
            : typeof prop === "string"
            ? (...args: Array<unknown>) => Effect.succeed(`${prop} ${args.join(" ")}`)
            : undefined
      })
      type Handle = typeof members & { readonly ping: (word: string) => Effect.Effect<string> }
      const recorder = ContainerRecording.record(handle as Handle)
      const evicted = new BoxFailure({ message: "evicted" })
      yield* recorder.container.destroy(evicted)
      yield* recorder.container.destroy()
      expect(given).toEqual([evicted, undefined])
      expect([yield* recorder.container.monitor(), yield* recorder.container.ping("box")]).toEqual([
        "exited",
        "ping box"
      ])
      // A spread of the recorded box, as a container object passes it on, keeps recording and keeps the handle's own.
      const spread = { ...recorder.container }
      expect([yield* spread.running, yield* spread.monitor()]).toEqual([false, "exited"])
      expect(recorder.calls()).toEqual([
        { operation: "destroy", input: { error: "BoxFailure" }, output: null },
        { operation: "destroy", input: null, output: null },
        { operation: "running", input: null, output: false }
      ])
      const replayed = ContainerRecording.replay<Box>({ calls: recorder.calls() })
      yield* replayed.container.destroy(evicted)
      yield* replayed.container.destroy()
      yield* replayed.container.running
      expect(replayed.remaining()).toBe(0)
    }))

  it.effect("a failed call is recorded by its tag, and replays as a failure with that tag", () =>
    Effect.gen(function*() {
      const live = liveBox()
      const recorder = ContainerRecording.record(live.container)
      const snapshot = yield* Effect.flip(recorder.container.snapshotContainer({ name: "early" }))
      const refused = yield* Effect.flip(run(recorder.container, ["boom"]))
      const odd = yield* Effect.flip(run(recorder.container, ["odd"]))
      const plain = yield* Effect.flip(run(recorder.container, ["plain"]))
      const lost = yield* Effect.flip(run(recorder.container, ["lost"], { stdout: "pipe" }))
      expect([snapshot, refused, odd, plain, lost]).toEqual([
        new BoxFailure({ message: "not running" }),
        new NamedFailure("exec refused"),
        "a bare string",
        { reason: "no tag" },
        new BoxFailure({ message: "exit lost" })
      ])
      const calls = recorder.calls()
      expect(calls.map((call) => call.failure ?? (call.output as ContainerRecording.ExecAnswer).exitFailure)).toEqual([
        "BoxFailure",
        "NamedFailure",
        "unknown",
        "unknown",
        "BoxFailure"
      ])

      const replayed = ContainerRecording.replay<Box>({ calls })
      const again = [
        yield* Effect.flip(replayed.container.snapshotContainer({ name: "early" })),
        yield* Effect.flip(run(replayed.container, ["boom"])),
        yield* Effect.flip(run(replayed.container, ["odd"])),
        yield* Effect.flip(run(replayed.container, ["plain"])),
        yield* Effect.flip(run(replayed.container, ["lost"], { stdout: "pipe" }))
      ]
      expect(
        again.map((error) =>
          error instanceof ContainerRecording.ReplayedFailure ? [error._tag, error.operation] : error
        )
      ).toEqual([
        ["BoxFailure", "snapshotContainer"],
        ["NamedFailure", "exec"],
        ["unknown", "exec"],
        ["unknown", "exec"],
        ["BoxFailure", "exec"]
      ])
    }))

  it.effect("a recorded command whose exit nobody read has no exit code to replay", () =>
    Effect.gen(function*() {
      const recorder = ContainerRecording.record(liveBox().container)
      yield* Effect.scoped(recorder.container.exec(["write", "a", "b"], {}))
      expect(recorder.calls()[0]!.output).toEqual({ stdout: "", stderr: "" })
      const replayed = ContainerRecording.replay<Box>({ calls: recorder.calls() })
      const exit = yield* Effect.exit(
        Effect.scoped(Effect.flatMap(replayed.container.exec(["write", "a", "b"], {}), (process) => process.exitCode))
      )
      expect(defectOf(exit)).toMatchObject({ index: 0, operation: "exit", recorded: "none" })
    }))

  it.effect("normalize erases what the clock decides from a call's input, for recording and comparing alike", () =>
    Effect.gen(function*() {
      const normalize: ContainerRecording.Normalize = (operation, input) =>
        operation === "setInactivityTimeout" ? "<duration>" : input
      const recorder = ContainerRecording.record(liveBox().container, { normalize })
      yield* recorder.container.setInactivityTimeout(59_871)
      expect(recorder.calls()).toEqual([{ operation: "setInactivityTimeout", input: "<duration>", output: null }])
      const replayed = ContainerRecording.replay<Box>({ calls: recorder.calls() }, { normalize })
      yield* replayed.container.setInactivityTimeout(58_002)
      expect(replayed.remaining()).toBe(0)
    }))

  it.effect("make chooses the container for each mode, and a mode without what it needs is a defect", () =>
    Effect.gen(function*() {
      const live = liveBox()
      expect(ContainerRecording.make({ mode: "passthrough", live: live.container })).toBe(live.container)
      const recorded = ContainerRecording.make({ mode: "record", live: live.container })
      yield* recorded.start()
      expect(live.state.up).toBe(true)
      const replayed = ContainerRecording.make<Box>({
        mode: "replay",
        recording: { calls: [{ operation: "running", input: null, output: true }] }
      })
      expect(yield* replayed.running).toBe(true)
      expect(() => ContainerRecording.make({ mode: "replay" })).toThrow("ContainerRecording replay needs a recording")
      expect(() => ContainerRecording.make({ mode: "record" })).toThrow(
        "ContainerRecording record needs the live container"
      )
    }))

  it.effect("encode scrubs every named secret and token shape, and refuses what scrubbing cannot reach", () =>
    Effect.gen(function*() {
      const secret = "plain-opaque-session-value"
      const calls: ReadonlyArray<ContainerRecording.Call> = [{
        operation: "exec",
        input: { argv: ["sh", "-c", `echo ${secret}`], options: { env: { token: "named-field" } }, sizes: [1, 2] },
        output: { stdout: `got ${LIVE_TOKEN}`, stderr: "", exitCode: 0 }
      }]
      const text = yield* ContainerRecording.encode({ calls }, [Redacted.make(secret), "short"])
      expect(text).not.toContain(secret)
      expect(text).not.toContain(LIVE_TOKEN)
      expect(text).not.toContain("named-field")
      expect(text.split("\n")).toHaveLength(4)
      expect(ContainerRecording.decode(text).calls[0]!.input).toMatchObject({ sizes: [1, 2] })
      expect(yield* ContainerRecording.encode({ calls })).not.toContain(LIVE_TOKEN)

      const shaped = yield* Effect.flip(ContainerRecording.encode({ label: LIVE_TOKEN, calls }))
      expect(shaped.rules).toContain("github-token")
      expect(shaped.message).not.toContain(LIVE_TOKEN)
      const named = yield* Effect.flip(ContainerRecording.encode({ label: secret, calls }, [secret]))
      expect(named.rules).toEqual(["live-secret"])
      expect(() => ContainerRecording.decode(`{"calls":[{"operation":"reboot","input":null}]}`)).toThrow()
    }))
})
