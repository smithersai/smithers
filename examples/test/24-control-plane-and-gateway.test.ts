import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Control from "@smthrs/control/Control"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { HttpServer } from "effect/unstable/http"
import { request as httpRequest } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoveredFlow, main, serve, startLaunch } from "../src/24-control-plane-and-gateway.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("plans, approves, runs, and watches a discovered flow over a loopback control server", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "gateway"))

    expect(summary.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // The catalog a remote client reads is the project's `flows/` directory:
    // nothing in the example names this flow, the directory does.
    expect(summary.catalog).toEqual([discoveredFlow])

    // The plan card crossed the wire and decoded on the other side, carrying
    // the envelope the descriptor's own frontmatter declared.
    expect(summary.plannedFlow).toBe(discoveredFlow)
    expect(summary.plannedEnvelope).toEqual(["examples/RemoteShip"])

    // The approval gate holds over RPC exactly as it does in process.
    expect(summary.beforeApproval).toBe("Parked")
    expect(summary.afterApproval).toBe("Accepted")

    // And what reached the executor is the discovered flow, not a stand-in.
    // Once: the parked launch never reached it.
    expect(summary.launched).toEqual([discoveredFlow])

    // The run the client watches is the run the client approved. The receipt
    // named it, and it is the only run the plane knows about.
    expect(summary.watchedRunId).toBeTypeOf("string")
    expect(summary.listed).toEqual([summary.watchedRunId])
    // The executor started it, the run reached its durable wait, and the
    // executor wrote that back onto the plane's row.
    expect(summary.parked).toBe("parked")

    // And the watch replayed durable history over the WebSocket rather than
    // only forwarding what happened after the subscription opened. Both halves
    // of the chain are in one stream: the plane's decision and the engine's
    // execution of it.
    expect(summary.watched).toContain("control.run.accepted")
    expect(summary.watched).toContain("flows.engine.attempt-started")
  }), { timeout: 60_000 })

const credential = "gateway-session-credential"
const target = { _tag: "Plan", planId: "plan", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } }
const payload = (tag: "Approve" | "Run") => tag === "Approve"
  ? { target, scope: "once", idempotencyKey: "approve" }
  : { ...target, idempotencyKey: "run" }

// Any entry to these sentinel mutation handlers demonstrates a boundary bypass.
const boundary = <A, E>(use: (url: string, calls: Array<ControlSchema.Principal>) => Effect.Effect<A, E>) => {
  const calls: Array<ControlSchema.Principal> = []
  const control = Layer.effect(Control.Control)(Effect.gen(function*() {
    const noop = yield* Control.Control
    const mutation = (input: { readonly principal?: ControlSchema.Principal | undefined }) => Effect.sync(() => {
      if (input.principal !== undefined) calls.push(input.principal)
      return { _tag: "Accepted" as const, receiptId: "receipt" }
    })
    return Control.make({ ...noop, approve: mutation, run: mutation })
  })).pipe(Layer.provide(Control.layerNoop))
  return Effect.scoped(Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    if (server.address._tag !== "InetAddressV4") throw new Error("expected TCP")
    return yield* use(`http://127.0.0.1:${server.address.port}`, calls)
  }).pipe(Effect.provide(serve(credential).pipe(Layer.provide(control)))))
}

const request = (url: string, tag: "Approve" | "Run", headers: Record<string, string>, websocket: boolean) =>
  Effect.promise(() => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify({ _tag: "Request", id: "0", tag, payload: payload(tag), headers: [] }) + "\n"
    if (websocket) {
      const socket = new NodeSocket.NodeWS.WebSocket(`${url.replace("http:", "ws:")}/rpc/ws`, { headers })
      socket.on("error", reject)
      socket.on("unexpected-response", (_request, response) => {
        response.resume()
        resolve({ status: response.statusCode!, body: "" })
        socket.terminate()
      })
      socket.on("open", () => socket.send(body))
      socket.on("message", (data) => {
        if (!data.toString().includes('"Exit"')) return
        socket.close()
        resolve({ status: 101, body: data.toString() })
      })
    } else {
      const call = httpRequest(`${url}/rpc`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }
      }, (response) => {
        let result = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => { result += chunk })
        response.on("end", () => resolve({ status: response.statusCode!, body: result }))
      })
      call.on("error", reject)
      call.end(body)
    }
  }))

