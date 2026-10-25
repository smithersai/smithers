// The sandbox limits on the server (worker/branch/BudgetApi.ts, docs/features/sandbox-budgets.md#the-limits): an Admin
// sets them through ChatApi's real handler over this file's schema of the compose Postgres, and they sync through the
// compose Electric to Admins only.
import { Data, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { SANDBOX_LIMIT_COLUMNS } from "../../src/features/spend/contract.ts"
import type { Actor } from "../Actor.ts"
import { answers, harness, testFile } from "../test/harness.ts"
import * as Budget from "./Budget.ts"
import * as BudgetApi from "./BudgetApi.ts"

const runtime = testFile("sandbox_limits")

beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE sandbox_limits`)))

const admin: Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const agentForAdmin: Actor = { ...admin, act: { kind: "agent", id: "agent-run-1" } }

const limits = () => runtime.runPromise(Budget.limits)

/** ChatApi as `actor`, its Electric requests recorded and pointed at this file's schema. */
const open = async (actor: Actor | null, options: Pick<NonNullable<Parameters<typeof harness>[2]>, "database"> = {}) => {
  const { name } = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const upstream: Array<URL> = []
  const h = await harness(runtime, answers("never"), {
    ...(actor === null ? {} : { actor }),
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
  h.fetch("/api/sandbox-limits", {
    method: "POST",
    body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
  })

/** The rows a shape response carries. */
const values = async (response: Response) =>
  ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
    row.value === undefined ? [] : [row.value]
  )

describe("POST /api/sandbox-limits", () => {
  test("an Admin sets the limits, which the next admission reads; setting them again replaces them", async () => {
    const { h } = await open(admin)

    const response = await set(h, { awake: 5, perPerson: 1, monthlyAlertUsd: 40 })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ txid: expect.any(Number) })
    expect(await limits()).toEqual({ awake: 5, perPerson: 1, monthlyAlertUsd: 40 })
    expect(h.only("sandbox.limits").annotations).toMatchObject({ awake: 5, perPerson: 1, monthlyAlertUsd: 40, status: 200 })
    expect(h.count(BudgetApi.requests, { status: "200" })).toBe(1)
    // Never who set them.
    expect(JSON.stringify(h.only("sandbox.limits"))).not.toContain("person-admin")

    expect((await set(h, { awake: 30, perPerson: 3, monthlyAlertUsd: 0 })).status).toBe(200)
    expect(await limits()).toEqual({ awake: 30, perPerson: 3, monthlyAlertUsd: 0 })
  })

  test.each([
    ["no machine awake", { awake: 0, perPerson: 1, monthlyAlertUsd: 1 }, 400, "invalid"],
    ["a person above their bound", { awake: 5, perPerson: 101, monthlyAlertUsd: 1 }, 400, "invalid"],
    ["a negative alert", { awake: 5, perPerson: 1, monthlyAlertUsd: -1 }, 400, "invalid"],
    ["a fraction", { awake: 2.5, perPerson: 1, monthlyAlertUsd: 1 }, 400, "invalid"],
    ["a missing limit", { awake: 5, perPerson: 1 }, 400, "invalid"],
    ["a body that isn't JSON", "{", 400, "invalid"],
    ["a body that isn't UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 400, "invalid"],
    ["a body over 1 KiB", { awake: 5, perPerson: 1, monthlyAlertUsd: 1, pad: "x".repeat(2_000) }, 413, "too_large"],
  ] as const)("refuses %s, writing nothing", async (_, body, status, code) => {
    const { h } = await open(admin)

    const response = await set(h, body)

    expect([response.status, await response.json()]).toEqual([status, { code }])
    expect(await limits()).toEqual({ awake: 20, perPerson: 2, monthlyAlertUsd: 100 })
  })

  test.each([
    ["signed out", null, 401, "authentication"],
    ["a Member", member, 403, "forbidden"],
    ["an agent acting for an Admin", agentForAdmin, 403, "person_only"],
  ] as const)("refuses %s", async (_, actor, status, code) => {
    const { h } = await open(actor)

    const response = await set(h, { awake: 1, perPerson: 1, monthlyAlertUsd: 1 })

    expect([response.status, await response.json()]).toEqual([status, { code }])
    expect(await limits()).toEqual({ awake: 20, perPerson: 2, monthlyAlertUsd: 100 })
    expect(h.only("sandbox.limits")).toMatchObject({ level: "WARN", annotations: { status } })
  })

  test("405 for another method", async () => {
    const { h } = await open(admin)

    const response = await h.fetch("/api/sandbox-limits")

    expect([response.status, response.headers.get("allow")]).toEqual([405, "POST"])
    expect(h.count(BudgetApi.requests, { status: "405" })).toBe(1)
  })

  test("503 with the database's code when Postgres fails, as an Error line", async () => {
    class Unreachable extends Data.TaggedError("Unreachable")<{}> {}
    const { h } = await open(admin, { database: Layer.effect(SqlClient.SqlClient, Effect.fail(new Unreachable())) })

    const response = await set(h, { awake: 1, perPerson: 1, monthlyAlertUsd: 1 })

    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(h.only("sandbox.limits")).toMatchObject({ level: "ERROR", annotations: { status: 503 } })
  })
})

describe("the limits' shape", () => {
  test("an Admin syncs the limits, with the columns the device keeps", async () => {
    const { h, upstream } = await open(admin)
    await set(h, { awake: 4, perPerson: 2, monthlyAlertUsd: 50 })

    const rows = await values(await h.fetch("/api/shapes/sandbox-limits?offset=-1"))

    expect(rows).toEqual([{
      audience: "admin",
      awake: "4",
      awake_per_person: "2",
      monthly_alert_usd: "50",
      updated_at: expect.any(String),
    }])
    expect(upstream.map((url) => Object.fromEntries(url.searchParams))).toEqual([{
      offset: "-1",
      table: "sandbox_limits",
      where: "audience = $1",
      "params[1]": "admin",
      columns: SANDBOX_LIMIT_COLUMNS.join(","),
    }])
    expect(h.count(BudgetApi.shapes, { status: "200", live: "false" })).toBe(1)
  })

  test.each([
    ["a Member", member],
    ["an agent acting for an Admin", agentForAdmin],
    ["a signed-out request", null],
  ] as const)("%s is refused without calling Electric", async (_, actor) => {
    const { h, upstream } = await open(actor)

    const response = await h.fetch("/api/shapes/sandbox-limits?offset=-1")

    expect(response.status).toBe(403)
    expect(upstream).toEqual([])
  })
})
