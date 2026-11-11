// Spend alerts end to end on the server (docs/features/spend-alerts.md): a call to the model endpoint starts its
// window's `ops/SpendAlert`, the flow runs on the Node host (worker/test/flowHost.ts) and records the alert, and
// `GET /api/shapes/spend-alerts` syncs it to an Admin through the compose Electric, and to nobody else. Only the model
// is scripted.
import { Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { SPEND_ALERT_COLUMNS } from "../src/features/spend/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "./Actor.vibe"
import * as SpendAlert from "./flows/SpendAlert.ts"
import * as SpendAlerts from "./SpendAlerts.vibe"
import { runFlow } from "./test/flowHost.ts"
import { delta, eventually, harness, stop, testFile, usage } from "./test/harness.ts"

const runtime = testFile("spend_alerts")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE model_usage, model_budget_days, spend_alerts`),
  )
)

const admin: Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const agentForAdmin: Actor = { ...admin, act: { kind: "agent", id: "agent-run-1" } }

const scratch = () =>
  runtime.runPromise(Effect.gen(function* () {
    return yield* TestDatabase.Scratch
  }))

/** ChatApi as `actor`, its Electric requests recorded and pointed at this file's schema. */
const open = async (actor: Actor | null, config: Record<string, string> = {}) => {
  const { name } = await scratch()
  const upstream: Array<URL> = []
  const h = await harness(runtime, () => Stream.make(delta("answer"), usage, stop), {
    ...(actor === null ? {} : { actor }),
    config,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      upstream.push(new URL(url))
      if (url.searchParams.get("table") === "spend_alerts") url.searchParams.set("table", `${name}.spend_alerts`)
      return fetch(url, init)
    },
  })
  return { h, upstream }
}

/** The rows a shape response carries. */
const values = async (response: Response) =>
  ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
    row.value === undefined ? [] : [row.value]
  )

describe("GET /api/shapes/spend-alerts", () => {
  test("a call starts its window's alert; once the window ends the flow records it, and an Admin syncs it", async () => {
    const { h, upstream } = await open(admin, { MODEL_SPEND_ALERT_WINDOW: "1 second" })
    const call = await h.fetch("/api/model/agent", {
      method: "POST",
      body: JSON.stringify({
        modelId: "m",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        params: {},
      }),
    })
    await call.text()
    expect(call.status).toBe(200)
    const [start] = h.starts
    expect(start).toMatchObject({ flow: "ops/SpendAlert" })
    const window = start!.payload as SpendAlert.Window

    const ran = await runFlow(SpendAlert.SpendAlert, window, SpendAlert.registration((await scratch()).database), {
      executionId: start!.executionId,
    })
    expect(ran.status).toBe("completed")

    const response = await h.fetch("/api/shapes/spend-alerts?offset=-1&where=true&columns=audience")
    expect(response.status).toBe(200)
    const [alert] = await values(response)
    // The scripted model reports 12 input and 34 output tokens; `test-model` has no price. Electric's wire carries
    // every value as text; its client parses them.
    expect(alert).toMatchObject({
      id: start!.executionId,
      kind: "model",
      calls: "1",
      tokens: "46",
      cost_usd: null,
      budget: "1000000",
    })
    expect(JSON.parse(alert!.roles as string)).toEqual([{ role: "agent", calls: 1, tokens: 46, costUsd: null }])
    expect(alert).not.toHaveProperty("audience")
    expect(Object.fromEntries(upstream[0]!.searchParams)).toEqual({
      offset: "-1",
      table: "spend_alerts",
      where: "audience = $1",
      "params[1]": "admin",
      columns: SPEND_ALERT_COLUMNS.join(","),
    })
    await eventually(() => h.line("spend.alerts.shape").length === 1)
    expect(h.count(SpendAlerts.shapes, { status: "200", live: "false" })).toBe(1)
  })

  test("a Member, an agent acting for an Admin, and a signed-out request are refused without calling Electric", async () => {
    for (const actor of [member, agentForAdmin, null]) {
      const { h, upstream } = await open(actor)
      const response = await h.fetch("/api/shapes/spend-alerts?offset=-1")
      expect(response.status).toBe(403)
      expect(response.headers.get("retry-after")).toBeNull()
      expect(upstream).toEqual([])
      await response.body?.cancel()
    }
  })

  test("when who is asking can't be read, the request is refused 503 and Electric is never asked", async () => {
    const upstream: Array<string> = []
    const h = await harness(runtime, () => Stream.empty, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
      fetch: async (input) => {
        upstream.push(String(input))
        return new Response(null, { status: 500 })
      },
    })
    const response = await h.fetch("/api/shapes/spend-alerts?offset=-1&handle=h-1")
    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"])
    expect(upstream).toEqual([])
  })
})
