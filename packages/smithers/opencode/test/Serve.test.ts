import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http/HttpServer"
import { createServer } from "node:http"
import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as ScriptedDriver from "../src/ScriptedDriver.ts"
import * as Serve from "../src/Serve.ts"
import * as Store from "../src/Store.ts"
import { run, scratchDirectory, until } from "./Harness.ts"

interface Id {
  readonly id: string
}

/** The whole server on a loopback socket of its own, over the scripted driver. */
const socketed = (directory: string) =>
  Serve.layer({
    directory,
    bind: { ...Serve.defaultBind, port: 0 },
    version: "test",
    seat: "scripted:demo"
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        ScriptedDriver.layer({ script: DemoScript.script, delay: 0 }),
        Store.layerSqlite(Serve.databasePath(directory))
      )
    )
  )

describe("Serve", () => {
  it("admits loopback and refuses the rest without --listen and a password", () => {
    expect(Serve.refusal(Serve.defaultBind)).toBeUndefined()
    expect(Serve.refusal({ ...Serve.defaultBind, hostname: "0.0.0.0" })).toContain("--listen")
    expect(Serve.refusal({ ...Serve.defaultBind, hostname: "0.0.0.0", listen: true })).toContain(
      "OPENCODE_SERVER_PASSWORD"
    )
    expect(
      Serve.refusal({
        ...Serve.defaultBind,
        hostname: "0.0.0.0",
        listen: true,
        credentials: { username: "u", password: "p" }
      })
    ).toBeUndefined()
    expect(Serve.isLoopback("::1")).toBe(true)
  })

  it("prints the banner with the directory and the URL", () => {
    expect(Serve.banner(Serve.defaultBind, "/repo")).toBe(
      "Serving /repo at http://127.0.0.1:4096. Open https://app.opencode.ai and allow the local network permission."
    )
    expect(Serve.url({ ...Serve.defaultBind, hostname: "::1", port: 1 })).toBe("http://[::1]:1")
    expect(Serve.databasePath("/repo")).toBe("/repo/.smithers/opencode.sqlite")
  })

  it("binds a socket and serves health over it", async () => {
    const scratch = scratchDirectory()
    try {
      const status = await run(
        Effect.gen(function*() {
          const server = yield* HttpServer
          const address = server.address
          const port = address._tag === "InetAddressV4" || address._tag === "InetAddressV6" ? address.port : 0
          const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/global/health`))
          return response.status
        }).pipe(
          Effect.provide(
            Serve.layer({
              directory: scratch.directory,
              bind: { ...Serve.defaultBind, port: 0 },
              version: "test",
              seat: "scripted:demo"
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  ScriptedDriver.layer({ script: DemoScript.script, delay: 0 }),
                  Store.layerSqlite(Serve.databasePath(scratch.directory))
                )
              )
            )
          ),
          Effect.scoped
        )
      )
      expect(status).toBe(200)
    } finally {
      scratch.remove()
    }
  })

  it("closes the socket at once with an event stream held open", async () => {
    const scratch = scratchDirectory()
    const held: { reader?: ReadableStreamDefaultReader<Uint8Array> } = {}
    let started = 0
    try {
      await run(
        Effect.gen(function*() {
          const server = yield* HttpServer
          const address = server.address
          const port = address._tag === "InetAddressV4" || address._tag === "InetAddressV6" ? address.port : 0
          const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/global/event`))
          held.reader = response.body!.getReader()
          const first = yield* Effect.promise(() => held.reader!.read())
          expect(new TextDecoder().decode(first.value)).toContain("server.connected")
          started = Date.now()
        }).pipe(
          Effect.provide(
            Serve.layer({
              directory: scratch.directory,
              bind: { ...Serve.defaultBind, port: 0 },
              version: "test",
              seat: "scripted:demo"
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  ScriptedDriver.layer({ script: DemoScript.script, delay: 0 }),
                  Store.layerSqlite(Serve.databasePath(scratch.directory))
                )
              )
            )
          ),
          Effect.scoped
        )
      )
      // The stream was ended by the hub, not by the socket's graceful timeout.
      expect(Date.now() - started).toBeLessThan(1500)
      let done = false
      for (let reads = 0; reads < 20 && !done; reads++) done = (await held.reader!.read()).done
      expect(done).toBe(true)
    } finally {
      scratch.remove()
    }
  })

  it("fails the layer on a refused bind", async () => {
    const scratch = scratchDirectory()
    try {
      const error = await run(
        Effect.flip(
          Serve.host({
            directory: scratch.directory,
            bind: { ...Serve.defaultBind, hostname: "0.0.0.0" },
            version: "test",
            seat: "scripted:demo"
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                ScriptedDriver.layer({ script: DemoScript.script, delay: 0 }),
                Store.layerSqlite(Serve.databasePath(scratch.directory))
              )
            ),
            Effect.scoped
          )
        )
      )
      expect(error).toBeInstanceOf(Serve.BindRefused)
      expect(error.message).toContain("--listen")
    } finally {
      scratch.remove()
    }
  })
  /**
   * A request still in flight when the server stops.
   *
   * `POST /session/:id/message` answers when the turn is over, so a turn
   * parked on a permission holds the request, and node's `server.close`
   * waits for every connection that is not idle when it is called. The turn
   * is never going to settle now, so the wait has to end here: the request is
   * answered 503 and the connection is let go.
   *
   * Before the drain this took 5.0 s against 27 ms with nothing held: the
   * request was answered only when the graceful timeout interrupted it, and
   * the connection it left behind was then an idle keep-alive socket node
   * waits out `keepAliveTimeout` on.
   */
  it("answers a held synchronous prompt and closes the socket at once", async () => {
    const scratch = scratchDirectory()
    let held: Promise<Response> | undefined
    let started = 0
    try {
      await run(
        Effect.gen(function*() {
          const server = yield* HttpServer
          const address = server.address
          const port = address._tag === "InetAddressV4" || address._tag === "InetAddressV6" ? address.port : 0
          const base = `http://127.0.0.1:${port}`
          const post = (path: string, body: unknown) =>
            fetch(`${base}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            })
          const session = yield* Effect.promise(() => post("/session", {}).then((r) => r.json() as Promise<Id>))
          // Not awaited: the demo script parks on a permission nobody answers,
          // so this request is open until the server stops.
          held = post(`/session/${session.id}/message`, { parts: [{ type: "text", text: "demo" }] })
          yield* Effect.promise(async () => {
            for (let look = 0; look < 300; look++) {
              const pending = await fetch(`${base}/permission`).then((r) => r.json() as Promise<Array<unknown>>)
              if (pending.length > 0) return
              await new Promise((resolve) => setTimeout(resolve, 20))
            }
            throw new Error("the demo turn never parked on a permission")
          })
          started = Date.now()
        }).pipe(Effect.provide(socketed(scratch.directory)), Effect.scoped)
      )
      expect(Date.now() - started).toBeLessThan(1500)
      const answer = await held!
      expect(answer.status).toBe(503)
      expect(await answer.text()).toContain("the server is stopping")
    } finally {
      scratch.remove()
    }
  })

  /**
   * The wedge: one client that was mid-request when the server stopped and
   * keeps asking on the same connection afterwards.
   *
   * The synchronous prompt is that request, because a turn parked on a
   * permission holds it. Its connection is never idle, and node's
   * `server.close` calls back only when every connection that was not idle
   * when it was called has gone, so nothing ever ends the close. Against a
   * spawned server the listener closed 152 ms after the signal and the
   * process was still alive when the run gave up 30 s later, leaving only
   * when the client hung up. Here the scope never closes and the test hangs
   * to its bound.
   */
  it("leaves while a client keeps asking on the connection it was using", async () => {
    const scratch = scratchDirectory()
    const client: { socket?: ReturnType<typeof connect>; asking?: ReturnType<typeof setInterval> } = {}
    let started = 0
    try {
      await run(
        Effect.gen(function*() {
          const server = yield* HttpServer
          const address = server.address
          const port = address._tag === "InetAddressV4" || address._tag === "InetAddressV6" ? address.port : 0
          const base = `http://127.0.0.1:${port}`
          const session = yield* Effect.promise(() =>
            fetch(`${base}/session`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}"
            }).then((r) => r.json() as Promise<Id>)
          )
          const socket = connect(port, "127.0.0.1")
          client.socket = socket
          socket.on("error", () => {})
          socket.on("data", () => {})
          yield* Effect.promise(() => new Promise<void>((resolve) => socket.once("connect", () => resolve())))
          // The turn parks, so this request is still in flight when the
          // scope closes and the connection is not idle.
          const body = JSON.stringify({ parts: [{ type: "text", text: "demo" }] })
          socket.write(
            `POST /session/${session.id}/message HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
              `content-type: application/json\r\nConnection: keep-alive\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
          )
          yield* Effect.promise(() =>
            until(async () =>
              await fetch(`${base}/permission`).then((r) => r.json() as Promise<Array<unknown>>).then((p) =>
                p.length > 0
              )
            )
          )
          // A client that asks again as soon as it is answered is never idle.
          client.asking = setInterval(() => {
            if (socket.writable) {
              socket.write(
                `GET /global/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`
              )
            }
          }, 20)
          started = Date.now()
        }).pipe(Effect.provide(socketed(scratch.directory)), Effect.scoped)
      )
      expect(Date.now() - started).toBeLessThan(2500)
    } finally {
      if (client.asking !== undefined) clearInterval(client.asking)
      client.socket?.destroy()
      scratch.remove()
    }
  })

  /**
   * What the grace is for: a connection that is neither idle nor going to
   * finish is destroyed rather than waited on, so the close always ends.
   */
  it("destroys what is left when the grace expires", async () => {
    const server = createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as { port: number }
    const socket = connect(port, "127.0.0.1")
    socket.on("error", () => {})
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    // A request the handler never answers: node's close would wait for it.
    socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    Serve.drain(server, "50 millis")
    await closed
    expect(Date.now() - started).toBeLessThan(1500)
    socket.destroy()
  })
})
