// A person's own models on the tab (docs/features/personal-model.md#the-settings-section), driven as React drives it:
// the personal model layer's plain actions and its live queries, with no React. Each tab runs the browser's own layer
// (`appLayer`) on a Node device (src/test/chatApi.ts) against ChatApi's real handler over the compose Postgres and
// Electric, and its device's engine runs `model/test` and `model/remove` as a browser's leading engine worker does.
// Unhappy paths give the tab a faulty `PersonalModelClient` (the real one behind switches) or a faulty engine
// (test.faults-by-injection).
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Collection } from "@smthrs/effect-tanstack-db"
import { type Duration, Effect, Layer, Logger, type ManagedRuntime, Metric } from "effect"
import { SqlClient } from "effect/sql"
import type { HttpClient } from "effect/http"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.vibe"
import { leaks } from "../../../worker/personal/test/harness.ts"
import { ANTHROPIC_ORIGIN, OPENAI_ORIGIN, type Reply } from "../../../worker/personal/test/provider.ts"
import { dispatches } from "../../flows/dispatch"
import {
  CHATAPI_ORIGIN,
  member,
  nodeDevice,
  type NodeDevice,
  openFaultyApp,
  openTab,
  openTestApi,
  TestChatApi,
} from "../../test/chatApi"
import { EngineFaults } from "../../test/faults"
import { AuthStore, SESSION } from "../auth/store"
import { MODEL_TIERS } from "../model/contract"
import { save } from "./actions"
import { ModelNotTaken, PersonalModelClient } from "./api"
import { keyTail, MAX_CONNECTIONS, PERSONAL_MODEL_SHAPE_ROUTE, resolveTier } from "./contract"
import { writes } from "./metrics"
import { PersonalModel } from "./personalModel"
import { PersonalModelStore } from "./store"
import { answers, listOf, rowStatusOf, type SaveForm, statusOf } from "./view"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long Electric or a flow may take on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: a fresh device, its sign-in, its engine and its first syncs, on a loaded machine. */
const WITHIN = 90_000

/** The key a test saves: every form of it is searched for wherever the device keeps anything. */
const KEY = "sk-test-SENTINEL/+=\"personal\"~key"
const ROTATED = `${KEY}-rotated`

const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }

/**
 * A faulty `PersonalModelClient`: the real one, behind switches, counting the saves that reach it. `hold` never
 * answers; `network` fails before sending, as no answer does; `gateway` answers a 502 with no code; `lost` sends, then
 * loses the answer; `taken` answers 202 and sends nothing.
 */
