// Model spend at the metered model endpoint (worker/ModelSpend.ts, docs/features/spend-alerts.md), through ChatApi's
// routes on this file's schema of the compose Postgres. The model provider is the only scripted seam. Remote flow starts
// go to the harness's recording `FlowStarter` unless a test gives a failing one, as the host refusing a start.
import type { ModelEvent } from "@smthrs/model"
import { ConfigProvider, Duration, Effect, Exit, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import type { Actor } from "./Actor.vibe"
import * as Flows from "./Flows.vibe"
import * as SpendAlert from "./flows/SpendAlert.ts"
import * as ModelSpend from "./ModelSpend.ts"
import { delta, harness, stop, testFile } from "./test/harness.ts"

const runtime = testFile("model_spend")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE model_roles, model_usage, model_budget_days`),
  )
)

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const body = JSON.stringify({
  modelId: "browser-choice",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  params: { maxTokens: 100 },
})

/** A model that answers, reports `usage` and stops. */
const reporting = (usage: Omit<Extract<ModelEvent.ModelEvent, { type: "usage" }>, "type">) => () =>
  Stream.make(delta("answer"), { type: "usage", ...usage } as ModelEvent.ModelEvent, stop)

type Harness = Awaited<ReturnType<typeof harness>>

/** One call to the endpoint, read to its end: its status. */
const ask = async (h: Harness, role = "agent") => {
  const response = await h.fetch(`/api/model/${role}`, { method: "POST", body })
  await response.text()
  return response.status
}

const alertStarts = (h: Harness) => h.starts.filter((start) => start.flow === "ops/SpendAlert")

describe("what each call spent", () => {
  test("tokens and estimated cost by role and model, one model.spend line each, with no content", async () => {
    const h = await harness(runtime, reporting({ inputTokens: 12, outputTokens: 34 }), {
      actor: member,
      modelId: "qwen-3.8-27b",
    })
    expect(await ask(h)).toBe(200)
    expect(await ask(h, "renderer")).toBe(200)

    // qwen-3.8-27b: $0.99 a million input tokens and $1.49 a million output (`Pricing.table` in @smthrs/model).
    const cost = (12 * 0.99 + 34 * 1.49) / 1_000_000
    for (const role of ["agent", "renderer"]) {
      expect(h.count(ModelSpend.tokens, { role, model: "qwen-3.8-27b" })).toBe(46)
      expect(h.count(ModelSpend.usd, { role, model: "qwen-3.8-27b" })).toBeCloseTo(cost, 12)
    }
    expect(h.line("model.spend").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ role: "agent", modelId: "qwen-3.8-27b", tokens: 46, costSource: "estimated" }),
      expect.objectContaining({ role: "renderer", modelId: "qwen-3.8-27b", tokens: 46, costSource: "estimated" }),
    ])
    expect(h.line("model.spend")[0]!.annotations.costUsd).toBeCloseTo(cost, 12)
    expect(JSON.stringify(h.line("model.spend"))).not.toContain("hello")
  })

  test("a provider's own charge wins; an unpriced model counts its tokens and no cost; no usage records nothing", async () => {
    const charged = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1, costUsd: 0.25 }), {
      actor: member,
      modelId: "qwen-3.8-27b",
    })
    await ask(charged)
    expect(charged.count(ModelSpend.usd, { role: "agent", model: "qwen-3.8-27b" })).toBe(0.25)
    expect(charged.only("model.spend").annotations).toMatchObject({ costUsd: 0.25, costSource: "reported" })

    const unpriced = await harness(runtime, reporting({ inputTokens: 5, outputTokens: 6 }), { actor: member })
    await ask(unpriced)
    expect(unpriced.count(ModelSpend.tokens, { role: "agent", model: "test-model" })).toBe(11)
    expect(unpriced.count(ModelSpend.usd, { role: "agent", model: "test-model" })).toBe(0)
    expect(unpriced.only("model.spend").annotations).not.toHaveProperty("costUsd")

    const silent = await harness(runtime, () => Stream.make(delta("answer"), stop), { actor: member })
    await ask(silent)
    expect(silent.line("model.spend")).toEqual([])
  })
})

describe("spend alerts", () => {
  test("production's default is on: an admitted call starts its window's alert once, with the window and budget", async () => {
    // No setting and no dev default: what a deploy runs.
    const h = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), { actor: member })
    const before = Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW)
    expect(await ask(h)).toBe(200)
    expect(await ask(h)).toBe(200)
    expect(await ask(h, "judge")).toBe(200)
    const after = Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW)

    // One start per window this isolate saw: one, unless the calls straddled a window's end.
    const windows = before.from === after.from ? [before] : [before, after]
    expect(alertStarts(h)).toEqual(windows.map((window) => ({
      flow: "ops/SpendAlert",
      executionId: SpendAlert.executionId(window),
      payload: { ...window, budget: 1_000_000 },
    })))
    expect(before.until - before.from).toBe(15 * 60 * 1000)
  })

  test("a call that is refused starts no alert: signed out, or today's budget spent", async () => {
    const signedOut = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }))
    expect(await ask(signedOut)).toBe(401)
    expect(alertStarts(signedOut)).toEqual([])

    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO model_budget_days (day, committed) VALUES ((now() AT TIME ZONE 'UTC')::date, 50)`))
    const spent = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), {
      actor: member,
      config: { MODEL_DAILY_TOKEN_BUDGET: "50" },
    })
    expect(await ask(spent)).toBe(429)
    expect(alertStarts(spent)).toEqual([])
  })

  test("the dev stack turns alerts off, MODEL_SPEND_ALERTS turns them back on, and off in a deploy's environment", async () => {
    const dev = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), {
      actor: member,
      spendAlerts: false,
    })
    expect(await ask(dev)).toBe(200)
    expect(alertStarts(dev)).toEqual([])

    const devOn = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), {
      actor: member,
      spendAlerts: false,
      config: { MODEL_SPEND_ALERTS: "true" },
    })
    expect(await ask(devOn)).toBe(200)
    expect(alertStarts(devOn)).toHaveLength(1)

    const off = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), {
      actor: member,
      config: { MODEL_SPEND_ALERTS: "false" },
    })
    expect(await ask(off)).toBe(200)
    expect(alertStarts(off)).toEqual([])
    // Spend is still recorded with alerts off.
    expect(off.count(ModelSpend.tokens, { role: "agent", model: "test-model" })).toBe(2)
  })

  test("MODEL_SPEND_ALERT_WINDOW sets the window", async () => {
    const h = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), {
      actor: member,
      config: { MODEL_SPEND_ALERT_WINDOW: "1 hour" },
    })
    await ask(h)
    const [start] = alertStarts(h)
    const payload = start!.payload as SpendAlert.Window
    expect(payload.until - payload.from).toBe(3_600_000)
    expect(payload.from % 3_600_000).toBe(0)
    expect(start!.executionId).toBe(`spend-alert-3600000-${payload.from}`)
  })

  test("a start the host can't record is an Error line and a count; the call goes on, and the next call starts it", async () => {
    const attempts: Array<string> = []
    const starter = Flows.FlowStarter.of({
      start: (_flow, { executionId }) =>
        Effect.suspend(() => {
          attempts.push(executionId)
          return attempts.length === 1
            ? Effect.fail(new Flows.StartUnavailable({ errorCode: "object_unreachable" }))
            : Effect.void
        }),
    })
    const h = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), { actor: member, starter })
    const before = Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW)
    expect(await ask(h)).toBe(200)
    expect(h.only("model.spend.alert")).toMatchObject({
      level: "ERROR",
      annotations: { outcome: "not_started", errorCode: "object_unreachable" },
    })
    expect(h.count(SpendAlert.alerts, { outcome: "not_started" })).toBe(1)
    expect(await ask(h)).toBe(200)
    expect(await ask(h)).toBe(200)
    // The second call started it again; the third found it started in this isolate, unless a window ended between.
    if (Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW).from === before.from) {
      expect(attempts).toEqual([SpendAlert.executionId(before), SpendAlert.executionId(before)])
    }
    expect(h.line("model.spend.alert")).toHaveLength(1)
  })

  test("a start that dies is logged by its code too, never its message, and the call goes on", async () => {
    const starter = Flows.FlowStarter.of({ start: () => Effect.die(new Error("the object said something private")) })
    const h = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), { actor: member, starter })
    expect(await ask(h)).toBe(200)
    expect(h.only("model.spend.alert").annotations).toEqual({ outcome: "not_started", errorCode: "unknown" })
    expect(JSON.stringify(h.logs)).not.toContain("private")
  })

  test("a start that finds the window's alert already started counts as started", async () => {
    const attempts: Array<string> = []
    const starter = Flows.FlowStarter.of({
      start: (_flow, { executionId }) =>
        Effect.suspend(() => {
          attempts.push(executionId)
          return Effect.fail(new Flows.StartConflict())
        }),
    })
    const h = await harness(runtime, reporting({ inputTokens: 1, outputTokens: 1 }), { actor: member, starter })
    const before = Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW)
    expect(await ask(h)).toBe(200)
    expect(await ask(h)).toBe(200)
    if (Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW).from === before.from) {
      expect(attempts).toEqual([SpendAlert.executionId(before)])
    }
    expect(h.line("model.spend.alert")).toEqual([])
  })
})

describe("the settings", () => {
  const read = (env: Record<string, string>, defaults: { readonly on?: boolean } = {}) =>
    Effect.runPromiseExit(
      ModelSpend.settings(defaults).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      ),
    )

  test("on with a 15-minute window unless set; a window under a second or without end is refused", async () => {
    expect(await read({})).toEqual(Exit.succeed({ on: true, window: Duration.minutes(15) }))
    expect(await read({}, { on: false })).toEqual(Exit.succeed({ on: false, window: Duration.minutes(15) }))
    expect(await read({ MODEL_SPEND_ALERTS: "on", MODEL_SPEND_ALERT_WINDOW: "5 minutes" }, { on: false })).toEqual(
      Exit.succeed({ on: true, window: Duration.minutes(5) }),
    )
    expect(Exit.isFailure(await read({ MODEL_SPEND_ALERT_WINDOW: "500 millis" }))).toBe(true)
    expect(Exit.isFailure(await read({ MODEL_SPEND_ALERT_WINDOW: "Infinity" }))).toBe(true)
    expect(Exit.isFailure(await read({ MODEL_SPEND_ALERTS: "maybe" }))).toBe(true)
  })
})
