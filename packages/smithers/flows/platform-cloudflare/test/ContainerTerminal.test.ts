/**
 * `ContainerTerminal` against an in-memory container and socket, for the
 * exact edges a real container cannot produce on demand: frame boundaries,
 * each fault, and what telemetry records. `ContainerTerminal.workerd.test.ts`
 * runs the same functions against a real container and tmux.
 */
import { describe, expect, it } from "@effect/vitest"
import { TerminalProtocol } from "@smthrs/sandbox"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { ContainerTerminal } from "../src/index.ts"
import * as MemoryContainer from "./fixtures/MemoryContainer.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const id = "0b6c8a52-5f0e-4d4e-9a9e-1f2b3c4d5e6f"
const sentinel = "SENTINEL-7d02be"
const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text)
const max = TerminalProtocol.maxFrameBytes

/** `tmux attach-session` is driven by the test; every other command exits 0. */
const shell = (argv: ReadonlyArray<string>) => argv[1] === "attach-session" ? "interactive" as const : 0

const control = (frame: MemoryContainer.Sent) =>
  typeof frame === "string" ? TerminalProtocol.decodeServerControl(frame) : undefined

/** Attaches a viewer in the background and waits for its tmux client to start and `ready` to arrive. */
const open = (
  access: TerminalProtocol.Access,
  faults: MemoryContainer.Faults = {},
  options: Partial<ContainerTerminal.AttachOptions> = {}
) =>
  Effect.gen(function*() {
    const memory = MemoryContainer.make(shell, faults)
    const viewer = MemoryContainer.socket()
    const fiber = yield* Effect.forkChild(
      ContainerTerminal.attach(memory.container, viewer.socket, {
        name: id,
        user: "1000:2000",
        access,
        cols: 100,
        rows: 30,
        ...options
      })
    )
    const client = yield* memory.started
    return { memory, viewer, fiber, client }
  })

