import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import worker from "./index"
import { BrowserEgress, DeploymentBindings, executionContextFrom, runtimeFor } from "./Environment"
import type { WorkerEnv } from "./Environment"
import { GithubAppAuth } from "./githubApp"
import { memoryDurableObjects } from "./memoryDurableObjects"

/*
 * The runtime memo: one `ManagedRuntime` per env object, so the services
 * built from one deployment's bag (the GitHub App single-flight mint, the
 * catalog cache) live across requests, while two bags never share a service
 * or a credential.
 */

/**
 * A real RSA key pair for the GitHub App secrets: the mint signs an App JWT
 * with it, so this test exercises the same WebCrypto path the Worker runs.
 */
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
  true,
  ["sign", "verify"]
)
const exported = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
let exportedBinary = ""
for (const byte of exported) exportedBinary += String.fromCharCode(byte)
const APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(exportedBinary).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`

const appEnv = (): WorkerEnv => ({
  ...memoryDurableObjects(),
  ASSETS: { fetch: async () => new Response("app") },
  SMITHERS_GITHUB_APP_ID: "4163546",
  SMITHERS_GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY
})

/** GitHub as the App sees it, counting every token exchange. */
const github = () => {
  let exchanges = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname
    if (path === "/app/installations") return Response.json([{ id: 150824198, account: { login: "smithersai" } }])
    if (path.endsWith("/access_tokens")) {
      exchanges += 1
      return Response.json({ token: `ghs_round_${exchanges}` }, { status: 201 })
    }
    return Response.json({ message: "not found" }, { status: 404 })
  }) as typeof fetch
  return { exchanges: () => exchanges, restore: () => { globalThis.fetch = original } }
}

const bearer = (env: WorkerEnv) => runtimeFor(env).runPromise(GithubAppAuth.use((auth) => auth.token()))

describe("runtimeFor", () => {
  test("the same env object is one runtime, and a different one is another", () => {
    const env = appEnv()
    expect(runtimeFor(env)).toBe(runtimeFor(env))
    expect(runtimeFor(env)).not.toBe(runtimeFor(appEnv()))
  })

  test("requests under one env share the single-flight mint; two envs never share a token", async () => {
    const wire = github()
    try {
      const env = appEnv()
      // Concurrent callers queue behind one exchange.
      const [first, second] = await Promise.all([bearer(env), bearer(env)])
      expect(first?.value).toBe("ghs_round_1")
      expect(second?.value).toBe("ghs_round_1")
      expect(wire.exchanges()).toBe(1)
      // A later request under the same env reads the held token.
      expect((await bearer(env))?.value).toBe("ghs_round_1")
      expect(wire.exchanges()).toBe(1)
      // Another deployment's bag mints its own.
      expect((await bearer(appEnv()))?.value).toBe("ghs_round_2")
      expect(wire.exchanges()).toBe(2)
    } finally {
      wire.restore()
    }
  })

  test("the native adapter runs every request of one env under that env's services", async () => {
    const wire = github()
    try {
      const env = appEnv()
      // Two bootstraps on one env: the runtime is reused, nothing is rebuilt.
      expect((await worker.fetch(new Request("https://mvp.test/api/bootstrap"), env)).status).toBe(200)
      expect((await worker.fetch(new Request("https://mvp.test/api/bootstrap"), env)).status).toBe(200)
      expect(wire.exchanges()).toBe(0)
      await bearer(env)
      expect((await bearer(env))?.value).toBe("ghs_round_1")
      expect(wire.exchanges()).toBe(1)
    } finally {
      wire.restore()
    }
  })
})

describe("the optional and per-request services", () => {
  test("BrowserEgress is honestly absent without the binding and present with it", async () => {
    const read = (env: WorkerEnv) => runtimeFor(env).runPromise(BrowserEgress.use((egress) => Effect.succeed(Option.isSome(egress))))
    expect(await read(appEnv())).toBe(false)
    expect(await read({ ...appEnv(), BROWSER_EGRESS: { fetch: async () => new Response("") } })).toBe(true)
  })

  test("DeploymentBindings names what the bag carries", async () => {
    const read = (env: WorkerEnv) => runtimeFor(env).runPromise(DeploymentBindings.use((bindings) => Effect.succeed(bindings)))
    expect(await read(appEnv())).toEqual({ clientErrors: false, recommendLog: false, cloudApi: false })
    const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) }
    expect(await read({ ...appEnv(), CLIENT_ERRORS: namespace, RECOMMEND_LOG: namespace, SMITHERS_CLOUD_API_BASE_URL: " https://cloud.test " }))
      .toEqual({ clientErrors: true, recommendLog: true, cloudApi: true })
    expect((await read({ ...appEnv(), SMITHERS_CLOUD_API_BASE_URL: "  " })).cloudApi).toBe(false)
  })

  test("waitUntil hands the platform a promise that settles when the forked work does, and forks without one", async () => {
    const pending: Array<Promise<unknown>> = []
    let finished = false
    const fiber = await Effect.runPromise(
      executionContextFrom({ waitUntil: (promise) => pending.push(promise) }).waitUntil(
        Effect.sleep(10).pipe(Effect.tap(() => Effect.sync(() => { finished = true })))
      )
    )
    expect(pending).toHaveLength(1)
    expect(finished).toBe(false)
    await pending[0]
    expect(finished).toBe(true)
    expect(fiber).toBeDefined()
    const detached = await Effect.runPromise(executionContextFrom(undefined).waitUntil(Effect.succeed("done")))
    expect(await Effect.runPromise(Fiber.join(detached))).toBe("done")
  })
})
