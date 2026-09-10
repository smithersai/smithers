import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { WorkerEnv } from "./Environment"
import { WORKER_IDENTITY } from "./workerIdentity"
import { CLIENT_DISCONNECTED_STATUS, UNEXPECTED_FAILURE_MESSAGE } from "./Boundary"
import { durableObjectClasses, runFetch, workerProps } from "./Worker"
import { stripComments } from "../scripts/effect-policy"

/*
 * The deployed Worker's Durable Object wiring, without a deployment.
 *
 * Since upstream e089305e5d the gateway registry mints the Cloud token and
 * provisions the workspace INSIDE the object (`POST /resolve`), so the object
 * needs the deployment's identity door, Cloud origin and deadline. A registry
 * built over an empty bag answers every resolution
 * `unavailable: IDENTITY_UPSTREAM_URL is unset on this deployment.` — an
 * outage of `/api/workflow/*` that typechecks, deploys, and passes every
 * router test, because the router only forwards to the binding. This file is
 * the gate: `durableObjectClasses(env)` must thread the bag through to the
 * object's `ServerConfig`.
 */
const bag = {
  IDENTITY_UPSTREAM_URL: "https://identity.example",
  IDENTITY_SERVICE_TOKEN: "service-token-fixture",
  SMITHERS_CLOUD_API_BASE_URL: "https://cloud.example",
  UPSTREAM_TIMEOUT_MS: "1234"
} as unknown as WorkerEnv

const configOf = (env: WorkerEnv) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* ServerConfig
    }).pipe(Effect.provide(durableObjectClasses(env).GatewaySessionRegistry!.layers(memoryStorage())))
  )

describe("the gateway registry object runs on the deployment's own config", () => {
  test("the identity door, the Cloud origin and the deadline reach the object", async () => {
    const config = await configOf(bag)
    expect(config.identityUpstreamUrl).toBe("https://identity.example")
    expect(config.cloudApiBaseUrl).toBe("https://cloud.example")
    expect(config.upstreamTimeoutMs).toBe(1234)
    expect(Redacted.value(config.identityServiceToken!)).toBe("service-token-fixture")
  })

  test("an empty bag is the outage this test exists to catch, so it must not be what the Worker passes", async () => {
    const empty = await configOf({} as WorkerEnv)
    expect(empty.identityUpstreamUrl).toBeUndefined()
    const wired = await configOf(bag)
    expect(wired.identityUpstreamUrl).not.toBeUndefined()
  })
})

describe("every declared Durable Object class has a body", () => {
  test("one entry per WORKER_IDENTITY.durableObjects class name, and no extra", () => {
    const classes = durableObjectClasses({} as WorkerEnv)
    expect(Object.keys(classes).sort()).toEqual(WORKER_IDENTITY.durableObjects.map((d) => d.className).sort())
  })

  test("each body is a request Effect plus a per-object Layer factory", () => {
    const classes = durableObjectClasses(bag)
    for (const { className } of WORKER_IDENTITY.durableObjects) {
      expect(`${className}: ${typeof classes[className]!.handle}`).toBe(`${className}: function`)
      expect(`${className}: ${typeof classes[className]!.layers}`).toBe(`${className}: function`)
    }
  })

  /*
   * The factory is called once per in-memory object, so it must produce a
   * FRESH Layer each call: two objects that shared one Layer would share the
   * client-error throttle window and the gateway join map.
   */
  test("the factory returns a distinct Layer per object", () => {
    const classes = durableObjectClasses(bag)
    for (const { className } of WORKER_IDENTITY.durableObjects) {
      const first = classes[className]!.layers(memoryStorage())
      const second = classes[className]!.layers(memoryStorage())
      expect(`${className}: ${first === second}`).toBe(`${className}: false`)
    }
  })
})

/*
 * `durableObjectClasses(env)` is only half the wiring: the init closure has to
 * hand it the RESOLVED bag. That call lives inside `Cloudflare.Worker(...)`,
 * which cannot be invoked without a deployment, so it is pinned at the source
 * level — comments stripped, so prose may still name the wrong shapes.
 */
describe("the init closure registers the Durable Objects from the resolved bag", () => {
  const code = stripComments(readFileSync(new URL("./Worker.ts", import.meta.url), "utf8"))

  test("the exports are built from `deployment`, the same bag layersFromEnv gets", () => {
    expect(code).toContain("const deployment = { ...(env as WorkerEnv), ...resolved } as WorkerEnv")
    expect(code).toContain("durableObjectClasses(deployment)")
    expect(code).toContain("layersFromEnv(deployment)")
  })

  test("no Durable Object body is built from an empty bag", () => {
    expect(code).not.toContain("durableObjectClasses({})")
    expect(code).not.toContain("gatewayRegistryLayers(native, {})")
  })

  test("the bag exists before the exports are registered", () => {
    expect(code.indexOf("const deployment =")).toBeLessThan(code.indexOf("durableObjectClasses(deployment)"))
  })

  /*
   * The 499 and the 500 above are pinned on `runFetch`; this is what pins
   * that the deployed handler actually goes through it rather than yielding
   * the router directly, which is how the boundary was missing to begin with.
   */
  test("the fetch handler runs the router through the shared boundary", () => {
    expect(code).toContain("runFetch(routed, request.signal)")
    expect(code).toContain("responseFromExit(exit)")
    expect(code).not.toContain("const response = yield* handleRequest(request)")
  })
})

