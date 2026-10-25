// A repository's Secrets page on the tab (docs/features/secrets.md#the-secrets-page), driven as React drives it: the
// secrets layer's plain actions and its live queries, with no React. Each tab runs the browser's own layer (`appLayer`)
// on a Node device (src/test/chatApi.ts), against ChatApi's real secrets routes (worker/secrets/Api.ts) over the compose
// Postgres and Electric, with `secret/Put` and `secret/Delete` run for real on a Node host's engine. Unhappy paths give
// the tab a faulty `SecretsClient`, the real one behind switches (test.faults-by-injection).
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Duration, Effect, Layer, type ManagedRuntime, Metric, Option } from "effect"
import type { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { leaks, VALUE } from "../../../worker/secrets/test/harness.ts"
import {
  asPerson,
  CHATAPI_ORIGIN,
  nodeDevice,
  openTestApp,
  TEST_REPOSITORY,
  TestChatApi,
} from "../../test/chatApi"
import { Auth } from "../auth/auth"
import { AuthStore, SESSION } from "../auth/store"
import { repoId } from "../repo/contract"
import { Repo } from "../repo/repo"
import { SecretNotSaved, SecretsClient } from "./api"
import { secretRoute } from "./contract"
import { writes } from "./metrics"
import { Secrets } from "./secrets"
import { SecretsStore } from "./store"
import { accessOf } from "./view"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long Electric may take to deliver a row on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: a fresh device, its sign-in and its first syncs, on a loaded machine. */
const WITHIN = 90_000

const [OWNER, NAME] = TEST_REPOSITORY.split("/") as [string, string]
const REPO_ID = repoId(OWNER, NAME)
const ROTATED = `${VALUE}-rotated`

const person = (role: Actor["role"]): Actor => ({ subject: { kind: "person", id: `person-${role}` }, role })
const admin = person("admin")

/**
 * A faulty `SecretsClient`: the real one, behind switches. `hold` never answers; `network` fails before sending, as no
 * answer does; `lost` sends, then loses the answer; `taken` answers 202 and sends nothing; `slow` sends after 300 ms.
 */
type Fault = "hold" | "network" | "lost" | "taken" | "slow"
const faultyClient = () => {
  const state = { next: [] as Array<Fault> }
  const lost = new SecretNotSaved({})
  const fault = (real: Effect.Effect<void, SecretNotSaved>) =>
    Effect.suspend(() => {
      const next = state.next.shift()
      switch (next) {
        case undefined:
          return real
        case "hold":
          return Effect.never
        case "network":
          return Effect.fail(lost)
        case "lost":
          return Effect.andThen(real, Effect.fail(lost))
        case "taken":
          return Effect.void
        case "slow":
          return Effect.andThen(Effect.sleep("300 millis"), real)
      }
    })
  const layer = Layer.effect(
    SecretsClient,
    Effect.map(SecretsClient, (real) =>
      SecretsClient.of({
        put: (owner, name, secret, put) => fault(real.put(owner, name, secret, put)),
        remove: (owner, name, secret) => fault(real.remove(owner, name, secret)),
      })),
  ).pipe(Layer.provide(SecretsClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
  return { layer, state }
}

type App = ManagedRuntime.ManagedRuntime<Secrets | SecretsStore | Auth | AuthStore | Repo | TestChatApi, unknown>

/**
 * The app on a fresh ChatApi as `actor` (an Admin unless set), with an Admin among its `people`, on a device whose
 * SQLite file and outbox the test reads; the secrets page opened and its queries started as React does.
 */
const open = async (
  options: {
    readonly actor?: Actor | null
    readonly replace?: Layer.Layer<SecretsClient, never, HttpClient.HttpClient>
    /** What happens on the server before the page opens. */
    readonly before?: (api: TestChatApi["Service"]) => Promise<void>
    /** How long a taken write may take to show in the list: 60 s unless set. */
    readonly confirmWithin?: Duration.Input
  } = {},
) => {
  const file = join(tmpdir(), `mvp-secrets-${crypto.randomUUID()}.sqlite`)
  const outbox = new Map<string, string>()
  const host = nodeDevice({ file, outboxEntries: outbox })
  const runtime: App = openTestApp(
    {
      answers: false,
      host,
      ...(options.replace === undefined ? {} : { replace: options.replace }),
      ...(options.confirmWithin === undefined ? {} : { confirmWithin: options.confirmWithin }),
    },
    { actor: options.actor === undefined ? admin : options.actor, people: { admin } },
  )
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  await options.before?.(api)
  const secrets = await runtime.runPromise(Effect.service(Secrets))
  const store = await runtime.runPromise(Effect.service(SecretsStore))
  const auth = await runtime.runPromise(Effect.service(Auth))
  auth.queries.session.startSyncImmediate()
  // Signed in as sign-in's `load` sets it from the session route, which this ChatApi doesn't serve.
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  const actor = options.actor === undefined ? admin : options.actor
  await runtime.runPromise(
    session.update(SESSION, (row) =>
      void Object.assign(
        row,
        actor === null
          ? { status: "signed_out", login: null, role: null }
          : { status: "signed_in", login: actor.subject.id, role: actor.role },
      )),
  )
  await secrets.actions.open(OWNER, NAME)
  // Who the person is on the repository, as every repository route asks ChatApi (decision 0079).
  const repo = await runtime.runPromise(Effect.service(Repo))
  repo.queries.roles.startSyncImmediate()
  repo.actions.role(OWNER, NAME)
  await until(() => expect(repo.queries.roles.toArray.find((row) => row.id === REPO_ID)).toBeDefined())
  const list = secrets.queries.list(REPO_ID)
  for (const query of [list, secrets.queries.view, secrets.queries.forms]) query.startSyncImmediate()
  return {
    api,
    runtime,
    store,
    actions: secrets.actions,
    queries: secrets.queries,
    access: () =>
      accessOf(auth.queries.session.toArray[0], repo.queries.roles.toArray.find((row) => row.id === REPO_ID)),
    rows: () => list.toArray.map(({ name, hosts, methods }) => ({ name, hosts: [...hosts], methods: methods && [...methods] })),
    list,
    view: () => secrets.queries.view.toArray[0]!,
    /** Form `key` of this repository's page (`add`, `rotate:<NAME>`, `delete:<NAME>`), or of `repo`'s. */
    form: (key: string, repo = REPO_ID) => secrets.queries.forms.toArray.find((form) => form.id === `${repo}|${key}`),
    count: (attributes: Record<string, string>) => runtime.runSync(Metric.value(Metric.withAttributes(writes, attributes))).count,
    /** Everything this device keeps: its SQLite files, its outbox, and every row its secrets collections show. */
    kept: () =>
      [
        ...["", "-wal", "-shm", "-journal"].flatMap((suffix) =>
          existsSync(`${file}${suffix}`) ? [readFileSync(`${file}${suffix}`).toString("latin1")] : []
        ),
        JSON.stringify([...outbox]),
        JSON.stringify([list.toArray, secrets.queries.view.toArray, secrets.queries.forms.toArray]),
      ].join("\n"),
  }
}

/** Sets a secret through ChatApi as the Admin, as another device of theirs would. */
const putElsewhere = async (api: TestChatApi["Service"], secret: string, body: unknown) => {
  const response = await asPerson(api, "admin").fetch(`${api.origin}${secretRoute(OWNER, NAME, secret)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(202)
}

/** A stored secret's row, written straight to Postgres as `secret/Store` would, for a ChatApi nobody may write through. */
const storedElsewhere = (api: TestChatApi["Service"], secret: string) =>
  Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO secrets (repo_id, name, ciphertext, nonce, key_version, hosts, updated_by)
      VALUES (${REPO_ID}, ${secret}, 'sealed', 'nonce', 1, ARRAY['api.stripe.com'], 'person-admin')`)))

describe("an Admin's Secrets page", () => {
  test("Add and Rotate: Saving until the list shows the write; the form clears; the value is kept nowhere", async () => {
    const tab = await open()
    expect(tab.access()).toBe("write")

    expect(tab.actions.add("STRIPE_KEY", VALUE, "api.stripe.com, files.stripe.com\n")).toBe(true)
    expect(tab.form("add")).toMatchObject({ state: "sending", secret: "STRIPE_KEY", before: null, saved: 0 })
    await until(() => expect(tab.rows()).toEqual([{ name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com"], methods: null }]))
    // ChatApi took it (`saved` keys the form, so its fields clear), and the list showed it.
    await until(() => expect(tab.form("add")).toMatchObject({ state: "done", failure: null, saved: 1 }))
    expect(Number.isNaN(Date.parse(tab.list.toArray[0]!.updatedAt))).toBe(false)

    // Add never replaces: only Rotate does, keeping the methods.
    expect(tab.actions.add("STRIPE_KEY", ROTATED, "evil.example.com")).toBe(false)
    expect(tab.form("add")).toMatchObject({ state: "failed", failure: "exists", secret: "STRIPE_KEY", saved: 1 })

    // Bound to POST elsewhere; Rotate keeps the methods and takes the hosts typed.
    await putElsewhere(tab.api, "STRIPE_KEY", { value: VALUE, hosts: ["api.stripe.com"], methods: ["POST"] })
    await until(() => expect(tab.rows()[0]?.methods).toEqual(["POST"]))
    tab.actions.startRotate("STRIPE_KEY")
    expect(tab.view()).toMatchObject({ rotating: "STRIPE_KEY", deleting: null })
    const before = tab.list.toArray[0]!.updatedAt
    expect(tab.actions.rotate("STRIPE_KEY", ROTATED, "files.stripe.com")).toBe(true)
    expect(tab.form("rotate:STRIPE_KEY")).toMatchObject({ state: "sending", before })
    await until(() => expect(tab.rows()).toEqual([{ name: "STRIPE_KEY", hosts: ["files.stripe.com"], methods: ["POST"] }]))
    await until(() => expect(tab.view().rotating).toBeNull())
    expect(tab.form("rotate:STRIPE_KEY")).toBeUndefined()
    expect(tab.count({ op: "put", outcome: "started" })).toBe(2)
    expect(tab.count({ op: "put", outcome: "landed" })).toBe(2)
    expect(tab.count({ op: "put", outcome: "refused" })).toBe(1)

    // No collection row, no outbox entry and no stored byte holds either value, in any encoding.
    expect(leaks(tab.kept(), [VALUE, ROTATED])).toEqual([])
    const serverSpans = JSON.stringify(tab.api.spans.map((span) => [span.name, [...span.attributes]]))
    expect(leaks(serverSpans, [VALUE, ROTATED])).toEqual([])
    // Every log line, span and metric the tab exported, once the runtime closes and its exporter flushes.
    const { telemetry } = tab.api
    await tab.runtime.dispose()
    runtimes.splice(runtimes.indexOf(tab.runtime), 1)
    const exported = telemetry.map((request) => request.body).join("\n")
    expect(exported).toContain("secrets.write")
    expect(exported).toContain("smithers_web_secret_writes")
    expect(leaks(exported, [VALUE, ROTATED])).toEqual([])
  }, WITHIN)

  test("Delete asks first, says Saving until the row is gone; a write landing after its form closed changes nothing else", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    await putElsewhere(tab.api, "OLD_KEY", { value: VALUE, hosts: ["api.example.com"] })
    await until(() => expect(tab.rows().map((row) => row.name)).toEqual(["OLD_KEY"]))

    tab.actions.startRotate("OLD_KEY")
    tab.actions.startDelete("OLD_KEY")
    expect(tab.view()).toMatchObject({ rotating: null, deleting: "OLD_KEY" })
    tab.actions.cancel()
    expect(tab.view()).toMatchObject({ rotating: null, deleting: null })

    // Rotate, then Delete opened on the same row before it lands: the rotate's landing leaves the confirmation open.
    faulty.state.next.push("slow")
    tab.actions.startRotate("OLD_KEY")
    tab.actions.rotate("OLD_KEY", ROTATED, "files.example.com")
    tab.actions.startDelete("OLD_KEY")
    await until(() => expect(tab.rows()).toEqual([{ name: "OLD_KEY", hosts: ["files.example.com"], methods: null }]))
    await until(() => expect(tab.form("rotate:OLD_KEY")).toBeUndefined())
    expect(tab.view()).toMatchObject({ rotating: null, deleting: "OLD_KEY" })

    // Delete, then Rotate opened on the same row before it lands: the delete's landing leaves Rotate open.
    faulty.state.next.push("slow")
    expect(tab.actions.remove("OLD_KEY")).toBe(true)
    expect(tab.form("delete:OLD_KEY")).toMatchObject({ state: "sending" })
    tab.actions.startRotate("OLD_KEY")
    await until(() => expect(tab.rows()).toEqual([]))
    await until(() => expect(tab.form("delete:OLD_KEY")).toBeUndefined())
    expect(tab.view()).toMatchObject({ rotating: "OLD_KEY", deleting: null })

    // Delete secret: the confirmation closes once the row is gone.
    await putElsewhere(tab.api, "OLD_KEY", { value: VALUE, hosts: ["api.example.com"] })
    await until(() => expect(tab.rows().map((row) => row.name)).toEqual(["OLD_KEY"]))
    tab.actions.startDelete("OLD_KEY")
    expect(tab.actions.remove("OLD_KEY")).toBe(true)
    await until(() => expect(tab.rows()).toEqual([]))
    await until(() => expect(tab.view().deleting).toBeNull())
    expect(tab.count({ op: "delete", outcome: "landed" })).toBe(2)
  }, WITHIN)

  test("a refusal says why and keeps the form for another try; the next save clears it", async () => {
    const tab = await open()
    const failure = async (expected: string) =>
      until(() => expect(tab.form("add")).toMatchObject({ state: "failed", failure: expected }))

    expect(tab.actions.add("STRIPE_KEY", VALUE, "*.stripe.com")).toBe(true)
    await failure("invalid_hosts")
    expect(tab.actions.add("stripe_key", VALUE, "api.stripe.com")).toBe(true)
    await failure("invalid_name")
    expect(tab.actions.add("STRIPE_KEY", "short", "api.stripe.com")).toBe(true)
    await failure("too_short")
    // No name: nothing to send.
    expect(tab.actions.add("", VALUE, "api.stripe.com")).toBe(false)
    expect(tab.form("add")).toMatchObject({ state: "failed", failure: "invalid_name", saved: 0 })
    expect(tab.count({ op: "put", outcome: "refused" })).toBe(4)

    expect(tab.actions.add("STRIPE_KEY", VALUE, "api.stripe.com")).toBe(true)
    await until(() => expect(tab.form("add")).toMatchObject({ state: "done", failure: null, saved: 1 }))
    await until(() => expect(tab.rows().map((row) => row.name)).toEqual(["STRIPE_KEY"]))

    // Rotate's last failure goes when its form opens again.
    tab.actions.startRotate("STRIPE_KEY")
    expect(tab.actions.rotate("STRIPE_KEY", VALUE, "10.0.0.1")).toBe(true)
    await until(() => expect(tab.form("rotate:STRIPE_KEY")?.failure).toBe("invalid_hosts"))
    expect(tab.view().rotating).toBe("STRIPE_KEY")
    tab.actions.startRotate("STRIPE_KEY")
    expect(tab.form("rotate:STRIPE_KEY")).toBeUndefined()
  }, WITHIN)

  test("no answer is an unknown outcome, shown landed once the list has it; a write on its way can't be sent twice", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    await putElsewhere(tab.api, "OLD_KEY", { value: VALUE, hosts: ["api.example.com"] })
    await until(() => expect(tab.rows().map((row) => row.name)).toEqual(["OLD_KEY"]))

    // Nothing reached ChatApi: unknown, and stays so; the form keeps its fields.
    faulty.state.next.push("network")
    expect(tab.actions.add("NEW_KEY", VALUE, "api.example.com")).toBe(true)
    await until(() => expect(tab.form("add")).toMatchObject({ state: "unknown", failure: null, saved: 0 }))
    faulty.state.next.push("network")
    tab.actions.startDelete("OLD_KEY")
    expect(tab.actions.remove("OLD_KEY")).toBe(true)
    await until(() => expect(tab.form("delete:OLD_KEY")).toMatchObject({ state: "unknown" }))
    expect(tab.view().deleting).toBe("OLD_KEY")
    expect(tab.count({ op: "put", outcome: "unknown" })).toBe(1)
    expect(tab.count({ op: "delete", outcome: "unknown" })).toBe(1)

    // ChatApi took it, and the answer was lost: once the list shows it, it landed.
    faulty.state.next.push("lost")
    expect(tab.actions.add("NEW_KEY", VALUE, "api.example.com")).toBe(true)
    await until(() => expect(tab.form("add")).toMatchObject({ state: "done", saved: 1 }))
    expect(tab.rows().map((row) => row.name)).toEqual(["NEW_KEY", "OLD_KEY"])
    expect(tab.count({ op: "put", outcome: "started" })).toBe(1)
    faulty.state.next.push("lost")
    expect(tab.actions.remove("OLD_KEY")).toBe(true)
    await until(() => expect(tab.form("delete:OLD_KEY")).toBeUndefined())
    expect(tab.rows().map((row) => row.name)).toEqual(["NEW_KEY"])
    expect(tab.view().deleting).toBeNull()

    faulty.state.next.push("hold", "hold")
    expect(tab.actions.add("THIRD_KEY", VALUE, "api.example.com")).toBe(true)
    expect(tab.form("add")).toMatchObject({ state: "sending", failure: null })
    expect(tab.actions.add("THIRD_KEY", VALUE, "api.example.com")).toBe(false)
    tab.actions.startDelete("NEW_KEY")
    expect(tab.actions.remove("NEW_KEY")).toBe(true)
    expect(tab.actions.remove("NEW_KEY")).toBe(false)
    // A form on its way keeps its row when it opens again.
    tab.actions.startDelete("NEW_KEY")
    expect(tab.form("delete:NEW_KEY")).toMatchObject({ state: "sending" })
  }, WITHIN)

  test("a write the list doesn't show within the deadline says it hasn't shown up yet; one that landed stays landed", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer, confirmWithin: "4 seconds" })
    expect(tab.actions.add("STRIPE_KEY", VALUE, "api.stripe.com")).toBe(true)
    await until(() => expect(tab.form("add")).toMatchObject({ state: "done" }))
    tab.actions.startRotate("STRIPE_KEY")
    expect(tab.actions.rotate("STRIPE_KEY", ROTATED, "api.stripe.com")).toBe(true)
    await until(() => expect(tab.form("rotate:STRIPE_KEY")).toBeUndefined())
    // Taken, but never in the list; the earlier Add's deadline, passing meanwhile, leaves this one Saving.
    faulty.state.next.push("taken")
    expect(tab.actions.add("NEVER_KEY", VALUE, "api.stripe.com")).toBe(true)
    await until(() => expect(tab.form("add")).toMatchObject({ state: "confirming", secret: "NEVER_KEY", saved: 2 }))
    const taken = Date.now()
    await until(() => expect(tab.form("add")).toMatchObject({ state: "late" }), 15_000)
    expect(Date.now() - taken).toBeGreaterThanOrEqual(3_500)
    // The deadlines of the two that landed, which passed first, changed nothing.
    expect(tab.count({ op: "put", outcome: "late" })).toBe(1)
    expect(tab.form("rotate:STRIPE_KEY")).toBeUndefined()
  }, WITHIN)

  test("each repository has its own forms: a late answer changes only its own repository's page", async () => {
    const faulty = faultyClient()
    const tab = await open({ replace: faulty.layer })
    const OTHER = "github/octo/other"
    await putElsewhere(tab.api, "STRIPE_KEY", { value: VALUE, hosts: ["api.stripe.com"] })
    await until(() => expect(tab.rows().map((row) => row.name)).toEqual(["STRIPE_KEY"]))

    faulty.state.next.push("slow", "slow")
    expect(tab.actions.add("NEW_KEY", VALUE, "api.stripe.com")).toBe(true)
    tab.actions.startRotate("STRIPE_KEY")
    expect(tab.actions.rotate("STRIPE_KEY", ROTATED, "files.stripe.com")).toBe(true)
    await tab.actions.warm("octo", "other")
    await tab.actions.open("octo", "other")
    expect(tab.view()).toMatchObject({ owner: "octo", name: "other", repoId: OTHER, rotating: null })
    tab.actions.startRotate("STRIPE_KEY")
    expect(tab.form("add", OTHER)).toBeUndefined()

    // The first repository's writes land on its own forms; the page shown keeps its own Rotate open.
    await until(() => expect(tab.form("add")).toMatchObject({ state: "done", secret: "NEW_KEY" }))
    await until(() => expect(tab.form("rotate:STRIPE_KEY")).toBeUndefined())
    expect(tab.form("add", OTHER)).toBeUndefined()
    expect(tab.view()).toMatchObject({ repoId: OTHER, rotating: "STRIPE_KEY" })

    // Opening the same repository again keeps what is open; its list is its own.
    await tab.actions.open("octo", "other")
    expect(tab.view().rotating).toBe("STRIPE_KEY")
    expect(tab.queries.list("github/octo/unopened")).toBe(tab.queries.list("github/octo/also-unopened"))
    expect(Option.isNone(await tab.runtime.runPromise(tab.store.rowOf("github/octo/unopened", "STRIPE_KEY")))).toBe(true)
  }, WITHIN)
})

describe("who sees what", () => {
  test("a Member reads the names and hosts; a write is refused, as the server decides", async () => {
    const tab = await open({
      actor: person("member"),
      before: (api) => putElsewhere(api, "STRIPE_KEY", { value: VALUE, hosts: ["api.stripe.com"], methods: ["GET", "POST"] }),
    })
    expect(tab.access()).toBe("read")
    await until(() => expect(tab.rows()).toEqual([{ name: "STRIPE_KEY", hosts: ["api.stripe.com"], methods: ["GET", "POST"] }]))
    expect(tab.actions.add("OTHER_KEY", VALUE, "api.stripe.com")).toBe(true)
    await until(() => expect(tab.form("add")?.failure).toBe("forbidden"))
    expect(leaks(tab.kept())).toEqual([])
  }, WITHIN)

  test("a Guest and a signed-out person get no rows", async () => {
    for (const actor of [person("guest"), null]) {
      // The secret is in Postgres before the page opens, so its first sync would bring it to anyone allowed.
      const tab = await open({ actor, before: (api) => storedElsewhere(api, "STRIPE_KEY").then(() => {}) })
      expect(tab.access()).toBe("none")
      expect(await tab.list.toArrayWhenReady()).toEqual([])
      expect(tab.actions.add("OTHER_KEY", VALUE, "api.stripe.com")).toBe(true)
      await until(() => expect(tab.form("add")?.failure).toBe(actor === null ? "authentication" : "forbidden"))
    }
  }, WITHIN * 2)
})
