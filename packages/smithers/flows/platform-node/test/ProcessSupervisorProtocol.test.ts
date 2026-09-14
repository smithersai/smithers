import { describe, expect, it } from "@effect/vitest"
import { once } from "node:events"
import { existsSync, statSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { Control } from "../src/internal/ProcessSupervisor.ts"

const bounded = async <A>(promise: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Private protocol did not settle within two seconds")), 2000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const connected = async (control: Control, requests = false): Promise<Socket> => {
  const socket = createConnection(requests ? control.requestPath : control.path)
  // Protocol-refusal tests deliberately destroy the other end of this socket.
  socket.on("error", () => {})
  await bounded(once(socket, "connect"))
  return socket
}

const send = (socket: Socket, ...values: ReadonlyArray<unknown>): Promise<void> =>
  bounded(
    new Promise((resolve, reject) => {
      socket.write(values.map((value) => JSON.stringify(value)).join("\n") + "\n", (error) =>
        error ? reject(error) : resolve())
    })
  )

const session = async (use: (control: Control, socket: Socket, requests: Socket) => Promise<void>): Promise<void> => {
  const control = new Control()
  let socket: Socket | undefined
  let requests: Socket | undefined
  try {
    await bounded(control.listening)
    socket = await connected(control)
    requests = await connected(control, true)
    await bounded(control.requestsReady.promise)
    await use(control, socket, requests)
  } finally {
    socket?.destroy()
    requests?.destroy()
    control.dispose()
  }
}

const ready = { type: "ready", version: 1, pid: 4242 }
const spawned = { type: "spawned", pid: 4243 }
const exited = { type: "exit", code: 0, signal: null }

describe("private process lifetime protocol", () => {
  it("stores an early READY and withdraws the owned socket before activation", () =>
    session(async (control, socket, requests) => {
      expect(statSync(control.directory).mode & 0o777).toBe(0o700)
      await send(socket, ready)
      expect(await bounded(control.ready.promise)).toBe(4242)
      expect(() => control.withdraw(4242, 4244)).toThrow("Wrong supervisor identity")
      expect(existsSync(control.directory)).toBe(true)
      // Node's server.close() may already unlink this UNIX socket. Withdrawing
      // it must still succeed, and an accepted connection remains usable.
      control.withdraw(4242, 4242)
      expect(existsSync(control.path)).toBe(false)
      expect(existsSync(control.requestPath)).toBe(false)
      expect(existsSync(control.directory)).toBe(false)
      const received = once(requests, "data")
      await control.write({ type: "configure", command: "literal", args: ["a b"] })
      expect(String((await bounded(received))[0])).toBe(
        "{\"type\":\"configure\",\"command\":\"literal\",\"args\":[\"a b\"]}\n"
      )
      control.activationSent = true
      await send(socket, spawned, exited)
      await bounded(control.started.promise)
      expect(control.targetPid).toBe(4243)
      expect(await bounded(control.exited.promise)).toBe(0)
    }))

  it("accepts fragmented frames and preserves a target exit buffered after raw owner exit", () =>
    session(async (control, socket) => {
      let exits = 0
      control.onTargetExit = () => {
        exits++
      }
      socket.write("{\"type\":\"rea")
      socket.write("dy\",\"version\":1,\"pid\":4242}\n")
      expect(await bounded(control.ready.promise)).toBe(4242)
      control.activationSent = true
      control.rawEnded()
      expect(control.ownerDone).toBe(true)
      await send(socket, spawned, { ...exited, code: 23 })
      socket.end()
      expect(await bounded(control.exited.promise)).toBe(23)
      await bounded(control.ended.promise)
      expect(exits).toBe(1)
      expect(control.fault).toBeUndefined()
    }))

  it("rejects a second connection without displacing the accepted owner", () =>
    session(async (control, socket) => {
      await send(socket, ready)
      await bounded(control.ready.promise)
      const second = await connected(control)
      try {
        await bounded(once(second, "close"))
        control.activationSent = true
        await send(socket, spawned, exited)
        expect(await bounded(control.exited.promise)).toBe(0)
      } finally {
        second.destroy()
      }
    }))

  it("rejects a second request connection without displacing the accepted owner", () =>
    session(async (control, _socket, requests) => {
      const second = await connected(control, true)
      try {
        await bounded(once(second, "close"))
        const received = once(requests, "data")
        await control.write({ type: "stop" })
        expect(String((await bounded(received))[0])).toBe("{\"type\":\"stop\"}\n")
      } finally {
        second.destroy()
      }
    }))

  it("keeps receiving exit and cleanup after the request channel closes", () =>
    session(async (control, socket, requests) => {
      control.activationSent = true
      await send(socket, ready, spawned)
      await bounded(control.started.promise)
      const closed = once(control.requestSocket!, "close")
      requests.end()
      await bounded(closed)
      await expect(control.write({ type: "stop" })).rejects.toThrow("channel closed")
      expect(control.socket!.destroyed).toBe(false)
      await send(socket, exited, { type: "cleanup" })
      socket.end()
      expect(await bounded(control.exited.promise)).toBe(0)
      await bounded(control.ended.promise)
      expect(control.cleanupAcknowledged).toBe(true)
    }))

  it("settles every pending outcome when the raw owner exits before connecting", async () => {
    const control = new Control()
    try {
      await bounded(control.listening)
      control.rawEnded()
      await bounded(control.ended.promise)
      await expect(control.ready.promise).rejects.toThrow("closed before reporting")
      await expect(control.started.promise).rejects.toThrow("closed before reporting")
      await expect(control.exited.promise).rejects.toThrow("closed before reporting")
      await expect(control.write({ type: "start" })).rejects.toThrow("channel closed")
      expect(control.ownerDone).toBe(true)
    } finally {
      control.dispose()
    }
  })

  it("preserves a native status socket failure for pending readers", () =>
    session(async (control, socket) => {
      control.activationSent = true
      await send(socket, ready, spawned)
      await bounded(control.started.promise)
      const failure = Object.assign(new Error("status connection reset"), { code: "ECONNRESET" })
      control.socket!.destroy(failure)
      await bounded(control.ended.promise)
      await expect(control.exited.promise).rejects.toBe(failure)
      await expect(control.lost.promise).rejects.toBe(failure)
      expect(control.fault).toBe(failure)
      expect(control.requestSocket!.destroyed).toBe(true)
      expect(control.cleanupAcknowledged).toBe(false)
    }))

  it("rejects unreported outcomes when an accepted channel closes", () =>
    session(async (control, socket) => {
      await send(socket, ready)
      expect(await bounded(control.ready.promise)).toBe(4242)
      socket.end()
      await bounded(control.ended.promise)
      await expect(control.started.promise).rejects.toThrow("closed before reporting")
      await expect(control.exited.promise).rejects.toThrow("closed before reporting")
      await expect(control.write({ type: "start" })).rejects.toThrow("channel closed")
    }))

  it("retains a native spawn failure and resolves termination after its channel closes", () =>
    session(async (control, socket) => {
      await send(socket, ready)
      await bounded(control.ready.promise)
      control.activationSent = true
      const failure = { type: "spawn_error", code: "ENOENT", message: "missing command", syscall: "spawn literal" }
      await send(socket, failure)
      await expect(bounded(control.started.promise)).rejects.toEqual(failure)
      await expect(control.exited.promise).rejects.toEqual(failure)
      expect(control.spawnFailed).toBe(true)
      expect(control.targetPid).toBeUndefined()
      socket.end()
      await bounded(control.ended.promise)
      expect(control.fault).toEqual(failure)
    }))

  it("preserves a target signal as a failure and notifies automatic cleanup once", () =>
    session(async (control, socket) => {
      let exits = 0
      control.onTargetExit = () => {
        exits++
      }
      control.activationSent = true
      await send(socket, ready, spawned, { type: "exit", code: null, signal: "SIGINT" })
      await bounded(control.started.promise)
      await expect(bounded(control.exited.promise)).rejects.toMatchObject({ signal: "SIGINT" })
      expect(control.targetDone).toBe(true)
      expect(exits).toBe(1)
    }))

  it("reports a helper fault to all still-pending launch and exit waiters", () =>
    session(async (control, socket) => {
      const fault = { type: "fault", message: "configuration refused", code: "EINVAL" }
      await send(socket, fault)
      await expect(bounded(control.started.promise)).rejects.toEqual(fault)
      await expect(control.exited.promise).rejects.toEqual(fault)
      socket.end()
      await bounded(control.ended.promise)
      await expect(control.ready.promise).rejects.toEqual(fault)
    }))

  it("does not treat a cleanup announcement as proof that the target exited", () =>
    session(async (control, socket) => {
      await send(socket, { type: "cleanup" }, ready)
      await bounded(control.ready.promise)
      expect(control.cleanupAcknowledged).toBe(true)
      expect(control.targetDone).toBe(false)
      expect(control.ownerDone).toBe(false)
      control.activationSent = true
      await send(socket, spawned, exited)
      expect(await bounded(control.exited.promise)).toBe(0)
    }))

  it("keeps cleanup failure separate from the target's reported exit status", () =>
    session(async (control, socket) => {
      control.activationSent = true
      const failure = { type: "cleanup_error", message: "An escaped child could not be verified" }
      await send(socket, ready, spawned, exited, failure)
      expect(await bounded(control.exited.promise)).toBe(0)
      socket.end()
      await bounded(control.ended.promise)
      expect(control.cleanupFailed).toBe(true)
      expect(control.fault).toEqual(failure)
      expect(control.targetDone).toBe(true)
    }))

  const invalid: ReadonlyArray<{
    readonly name: string
    readonly values: ReadonlyArray<unknown>
    readonly activated?: boolean
    readonly message: string
  }> = [
    { name: "null", values: [null], message: "Invalid process status" },
    { name: "primitive", values: [1], message: "Invalid process status" },
    { name: "unknown type", values: [{ type: "unknown" }], message: "Unknown process status" },
    { name: "wrong ready version", values: [{ ...ready, version: 2 }], message: "Invalid process readiness" },
    { name: "unsafe ready pid", values: [{ ...ready, pid: 2 ** 53 }], message: "Invalid process readiness" },
    { name: "reserved ready pid", values: [{ ...ready, pid: 1 }], message: "Invalid process readiness" },
    { name: "duplicate ready", values: [ready, ready], message: "Invalid process readiness" },
    { name: "startup before activation", values: [ready, spawned], message: "Invalid target startup" },
    {
      name: "unsafe target pid",
      values: [{ ...spawned, pid: 2 ** 53 }],
      activated: true,
      message: "Invalid target startup"
    },
    {
      name: "reserved target pid",
      values: [{ ...spawned, pid: 1 }],
      activated: true,
      message: "Invalid target startup"
    },
    {
      name: "duplicate startup",
      values: [ready, spawned, spawned],
      activated: true,
      message: "Invalid target startup"
    },
    {
      name: "spawn failure before activation",
      values: [{ type: "spawn_error" }],
      message: "Invalid target spawn failure"
    },
    {
      name: "spawn failure after startup",
      values: [spawned, { type: "spawn_error" }],
      activated: true,
      message: "Invalid target spawn failure"
    },
    { name: "exit before startup", values: [exited], message: "Invalid target exit status" },
    {
      name: "duplicate exit",
      values: [spawned, exited, exited],
      activated: true,
      message: "Invalid target exit status"
    },
    {
      name: "negative exit status",
      values: [spawned, { ...exited, code: -1 }],
      activated: true,
      message: "Invalid target exit status"
    },
    {
      name: "fractional exit status",
      values: [spawned, { ...exited, code: 0.5 }],
      activated: true,
      message: "Invalid target exit status"
    },
    {
      name: "status and signal",
      values: [spawned, { ...exited, signal: "SIGINT" }],
      activated: true,
      message: "Invalid target exit status"
    },
    {
      name: "missing signal",
      values: [spawned, { ...exited, code: null }],
      activated: true,
      message: "Invalid target exit status"
    },
    {
      name: "malformed signal",
      values: [spawned, { code: null, signal: "TERM", type: "exit" }],
      activated: true,
      message: "Invalid target exit status"
    }
  ]
  for (const test of invalid) {
    it(`closes the channel on ${test.name}`, () =>
      session(async (control, socket) => {
        control.activationSent = test.activated ?? false
        await send(socket, ...test.values)
        await bounded(control.ended.promise)
        expect(control.fault).toBeInstanceOf(Error)
        expect((control.fault as Error).message).toBe(test.message)
        expect(control.socket?.destroyed).toBe(true)
      }))
  }

  for (const frame of ["{broken json}\n", "x".repeat(16 * 1024 + 1), "é".repeat(8 * 1024 + 1)]) {
    it(`bounds and refuses malformed raw data (${Buffer.byteLength(frame)} bytes)`, () =>
      session(async (control, socket) => {
        socket.write(frame)
        await bounded(control.ended.promise)
        expect(control.fault).toBeInstanceOf(Error)
        await expect(control.ready.promise).rejects.toBe(control.fault)
        await expect(control.started.promise).rejects.toBe(control.fault)
        await expect(control.exited.promise).rejects.toBe(control.fault)
      }))
  }

  it("rejects excessive configuration locally while preserving the usable channel", () =>
    session(async (control, socket, requests) => {
      await send(socket, ready)
      await bounded(control.ready.promise)
      await expect(control.write({ type: "configure", command: "x".repeat(4 * 1024 * 1024) }))
        .rejects.toThrow("configuration exceeds")
      const received = once(requests, "data")
      await control.write({ type: "stop" })
      expect(String((await bounded(received))[0])).toBe("{\"type\":\"stop\"}\n")
    }))
})
