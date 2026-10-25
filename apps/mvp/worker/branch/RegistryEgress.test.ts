// A box's registry egress (worker/branch/RegistryEgress.ts): `@smthrs/secrets`' own forwarder under the registry
// policy, the upstream scripted on the `fetch` seam Effect's fetch client takes as a service, as the SDK's egress tests do.
import { Egress } from "@smthrs/secrets"
import { Effect, Layer, Metric } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import * as RegistryEgress from "./RegistryEgress.ts"

/** An upstream that answers every request with `body` and records each one it got. */
const upstream = (body: string) => {
  const got: Array<{ readonly method: string; readonly url: string }> = []
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    got.push({ method: request.method, url: request.url })
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }))
  }) as typeof globalThis.fetch
  return { got, layer: Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch)) }
}

/** A box's request through the registry egress, and what the box gets back. */
const through = async (request: Request, layer: ReturnType<typeof upstream>["layer"]) => {
  const { response, context } = await Effect.runPromise(
    Effect.all({ response: RegistryEgress.forward(HttpServerRequest.fromWeb(request)), context: Effect.context<never>() })
      .pipe(Effect.provide(layer)),
  )
  const web = HttpServerResponse.toWeb(response, { context })
  return { status: web.status, body: await web.text() }
}

const counted = (outcome: string) =>
  Effect.runSync(Metric.value(Metric.withAttributes(RegistryEgress.requests, { outcome }))).count

/** One request a repository's install makes to each registry host. */
const INSTALLS = [
  "https://registry.npmjs.org/effect",
  "https://registry.yarnpkg.com/left-pad",
  "https://pypi.org/simple/six/",
  "https://files.pythonhosted.org/packages/six-1.16.0-py2.py3-none-any.whl",
  "https://crates.io/api/v1/crates/serde",
  "https://index.crates.io/config.json",
  "https://static.crates.io/crates/serde/serde-1.0.200.crate",
  "https://proxy.golang.org/github.com/google/uuid/@v/list",
  "https://sum.golang.org/lookup/github.com/google/uuid@v1.6.0",
  "https://github.com/dprint/dprint/releases/download/0.50.0/dprint-x86_64-unknown-linux-gnu.zip",
  "https://objects.githubusercontent.com/github-production-release-asset/1",
  "https://release-assets.githubusercontent.com/github-production-release-asset/1",
  "https://plugins.dprint.dev/typescript-0.93.4.wasm",
]

describe("a box's registry egress", () => {
  test("forwards an install's requests to every registry host, counted", async () => {
    const registries = upstream(`{"name":"effect"}`)
    const before = counted("forwarded")
    expect(await through(new Request(INSTALLS[0]!), registries.layer)).toEqual({ status: 200, body: `{"name":"effect"}` })
    for (const url of INSTALLS.slice(1)) expect((await through(new Request(url), registries.layer)).status, url).toBe(200)
    expect(registries.got).toEqual(INSTALLS.map((url) => ({ method: "GET", url })))
    expect(counted("forwarded") - before).toBe(INSTALLS.length)
    // Each registry host is reached, and no other.
    expect(new Set(INSTALLS.map((url) => new URL(url).hostname))).toEqual(new Set(RegistryEgress.HOSTS))
  })

  test("refuses every other host before anything is sent: the box reaches nothing else", async () => {
    const elsewhere = upstream("never")
    const before = counted("host_not_allowed")
    const others = [
      "https://api.github.com/user",
      "https://raw.githubusercontent.com/o/r/main/x",
      "https://registry.npmjs.org.evil.test/x",
      "https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init",
      "https://storage.googleapis.com/x",
    ]
    for (const url of others) expect((await through(new Request(url), elsewhere.layer)).status, url).toBe(403)
    expect(elsewhere.got).toEqual([])
    expect(counted("host_not_allowed") - before).toBe(others.length)
  })

  test("names no secret: the policy holds only the registry hosts, and its vault reveals nothing", async () => {
    expect(RegistryEgress.POLICY).toEqual({ secrets: [], allow: RegistryEgress.HOSTS })
    const refused = await Effect.runPromise(
      Effect.flip(Effect.flatMap(Effect.service(Egress.Vault), (vault) => vault.reveal("NPM_TOKEN"))).pipe(
        Effect.provide(RegistryEgress.services),
      ),
    )
    expect(refused).toBeInstanceOf(Egress.SecretUnavailable)
  })

  test("a box's commands trust the egress's CA in Node and in dprint", () => {
    expect(RegistryEgress.trustOf("/ca.crt")).toEqual({ NODE_EXTRA_CA_CERTS: "/ca.crt", DPRINT_CERT: "/ca.crt" })
  })

  test("a branch's or a TODO's box gets the secrets egress only with SANDBOX_SECRETS on; a check job's never does", () => {
    const branch = { branchId: "b", owner: "o", name: "n", branch: "main" }
    expect(RegistryEgress.secretsEgress(branch, true)).toBe(true)
    expect(RegistryEgress.secretsEgress({ ...branch, forge: "github" }, true)).toBe(true)
    expect(RegistryEgress.secretsEgress({ ...branch, kind: "job" }, true)).toBe(false)
    // An object that holds no branch yet: the secrets egress, which refuses it (worker/BranchSandboxes.ts `egressOut`).
    expect(RegistryEgress.secretsEgress(undefined, true)).toBe(true)
    for (const box of [branch, { ...branch, forge: "github" as const }, { ...branch, kind: "job" as const }, undefined]) {
      expect(RegistryEgress.secretsEgress(box, false)).toBe(false)
    }
  })
})
