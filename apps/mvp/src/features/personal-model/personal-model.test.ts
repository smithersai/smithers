// A person's own models on the tab (docs/features/personal-model.md#the-settings-section), driven as React drives it:
// the personal model layer's plain actions and its live queries, with no React. Each tab runs the browser's own layer
// (`appLayer`) on a Node device (src/test/chatApi.ts) against ChatApi's real handler over the compose Postgres and
// Electric, and its device's engine runs `model/test` and `model/remove` as a browser's leading engine worker does.
// Unhappy paths give the tab a faulty `PersonalModelClient` (the real one behind switches) or a faulty engine
// (test.faults-by-injection).
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Duration, Effect, Layer, type ManagedRuntime, Metric } from "effect"
import type { HttpClient } from "effect/http"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
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
  openTestApp,
  TestChatApi,
} from "../../test/chatApi"
import { EngineFaults } from "../../test/faults"
import { AuthStore, SESSION } from "../auth/store"
import { MODEL_TIERS } from "../model/contract"
import { ModelNotTaken, PersonalModelClient } from "./api"
import { keyTail, PERSONAL_MODEL_SHAPE_ROUTE } from "./contract"
import { writes } from "./metrics"
import { PersonalModel } from "./personalModel"
import { PersonalModelStore } from "./store"
import { type SaveForm, statusOf, tierView, toastOf } from "./view"

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
  const state = { next: [] as Array<Fault>, puts: 0 }
  const layer = Layer.effect(
    PersonalModelClient,
    Effect.map(PersonalModelClient, (real) =>
      PersonalModelClient.of({
        ...real,
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
    const app = openTestApp({ answers: false }, {
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
    /** The saved key of `protocol`, OpenAI-compatible unless named. */
    row: (protocol = "openai-chat") => queries.saved.toArray.find((row) => row.protocol === protocol),
    form: () => queries.form.toArray[0],
    test: () => queries.test.toArray[0],
    hidden: () => queries.hidden.toArray[0],
    status: () => statusOf(queries.saved.toArray, queries.form.toArray[0], queries.test.toArray[0]),
    toast: () => toastOf(session.tanstack.get(SESSION), queries.saved.toArray, queries.hidden.toArray[0]),
    count: (attributes: Record<string, string>) => runtime.runSync(Metric.value(Metric.withAttributes(writes, attributes))).count,
    dispatched: (flow: string, outcome: string) =>
      runtime.runSync(Metric.value(Metric.withAttributes(dispatches, { flow, door: "button", outcome }))).count,
  }
}

/** A save of one key, Fast named `model` on it (none when `""`), every other tier falling back to it. */
const one = (protocol: string, baseUrl: string, model: string, key: string): SaveForm => ({
  keys: [{ protocol, baseUrl, key }],
  models: model === "" ? {} : { fast: { protocol, modelId: model } },
})

/** The scripted OpenAI-compatible provider, as a person types it: its `/v1` goes, as the protocol's path follows. */
const SCRIPTED = (key: string) => one("openai-chat", `${OPENAI_ORIGIN}/v1/`, "gpt-test", key)

const OPENAI = (key: string) => one("openai-chat", "https://api.openai.com/v1/", "gpt-5", key)

/** Both scripted providers' keys: Fast and Hard on the Anthropic-compatible one, Implement on the OpenAI-compatible. */
const BOTH = (openai: string, anthropic: string): SaveForm => ({
  keys: [
    { protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, key: openai },
    { protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, key: anthropic },
  ],
  models: {
    fast: { protocol: "anthropic-messages", modelId: "claude-test" },
    implement: { protocol: "openai-chat", modelId: "gpt-test" },
    hard: { protocol: "anthropic-messages", modelId: "claude-hard" },
  },
})

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
    // No key, two keys of one protocol, or a tier this build doesn't know.
    expect(refused({ keys: [], models: {} })).toBe("invalid")
    expect(refused({ ...OPENAI(KEY), keys: [...OPENAI(KEY).keys, ...OPENAI(ROTATED).keys] })).toBe("invalid")
    expect(refused({ ...OPENAI(KEY), models: { cheap: { protocol: "openai-chat", modelId: "gpt-5" } } })).toBe("invalid")
    // A tier on a key it doesn't save, and a key at a host with no preset whose tiers name no model.
    expect(refused({ ...OPENAI(KEY), models: { fast: { protocol: "anthropic-messages", modelId: "claude-5" } } })).toBe("no_key")
    expect(refused(one("openai-chat", OPENAI_ORIGIN, "", KEY))).toBe("no_model")
    expect(tab.form()).toMatchObject({ op: "save", state: "failed", sent: null, saved: 0 })
    expect(faulty.state.puts).toBe(0)
    expect(tab.count({ op: "put", outcome: "refused" })).toBe(16)
  }, WITHIN)

  test("no whole answer is an unknown outcome; a save on its way can't be sent twice, nor a test or a remove", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    faulty.state.next.push("network")
    expect(tab.actions.save(OPENAI(KEY))).toBe(true)
    // What it sent: the base URL as ChatApi keeps it and the tiers' models; never the key.
    await until(() => expect(tab.form()).toMatchObject({ state: "unknown", failure: null, saved: 0 }))
    expect(tab.form()?.sent).toEqual({
      keys: [{ protocol: "openai-chat", baseUrl: "https://api.openai.com" }],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-5" } },
    })
    expect(tab.count({ op: "put", outcome: "unknown" })).toBe(1)

    faulty.state.next.push("hold")
    expect(tab.actions.save(one("anthropic-messages", "https://api.anthropic.com", " claude-5 ", KEY))).toBe(true)
    expect(tab.form()).toMatchObject({ state: "sending", sent: { models: { fast: { modelId: "claude-5" } } } })
    expect(tab.actions.save(OPENAI(KEY))).toBe(false)
    expect(tab.actions.test()).toBe(false)
    expect(tab.actions.remove()).toBe(false)
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
    expect(tab.actions.remove()).toBe(true)
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

describe("the failure toast's Hide", () => {
  test("marks that failure hidden on this device, through a reload; a later Hide moves the mark", async () => {
    const tab = await open()
    tab.actions.hide("2026-10-24T11:00:00.000Z")
    expect(tab.hidden()).toMatchObject({ failedAt: "2026-10-24T11:00:00.000Z" })
    await until(() => expect(tab.device.stored("personal-model-hidden")).toBe(1))
    await tab.runtime.dispose()
    runtimes.splice(runtimes.indexOf(tab.runtime), 1)
    const reloaded = await open({ api: tab.api, device: tab.device })
    await until(() => expect(reloaded.hidden()).toMatchObject({ failedAt: "2026-10-24T11:00:00.000Z" }))
    reloaded.actions.hide("2026-10-24T12:00:00.000Z")
    expect(reloaded.hidden()).toMatchObject({ failedAt: "2026-10-24T12:00:00.000Z" })
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

  test("two keys: each tier lands on its key and shows; an empty key keeps the saved one; a new base URL needs its key", async () => {
    const tab = await open({ provider: { text: "ok" } })
    expect(tab.actions.save(BOTH(KEY, ROTATED))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ op: "save", state: "done", saved: 1 }))
    expect(tab.rows()).toMatchObject([
      {
        protocol: "anthropic-messages",
        baseUrl: ANTHROPIC_ORIGIN,
        fastModel: "claude-test",
        implementModel: null,
        hardModel: "claude-hard",
        keyLast4: keyTail(ROTATED),
      },
      {
        protocol: "openai-chat",
        baseUrl: OPENAI_ORIGIN,
        fastModel: null,
        implementModel: "gpt-test",
        hardModel: null,
        keyLast4: keyTail(KEY),
      },
    ])
    // What Settings shows: each tier's model on its key, and what it would use if left empty.
    expect(MODEL_TIERS.map((tier) => tierView(tab.rows(), tier))).toEqual([
      { model: "claude-test", placeholder: "gpt-test", protocol: "anthropic-messages" },
      { model: "gpt-test", placeholder: "claude-hard", protocol: "openai-chat" },
      { model: "claude-hard", placeholder: "gpt-test", protocol: "anthropic-messages" },
    ])

    // Both keys kept without typing them again, Fast moved to the OpenAI-compatible one, the rest falling back to it.
    expect(tab.actions.save({
      keys: [
        { protocol: "openai-chat", baseUrl: `${OPENAI_ORIGIN}/v1`, key: "" },
        { protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, key: "" },
      ],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-test" } },
    })).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 2 }))
    expect(tab.rows()).toMatchObject([
      { protocol: "anthropic-messages", fastModel: null, implementModel: null, hardModel: null, keyLast4: keyTail(ROTATED) },
      { protocol: "openai-chat", fastModel: "gpt-test", implementModel: null, hardModel: null, keyLast4: keyTail(KEY) },
    ])
    // The kept key still answers, with the key typed the first time.
    expect(tab.actions.test()).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "done", result: { ok: true } }))
    expect(tab.api.providerCalls.map((call) => [new URL(call.url).origin, call.headers.get("authorization")]))
      .toContainEqual([OPENAI_ORIGIN, `Bearer ${KEY}`])

    // A saved key never goes to another base URL unless typed again.
    expect(tab.actions.save({
      keys: [{ protocol: "openai-chat", baseUrl: "https://other.example.com", key: "" }],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-test" } },
    })).toBe(false)
    expect(tab.form()).toMatchObject({ state: "failed", failure: "key_required" })
    expect(leaks(tab.kept(), [KEY, ROTATED])).toEqual([])
  }, WITHIN)

  test("a key at a provider's own host saves with no model named, and each tier shows the preset it uses", async () => {
    const tab = await open()
    expect(tab.actions.save(one("openai-chat", "https://api.openai.com/v1", "", KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done", saved: 1 }))
    expect(tab.rows()).toMatchObject([
      { protocol: "openai-chat", baseUrl: "https://api.openai.com", fastModel: null, implementModel: null, hardModel: null },
    ])
    expect(MODEL_TIERS.map((tier) => tierView(tab.rows(), tier).placeholder)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])
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

  test("Test through its flow: OK; the provider's refusal, recorded on the row, toasts until hidden; OK clears it", async () => {
    let answer: Reply = { text: "ok" }
    const tab = await open({ provider: () => answer })
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "done" }))

    expect(tab.actions.test()).toBe(true)
    expect(tab.test()).toMatchObject({ state: "testing" })
    await until(() => expect(tab.test()).toMatchObject({ state: "done", result: { ok: true, sample: "ok" } }))
    expect(tab.status()).toEqual({ _tag: "Text", text: "OK" })
    expect(tab.api.providerCalls).toHaveLength(1)
    // The person's own key went to their own provider; the test took the status line, and the form kept its count.
    expect(tab.api.providerCalls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(tab.form()).toMatchObject({ state: "done", saved: 1, quiet: true })

    // The provider refuses the key: the test says so, and the row records it, which the toast shows.
    answer = { status: 401, error: { message: "Incorrect API key" } }
    expect(tab.actions.test()).toBe(true)
    await until(() =>
      expect(tab.test()).toMatchObject({ state: "done", result: { ok: false, status: 401, host: "models.example.com" } })
    )
    await until(() => expect(tab.row()).toMatchObject({ failureStatus: 401 }))
    const failedAt = tab.row()!.failedAt!
    await until(() => expect(tab.toast()).toEqual({ detail: "models.example.com · HTTP 401", failedAt }))
    // The status line names the host and the status, from the test or the row, whichever is newer.
    expect(tab.status()).toMatchObject({ text: expect.stringMatching(/^models\.example\.com .*HTTP 401$/) })
    tab.actions.hide(failedAt)
    expect(tab.toast()).toBeUndefined()

    // It passes again: the row's failure clears.
    answer = { text: "ok again" }
    expect(tab.actions.test()).toBe(true)
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
    expect(tab.actions.remove()).toBe(true)
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
  test("a Guest's save is refused, as the server decides, and nothing syncs", async () => {
    const tab = await open({ actor: guest })
    expect(tab.actions.save(SCRIPTED(KEY))).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ state: "failed", failure: "forbidden" }))
    expect(tab.status()).toEqual({ _tag: "Text", text: "Only Members can use their own model" })
    expect(tab.rows()).toEqual([])
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
    expect(tab.actions.remove()).toBe(true)
    await until(() => expect(tab.form()).toMatchObject({ op: "remove", state: "failed", failure: "authentication" }))
    expect(tab.actions.test()).toBe(true)
    await until(() => expect(tab.test()).toMatchObject({ state: "failed", failure: "authentication" }))
    expect(requested).not.toContain(PERSONAL_MODEL_SHAPE_ROUTE)
    expect(tab.toast()).toBeUndefined()
  }, WITHIN)
})
