import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http/HttpServer"
import { describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as ScriptedDriver from "../src/ScriptedDriver.ts"
import * as Serve from "../src/Serve.ts"
import * as Store from "../src/Store.ts"
import { run, scratchDirectory } from "./Harness.ts"

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
      expect(String(error)).toContain("--listen")
    } finally {
      scratch.remove()
    }
  })
})
