// Where spend alerts go outside the app (docs/features/spend-alerts.md#channels), on the server: an Admin sets each
// channel through ChatApi's real handler over this file's schema of the compose Postgres, the setting and the receipts
// sync through the compose Electric to Admins only, and the deployment's providers come from its configuration.
import { Channels } from "@smthrs/notifications"
import { ElectricCollection } from "@smthrs/effect-electric"
import { ConfigProvider, Data, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { ALERT_CHANNEL_COLUMNS, ALERT_DELIVERY_COLUMNS } from "../src/features/spend/contract.ts"
import type { Actor } from "./Actor.vibe"
import * as AlertChannels from "./AlertChannels.ts"
import { answers, harness, recorded, testFile } from "./test/harness.ts"

const runtime = testFile("alert_channels")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE alert_channels, alert_deliveries`))
)

const admin: Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const agentForAdmin: Actor = { ...admin, act: { kind: "agent", id: "agent-run-1" } }

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

const channelRows = () =>
  sql<{ channel: string; destinations: ReadonlyArray<string>; appUrl: string; updatedBy: string; audience: string }>(
    `SELECT channel, destinations, app_url AS "appUrl", updated_by AS "updatedBy", audience FROM alert_channels
     ORDER BY channel`,
  )

/** ChatApi as `actor`, its Electric requests recorded and pointed at this file's schema. */
const open = async (actor: Actor | null, options: Pick<NonNullable<Parameters<typeof harness>[2]>, "database" | "config"> = {}) => {
  const { name } = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const upstream: Array<URL> = []
  const h = await harness(runtime, answers("never"), {
    ...(actor === null ? {} : { actor }),
    config: { ALERT_APP_URL: "http://chat.test/app" },
    ...options,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      upstream.push(new URL(url))
      const table = url.searchParams.get("table")
      if (table !== null) url.searchParams.set("table", `${name}.${table}`)
      return fetch(url, init)
    },
  })
  return { h, upstream }
}

const set = (h: Awaited<ReturnType<typeof open>>["h"], body: unknown) =>
  h.fetch("/api/alert-channels", {
    method: "POST",
    body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
  })

/** The rows a shape response carries. */
const values = async (response: Response) =>
  ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
    row.value === undefined ? [] : [row.value]
  )

/** Wait for the exact shape's committed fixture before asserting its raw HTTP snapshot. */
const delivered = (table: "alert_channels" | "alert_deliveries", txid: number) =>
  runtime.runPromise(Effect.gen(function* () {
    const { name } = yield* TestDatabase.Scratch
    const url = new URL(`${yield* TestDatabase.electricUrl}/v1/shape`)
    url.searchParams.set("table", `${name}.${table}`)
    url.searchParams.set("where", "audience = $1")
    url.searchParams.set("params[1]", "admin")
    url.searchParams.set("columns", (table === "alert_channels" ? ALERT_CHANNEL_COLUMNS : ALERT_DELIVERY_COLUMNS).join(","))
    const rows = yield* ElectricCollection.make({
      id: `alert-fixture-${table}-${txid}`, schema: Schema.Struct({ channel: Schema.String }),
      getKey: row => row.channel, shape: { url: url.href },
    })
    yield* rows.preload.pipe(Effect.andThen(rows.awaitTxId(txid, "15 seconds")), Effect.timeout("20 seconds"),
      Effect.tapError(() => Effect.logWarning("alerts.fixture.delivery").pipe(Effect.annotateLogs({ table, stage: "transaction" }))))
  }).pipe(Effect.scoped))

describe("POST /api/alert-channels", () => {
  test("a local or preview request persists the configured alert link", async () => {
    const config: Record<string, string> = { ALERT_APP_URL: "https://smithers.example/app" }
    const { h } = await open(admin, { config })
    delete config.ALERT_APP_URL
    expect((await set(h, { channel: "email", destinations: ["ops@example.com"] })).status).toBe(200)
    expect((await channelRows())[0]?.appUrl).toBe("https://smithers.example/app")
  })

  test.each([undefined, "relative", "javascript:alert(1)", "https://user:password@example.com/app", "https://:password@example.com/app"])(
    "refuses saving without a usable configured app URL: %j", async (appUrl) => {
      const config: Record<string, string> = {}
      if (appUrl !== undefined) config.ALERT_APP_URL = appUrl
      const { h } = await open(admin, { config })
      expect((await set(h, { channel: "email", destinations: ["ops@example.com"] })).status).toBe(503)
      expect(await channelRows()).toEqual([])
    },
  )

  test("an Admin sets email addresses, trimmed and without repeats, and the app address messages link to", async () => {
    const { h } = await open(admin)

    const response = await set(h, {
      channel: "email",
      destinations: [" will@example.com ", "ops@example.com", "will@example.com", ""],
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ txid: expect.any(Number) })
    expect(await channelRows()).toEqual([{
      channel: "email",
      destinations: ["will@example.com", "ops@example.com"],
      appUrl: "http://chat.test/app",
      updatedBy: "person-admin",
      audience: "admin",
    }])
    // Its record says which channel and how many, never one of them.
    expect(h.only("alerts.channel").annotations).toMatchObject({ channel: "email", destinations: 2, status: 200 })
    expect(h.count(AlertChannels.requests, { channel: "email", status: "200" })).toBe(1)
    expect(recorded(h)).not.toContain("will@example.com")
    expect(recorded(h)).not.toContain("ops@example.com")
  })

  test("an Admin sets a Telegram chat, replaces it, and turns it off with no destinations", async () => {
    const { h } = await open(admin)

    expect((await set(h, { channel: "telegram", destinations: ["-1001234567890"] })).status).toBe(200)
    expect((await set(h, { channel: "telegram", destinations: ["@smithers_alerts"] })).status).toBe(200)
    expect((await channelRows()).map((row) => row.destinations)).toEqual([["@smithers_alerts"]])

    const off = await set(h, { channel: "telegram", destinations: [] })
    expect(off.status).toBe(200)
    expect(await off.json()).toEqual({ txid: expect.any(Number) })
    expect(await channelRows()).toEqual([])
    // Turning off a channel that is off changes nothing.
    const again = await set(h, { channel: "telegram", destinations: ["  "] })
    expect(await again.json()).toEqual({ txid: null })
    expect(h.line("alerts.channel").at(-1)!.annotations).toMatchObject({ existing: true, destinations: 0 })
  })

  test.each([
    ["an address that isn't one", { channel: "email", destinations: ["will"] }, 400, "invalid_destination"],
    ["two Telegram chats", { channel: "telegram", destinations: ["123456789", "987654321"] }, 400, "invalid_destination"],
    ["a chat id that isn't one", { channel: "telegram", destinations: ["chat"] }, 400, "invalid_destination"],
    ["another channel", { channel: "sms", destinations: [] }, 400, "invalid"],
    ["eleven addresses", {
      channel: "email",
      destinations: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`),
    }, 400, "invalid"],
    ["a body that isn't JSON", "{", 400, "invalid"],
    ["a body that isn't UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 400, "invalid"],
    ["a body over 4 KiB", { channel: "email", destinations: ["x".repeat(5_000)] }, 413, "too_large"],
  ] as const)("refuses %s, writing nothing", async (_, body, status, code) => {
    const { h } = await open(admin)

    const response = await set(h, body)

    expect([response.status, await response.json()]).toEqual([status, { code }])
    expect(await channelRows()).toEqual([])
  })

  test.each([
    ["signed out", null, 401, "authentication"],
    ["a Member", member, 403, "forbidden"],
    ["an agent acting for an Admin", agentForAdmin, 403, "person_only"],
  ] as const)("refuses %s", async (_, actor, status, code) => {
    const { h } = await open(actor)

    const response = await set(h, { channel: "email", destinations: ["will@example.com"] })

    expect([response.status, await response.json()]).toEqual([status, { code }])
    expect(await channelRows()).toEqual([])
    expect(h.only("alerts.channel")).toMatchObject({ level: "WARN", annotations: { status } })
  })

  test("405 for another method", async () => {
    const { h } = await open(admin)

    const response = await h.fetch("/api/alert-channels")

    expect([response.status, response.headers.get("allow")]).toEqual([405, "POST"])
    expect(h.count(AlertChannels.requests, { channel: "none", status: "405" })).toBe(1)
  })

  test("503 with the database's code when Postgres fails, as an Error line", async () => {
    class Unreachable extends Data.TaggedError("Unreachable")<{}> {}
    const { h } = await open(admin, { database: Layer.effect(SqlClient.SqlClient, Effect.fail(new Unreachable())) })

    const response = await set(h, { channel: "email", destinations: ["will@example.com"] })

    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(h.only("alerts.channel")).toMatchObject({ level: "ERROR", annotations: { status: 503, channel: "email" } })
  })
})