type Fault = "hold" | "network" | "gateway" | "lost" | "taken"
const faultyClient = () => {
  const state = {
    next: [] as Array<Fault>,
    puts: 0,
    /** What Link answers: OpenAI's device code is the one thing here no test may reach. */
    link: Effect.succeed({ userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device", expiresInSeconds: 900 }) as PersonalModelClient["Service"]["link"],
    links: 0,
  }
  const layer = Layer.effect(
    PersonalModelClient,
    Effect.map(PersonalModelClient, (real) =>
      PersonalModelClient.of({
        ...real,
        link: Effect.suspend(() => {
          state.links++
          return state.link
        }),
        put: (put) =>
          Effect.suspend(() => {
            state.puts++
            switch (state.next.shift()) {
              case undefined:
                return real.put(put)
              case "hold":
                return Effect.never
              case "network":
                return Effect.fail(new ModelNotTaken({}))
              case "gateway":
                return Effect.fail(new ModelNotTaken({ status: 502 }))
              case "lost":
                return Effect.andThen(real.put(put), Effect.fail(new ModelNotTaken({})))
              case "taken":
                return Effect.void
            }
          }),
      })),
  ).pipe(Layer.provide(PersonalModelClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
  return { layer, state }
}

type Tab = ManagedRuntime.ManagedRuntime<PersonalModel | PersonalModelStore | AuthStore, unknown>

/**
 * A tab signed in as `actor` (a Member unless set, `null` signed out) on a fresh ChatApi whose people's provider
 * answers `provider`, its device's engine running the flows a press dispatches, and the section's queries started as
 * React starts them. `api` and `device` reopen a device a test kept (a reload); `fetch` sees the tab's requests.
 */
const open = async (
  options: {
    readonly actor?: Actor | null
    readonly provider?: Reply | ((index: number) => Reply)
    readonly replace?: Layer.Layer<PersonalModelClient, never, HttpClient.HttpClient>
    readonly confirmWithin?: Duration.Input
    readonly api?: TestChatApi["Service"]
    readonly device?: NodeDevice
    readonly fetch?: (api: TestChatApi["Service"]) => typeof globalThis.fetch
  } = {},
) => {
  const api = options.api ?? await (async () => {
    const app = openTestApi({
      actor: options.actor === undefined ? member : options.actor,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    })
    runtimes.push(app)
    return app.runPromise(Effect.service(TestChatApi))
  })()
  const file = join(tmpdir(), `mvp-personal-model-${crypto.randomUUID()}.sqlite`)
  const outbox = new Map<string, string>()
  const device = options.device ?? nodeDevice({ agent: api, file, outboxEntries: outbox })
  const runtime: Tab = openTab(options.fetch === undefined ? api : { ...api, fetch: options.fetch(api) }, {
    host: device,
    ...(options.replace === undefined ? {} : { replace: options.replace }),
    ...(options.confirmWithin === undefined ? {} : { confirmWithin: options.confirmWithin }),
  })
  runtimes.push(runtime)
  const tab = await bind(runtime, options.actor === null ? "signed_out" : "signed_in")
  return {
    api,
    device,
    runtime,
    ...tab,
    /** Everything this device keeps: its SQLite files, its outbox, and every row the section's queries show. */
    kept: () =>
      [
        ...["", "-wal", "-shm", "-journal"].flatMap((suffix) =>
          existsSync(`${file}${suffix}`) ? [readFileSync(`${file}${suffix}`).toString("latin1")] : []
        ),
        JSON.stringify([...outbox]),
        JSON.stringify(Object.values(tab.queries).map((query) => query.toArray)),
      ].join("\n"),
  }
}

/** The section on `runtime` once sign-in says `status`, as React reads it. */
const bind = async (
  runtime: ManagedRuntime.ManagedRuntime<PersonalModel | PersonalModelStore | AuthStore, unknown>,
  status: "signed_in" | "signed_out" = "signed_in",
) => {
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).toBe(status))
  const { queries, actions } = await runtime.runPromise(Effect.service(PersonalModel))
  for (const query of Object.values(queries)) query.startSyncImmediate()
  return {
    actions,
    queries,
    session: () => session.tanstack.get(SESSION),
    rows: () => queries.saved.toArray,
    /** The saved connection of `protocol`, OpenAI-compatible unless named. */
    row: (protocol = "openai-chat") => queries.saved.toArray.find((row) => row.protocol === protocol),
    form: () => queries.form.toArray[0],
    test: () => queries.test.toArray[0],
    add: () => queries.add.toArray[0]?.view,
    link: () => queries.link.toArray[0],
    status: () => statusOf(queries.form.toArray[0], queries.test.toArray[0]),
    /** The refusal line of the saved connection of `protocol`. */
    line: (protocol = "openai-chat") =>
      rowStatusOf(queries.saved.toArray.find((row) => row.protocol === protocol)!, queries.test.toArray[0]),
    count: (attributes: Record<string, string>) => runtime.runSync(Metric.value(Metric.withAttributes(writes, attributes))).count,
    dispatched: (flow: string, outcome: string) =>
      runtime.runSync(Metric.value(Metric.withAttributes(dispatches, { flow, door: "button", outcome }))).count,
  }
}

/** A save of one API key, Fast named `model` on it (none when `""`), every other tier falling back to it. */
const one = (protocol: string, baseUrl: string, model: string, key: string): SaveForm => ({
  connections: [{ kind: "api_key", protocol, baseUrl, key, ...(model === "" ? {} : { models: { fast: model } }) }],
})

/** The scripted OpenAI-compatible provider, as a person types it: its `/v1` goes, as the protocol's path follows. */
const SCRIPTED = (key: string) => one("openai-chat", `${OPENAI_ORIGIN}/v1/`, "gpt-test", key)

const OPENAI = (key: string) => one("openai-chat", "https://api.openai.com/v1/", "gpt-5", key)

/** Both scripted providers' keys: Implement on the OpenAI-compatible one, Fast and Hard on the Anthropic-compatible. */
const BOTH = (openai: string, anthropic: string): SaveForm => ({
  connections: [
    { kind: "api_key", protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, key: openai, models: { implement: "gpt-test" } },
    { kind: "api_key", protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, key: anthropic, models: { fast: "claude-test", hard: "claude-hard" } },
  ],
})

/** A Codex connection in Postgres, as `model/CodexLink` writes one once the person approves. */
const linkedRow = (tab: Awaited<ReturnType<typeof open>>, id: string) =>
  Effect.runPromise(tab.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO personal_models (person_id, id, kind, position, active, ciphertext, nonce, key_version, key_last4)
    VALUES ('person-member', ${id}, 'codex_subscription', 0, true, 'sealed', 'nonce', 1, 'zzzz')`)))

describe("Save on the tab", () => {
  test("refuses on the tab what ChatApi would, with its code, and sends nothing", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    const refused = (form: SaveForm) => {
      expect(tab.actions.save(form)).toBe(false)
      return tab.form()?.failure
    }
    expect(refused(one("gpt", "https://api.openai.com", "gpt-5", KEY))).toBe("invalid_protocol")
    expect(refused(one("openai-chat", "http://api.openai.com", "gpt-5", KEY))).toBe("invalid_base_url")
    expect(refused(one("openai-chat", "https://localhost", "gpt-5", KEY))).toBe("invalid_base_url")
    expect(refused(one("openai-chat", "https://api.openai.com:8443", "gpt-5", KEY))).toBe("invalid_base_url")
    expect(refused(one("anthropic-messages", "https://api.anthropic.com", "claude 5", KEY))).toBe("invalid_model")
    expect(refused(one("anthropic-messages", "https://api.anthropic.com", "  ", KEY))).toBe("invalid_model")
    expect(refused(one("anthropic-messages", "https://api.anthropic.com", "-claude", KEY))).toBe("invalid_model")
    expect(refused(one("anthropic-messages", "https://api.anthropic.com", "c".repeat(82), KEY))).toBe("invalid_model")
    // An empty key keeps a saved one, and none is saved here.
    expect(refused(OPENAI(""))).toBe("key_required")
    // Eight bytes, but four characters: all of it would show as its last four.
    expect(refused(OPENAI("éééé"))).toBe("too_short")
    expect(refused(OPENAI("x".repeat(15)))).toBe("too_short")
    // A Claude token by its prefix: the shape's refusal, before anything leaves the tab.
    expect(refused({ connections: [{ kind: "claude_subscription", key: "sk-ant-api03-not-a-token" }] })).toBe("invalid_token")
    expect(refused({ connections: [{ kind: "claude_subscription", key: "sk-ant-oat" }] })).toBe("too_short")
    // No connection, too many, a kind this build doesn't know, a tier this build doesn't know, or two active of a kind.
    expect(refused({ connections: [] })).toBe("invalid")
    expect(refused({ connections: Array.from({ length: MAX_CONNECTIONS + 1 }, () => OPENAI(KEY).connections[0]!) })).toBe("invalid")
    expect(refused({ connections: [{ kind: "gemini", key: KEY }] })).toBe("invalid")
    expect(refused({ connections: [{ ...OPENAI(KEY).connections[0]!, models: { cheap: "gpt-5" } }] })).toBe("invalid")
    expect(refused({ connections: [{ kind: "jev", key: KEY }, { kind: "jev", key: ROTATED }] })).toBe("invalid")
    expect(tab.form()).toMatchObject({ op: "save", state: "failed", sent: null, saved: 0 })
    expect(faulty.state.puts).toBe(0)
    expect(tab.count({ op: "put", outcome: "refused" })).toBe(18)
  }, WITHIN)

  test("no whole answer is an unknown outcome; a save on its way can't be sent twice, nor a test or a remove", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    faulty.state.next.push("network")
    expect(tab.actions.save(OPENAI(KEY))).toBe(true)
    // What it sent: the base URL as ChatApi keeps it and the tiers' models; never the key.
    await until(() => expect(tab.form()).toMatchObject({ state: "unknown", failure: null, saved: 0 }))
    expect(tab.form()?.sent).toEqual({
      connections: [{ id: null, kind: "api_key", active: true, protocol: "openai-chat", baseUrl: "https://api.openai.com", models: { fast: "gpt-5" } }],
    })
    expect(tab.count({ op: "put", outcome: "unknown" })).toBe(1)

    faulty.state.next.push("hold")
    expect(tab.actions.save(one("anthropic-messages", "https://api.anthropic.com", " claude-5 ", KEY))).toBe(true)
    expect(tab.form()).toMatchObject({ state: "sending", sent: { connections: [{ models: { fast: "claude-5" } }] } })
    expect(tab.actions.save(OPENAI(KEY))).toBe(false)
    expect(tab.actions.test()).toBe(false)
    expect(tab.actions.removeAll()).toBe(false)
    expect(faulty.state.puts).toBe(2)
  }, WITHIN)

  test("a save ChatApi took clears the key; one the row doesn't show within the deadline says it hasn't yet", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer, confirmWithin: "2 seconds" })
    faulty.state.next.push("taken")
    expect(tab.actions.save(OPENAI(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "confirming", saved: 1 }))
    const taken = Date.now()
    await until(() => expect(tab.form()).toMatchObject({ state: "late", saved: 1 }), 15_000)
    expect(Date.now() - taken).toBeGreaterThanOrEqual(1_500)
    expect(tab.count({ op: "put", outcome: "started" })).toBe(1)
    expect(tab.count({ op: "put", outcome: "late" })).toBe(1)
    // A later save's deadline is its own: the earlier one, passing meanwhile, changes nothing.
    faulty.state.next.push("taken")
    expect(tab.actions.save(OPENAI(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "confirming", saved: 2 }))
  }, WITHIN)
})

describe("a form write the device refuses", () => {
  test("after a save ChatApi took is a defect, logged once as app.unhandled with its code", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    faulty.state.next.push("taken")
    const store = await tab.runtime.runPromise(Effect.service(PersonalModelStore))
    // The device refuses every update of the form's row, as only a bug in its key or schema would.
    const refusing = PersonalModelStore.of({
      ...store,
      form: { ...store.form, update: () => Effect.fail(new Collection.MutationRefused({ operation: "update", cause: "refused" })) },
    })
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const saved = save(SCRIPTED(KEY)).pipe(
      Effect.provideService(PersonalModelStore, refusing),
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
    ) as unknown as Effect.Effect<boolean>
    expect(await tab.runtime.runPromise(saved)).toBe(true)
    await until(() =>
      expect(logs.filter((log) => log.message === "app.unhandled")).toEqual([expect.objectContaining({
        level: "ERROR",
        annotations: expect.objectContaining({ feature: "personal-model", boundary: "fork", kind: "defect", "error.type": "MutationRefused" }),
      })])
    )
    expect(JSON.stringify(logs)).not.toContain(KEY)
  }, WITHIN)
})

describe("an engine that can't run Test or Remove", () => {
  test("says it's unavailable, to be tried again", async () => {
    const runtime = openFaultyApp({ answers: false })
    runtimes.push(runtime)
    const engine = await runtime.runPromise(Effect.service(EngineFaults))
    const tab = await bind(runtime)
    // A test the engine hasn't recorded yet runs: a second waits.
    await runtime.runPromise(Effect.andThen(engine.refuseStarts("model/remove"), engine.holdStarts))
    expect(tab.actions.test()).toBe(true)
    expect(tab.test()).toMatchObject({ state: "testing", result: null })
    expect(tab.actions.test()).toBe(false)
    expect(tab.actions.removeAll()).toBe(true)
    // A write forgets the last test, which was about the model before it.
    expect(tab.test()).toBeUndefined()
    await until(() => expect(tab.form()).toMatchObject({ op: "remove", state: "failed", failure: "unavailable" }))
    // A test takes the status line from the last write's outcome.
    await runtime.runPromise(engine.refuseStarts("model/test"))
    expect(tab.actions.test()).toBe(true)
    expect(tab.form()).toMatchObject({ state: "failed", quiet: true })
    await until(() => expect(tab.test()).toMatchObject({ state: "failed", failure: "unavailable", result: null }))
    expect(tab.actions.test()).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "failed", failure: "unavailable" }))
  }, WITHIN)
})

describe("a Member's own model, on ChatApi's real routes", () => {
  test("Save: Saving until the row shows it, the key clears, Save again replaces it; the key is kept nowhere", async () => {
    const tab = await open({ confirmWithin: "3 seconds" })
    expect(tab.rows()).toEqual([])
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    expect(tab.status()).toEqual({ _tag: "Text", text: "Saving" })
    await until(() =>
      expect(tab.row()).toMatchObject({
        personId: "person-member",
        protocol: "openai-chat",
        baseUrl: OPENAI_ORIGIN,
        fastModel: "gpt-test",
        implementModel: null,
        hardModel: null,
        keyLast4: keyTail(KEY),
        failureStatus: null,
        failedAt: null,
      })
    )
    // ChatApi took it (`saved` keys the form, so the key field clears), and the row showed it.
    await until(() => expect(tab.form()).toMatchObject({ op: "save", state: "done", failure: null, saved: 1 }))
    expect(tab.status()).toEqual({ _tag: "None" })

    // Another provider, another key: Save replaces the configuration, and the key it left out goes.
    const before = tab.row()!.updatedAt
    expect(tab.actions.save(one("anthropic-messages", ANTHROPIC_ORIGIN, "claude-test", ROTATED))).toBe(true)
    await until(() =>
      expect(tab.rows()).toMatchObject([
        { protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, fastModel: "claude-test", keyLast4: keyTail(ROTATED) },
      ])
    )
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 2 }))
    expect(tab.row("anthropic-messages")!.updatedAt).not.toBe(before)
    // The deadlines passing after both landed change nothing.
    await tab.runtime.runPromise(Effect.sleep("3500 millis"))
    expect(tab.form()).toMatchObject({ state: "done", saved: 2 })
    expect([tab.count({ op: "put", outcome: "started" }), tab.count({ op: "put", outcome: "landed" })]).toEqual([2, 2])
    expect(tab.count({ op: "put", outcome: "late" })).toBe(0)

    // No collection row, no outbox entry and no stored byte holds either key, in any encoding; nor ChatApi's spans.
    await until(() => expect(tab.device.stored("personal-model")).toBe(1))
    expect(leaks(tab.kept(), [KEY, ROTATED])).toEqual([])
    expect(leaks(JSON.stringify(tab.api.spans.map((span) => [span.name, [...span.attributes]])), [KEY, ROTATED])).toEqual([])
    // Every log line, span and metric the tab exported, once the runtime closes and its exporter flushes: the records,
    // and never a key, a base URL or a model id.
    const { telemetry } = tab.api
    await tab.runtime.dispose()
    runtimes.splice(runtimes.indexOf(tab.runtime), 1)
    const exported = telemetry.map((request) => request.body).join("\n")
    expect(exported).toContain("personal_model.put")
    expect(exported).toContain("smithers_web_personal_model_writes")
    expect(leaks(exported, [KEY, ROTATED])).toEqual([])
    for (const leaked of ["models.example.com", "anthropic.example.com", "gpt-test", "claude-test"]) {
      expect(exported).not.toContain(leaked)
    }
  }, WITHIN)

  test("two connections: each tier lands on its own; an empty key keeps the saved one; a new base URL needs its key", async () => {
    const tab = await open({ provider: { text: "ok" } })
    expect(tab.actions.save(BOTH(KEY, ROTATED))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ op: "save", state: "done", saved: 1 }))
    expect(tab.rows()).toMatchObject([
      { kind: "api_key", position: 0, active: true, protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, fastModel: null, implementModel: "gpt-test", hardModel: null, keyLast4: keyTail(KEY) },
      { kind: "api_key", position: 1, active: true, protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, fastModel: "claude-test", implementModel: null, hardModel: "claude-hard", keyLast4: keyTail(ROTATED) },
    ])
    expect(MODEL_TIERS.map((tier) => resolveTier(tab.rows(), tier)?.modelId)).toEqual(["claude-test", "gpt-test", "claude-hard"])

    // Both keys kept without typing them again.
    const [first, second] = listOf(tab.rows())
    expect(tab.actions.save({ connections: [{ ...first!, baseUrl: `${OPENAI_ORIGIN}/v1`, models: { fast: "gpt-test" } }, { ...second!, models: {} }] })).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 2 }))
    expect(tab.rows()).toMatchObject([
      { protocol: "openai-chat", fastModel: "gpt-test", implementModel: null, hardModel: null, keyLast4: keyTail(KEY) },
      { protocol: "anthropic-messages", fastModel: null, implementModel: null, hardModel: null, keyLast4: keyTail(ROTATED) },
    ])
    // The kept key still answers, with the key typed the first time.
    expect(tab.actions.test(tab.row()!.id)).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "done", result: { ok: true } }))
    expect(tab.api.providerCalls.map((call) => [new URL(call.url).origin, call.headers.get("authorization")]))
      .toContainEqual([OPENAI_ORIGIN, `Bearer ${KEY}`])

    // A saved key never goes to another base URL unless typed again.
    expect(tab.actions.save({ connections: [{ ...first!, baseUrl: "https://other.example.com" }] })).toBe(false)
    expect(tab.form()).toMatchObject({ state: "failed", failure: "key_required" })
    expect(leaks(tab.kept(), [KEY, ROTATED])).toEqual([])
  }, WITHIN)

  test("a list: Add goes last, Move reorders, Active turns routing off, Remove takes one and the last through its flow", async () => {
    const tab = await open()
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 1 }))
    const openai = tab.row()!.id

    // Kimi K3: just a key; the server fills in its endpoint and models, and the dialog closes once ChatApi takes it.
    tab.actions.showAdd("moonshot")
    expect(tab.add()).toBe("moonshot")
    expect(tab.actions.add({ kind: "moonshot", key: ROTATED })).toBe(true)
    await until(() => expect(tab.add()).toBe("closed"))
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 2, adding: true }))
    expect(tab.rows()).toMatchObject([
      { id: openai, kind: "api_key", keyLast4: keyTail(KEY) },
      { kind: "moonshot", protocol: "openai-chat", baseUrl: "https://api.moonshot.ai", fastModel: "kimi-k3", hardModel: "kimi-k3", keyLast4: keyTail(ROTATED) },
    ])
    const kimi = tab.rows()[1]!.id

    expect(tab.actions.move(kimi, -1)).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 3 }))
    expect(tab.rows().map(({ id, position }) => [id, position])).toEqual([[kimi, 0], [openai, 1]])

    expect(tab.actions.setActive(kimi, false)).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 4 }))
    expect(tab.rows().map(({ active }) => active)).toEqual([false, true])
    expect(resolveTier(tab.rows(), "fast")).toMatchObject({ connectionId: openai })
    expect(tab.actions.setActive(openai, false)).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 5 }))
    // Nothing active answers: the composer's gate is back.
    expect(answers(tab.rows())).toBe(false)

    expect(tab.actions.remove(kimi)).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 6 }))
    expect(tab.rows().map(({ id }) => id)).toEqual([openai])
    // A PUT can't leave nothing: the last goes through `model/remove`.
    expect(tab.actions.remove(openai)).toBe(true)
    expect(tab.form()).toMatchObject({ op: "remove", state: "sending" })
    await until(() => expect(tab.rows()).toEqual([]))
    await until(() => expect(tab.dispatched("model/remove", "done")).toBe(1))
    expect(leaks(tab.kept(), [KEY, ROTATED])).toEqual([])
  }, WITHIN)

  test("a Claude token saves, its kind answers no tier, and a second takes over from the first", async () => {
    const tab = await open()
    const token = `sk-ant-oat01-${KEY}`
    expect(tab.actions.add({ kind: "claude_subscription", key: "sk-ant-api03-not-a-token" })).toBe(false)
    expect(tab.status()).toMatchObject({ text: "Tokens start with sk-ant-oat" })
    expect(tab.actions.add({ kind: "claude_subscription", key: token })).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 1 }))
    expect(tab.rows()).toMatchObject([{ kind: "claude_subscription", protocol: null, baseUrl: null, active: true, keyLast4: keyTail(token) }])
    expect(answers(tab.rows())).toBe(false)
    expect(tab.actions.add({ kind: "claude_subscription", key: `${token}-2` })).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 2 }))
    expect(tab.rows().map(({ active }) => active)).toEqual([false, true])
    expect(leaks(tab.kept(), [token])).toEqual([])
  }, WITHIN)

  test("a write the tab can't confirm closes the dialog once the rows show it", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    tab.actions.showAdd("jev")
    faulty.state.next.push("lost")
    expect(tab.actions.add({ kind: "jev", key: KEY })).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 1 }))
    expect(tab.add()).toBe("closed")
  }, WITHIN)

  test("Link: the code until the connection arrives in the shape, then the dialog closes; a second link waits for the first", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    tab.actions.showAdd("codex_subscription")
    expect(tab.actions.link()).toBe(true)
    await until(() => expect(tab.link()).toMatchObject({ state: "waiting", userCode: "ABCD-EFGH", attempt: 1 }))
    expect(tab.actions.link()).toBe(false)
    expect(faulty.state.links).toBe(1)
    await linkedRow(tab, crypto.randomUUID())
    await until(() => expect(tab.link()).toMatchObject({ state: "done" }))
    expect(tab.add()).toBe("closed")
    expect(tab.rows()).toMatchObject([{ kind: "codex_subscription", keyLast4: "zzzz" }])
    expect([tab.count({ op: "link", outcome: "started" }), tab.count({ op: "link", outcome: "landed" })]).toEqual([1, 1])
    // It keeps its place in a list saved around it, with no key.
    expect(tab.actions.setActive(tab.rows()[0]!.id, false)).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done" }))
    expect(tab.rows()).toMatchObject([{ kind: "codex_subscription", active: false }])
  }, WITHIN)

  test("Link: one ChatApi hasn't answered yet can't be pressed again", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    faulty.state.link = Effect.never
    expect(tab.actions.link()).toBe(true)
    expect(tab.link()).toMatchObject({ state: "starting", attempt: 1 })
    expect(tab.actions.link()).toBe(false)
    expect(faulty.state.links).toBe(1)
  }, WITHIN)

  test("Link: a code that lapses says expired and Link may go again, whose deadline is its own; a refusal says why", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    faulty.state.link = Effect.succeed({ userCode: "LAPS-ED00", verificationUrl: "https://auth.openai.com/codex/device", expiresInSeconds: 1 })
    expect(tab.actions.link()).toBe(true)
    await until(() => expect(tab.link()).toMatchObject({ state: "expired", userCode: null }))
    expect(tab.count({ op: "link", outcome: "expired" })).toBe(1)

    // A link that landed before its deadline stays landed; the deadline passing while a later link waits changes nothing.
    faulty.state.link = Effect.succeed({ userCode: "LAND-ED00", verificationUrl: "https://auth.openai.com/codex/device", expiresInSeconds: 3 })
    expect(tab.actions.link()).toBe(true)
    await until(() => expect(tab.link()).toMatchObject({ state: "waiting", attempt: 2 }))
    await linkedRow(tab, crypto.randomUUID())
    await until(() => expect(tab.link()).toMatchObject({ state: "done", attempt: 2 }))
    faulty.state.link = Effect.succeed({ userCode: "LATE-R000", verificationUrl: "https://auth.openai.com/codex/device", expiresInSeconds: 900 })
    expect(tab.actions.link()).toBe(true)
    await until(() => expect(tab.link()).toMatchObject({ state: "waiting", attempt: 3 }))
    await tab.runtime.runPromise(Effect.sleep("3500 millis"))
    expect(tab.link()).toMatchObject({ state: "waiting", attempt: 3 })
    expect(tab.count({ op: "link", outcome: "expired" })).toBe(1)

    // The row a link waits on can't end but by Link's own answer; a fresh tab's refusals start from nothing held.
    const second = faultyClient()
    const refused = await open({ replace: second.layer })
    second.state.link = Effect.fail(new ModelNotTaken({ status: 502, code: "link_refused" }))
    expect(refused.actions.link()).toBe(true)
    await until(() => expect(refused.link()).toMatchObject({ state: "failed", failure: "link_refused" }))
    expect(refused.count({ op: "link", outcome: "refused" })).toBe(1)

    second.state.link = Effect.fail(new ModelNotTaken({}))
    expect(refused.actions.link()).toBe(true)
    await until(() => expect(refused.link()).toMatchObject({ state: "failed", failure: "unavailable" }))
    expect(refused.count({ op: "link", outcome: "unknown" })).toBe(1)
  }, WITHIN)

  test("a key at a provider's own host saves with no model named, and each tier shows the preset it uses", async () => {
    const tab = await open()
    expect(tab.actions.save(one("openai-chat", "https://api.openai.com/v1", "", KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 1 }))
    expect(tab.rows()).toMatchObject([
      { protocol: "openai-chat", baseUrl: "https://api.openai.com", fastModel: null, implementModel: null, hardModel: null },
    ])
    expect(MODEL_TIERS.map((tier) => resolveTier(tab.rows(), tier)?.modelId)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])
  }, WITHIN)

  test("ChatApi's refusal says why; no whole answer shows landed once the row has it", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    // A key ChatApi refuses, which the tab doesn't check: only ChatApi knows what a key may hold.
    expect(tab.actions.save(SCRIPTED(`${KEY}\n`))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "failed", failure: "control_character", saved: 0 }))
    expect(tab.status()).toEqual({ _tag: "Text", text: "Keys can't contain line breaks or control characters" })
    expect(tab.count({ op: "put", outcome: "refused" })).toBe(1)

    // A gateway's answer with no code: the outcome is unknown.
    faulty.state.next.push("gateway")
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "unknown", saved: 0 }))
    expect(tab.status()).toEqual({ _tag: "Text", text: "Couldn't confirm the save" })

    // ChatApi took it, and the answer was lost: once the row shows it, it landed.
    faulty.state.next.push("lost")
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 1 }))
    expect(tab.row()).toMatchObject({ keyLast4: keyTail(KEY) })
    expect([tab.count({ op: "put", outcome: "unknown" }), tab.count({ op: "put", outcome: "started" })]).toEqual([2, 1])
  }, WITHIN)

  test("Test draft guard: a list on screen that isn't the saved one never calls a provider; the saved one tests", async () => {
    let answer: Reply = { text: "ok" }
    const tab = await open({ provider: () => answer })
    // Without a prior write or test, validation still creates a visible refusal.
    expect(tab.actions.test(undefined, { connections: [] })).toBe(false)
    expect(tab.status()).toMatchObject({ text: "Your model wasn't saved" })
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done" }))
    const id = tab.row()!.id
    const saved = listOf(tab.rows())[0]!
    for (const baseUrl of ["not a url", "https://exa mple.test/v1"]) {
      expect(tab.actions.test(id, { connections: [{ ...saved, baseUrl }] })).toBe(false)
      expect(tab.line()).toMatchObject({ text: "Base URLs are https:// on a public host, with no port" })
    }
    expect(tab.actions.test(id, { connections: [{ ...saved, key: ROTATED }] })).toBe(false)
    expect(tab.line()).toMatchObject({ text: "Save first" })
    expect(tab.actions.test(id, { connections: [{ ...saved, models: { fast: "changed" } }] })).toBe(false)
    expect(tab.api.providerCalls).toHaveLength(0)
    expect(tab.count({ op: "test", outcome: "refused" })).toBe(5)
    expect(tab.kept()).not.toContain(ROTATED)
    expect(tab.actions.test(id, { connections: listOf(tab.rows()) })).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "done", result: { ok: true } }))
    expect(tab.api.providerCalls).toHaveLength(1)
    answer = { status: 401, error: { message: "Incorrect API key" } }
    expect(tab.actions.test(id, { connections: listOf(tab.rows()) })).toBe(true)
    await until(() => expect(tab.row()).toMatchObject({ failureStatus: 401 }))
    await until(() => expect(tab.test()).toMatchObject({ state: "done" }))
    expect(tab.actions.test(id, { connections: [{ ...saved, key: ROTATED }] })).toBe(false)
    expect(tab.line()).toMatchObject({ text: "Save first" })
  }, WITHIN)

  test("Test through its flow: OK; the provider's refusal, recorded on the row, shows on its row; OK clears it", async () => {
    let answer: Reply = { text: "ok" }
    const tab = await open({ provider: () => answer })
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done" }))

    const id = tab.row()!.id
    expect(tab.actions.test(id)).toBe(true)
    expect(tab.test()).toMatchObject({ state: "testing", connection: id })
    await until(() => expect(tab.test()).toMatchObject({ state: "done", result: { ok: true, sample: "ok" } }))
    expect(tab.line()).toEqual({ _tag: "Text", text: "OK" })
    expect(tab.api.providerCalls).toHaveLength(1)
    // The person's own key went to their own provider; the test took the status line, and the form kept its count.
    expect(tab.api.providerCalls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(tab.form()).toMatchObject({ state: "done", saved: 1, quiet: true })

    // The provider refuses the key: the test says so, and the row records it, which Settings shows.
    answer = { status: 401, error: { message: "Incorrect API key" } }
    expect(tab.actions.test(id)).toBe(true)
    await until(() =>
      expect(tab.test()).toMatchObject({ state: "done", result: { ok: false, status: 401, host: "models.example.com" } })
    )
    await until(() => expect(tab.row()).toMatchObject({ failureStatus: 401 }))
    // The row's line names the host and the status, from the test or the row, whichever is newer.
    expect(tab.line()).toMatchObject({ text: expect.stringMatching(/^models\.example\.com .*HTTP 401$/) })

    // It passes again: the row's failure clears.
    answer = { text: "ok again" }
    expect(tab.actions.test(id)).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "done", result: { ok: true, sample: "ok again" } }))
    await until(() => expect(tab.row()).toMatchObject({ failureStatus: null, failedAt: null }))
    expect(tab.dispatched("model/test", "done")).toBe(3)
  }, WITHIN)

  test("a save made while a test runs drops the test's answer, which was about the model before", async () => {
    const tab = await open()
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done" }))
    expect(tab.actions.test()).toBe(true)
    expect(tab.actions.save(SCRIPTED(ROTATED))).toBe(true)
    expect(tab.test()).toBeUndefined()
    await until(() => expect(tab.dispatched("model/test", "done")).toBe(1))
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 2 }))
    expect(tab.test()).toBeUndefined()
  }, WITHIN)

  test("Remove through its flow: the row goes; a test then says no model is saved", async () => {
    const tab = await open()
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 1 }))
    expect(tab.actions.removeAll()).toBe(true)
    expect(tab.form()).toMatchObject({ op: "remove", state: "sending" })
    await until(() => expect(tab.rows()).toEqual([]))
    await until(() => expect(tab.form()).toMatchObject({ op: "remove", state: "done", saved: 2 }))
    expect([tab.count({ op: "delete", outcome: "landed" }), tab.dispatched("model/remove", "done")]).toEqual([1, 1])
    // The agent may still call it: ChatApi says there's nothing to test.
    expect(tab.actions.test()).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "failed", failure: "none" }))
    expect(tab.status()).toEqual({ _tag: "Text", text: "No model saved" })
  }, WITHIN)
})

describe("who has a model of their own", () => {
  test("a Guest of the deployment's repository saves their own, and it syncs back (ruling AUTH-8)", async () => {
    const tab = await open({ actor: guest })
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.rows()).toHaveLength(1))
    expect(tab.form()).not.toMatchObject({ state: "failed" })
  }, WITHIN)

  test("a tab signed out never asks for the row; its Test and Remove are refused for want of a session", async () => {
    const requested: Array<string> = []
    const tab = await open({
      actor: null,
      fetch: (api) => (input, init) => {
        requested.push(new URL(input instanceof Request ? input.url : String(input)).pathname)
        return api.fetch(input, init)
      },
    })
    expect(tab.actions.removeAll()).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ op: "remove", state: "failed", failure: "authentication" }))
    expect(tab.actions.test()).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "failed", failure: "authentication" }))
    expect(requested).not.toContain(PERSONAL_MODEL_SHAPE_ROUTE)
  }, WITHIN)
})
