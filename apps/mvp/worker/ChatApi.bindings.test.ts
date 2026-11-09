// The settings ChatApi's Worker binds, read from Alchemy's own plan of it. Alchemy binds a setting to the Worker only
// when ChatApi's Effect Config reads it while Alchemy plans the Worker (docs/infrastructure.md#credentials); a setting
// read later, or only on a path the plan doesn't take, is never bound, and production reads it as unset. On 2026-10-31
// sign-in read APP_DOMAIN and APP_ALIASES only once SESSION_SECRET was set, which Alchemy binds from the stack rather
// than from Config, so no plan ever read them and aliases signed in through their own GitHub callback (decision 0130).
import * as Cloudflare from "@alchemy.run/cloudflare"
import { run } from "@alchemy.run/test/Core"
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import { Stage } from "alchemy/Stage"
import { ConfigProvider, Effect, Redacted } from "effect"
import { generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import * as Electric from "../infra/Electric.ts"
import * as Secrets from "../infra/Secrets.ts"
import * as SignIn from "../infra/SignIn.ts"
import ChatApi from "./ChatApi.ts"
import { DEFAULT_CHAT_MODEL } from "./ModelRoles.ts"

/** The Workers whose settings ChatApi's Worker carries: ChatApi and the Durable Objects it hosts. */
const HOSTED = ["ChatApi", "FlowExecution", "SandboxObject"]

/** Every setting docs/infrastructure.md#credentials says ChatApi's Worker uses. */
const documented = () =>
  readFileSync(new URL("../docs/infrastructure.md", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length === 6 && HOSTED.some((name) => cells[3]!.split(", ").includes(name)))
    .flatMap((cells) => [...cells[1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1]!))
    .sort()

/**
 * A private key in PEM, as Code Storage's ES256 key and the GitHub App's RS256 key are: a key that doesn't import turns
 * its feature off before it reads the rest of the feature's settings.
 */
const pem = (type: "ec" | "rsa") =>
  (type === "ec"
    ? generateKeyPairSync("ec", { namedCurve: "P-256" })
    : generateKeyPairSync("rsa", { modulusLength: 2048 })).privateKey.export({ type: "pkcs8", format: "pem" })
    .toString()

/** A valid value for each documented setting; a newly documented one needs one here before this test passes. */
const SETTINGS: Readonly<Record<string, string>> = {
  APP_DOMAIN: "smithers.test",
  APP_ALIASES: "factory.smithers.test=/acme/widgets/-/factory",
  CEREBRAS_API_KEY: "cerebras-key",
  CHAT_MODEL: JSON.stringify(DEFAULT_CHAT_MODEL),
  SUMMARY_MODEL: JSON.stringify(DEFAULT_CHAT_MODEL),
  MODEL_DAILY_TOKEN_BUDGET: "1000000",
  MODEL_MAX_OUTPUT_TOKENS: "4096",
  MODEL_MAX_MESSAGES: "200",
  MODEL_MAX_REQUEST_BYTES: "1000000",
  MODEL_RESERVATION_EXPIRY: "1 hour",
  HOSTED_AUTH_SITES: JSON.stringify([{ origin: "https://vibelang.smithers.test", secret: "h".repeat(64) }]),
  AUTH_BROKER_ENCRYPTION_KEY: "a".repeat(43) + "=",
  AUTH_BROKER_ORIGIN: "https://smithers.test",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_REPOSITORY: "acme/widgets",
  SESSION_MAX_AGE_DAYS: "30",
  ROLE_RECHECK_MINUTES: "10",
  GITHUB_ALLOWED_REPOSITORIES: "acme/gadgets",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: pem("rsa"),
  FLOW_EXECUTION_LOCATION: "enam",
  REPO_FLOWS: "true",
  TODO_RUNS: "true",
  GATE_IMAGE: `registry.cloudflare.com/account/smithers-gate@sha256:${"a".repeat(64)}`,
  SANDBOX_SECRETS: "true",
  EGRESS_ALLOW_HOSTS: "receiver.example",
  SANDBOX_COMMAND_MAX_SECONDS: "600",
  SANDBOX_SESSION_TIMEOUT_SECONDS: "60",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_API_URL: "https://api.github.test",
  CODE_STORAGE_ORG: "acme",
  CODE_STORAGE_KEY: pem("ec"),
  ALERT_EMAIL_API_KEY: "email-key",
  ALERT_TELEGRAM_BOT_TOKEN: "telegram-token",
  BUG_REPORTS_READ_TOKEN: "bug-reports-token",
  FEED_KEYS: `acme/widgets=${"0".repeat(64)}`,
  ALERT_EMAIL_FROM: "Smithers <alerts@smithers.test>",
  ALERT_EMAIL_API_URL: "https://email.test",
  ALERT_TELEGRAM_API_URL: "https://telegram.test",
  GITHUB_APP_SLUG: "smithers-test",
  GITHUB_TOKEN: "github-token",
  CODE_STORAGE_API_URL: "https://code-storage.test",
  REPO_MAX_REPOSITORIES: "10",
  REPO_MAX_STORED_GB: "10",
  REPO_MAX_READ_GB_PER_MONTH: "100",
  REPO_MAX_SIZE_MB: "500",
  REPO_BUDGET_USD: "10",
  REPO_TREE_MAX_PATHS: "10000",
  REPO_CLONE_DEADLINE: "5 minutes"
}

/** The values the stack makes and binds itself (alchemy.run.ts), which a real plan's Config never sees. */
const STACK_MADE = { SESSION_SECRET: "s".repeat(64), SECRETS_KEY: "k".repeat(64) }

const made = (value: string) => Output.literal(Redacted.make(value))

/**
 * The names ChatApi's Worker binds when Alchemy plans it as alchemy.run.ts declares it in production, with `settings`
 * as the deploying environment. Nothing reaches Cloudflare: the stack is evaluated, never diffed or applied.
 */
const planned = (settings: Readonly<Record<string, string>>) =>
  run(
    Alchemy.Stack(
      "chatapi-bindings",
      { providers: Cloudflare.providers(), state: Alchemy.inMemoryState() },
      Effect.gen(function*() {
        const worker = yield* ChatApi.pipe(
          Effect.provideService(
            Electric.Endpoint,
            Electric.Endpoint.of({ service: Output.literal("electric-gateway") })
          ),
          Effect.provideService(SignIn.Secret, SignIn.Secret.of({ value: made(STACK_MADE.SESSION_SECRET) })),
          Effect.provideService(Secrets.Secret, Secrets.Secret.of({ value: made(STACK_MADE.SECRETS_KEY) }))
        )
        return Object.keys(worker.Props.env ?? {}).sort()
      })
    ).pipe(
      Effect.map((stack) => stack.output as ReadonlyArray<string>),
      Effect.provideService(Stage, "test"),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ...settings, CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" })
      )
    ),
    { providers: Cloudflare.providers() }
  )

describe("ChatApi's bindings", () => {
  test("cover every setting docs/infrastructure.md says it uses", () => {
    expect(Object.keys(SETTINGS).sort()).toEqual(documented())
  })

  test("bind every documented setting that is set, sign-in's APP_DOMAIN and APP_ALIASES included", async () => {
    const bound = await planned(SETTINGS)
    expect(Object.keys(SETTINGS).filter((name) => !bound.includes(name))).toEqual([])
    expect(bound).toEqual(expect.arrayContaining(["APP_DOMAIN", "APP_ALIASES"]))
  }, 120_000)

  test("are the same whether or not the plan's Config sees the values the stack makes", async () => {
    // A read behind SESSION_SECRET or SECRETS_KEY runs only where they are set, at runtime, so it would bind nothing.
    expect(await planned(SETTINGS)).toEqual(await planned({ ...SETTINGS, ...STACK_MADE }))
  }, 120_000)
})