describe("the channels' and receipts' shapes", () => {
  test("an Admin syncs the setting and the receipts, without their audience", async () => {
    const { h, upstream } = await open(admin)
    const saved = await set(h, { channel: "email", destinations: ["will@example.com"] })
    expect(saved.status).toBe(200)
    const { txid } = await saved.json() as { txid: number }
    const [receipt] = await sql<{ txid: string }>(`
      INSERT INTO alert_deliveries (alert_id, channel, status, code, reason, http_status)
      VALUES ('spend-alert-900000-0', 'telegram', 'refused', 'rejected', 'Bad Request: chat not found', 400)
      RETURNING pg_current_xact_id()::xid::text AS txid`)
    await delivered("alert_channels", txid)
    await delivered("alert_deliveries", Number(receipt!.txid))

    const channels = await values(await h.fetch("/api/shapes/alert-channels?offset=-1"))
    const receipts = await values(await h.fetch("/api/shapes/alert-deliveries?offset=-1"))

    expect(channels).toEqual([
      { channel: "email", destinations: '["will@example.com"]', updated_at: expect.any(String) },
    ])
    expect(receipts).toEqual([{
      alert_id: "spend-alert-900000-0",
      channel: "telegram",
      status: "refused",
      code: "rejected",
      reason: "Bad Request: chat not found",
      http_status: "400",
      attempts: "1",
      updated_at: expect.any(String),
    }])
    expect(upstream.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      {
        offset: "-1",
        table: "alert_channels",
        where: "audience = $1",
        "params[1]": "admin",
        columns: ALERT_CHANNEL_COLUMNS.join(","),
      },
      {
        offset: "-1",
        table: "alert_deliveries",
        where: "audience = $1",
        "params[1]": "admin",
        columns: ALERT_DELIVERY_COLUMNS.join(","),
      },
    ])
    expect(h.count(AlertChannels.channelShapes, { status: "200", live: "false" })).toBe(1)
    expect(h.count(AlertChannels.deliveryShapes, { status: "200", live: "false" })).toBe(1)
  })

  test("a Member, an agent acting for an Admin, and a signed-out request are refused without calling Electric", async () => {
    const { h: adminHandler } = await open(admin)
    const saved = await set(adminHandler, { channel: "email", destinations: ["hidden@example.com"] })
    expect(saved.status).toBe(200)
    const { txid } = await saved.json() as { txid: number }
    const [receipt] = await sql<{ txid: string }>(`INSERT INTO alert_deliveries (alert_id, channel, status)
      VALUES ('hidden-alert', 'email', 'sent') RETURNING pg_current_xact_id()::xid::text AS txid`)
    await delivered("alert_channels", txid)
    await delivered("alert_deliveries", Number(receipt!.txid))
    expect(await values(await adminHandler.fetch("/api/shapes/alert-channels?offset=-1"))).toHaveLength(1)
    expect(await values(await adminHandler.fetch("/api/shapes/alert-deliveries?offset=-1"))).toHaveLength(1)
    for (const actor of [member, agentForAdmin, null]) {
      const { h, upstream } = await open(actor)
      for (const path of ["/api/shapes/alert-channels?offset=-1", "/api/shapes/alert-deliveries?offset=-1"]) {
        const response = await h.fetch(path)
        expect(response.status).toBe(403)
        expect(response.headers.get("retry-after")).toBeNull()
      }
      expect(upstream).toEqual([])
    }
  })
})

