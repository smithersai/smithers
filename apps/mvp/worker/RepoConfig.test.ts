// The repository feature's configuration (worker/RepoConfig.ts): Code Storage only when its organization and key are
// set, a key that doesn't import refused without printing it, and the clone's services built from the same settings.
import { ImmutableCache } from "@smthrs/artifacts"
import { Core, type GitHub } from "@smthrs/integrations"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Duration, Effect, Exit, Layer, Logger, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import { CloneUnavailable } from "./flows/RepoClone.ts"
import * as RepoConfig from "./RepoConfig.ts"

/** A fresh ES256 key, as Code Storage's Keys page hands one out: a PKCS#8 PEM. */
const pem = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`
}

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

const run = <A, E>(effect: Effect.Effect<A, E, never>, config: Record<string, string>, logs: Array<StructuredLog> = []) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
      Effect.provide(Logger.layer([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))])),
    ),
  )

const codeStorage = RepoConfig.codeStorage.pipe(Effect.provide(FetchHttpClient.layer))

describe("RepoConfig", () => {
  test("no Code Storage organization or key: nothing clones", async () => {
    expect(await run(codeStorage, {})).toEqual(Option.none())
    expect(await run(codeStorage, { CODE_STORAGE_ORG: "smithers" })).toEqual(Option.none())
    expect(await run(RepoConfig.cloneServices(Layer.empty as never, ImmutableCache.layerMemory()).pipe(Effect.provide(FetchHttpClient.layer)), {}))
      .toEqual(Option.none())
  })

  test("a key that doesn't import is refused and logged by code, never printed", async () => {
    const logs: Array<StructuredLog> = []
    const key = "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n"
    expect(await run(codeStorage, { CODE_STORAGE_ORG: "smithers", CODE_STORAGE_KEY: key }, logs)).toEqual(Option.none())
    expect(logs.find((log) => log.message === "repo.config")!.annotations).toMatchObject({ errorCode: "invalid_key" })
    expect(JSON.stringify(logs)).not.toContain("bm90IGEga2V5")
  })

  test("with an organization and a key: the client, and the clone's services with the budgets and deadline", async () => {
    const config = { CODE_STORAGE_ORG: "smithers", CODE_STORAGE_KEY: await pem(), REPO_CLONE_DEADLINE: "5 minutes" }
    expect(Option.isSome(await run(codeStorage, config))).toBe(true)
    // Postgres and Code Storage both unreachable: what Index reads must fail as a retry, never a crash.
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const services = await run(
      RepoConfig.cloneServices(unreachable, ImmutableCache.layerMemory()).pipe(Effect.provide(FetchHttpClient.layer)),
      { ...config, REPO_MAX_STORED_GB: "2", CODE_STORAGE_API_URL: "http://127.0.0.1:1" },
    )
    expect(Option.isSome(services)).toBe(true)
    const value = Option.getOrThrow(services)
    expect(Duration.toMillis(value.deadline)).toBe(5 * 60_000)
    expect(value.budgets).toEqual({
      maxRepositories: 100, clonesPerPerson: 3,
      maxStoredBytes: 2e9,
      maxReadBytes: 40e9,
      maxRepositoryBytes: 1e9,
      budgetUsd: 20,
    })
    expect(value.upstream.head).toBeTypeOf("function")
    // Index reads the list through RepoApi's reads: a Code Storage it can't reach is retried, never a crash.
    const indexed = await Effect.runPromiseExit(value.index("octocat", "Spoon-Knife", "a".repeat(40)))
    expect(Exit.isFailure(indexed) && Exit.findErrorOption(indexed)).toEqual(Option.some(new CloneUnavailable()))
    // Without the GitHub App, it is installed nowhere.
    expect(await Effect.runPromise(value.installed("octocat", "Spoon-Knife"))).toBe(false)
  })

  test("whether the App is installed: GitHub's answer as the App; 404 is no, any other refusal is retried", async () => {
    const refusal = (status: number) =>
      new Core.IntegrationError.IntegrationError("delivery-failed", `GitHub answered ${status}`, { status, retryable: false })
    // The App as GitHub answers it, scripted: installed on acme/widgets only, and down for acme/down.
    const app = {
      installation: (owner: string, name: string) =>
        `${owner}/${name}` === "acme/widgets"
          ? Effect.succeed({ id: 77 })
          : Effect.fail(refusal(`${owner}/${name}` === "acme/down" ? 502 : 404)),
    } as unknown as GitHub.AppAuth.AppAuth
    const installed = RepoConfig.installedWith(Option.some({ app }))
    expect(await Effect.runPromise(installed("acme", "widgets"))).toBe(true)
    expect(await Effect.runPromise(installed("acme", "other"))).toBe(false)
    expect(await Effect.runPromise(Effect.flip(installed("acme", "down")))).toEqual(new CloneUnavailable())
    expect(await Effect.runPromise(RepoConfig.installedWith(Option.none())("acme", "widgets"))).toBe(false)
  })
})