/*
 * The deployed path's boundary. Alchemy's bridge attaches no abort listener
 * (HttpServer.ts:24-52 calls `toHandled`, not `toWebHandlerWith`), so
 * src/Worker.ts owns disconnect and defects itself. Without this the router's
 * finalizers never run for a client that hung up, an interruption surfaces as
 * Alchemy's 503, and a defect answers a bodyless 500 the cross-origin-isolated
 * app document cannot read. `runFetch` shares `responseFromExit` with the
 * native adapter, so the two entrypoints answer identically.
 */
describe("the deployed fetch answers a disconnect and a defect like the native adapter", () => {
  const isolation = (response: Response) => ({
    coop: response.headers.get("Cross-Origin-Opener-Policy"),
    coep: response.headers.get("Cross-Origin-Embedder-Policy"),
    type: response.headers.get("content-type")
  })

  test("a signal already aborted answers 499 without running the route", async () => {
    let ran = false
    const controller = new AbortController()
    controller.abort()
    const response = await Effect.runPromise(
      runFetch(
        Effect.sync(() => {
          ran = true
          return new Response("ok")
        }),
        controller.signal
      )
    )
    expect(response.status).toBe(CLIENT_DISCONNECTED_STATUS)
    expect(await response.json()).toEqual({ status: "error", message: "The client disconnected." })
    expect(isolation(response)).toEqual({
      coop: "same-origin",
      coep: "require-corp",
      type: "application/json; charset=utf-8"
    })
    expect(ran).toBe(false)
  })

  test("a client that disconnects mid-route interrupts the fiber, runs its finalizer, and answers 499", async () => {
    const controller = new AbortController()
    let released = false
    const route = Effect.never.pipe(
      Effect.onInterrupt(() => Effect.sync(() => {
        released = true
      })),
      Effect.as(new Response("never"))
    )
    const answered = Effect.runPromise(runFetch(route, controller.signal))
    await Effect.runPromise(Effect.sleep("10 millis"))
    controller.abort()
    const response = await answered
    expect(response.status).toBe(CLIENT_DISCONNECTED_STATUS)
    expect(await response.json()).toEqual({ status: "error", message: "The client disconnected." })
    expect(released).toBe(true)
  })

  test("a dying route is logged once and answers a generic 500 with the isolation headers", async () => {
    const logged: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args[0])
    }
    try {
      const response = await Effect.runPromise(
        runFetch(Effect.die(new Error("boom")) as Effect.Effect<Response>, new AbortController().signal)
      )
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ status: "error", message: UNEXPECTED_FAILURE_MESSAGE })
      expect(isolation(response)).toEqual({
        coop: "same-origin",
        coep: "require-corp",
        type: "application/json; charset=utf-8"
      })
      expect(logged).toEqual(["worker fetch failed:"])
    } finally {
      console.error = original
    }
  })

  test("a route that answers normally is passed through untouched", async () => {
    const answer = new Response("hello", { status: 201, headers: { "x-route": "yes" } })
    const response = await Effect.runPromise(runFetch(Effect.succeed(answer), new AbortController().signal))
    expect(response).toBe(answer)
    expect(response.status).toBe(201)
    expect(response.headers.get("x-route")).toBe("yes")
  })

  test("the 500 body never carries the defect", async () => {
    const original = console.error
    console.error = () => {}
    try {
      const response = await Effect.runPromise(
        runFetch(Effect.die(new Error("secret-token-in-a-stack-trace")) as Effect.Effect<Response>, new AbortController().signal)
      )
      expect(await response.text()).not.toContain("secret-token-in-a-stack-trace")
    } finally {
      console.error = original
    }
  })
})

describe("the deployed props still declare the frozen identity", () => {
  test("the five Durable Object bindings carry the binding name and the class name", () => {
    for (const { binding, className } of WORKER_IDENTITY.durableObjects) {
      expect((workerProps.env as Record<string, { name?: string; className?: string }>)[binding]).toMatchObject({
        name: binding,
        className
      })
    }
  })

  test("name, domain, route, compatibility and workers.dev come from WORKER_IDENTITY", () => {
    expect(workerProps.name).toBe(WORKER_IDENTITY.name)
    expect(workerProps.domain).toEqual({ name: WORKER_IDENTITY.domain.name, zoneId: WORKER_IDENTITY.domain.zoneId })
    expect(workerProps.routes).toEqual(WORKER_IDENTITY.routes.map((r) => ({ pattern: r.pattern, zoneId: r.zoneId })))
    expect(workerProps.compatibility).toEqual({
      date: WORKER_IDENTITY.compatibility.date,
      flags: [...WORKER_IDENTITY.compatibility.flags]
    })
    expect(workerProps.workersDev).toBe(WORKER_IDENTITY.workersDev)
    expect(workerProps.assets.directory).toBe(WORKER_IDENTITY.assets.directory)
    expect(workerProps.assets.runWorkerFirst).toEqual([...WORKER_IDENTITY.assets.runWorkerFirst])
  })
})