describe("destinations", () => {
  test("a channel's stored destinations become where its messages go, or none when they aren't one it takes", () => {
    expect(AlertChannels.destinationOf("email", ["will@example.com"])).toEqual(
      Option.some({ _tag: "email", to: ["will@example.com"] }),
    )
    expect(AlertChannels.destinationOf("telegram", ["-1001234567890"])).toEqual(
      Option.some({ _tag: "telegram", chatId: "-1001234567890" }),
    )
    expect(AlertChannels.destinationOf("email", [])).toEqual(Option.none())
    expect(AlertChannels.destinationOf("telegram", [])).toEqual(Option.none())
  })
})

describe("the deployment's providers", () => {
  const available = (config: Record<string, string>, options: { readonly dev?: boolean } = {}) =>
    Effect.runPromise(
      AlertChannels.channelsConfig(options).pipe(
        Effect.flatMap((layer) =>
          Effect.provide(Effect.map(Effect.service(Channels.Channels), (channels) => channels.available), layer)
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
      ),
    )

  test("a channel has a provider only with its credential", async () => {
    expect(await available({})).toEqual([])
    expect(await available({ ALERT_EMAIL_API_KEY: "re_key" })).toEqual(["email"])
    expect(await available({ ALERT_TELEGRAM_BOT_TOKEN: "1:token", ALERT_TELEGRAM_API_URL: "http://127.0.0.1:9" }))
      .toEqual(["telegram"])
    expect(
      await available({
        ALERT_EMAIL_API_KEY: "re_key",
        ALERT_EMAIL_API_URL: "http://127.0.0.1:9",
        ALERT_EMAIL_FROM: "Alerts <alerts@example.com>",
        ALERT_TELEGRAM_BOT_TOKEN: "1:token",
      }),
    ).toEqual(["email", "telegram"])
    // A URL alone is no provider in a deployment.
    expect(await available({ ALERT_EMAIL_API_URL: "http://127.0.0.1:9", ALERT_TELEGRAM_API_URL: "http://127.0.0.1:9" }))
      .toEqual([])
    expect(AlertChannels.DEFAULT_EMAIL_FROM).toBe("Smithers <onboarding@resend.dev>")
  })

  test("under alchemy dev, a provider pointed at a local fake sends without its credential", async () => {
    expect(
      await available(
        { ALERT_EMAIL_API_URL: "http://127.0.0.1:9", ALERT_TELEGRAM_API_URL: "http://127.0.0.1:9" },
        { dev: true },
      ),
    ).toEqual(["email", "telegram"])
    // Without a URL, dev has no provider either: it never sends to the real services with a placeholder.
    expect(await available({}, { dev: true })).toEqual([])
    expect(AlertChannels.DEV_CREDENTIAL).toBe("dev")
  })
})