for (const websocket of [false, true]) {
  for (const tag of ["Approve", "Run"] as const) {
    for (const invalid of ["missing credential", "wrong credential", "foreign origin", "null origin", "foreign host", "wrong port"] as const) {
      it.live(`${websocket ? "WebSocket" : "HTTP"} ${tag} rejects ${invalid}`, () => boundary((url, calls) =>
        Effect.gen(function*() {
          const headers: Record<string, string> = { authorization: `Bearer ${credential}` }
          if (invalid === "missing credential") delete headers.authorization
          if (invalid === "wrong credential") headers.authorization = "Bearer wrong"
          if (invalid === "foreign origin") headers.origin = "https://attacker.example"
          if (invalid === "null origin") headers.origin = "null"
          if (invalid === "foreign host") headers.host = "attacker.example"
          if (invalid === "wrong port") headers.host = "127.0.0.1:1"
          const response = yield* request(url, tag, headers, websocket)
          expect(calls).toEqual([])
          if (invalid.includes("credential")) expect(response.body).toContain("Unauthorized")
          else expect(response.status).toBe(403)
        })))
    }
    it.live(`${websocket ? "WebSocket" : "HTTP"} ${tag} authenticates the session operator`, () => boundary((url, calls) =>
      Effect.gen(function*() {
        const response = yield* request(url, tag, { authorization: `Bearer ${credential}`, origin: url }, websocket)
        expect(response.body).toContain("Accepted")
        expect(calls).toEqual([{ id: "local", kind: "operator", stampedAt: expect.any(Number) }])
      })))
  }
}

for (const interruption of [false, true]) {
  it.live(`closes a pending launch after ${interruption ? "interruption before release" : "RPC failure after launch"}`, () =>
    Effect.gen(function*() {
      let launchFiber: Fiber.Fiber<void> | undefined
      let ran = false
      const accepted = yield* Deferred.make<void>()
      const session = Effect.scoped(Effect.gen(function*() {
        const scope = yield* Effect.scope
        // Closing the request scope must not close the server-owned launch.
        const pending = yield* Effect.scoped(startLaunch(scope, Effect.sync(() => { ran = true })))
        launchFiber = pending.fiber
        expect(launchFiber.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(accepted, undefined)
        return yield* interruption ? Effect.never : Effect.fail("RPC failed after acceptance")
      }))
      yield* Effect.gen(function*() {
        if (interruption) {
          const caller = yield* Effect.forkChild(session)
          yield* Deferred.await(accepted)
          yield* Fiber.interrupt(caller)
        } else {
          yield* Effect.exit(session)
        }
        expect(launchFiber?.pollUnsafe()).toBeDefined()
        expect(ran).toBe(false)
      }).pipe(Effect.ensuring(Effect.suspend(() => launchFiber === undefined ? Effect.void : Fiber.interrupt(launchFiber))))
    }))
}

it.live("awaits an active launch's finalizer before closing its services", () =>
  Effect.gen(function*() {
    const events: Array<string> = []
    const running = yield* Deferred.make<void>()
    let launchFiber: Fiber.Fiber<never> | undefined
    yield* Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("services closed") }))
        const scope = yield* Effect.scope
        const pending = yield* startLaunch(scope, Deferred.succeed(running, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("launch finalized") }))))
        ))
        launchFiber = pending.fiber
        yield* Deferred.succeed(pending.start, undefined)
        yield* Deferred.await(running)
      }))
      expect(events).toEqual(["launch finalized", "services closed"])
    }).pipe(Effect.ensuring(Effect.suspend(() => launchFiber === undefined ? Effect.void : Fiber.interrupt(launchFiber))))
  }))