describe("ContainerTerminal.attach", () => {
  it.effect("a writer's client types, resizes and sees the shell until the session ends", () =>
    Effect.gen(function*() {
      const { client, fiber, viewer } = yield* open("write")
      expect(client.argv).toEqual(["tmux", "attach-session", "-t", `=${id}`])
      expect(client.options).toEqual({
        user: "1000:2000",
        env: { TERM: "xterm-256color" },
        pty: { cols: 100, rows: 30 },
        stdin: "pipe"
      })
      expect(control(yield* viewer.next)).toEqual({ type: "ready", access: "write" })

      yield* client.write(bytes("$ "))
      expect(yield* viewer.next).toEqual(bytes("$ "))

      // An ArrayBuffer, a typed array over part of a buffer and a Blob all
      // reach stdin, in the order they were sent.
      viewer.emit("message", new Uint8Array(bytes("ls")).buffer)
      const window = new Uint8Array([0, 0x0d, 0])
      viewer.emit("message", window.subarray(1, 2))
      viewer.emit("message", new Blob([bytes("pwd\r")]))
      expect(yield* client.typed).toEqual(bytes("ls"))
      expect(yield* client.typed).toEqual(new Uint8Array([0x0d]))
      expect(yield* client.typed).toEqual(bytes("pwd\r"))

      viewer.emit("message", TerminalProtocol.encodeResize(120, 40))
      // A frame exactly at the cap is accepted.
      viewer.emit("message", new Uint8Array(max))
      expect((yield* client.typed).byteLength).toBe(max)
      expect(client.resizes).toEqual([[120, 40]])

      // Output larger than a frame leaves in frames under the cap, in order.
      const big = Uint8Array.from({ length: 2 * max + 100 }, (_, index) => index % 251)
      yield* client.write(big)
      const frames = [yield* viewer.next, yield* viewer.next, yield* viewer.next] as Array<Uint8Array>
      expect(frames.map((frame) => frame.byteLength)).toEqual([max, max, 100])
      expect(new Uint8Array(frames.flatMap((frame) => [...frame]))).toEqual(big)

      // The session ends: its client exits, and the viewer hears why.
      yield* client.exit(0)
      expect(control(yield* viewer.next)).toEqual({ type: "ended", reason: "closed" })
      expect(yield* viewer.closed).toBe(TerminalProtocol.CloseCode.ended)
      expect(yield* Fiber.join(fiber)).toEqual({
        outcome: "ended",
        closeCode: 1000,
        bytes: { in: 2 + 1 + 4 + max, out: 2 + big.byteLength, dropped: 0 }
      })
      // A client that exited by itself is never signalled.
      expect(client.kills).toEqual([])
    }))

  it.effect("a reader's client is read-only and sizes nothing; its bytes and resizes are dropped", () =>
    Effect.gen(function*() {
      // The caller's variables reach the client; TERM is always xterm's own.
      const { client, fiber, viewer } = yield* open("read", {}, { env: { LANG: "C.UTF-8", TERM: "dumb" } })
      expect(client.argv).toEqual(["tmux", "attach-session", "-f", "read-only,ignore-size", "-t", `=${id}`])
      // No stdin at all: nothing a reader sends has a way in.
      expect(client.options).toEqual({
        user: "1000:2000",
        env: { LANG: "C.UTF-8", TERM: "xterm-256color" },
        pty: { cols: 100, rows: 30 }
      })
      expect(control(yield* viewer.next)).toEqual({ type: "ready", access: "read" })

      viewer.emit("message", bytes("touch /tmp/reader\r"))
      // xterm's automatic replies: a device attributes answer and a cursor report.
      viewer.emit("message", new Blob([bytes("\x1b[?1;2c\x1b[30;100R")]))
      viewer.emit("message", TerminalProtocol.encodeResize(40, 10))
      yield* client.write(bytes("output"))
      expect(yield* viewer.next).toEqual(bytes("output"))

      // The viewer leaves: only its own client is killed.
      viewer.emit("close")
      const report = yield* Fiber.join(fiber)
      expect(report).toEqual({ outcome: "closed", closeCode: null, bytes: { in: 0, out: 6, dropped: 18 + 16 } })
      expect(client.kills).toEqual([9])
      expect(client.resizes).toEqual([])
    }))

  it.effect.each(
    [
      ["malformed JSON", "{nope", TerminalProtocol.CloseCode.unsupported, "unsupported"],
      [
        "an unknown control",
        JSON.stringify({ type: "paste", text: "x" }),
        TerminalProtocol.CloseCode.unsupported,
        "unsupported"
      ],
      [
        "a resize out of bounds",
        TerminalProtocol.encodeResize(0, 24),
        TerminalProtocol.CloseCode.unsupported,
        "unsupported"
      ],
      ["a number", 42, TerminalProtocol.CloseCode.unsupported, "unsupported"],
      ["null", null, TerminalProtocol.CloseCode.unsupported, "unsupported"],
      ["an object with no bytes", { size: 3 }, TerminalProtocol.CloseCode.unsupported, "unsupported"],
      ["a binary frame over the cap", new Uint8Array(max + 1), TerminalProtocol.CloseCode.tooBig, "too_big"],
      ["a text frame over the cap", "x".repeat(max + 1), TerminalProtocol.CloseCode.tooBig, "too_big"],
      // Under the cap in UTF-16 units, over it in UTF-8 bytes.
      ["a multi-byte text frame over the cap", "é".repeat(max / 2 + 1), TerminalProtocol.CloseCode.tooBig, "too_big"],
      [
        "a Blob over the cap, never read",
        { size: max + 1, arrayBuffer: () => Promise.reject(new Error("read")) },
        TerminalProtocol.CloseCode.tooBig,
        "too_big"
      ]
    ] as const
  )("%s closes the socket with its code and kills the client", ([, data, code, outcome]) =>
    Effect.gen(function*() {
      for (const access of ["write", "read"] as const) {
        const { client, fiber, viewer } = yield* open(access)
        yield* viewer.next
        viewer.emit("message", data)
        expect(yield* viewer.closed).toBe(code)
        expect((yield* Fiber.join(fiber)).outcome).toBe(outcome)
        expect(client.kills).toEqual([9])
      }
    }))

  it.effect.each(
    [
      ["a name that is not a lowercase UUID", { name: id.toUpperCase() }],
      ["a name with a tmux target suffix", { name: `${id}:0` }],
      ["root", { user: "0:2000" }],
      ["a user name", { user: "smithers" }],
      ["a uid with no gid", { user: "1000" }],
      ["a user that is not numeric", { user: "1000:2000;id" }],
      ["no columns", { cols: 0 }],
      ["too many rows", { rows: TerminalProtocol.maxRows + 1 }]
    ] as const
  )("refuses %s before running anything", ([, options]) =>
    Effect.gen(function*() {
      const memory = MemoryContainer.make(shell)
      const viewer = MemoryContainer.socket()
      const report = yield* ContainerTerminal.attach(memory.container, viewer.socket, {
        name: id,
        user: "1000:2000",
        access: "write",
        cols: 80,
        rows: 24,
        ...options
      })
      expect(report).toEqual({ outcome: "unsupported", closeCode: 1003, bytes: { in: 0, out: 0, dropped: 0 } })
      expect(yield* viewer.closed).toBe(TerminalProtocol.CloseCode.unsupported)
      expect(memory.commands).toEqual([])
    }))

  it.effect("a failed exec closes the socket as a host failure, so the viewer reconnects", () =>
    Effect.gen(function*() {
      const memory = MemoryContainer.make(shell, { exec: true })
      const viewer = MemoryContainer.socket()
      const report = yield* ContainerTerminal.attach(memory.container, viewer.socket, {
        name: id,
        user: "1000:2000",
        access: "write",
        cols: 80,
        rows: 24
      })
      expect(report.outcome).toBe("failed")
      expect(yield* viewer.closed).toBe(TerminalProtocol.CloseCode.failed)
      expect(TerminalProtocol.isFinal(TerminalProtocol.CloseCode.failed)).toBe(false)
    }))

  it.effect.each(
    [
      ["a client with no output", "write", { noStdout: true }],
      ["a writer's client with no stdin", "write", { noStdin: true }]
    ] as const
  )("%s is a host failure before ready", ([, access, faults]) =>
    Effect.gen(function*() {
      const { client, fiber, viewer } = yield* open(access, faults)
      expect(yield* viewer.closed).toBe(TerminalProtocol.CloseCode.failed)
      expect((yield* Fiber.join(fiber)).outcome).toBe("failed")
      expect(client.kills).toEqual([9])
    }))

  it.effect("a reader needs no stdin", () =>
    Effect.gen(function*() {
      const { client, fiber, viewer } = yield* open("read", { noStdin: true })
      expect(control(yield* viewer.next)).toEqual({ type: "ready", access: "read" })
      yield* client.exit(0)
      expect((yield* Fiber.join(fiber)).outcome).toBe("ended")
    }))

  it.effect("a failed stdin, resize, Blob read or output stream fails the bridge", () =>
    Effect.gen(function*() {
      const cases = [
        { faults: { stdin: true }, act: (viewer: MemoryContainer.MemorySocket) => viewer.emit("message", bytes("x")) },
        {
          faults: { resize: true },
          act: (viewer: MemoryContainer.MemorySocket) => viewer.emit("message", TerminalProtocol.encodeResize(80, 24))
        },
        {
          faults: {},
          act: (viewer: MemoryContainer.MemorySocket) =>
            viewer.emit("message", { size: 1, arrayBuffer: () => Promise.reject(new Error("read")) })
        }
      ]
      for (const { act, faults } of cases) {
        const { client, fiber, viewer } = yield* open("write", faults)
        yield* viewer.next
        act(viewer)
        expect(yield* viewer.closed).toBe(TerminalProtocol.CloseCode.failed)
        expect((yield* Fiber.join(fiber)).outcome).toBe("failed")
        expect(client.kills).toEqual([9])
      }
      const { client, fiber, viewer } = yield* open("read")
      yield* viewer.next
      yield* client.breakOutput
      expect(yield* viewer.closed).toBe(TerminalProtocol.CloseCode.failed)
      expect((yield* Fiber.join(fiber)).outcome).toBe("failed")
    }))

  it.effect("a socket that errors, or that a send finds gone, ends the bridge as closed", () =>
    Effect.gen(function*() {
      const errored = yield* open("write")
      yield* errored.viewer.next
      errored.viewer.emit("error")
      expect(yield* Fiber.join(errored.fiber)).toMatchObject({ outcome: "closed", closeCode: null })
      expect(errored.client.kills).toEqual([9])

      const gone = yield* open("write")
      yield* gone.viewer.next
      gone.viewer.breakSends()
      yield* gone.client.write(bytes("lost"))
      expect(yield* Fiber.join(gone.fiber)).toMatchObject({ outcome: "closed", bytes: { out: 0 } })
      expect(gone.client.kills).toEqual([9])

      // Gone before ready: nothing is bridged.
      const memory = MemoryContainer.make(shell)
      const early = MemoryContainer.socket()
      early.breakSends()
      const report = yield* ContainerTerminal.attach(memory.container, early.socket, {
        name: id,
        user: "1000:2000",
        access: "read",
        cols: 80,
        rows: 24
      })
      expect(report).toMatchObject({ outcome: "closed", closeCode: null })
    }))

  it.effect("a close that arrives while the client starts is not lost", () =>
    Effect.gen(function*() {
      const hold = yield* Deferred.make<void>()
      const memory = MemoryContainer.make(shell, { hold })
      const viewer = MemoryContainer.socket()
      const fiber = yield* Effect.forkChild(ContainerTerminal.attach(memory.container, viewer.socket, {
        name: id,
        user: "1000:2000",
        access: "write",
        cols: 80,
        rows: 24
      }))
      // The viewer leaves while exec is still starting the client.
      yield* memory.entered
      viewer.emit("close")
      expect(yield* Fiber.join(fiber)).toMatchObject({ outcome: "closed", closeCode: null })
      expect(viewer.listenerCount()).toBe(0)
    }))

  it.effect("ingress overflow closes a stalled attach with a bounded-buffer reason", () =>
    Effect.gen(function*() {
      const hold = yield* Deferred.make<void>()
      const memory = MemoryContainer.make(shell, { hold })
      const viewer = MemoryContainer.socket()
      const fiber = yield* Effect.forkChild(ContainerTerminal.attach(memory.container, viewer.socket, {
        name: id,
        user: "1000:2000",
        access: "write",
        cols: 80,
        rows: 24
      }))
      yield* memory.entered
      for (let i = 0; i < 17; i++) viewer.emit("message", new Uint8Array(max))
      // This also gives old code a terminating verdict, rather than a timeout.
      viewer.emit("message", "{invalid")
      const report = yield* Fiber.join(fiber)
      expect(report.outcome).toBe("failed")
      expect(viewer.closeCalls).toEqual([{
        code: TerminalProtocol.CloseCode.failed,
        reason: "Terminal input buffer full"
      }])
      expect(viewer.listenerCount()).toBe(0)
    }))

  it.effect.each(
    [
      ["empty binary", new Uint8Array(0)],
      ["resize", TerminalProtocol.encodeResize(80, 24)]
    ] as const
  )("a flood of %s frames closes stalled stdin with a bounded-buffer reason", ([, frame]) =>
    Effect.gen(function*() {
      const holdStdin = yield* Deferred.make<void>()
      const { client, fiber, viewer } = yield* open("write", { holdStdin })
      yield* viewer.next
      viewer.emit("message", new Uint8Array([1]))
      yield* client.typed
      for (let i = 0; i < 16_384; i++) viewer.emit("message", frame)
      // Without per-frame accounting this terminates as unsupported, rather than timing out.
      viewer.emit("message", "{invalid")
      expect((yield* Fiber.join(fiber)).outcome).toBe("failed")
      expect(viewer.closeCalls).toEqual([{
        code: TerminalProtocol.CloseCode.failed,
        reason: "Terminal input buffer full"
      }])
      expect(client.kills).toEqual([9])
      expect(viewer.listenerCount()).toBe(0)
    }))

  it.effect("2,000 one-byte frames survive stalled stdin in order without closing the socket", () =>
    Effect.gen(function*() {
      const holdStdin = yield* Deferred.make<void>()
      const { client, fiber, viewer } = yield* open("write", { holdStdin })
      yield* viewer.next
      viewer.emit("message", new Uint8Array([255]))
      expect(yield* client.typed).toEqual(new Uint8Array([255]))
      for (let i = 0; i < 2_000; i++) viewer.emit("message", new Uint8Array([i % 251]))
      // A real resize receipt means ingress drained while stdin remained stalled.
      viewer.emit("message", TerminalProtocol.encodeResize(80, 24))
      // Race the receipt with completion so the old frame cap fails without timing out.
      const state = yield* Effect.raceFirst(
        Effect.as(client.resized, "open"),
        Effect.as(Fiber.join(fiber), "closed")
      )
      expect(state).toBe("open")
      expect(viewer.closeCalls).toEqual([])
      yield* Deferred.succeed(holdStdin, undefined)
      for (let i = 0; i < 2_000; i++) expect(yield* client.typed).toEqual(new Uint8Array([i % 251]))
      // The budget is reclaimed after writes, so another full 1 MiB is accepted.
      for (let i = 0; i < 16; i++) {
        viewer.emit("message", new Uint8Array(max))
        expect((yield* client.typed).byteLength).toBe(max)
      }
      expect(viewer.closeCalls).toEqual([])
      viewer.emit("close")
      expect(yield* Fiber.join(fiber)).toMatchObject({ outcome: "closed", bytes: { in: 2_001 + 16 * max } })
    }))

  it.effect("more than 1 MiB across ingress, stdin and the pending write closes a stalled writer", () =>
    Effect.gen(function*() {
      // Each binary frame costs its byte length plus 64 bytes of overhead.
      const size = max - 64
      const holdStdin = yield* Deferred.make<void>()
      const { client, fiber, viewer } = yield* open("write", { holdStdin })
      yield* viewer.next
      viewer.emit("message", new Uint8Array(size))
      yield* client.typed
      // Receipts put eight frames in stdin; seven more remain in ingress.
      for (let i = 0; i < 8; i++) {
        viewer.emit("message", new Uint8Array(size))
        viewer.emit("message", TerminalProtocol.encodeResize(80, 24))
        yield* client.resized
      }
      for (let i = 0; i < 7; i++) viewer.emit("message", new Uint8Array(size))
      expect(viewer.closeCalls).toEqual([])
      viewer.emit("message", new Uint8Array([1]))
      const report = yield* Fiber.join(fiber)
      expect(report.outcome).toBe("failed")
      expect(viewer.closeCalls).toEqual([{
        code: TerminalProtocol.CloseCode.failed,
        reason: "Terminal input buffer full"
      }])
      expect(client.kills).toEqual([9])
    }))

  it.effect("interruption removes listeners and closes the socket during attach and streaming", () =>
    Effect.gen(function*() {
      const hold = yield* Deferred.make<void>()
      const memory = MemoryContainer.make(shell, { hold })
      const viewer = MemoryContainer.socket()
      const fiber = yield* Effect.forkChild(ContainerTerminal.attach(memory.container, viewer.socket, {
        name: id,
        user: "1000:2000",
        access: "read",
        cols: 80,
        rows: 24
      }))
      yield* memory.entered
      expect(viewer.listenerCount()).toBe(3)
      yield* Fiber.interrupt(fiber)
      expect(viewer.closeCalls).toEqual([{ code: TerminalProtocol.CloseCode.failed, reason: "Terminal interrupted" }])
      expect(viewer.listenerCount()).toBe(0)
      viewer.emit("message", bytes(sentinel))
      const running = yield* open("write")
      yield* running.viewer.next
      yield* Fiber.interrupt(running.fiber)
      expect(running.viewer.closeCalls).toEqual([{
        code: TerminalProtocol.CloseCode.failed,
        reason: "Terminal interrupted"
      }])
      expect(running.viewer.listenerCount()).toBe(0)
    }))

  it.effect("telemetry counts access, outcomes and bytes, and carries no content", () => {
    const t = Telemetry.make()
    return Effect.gen(function*() {
      const writer = yield* open("write")
      const reader = yield* open("read")
      yield* writer.viewer.next
      yield* reader.viewer.next
      expect(t.count(ContainerTerminal.sessionsOpen, { access: "write" })).toBe(1)
      expect(t.count(ContainerTerminal.sessionsOpen, { access: "read" })).toBe(1)

      writer.viewer.emit("message", bytes(`echo ${sentinel}\r`))
      expect(new TextDecoder().decode(yield* writer.client.typed)).toContain(sentinel)
      reader.viewer.emit("message", bytes(sentinel))
      yield* writer.client.write(bytes(sentinel))
      yield* writer.viewer.next
      yield* reader.client.write(bytes(sentinel))
      yield* reader.viewer.next
      reader.viewer.emit("message", `{"type":"${sentinel}"}`)
      yield* reader.viewer.closed
      yield* writer.client.exit(0)
      yield* Fiber.join(writer.fiber)
      yield* Fiber.join(reader.fiber)

      const failed = MemoryContainer.make(shell, { exec: true })
      yield* ContainerTerminal.attach(failed.container, MemoryContainer.socket().socket, {
        name: id,
        user: "1000:2000",
        access: "write",
        cols: 80,
        rows: 24
      })
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        expect(t.count(ContainerTerminal.sessionsOpen, { access: "write" })).toBe(0)
        expect(t.count(ContainerTerminal.sessionsOpen, { access: "read" })).toBe(0)
        expect(t.count(ContainerTerminal.connects, { access: "write", outcome: "ended" })).toBe(1)
        expect(t.count(ContainerTerminal.connects, { access: "read", outcome: "unsupported" })).toBe(1)
        expect(t.count(ContainerTerminal.connects, { access: "write", outcome: "failed" })).toBe(1)
        const typed = `echo ${sentinel}\r`.length
        expect(t.count(ContainerTerminal.bytes, { direction: "in" })).toBe(typed)
        expect(t.count(ContainerTerminal.bytes, { direction: "out" })).toBe(2 * sentinel.length)
        expect(t.count(ContainerTerminal.bytes, { direction: "dropped" })).toBe(sentinel.length)

        const spans = t.named("terminal.connect")
        expect(spans.map((span) => Object.fromEntries(span.attributes))).toEqual([
          {
            "smithers.terminal.id": id,
            "smithers.terminal.access": "write",
            "smithers.terminal.outcome": "ended",
            "smithers.terminal.close_code": 1000,
            "smithers.terminal.bytes_in": typed,
            "smithers.terminal.bytes_out": sentinel.length,
            "smithers.terminal.bytes_dropped": 0
          },
          {
            "smithers.terminal.id": id,
            "smithers.terminal.access": "read",
            "smithers.terminal.outcome": "unsupported",
            "smithers.terminal.close_code": 1003,
            "smithers.terminal.bytes_in": 0,
            "smithers.terminal.bytes_out": sentinel.length,
            "smithers.terminal.bytes_dropped": sentinel.length
          },
          {
            "smithers.terminal.id": id,
            "smithers.terminal.access": "write",
            "error.type": "ContainerFailure",
            "smithers.terminal.outcome": "failed",
            "smithers.terminal.close_code": 1011,
            "smithers.terminal.bytes_in": 0,
            "smithers.terminal.bytes_out": 0,
            "smithers.terminal.bytes_dropped": 0
          }
        ])
        // Each line is logged inside its span.
        expect(t.lines("cloudflare.terminal.connect").map((line) => line.annotations)).toEqual(
          spans.map((span) =>
            expect.objectContaining({
              trace_id: span.traceId,
              span_id: span.spanId,
              access: span.attributes.get("smithers.terminal.access"),
              "smithers.terminal.outcome": span.attributes.get("smithers.terminal.outcome")
            })
          )
        )
        // No id in a metric attribute, and no content anywhere.
        expect(t.metricAttributes()).not.toContain(id)
        t.expectNoContent(sentinel)
      }))
    )
  })
})

describe("ContainerTerminal.ensureSession", () => {
  const options = { name: id, user: "1000:2000", cwd: "/workspace" }
  const has = ["tmux", "has-session", "-t", `=${id}`]
  const create = ["tmux", "new-session", "-d", "-s", id, "-c", "/workspace"]
  const quiet = { user: "1000:2000", stdout: "ignore", stderr: "ignore", env: { TERM: "xterm-256color" } }

  /** A container whose `has-session` answers each code of `hasCodes` in turn, and `new-session` `createCode`. */
  const tmux = (hasCodes: ReadonlyArray<number>, createCode: number) => {
    const queue = [...hasCodes]
    return MemoryContainer.make((argv) => argv[1] === "has-session" ? queue.shift()! : createCode)
  }

  it.effect("finds a running session, and runs nothing else", () =>
    Effect.gen(function*() {
      const memory = tmux([0], 0)
      expect(yield* ContainerTerminal.ensureSession(memory.container, options)).toBe("existing")
      expect(memory.commands).toEqual([{ argv: has, options: quiet }])
    }))

  it.effect("creates a missing session in the directory, as the user", () =>
    Effect.gen(function*() {
      const memory = tmux([1], 0)
      expect(yield* ContainerTerminal.ensureSession(memory.container, options)).toBe("created")
      expect(memory.commands).toEqual([{ argv: has, options: quiet }, { argv: create, options: quiet }])
    }))

  it.effect("runs tmux under the caller's variables, with TERM always xterm's own", () =>
    Effect.gen(function*() {
      const memory = tmux([1], 0)
      const env = { HOME: "/home/p1", USER: "p1", LANG: "C.UTF-8", TERM: "dumb" }
      expect(yield* ContainerTerminal.ensureSession(memory.container, { ...options, env })).toBe("created")
      const expected = { ...quiet, env: { ...env, TERM: "xterm-256color" } }
      expect(memory.commands).toEqual([{ argv: has, options: expected }, { argv: create, options: expected }])
    }))

  it.effect("a session another caller created meanwhile counts as existing", () =>
    Effect.gen(function*() {
      const memory = tmux([1, 0], 1)
      expect(yield* ContainerTerminal.ensureSession(memory.container, options)).toBe("existing")
      expect(memory.commands.map((command) => command.argv)).toEqual([has, create, has])
    }))

  it.effect("fails when no session runs after new-session", () =>
    Effect.gen(function*() {
      const memory = tmux([1, 1], 3)
      const error = yield* Effect.flip(ContainerTerminal.ensureSession(memory.container, options))
      expect(error).toBeInstanceOf(ContainerTerminal.SessionFailed)
      expect(error).toMatchObject({ name: id, exitCode: 3 })
    }))

  it.effect("passes the container's own failure through", () =>
    Effect.gen(function*() {
      const memory = MemoryContainer.make(shell, { exec: true })
      const error = yield* Effect.flip(ContainerTerminal.ensureSession(memory.container, options))
      expect(error).toBeInstanceOf(MemoryContainer.ContainerFailure)
    }))

  it.effect.each(
    [
      ["name", { name: "not-a-uuid" }],
      ["name", { name: `${id} ` }],
      ["user", { user: "0:0" }],
      ["user", { user: "00:2000" }],
      ["user", { user: "smithers" }],
      ["user", { user: "1000" }],
      ["cwd", { cwd: "workspace" }],
      // tmux expands formats in -c, and #(...) runs a command.
      ["cwd", { cwd: "/tmp/#(touch /tmp/pwned)" }],
      ["cwd", { cwd: "/tmp/$HOME" }]
    ] as const
  )("refuses a bad %s before running anything", ([field, change]) =>
    Effect.gen(function*() {
      const memory = tmux([0], 0)
      const error = yield* Effect.flip(ContainerTerminal.ensureSession(memory.container, { ...options, ...change }))
      expect(error).toBeInstanceOf(ContainerTerminal.InvalidSession)
      expect(error).toMatchObject({ field })
      expect(memory.commands).toEqual([])
    }))

  it("isSessionName accepts lowercase UUIDs only", () => {
    expect(ContainerTerminal.isSessionName(id)).toBe(true)
    expect(ContainerTerminal.isSessionName(crypto.randomUUID())).toBe(true)
    expect(ContainerTerminal.isSessionName(id.toUpperCase())).toBe(false)
    expect(ContainerTerminal.isSessionName(`=${id}`)).toBe(false)
  })

  it.effect("telemetry counts outcomes, carries the id on the span only, and never a failure's text", () => {
    const t = Telemetry.make()
    return Effect.gen(function*() {
      yield* ContainerTerminal.ensureSession(tmux([1], 0).container, options)
      yield* ContainerTerminal.ensureSession(tmux([0], 0).container, options)
      const failed = MemoryContainer.make(() => {
        throw new Error("unreachable")
      }, { exec: true })
      expect(Exit.isFailure(yield* Effect.exit(ContainerTerminal.ensureSession(failed.container, options)))).toBe(true)
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        expect(t.count(ContainerTerminal.sessions, { outcome: "created" })).toBe(1)
        expect(t.count(ContainerTerminal.sessions, { outcome: "existing" })).toBe(1)
        expect(t.count(ContainerTerminal.sessions, { outcome: "failed" })).toBe(1)
        const spans = t.named("terminal.session")
        expect(spans.map((span) => Object.fromEntries(span.attributes))).toEqual([
          { "smithers.terminal.id": id, "smithers.terminal.session": "created" },
          { "smithers.terminal.id": id, "smithers.terminal.session": "existing" },
          { "smithers.terminal.id": id, "smithers.terminal.session": "failed", "error.type": "ContainerFailure" }
        ])
        // The span ends with the outcome: the container's error text is never its failure.
        for (const span of spans) {
          expect(span.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Success" } })
        }
        expect(t.lines("cloudflare.terminal.session").map((line) => line.annotations)).toEqual([
          expect.objectContaining({ trace_id: spans[0]!.traceId, outcome: "created" }),
          expect.objectContaining({ trace_id: spans[1]!.traceId, outcome: "existing" }),
          expect.objectContaining({ trace_id: spans[2]!.traceId, outcome: "failed", "error.type": "ContainerFailure" })
        ])
        t.expectNoContent("exec broke")
        expect(t.metricAttributes()).not.toContain(id)
      }))
    )
  })
})
