// Fuzzing of the device's stores and their history (src/device/registry.ts, history.ts, repoStores.ts): every declared
// migration chain from every version, the outbox's upgrade of stored writes under damage, the order and identity of a
// queue of writes across builds, a real device store brought forward through SQLite, and which store a collection
// belongs to.
import { Collection, Migrations } from "@smthrs/effect-tanstack-db"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { repoId } from "../features/repo/contract"
import { Draft as TodoDraft, Requested as TodoRequested, Sending as TodoSending } from "../features/todos/schema"
import { requestOf } from "../features/todos/writes.vibe"
import { deviceFrom, keptRows, persistenceOn, plain, prepare } from "../test/deviceFixture"
import { deviceRegistry, outboxUpgrade, TodoDraftsStore, TodoRequestedStore, TodoSendingPayload } from "./registry"
import { REPOSITORY_MEMORY, REPOSITORY_STORES, UNSCOPED_LOCAL, UNWIPED_FAMILIES } from "./repoStores"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

/** Runs `property` over `arbitrary`; a property that throws or answers false fails the test with its shrunk input. */
const holds = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (input: A) => Effect.Effect<boolean>, executions: number) => {
  const report = await Effect.runPromise(Fuzz.run(arbitrary, property, { seed, executions }))
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Fails the running property with `why`. */
const must = (ok: boolean, why: string): void => {
  if (!ok) throw new Error(why)
}

const int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
type Row = Record<string, unknown>

// ---------------------------------------------------------------------------------------------------------------------
// Every migration chain, from every version
// ---------------------------------------------------------------------------------------------------------------------

/** A store's or payload's history: its versions oldest first, and the step from each to the next. */
interface Chain {
  readonly id: string
  readonly versions: ReadonlyArray<Schema.Codec<unknown, unknown>>
  readonly steps: ReadonlyArray<Migrations.Step<unknown, unknown>>
  readonly keyOf?: (row: never) => unknown
}

const chains: ReadonlyArray<Chain> = [
  ...deviceRegistry.stores.flatMap((store): ReadonlyArray<Chain> =>
    store._tag === "Local" ? [{ id: store.id, versions: store.versions, steps: store.migrations, keyOf: store.getKey }] : []),
  ...deviceRegistry.outbox.payloads.map((payload): Chain => ({ id: payload.key, versions: payload.versions, steps: payload.migrations })),
]

/** A migration may drop who a write acted for and restamp its version; every other field it leaves as it was. */
const REWRITTEN = new Set(["via", "v"])

/** `row` at version index `from` walked to the chain's last version: the row there, or why a step refused it. */
const walk = (chain: Chain, from: number, row: unknown): { readonly row: unknown } | { readonly refused: string } => {
  let current = row
  for (let version = from; version < chain.versions.length - 1; version++) {
    const next = chain.steps[version]?.migrate(current)
    if (next instanceof Migrations.Unmigratable) return { refused: next.reason }
    must(Schema.is(chain.versions[version + 1] ?? Schema.Never)(next), `${chain.id}: version ${version + 1}'s row is not version ${version + 2}'s after its step`)
    current = next
  }
  return { row: current }
}

describe("the device's migration chains", () => {
  it("each store's history is whole: one step between each two versions, from the one to the other", () => {
    const sizes = Object.fromEntries(chains.map((chain) => [chain.id, chain.versions.length]))
    expect(sizes).toMatchObject({ "todo-drafts": 2, "todo-requested": 6, "todo-sending": 4 })
    for (const chain of chains) {
      expect([chain.id, chain.steps.length]).toEqual([chain.id, chain.versions.length - 1])
      chain.steps.forEach((step, index) => {
        expect([chain.id, index, step.from === chain.versions[index], step.to === chain.versions[index + 1]]).toEqual([chain.id, index, true, true])
      })
    }
  })

  it("any row of any version reaches this build's shape, the same every time, with its key and its content: or is refused by name", async () => {
    const hops = chains.flatMap((chain) => chain.versions.slice(0, -1).map((schema, from) => ({ chain, schema, from })))
    expect(hops.length).toBeGreaterThanOrEqual(20)
    const executions = Math.max(10, Math.ceil(pureExecutions / 6))
    for (const { chain, schema, from } of hops) {
      await holds(Arbitrary.schema(schema), (row: unknown) =>
        Effect.sync(() => {
          const before = JSON.stringify(row)
          const walked = walk(chain, from, row)
          must(JSON.stringify(row) === before, `${chain.id} v${from + 1}: a migration changed the row it was given`)
          must(same(walked, walk(chain, from, row)), `${chain.id} v${from + 1}: a migration is not deterministic`)
          if ("refused" in walked) {
            // The one refusal this build declares: an issue write the agent queued as itself (decision 0021).
            must(chain.id === "issue-sending" && from === 0 && (row as Row)["via"] === "agent" && walked.refused === "agent_write", `${chain.id} v${from + 1}: refused ${walked.refused}`)
            return true
          }
          const last = chain.versions.at(-1) ?? Schema.Never
          must(Schema.is(last)(walked.row), `${chain.id} v${from + 1}: the migrated row is not this build's`)
          const original = row as Row
          const migrated = walked.row as Row
          for (const field of Object.keys(original)) {
            if (!REWRITTEN.has(field)) must(same(original[field], migrated[field]), `${chain.id} v${from + 1}: field ${field} changed`)
          }
          if (chain.keyOf !== undefined) {
            must(same(chain.keyOf(original as never), chain.keyOf(migrated as never)), `${chain.id} v${from + 1}: the row's key changed`)
          }
          // A row already brought part of the way ends where the whole walk does.
          const next = chain.steps[from]?.migrate(row)
          must(same(walk(chain, from + 1, next), walked), `${chain.id} v${from + 1}: resuming the chain a step later ends elsewhere`)
          return true
        }), executions)
    }
  })

  it("todo-drafts 1 to 2, todo-requested 1 to 6 and todo-sending 1 to 4 keep the change itself: only the outbox's stamp moves", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      draft: TodoDraftsStore.versions[0] ?? Schema.Never,
      requested: TodoRequestedStore.versions[4] ?? Schema.Never,
      sending: TodoSendingPayload.versions[2] ?? Schema.Never,
    }))
    const chainOf = (id: string) => chains.find((chain) => chain.id === id) ?? { id, versions: [], steps: [] }
    await holds(arbitrary, (input) =>
      Effect.sync(() => {
        const draft = walk(chainOf("todo-drafts"), 0, input.draft)
        must("row" in draft && same(draft.row, input.draft) && Schema.is(TodoDraft)(draft.row), "a version 1 draft changed, or is no draft")
        must("row" in draft && (draft.row as Row)["after"] === undefined, "a version 1 draft gained a TODO to stack on")
        const requested = walk(chainOf("todo-requested"), 4, input.requested)
        must("row" in requested && same(requested.row, input.requested) && Schema.is(TodoRequested)(requested.row), "a version 5 change changed")
        const sending = walk(chainOf("todo-sending"), 2, input.sending)
        must("row" in sending && same(sending.row, { ...(input.sending as Row), v: 4 }) && Schema.is(TodoSending)(sending.row), "a version 3 queued change changed")
        // The route's body for the migrated change is the one the older build would have sent.
        if ("row" in sending && Schema.is(TodoSending)(sending.row)) {
          const request = requestOf(sending.row)
          const source = input.sending as Row
          must(request.opId === source["id"] && request.op === source["op"], "the migrated change names another op")
          must(!("after" in request), "a change queued before stacking names a TODO to stack on")
        }
        return true
      }), pureExecutions)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The outbox's stored writes
// ---------------------------------------------------------------------------------------------------------------------

/** The ops each version of `todo-sending` could queue. */
const OPS_AT: ReadonlyArray<ReadonlyArray<string>> = [["commit", "drop"], ["commit", "drop", "retry"], ["commit", "drop", "retry", "attach"], ["commit", "drop", "retry", "attach"]]
const CURRENT = TodoSendingPayload.schemaVersion

const Queued = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  title: Schema.String.check(Schema.isMaxLength(24)),
  prompt: Schema.String.check(Schema.isMaxLength(24)),
  acceptance: Schema.Array(Schema.String.check(Schema.isMaxLength(8))).check(Schema.isMaxLength(3)),
  number: int(0, 9_999),
  issue: Schema.NullOr(int(1, 9_999)),
  queuedAt: int(0, 2_000_000_000_000),
  op: Schema.Literals(["commit", "drop", "retry", "attach"]),
  from: int(1, 4),
})
type Queued = typeof Queued.Type

/** The `todo-sending` row a build at version `queued.from` stored. */
const rowAt = (queued: Queued): Row => ({
  id: queued.id,
  repo: "octo/hello",
  op: queued.op,
  title: queued.title,
  prompt: queued.prompt,
  acceptance: queued.acceptance,
  number: queued.number,
  ...(queued.issue === null ? {} : { issue: queued.issue }),
  repoId: "github/octo/hello",
  queuedAt: queued.queuedAt,
  v: queued.from,
})

/** An outbox write as @tanstack/offline-transactions stored it: one insert of `row`, whose op id is `id`, into `collectionId`. */
const storedWrite = (id: string, queuedAt: number, row: unknown, options: {
  readonly versions?: Readonly<Record<string, unknown>>
  readonly mutationFnName?: string
  readonly collectionId?: string
  readonly valueEncoding?: number
  readonly mutations?: unknown
}): Record<string, unknown> => {
  const collectionId = options.collectionId ?? "todo-sending"
  const key = `KEY::${JSON.stringify([collectionId, "string", id])}`
  return {
    id: `write-${id}`,
    mutationFnName: options.mutationFnName ?? "todo-op",
    mutations: options.mutations ?? [{ globalKey: key, type: "insert", modified: row, original: {}, changes: row, collectionId }],
    keys: [key],
    idempotencyKey: id,
    createdAt: "2026-10-21T04:46:26.298Z",
    retryCount: 1,
    nextAttemptAt: 1_792_557_987_347,
    metadata: { queuedAt, ...(options.versions === undefined ? {} : { versions: options.versions }) },
    version: 1,
    ...(options.valueEncoding === undefined ? {} : { valueEncoding: options.valueEncoding }),
  }
}

/** The upgrade of `stored`, which must answer and never throw. */
const upgraded = (stored: string): Migrations.UpgradedWrite => {
  try {
    return outboxUpgrade.write(stored)
  } catch (error) {
    throw new Error(`the outbox's upgrade threw on a stored write: ${String(error)}`, { cause: error })
  }
}

const told = (write: Migrations.UpgradedWrite): string => write._tag === "Parked" ? `Parked:${write.reason}` : write._tag

/** The row a write carries after its upgrade: the stored one when it was current. */
const carried = (stored: string, write: Migrations.UpgradedWrite): Row | undefined => {
  if (write._tag === "Parked") return undefined
  const parsed = JSON.parse(write._tag === "Upgraded" ? write.value : stored) as { readonly mutations: ReadonlyArray<{ readonly modified: Row }> }
  return parsed.mutations[0]?.modified
}

describe("the outbox's stored writes", () => {
  it("stamps each new write with its payload's version, one payload per mutation", () => {
    expect(outboxUpgrade.stamp).toEqual(Object.fromEntries(deviceRegistry.outbox.payloads.map((payload) => [payload.key, payload.schemaVersion])))
    expect(outboxUpgrade.stamp).toMatchObject({ "todo-sending": 4 })
    expect(deviceRegistry.outbox.payloads).toHaveLength(deviceRegistry.outbox.mutations.length)
  })

  it("a damaged, truncated or future write is parked by name and never thrown on; a sound one is upgraded once and then current", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      queued: Queued,
      damage: Schema.Literals([
        "none", "none", "none", "unstamped", "truncated", "not-json", "not-an-object", "mutations-not-a-list", "unknown-mutation",
        "unknown-collection", "unknown-encoding", "future-version", "version-zero", "version-negative", "version-fraction",
        "version-text", "field-missing", "field-mistyped", "row-null", "row-list",
      ]),
      cut: int(0, 100_000),
      ahead: int(1, 1_000),
      encoding: Schema.Literals(["absent", "2", "3"]),
      raw: Schema.String.check(Schema.isMaxLength(64)),
    }))
    await holds(arbitrary, ({ queued, damage, cut, ahead, encoding, raw }) =>
      Effect.sync(() => {
        const sound = rowAt(queued)
        const { title: _title, ...untitled } = sound
        const row: unknown = damage === "field-missing" ? untitled : damage === "field-mistyped" ? { ...sound, number: "7" } : damage === "row-null" ? null : damage === "row-list" ? [sound] : sound
        const stampedAs: unknown = damage === "future-version" ? CURRENT + ahead : damage === "version-zero" ? 0 : damage === "version-negative" ? -queued.from
          : damage === "version-fraction" ? queued.from + 0.5 : damage === "version-text" ? String(queued.from) : queued.from
        const write = storedWrite(queued.id, queued.queuedAt, row, {
          ...(damage === "unstamped" ? {} : { versions: { "todo-sending": stampedAs } }),
          ...(damage === "unknown-mutation" ? { mutationFnName: "todo-op-2" } : {}),
          ...(damage === "unknown-collection" ? { collectionId: "todo-sending-2" } : {}),
          ...(damage === "unknown-encoding" ? { valueEncoding: 9 } : encoding === "absent" ? {} : { valueEncoding: Number(encoding) }),
          ...(damage === "mutations-not-a-list" ? { mutations: { 0: sound } } : {}),
        })
        const whole = JSON.stringify(write)
        const stored = damage === "truncated" ? whole.slice(0, cut % whole.length) : damage === "not-json" ? `${whole}}` : damage === "not-an-object" ? JSON.stringify([write]) : whole

        // What this build must do with it, from the declared history alone.
        const readAs = damage === "unstamped" ? 1 : queued.from
        const decodes = sound["v"] === readAs && (OPS_AT[readAs - 1] ?? []).includes(queued.op) &&
          damage !== "field-missing" && damage !== "field-mistyped" && damage !== "row-null" && damage !== "row-list"
        const expected = damage === "truncated" || damage === "not-json" || damage === "not-an-object" || damage === "mutations-not-a-list" || damage === "unknown-encoding"
          ? "Parked:unreadable"
          : damage === "unknown-mutation" ? "Parked:mutation"
          : damage === "unknown-collection" ? "Parked:collection"
          : damage === "future-version" ? "Parked:newer"
          : damage === "version-zero" || damage === "version-negative" || damage === "version-fraction" || damage === "version-text" ? "Parked:unknown"
          // A write stamped with this build's version is this build's own: it is sent as stored.
          : readAs === CURRENT ? "Current"
          : decodes ? "Upgraded" : "Parked:decode"
        const answer = upgraded(stored)
        must(told(answer) === expected, `${damage} from version ${queued.from} (${queued.op}): ${told(answer)}, expected ${expected}`)

        if (answer._tag === "Upgraded") {
          const next = JSON.parse(answer.value) as Record<string, unknown> & { readonly mutations: ReadonlyArray<Row>; readonly metadata: Row }
          const modified = next.mutations[0]?.["modified"]
          must(same(modified, { ...sound, v: CURRENT }) && Schema.is(TodoSending)(modified), "the upgraded row is not the stored change at this build's version")
          must(same(next.mutations[0]?.["changes"], modified), "an upgraded insert's changes are not its row")
          must(same(next.metadata["versions"], { "todo-sending": CURRENT }) && next.metadata["queuedAt"] === queued.queuedAt, "the upgraded write is not stamped")
          for (const field of ["id", "mutationFnName", "keys", "idempotencyKey", "createdAt", "retryCount", "nextAttemptAt", "version"]) {
            must(same(next[field], write[field]), `the upgrade changed the write's ${field}`)
          }
          must(next.mutations.length === 1 && next.mutations[0]?.["globalKey"] === (write["keys"] as ReadonlyArray<string>)[0], "the upgrade changed the write's key")
          // Upgrading is done once: the upgraded write is current, and so is its own upgrade.
          must(told(upgraded(answer.value)) === "Current", "an upgraded write is upgraded again")
        }
        // Any text at all is answered; text that names no mutation is parked, and so is a write with text before it.
        const stray = upgraded(raw)
        if (!raw.includes("mutationFnName")) must(told(stray).startsWith("Parked:"), "arbitrary text was taken as a write")
        if (/^\S+$/u.test(raw)) must(told(upgraded(`${raw}${whole}`)) === "Parked:unreadable", "text before a write was read through")
        return true
      }), pureExecutions)
  })

  it("a queue of writes from mixed builds keeps each write, its order and its op id: one op id never becomes two requests", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      changes: Schema.Array(Schema.Struct({ title: Schema.String.check(Schema.isMaxLength(16)), number: int(1, 99), drop: Schema.Boolean }))
        .check(Schema.isMinLength(1), Schema.isMaxLength(5)),
      queue: Schema.Array(Schema.Struct({ change: int(0, 4), from: int(1, 4), queuedAt: int(0, 50), unstamped: Schema.Boolean }))
        .check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    }))
    await holds(arbitrary, ({ changes, queue }) =>
      Effect.sync(() => {
        // Each change has one op id; the queue holds it once or again, as builds at any version stored it.
        const stored = queue.map((entry) => {
          const index = entry.change % changes.length
          const change = changes[index] ?? { title: "", number: 1, drop: false }
          const from = entry.unstamped ? 1 : entry.from
          const row = rowAt({
            id: `op-${index}`, title: change.drop ? "" : change.title, prompt: change.drop ? "" : "Do it.", acceptance: [], number: change.drop ? change.number : 0,
            issue: null, queuedAt: entry.queuedAt, op: change.drop ? "drop" : "commit", from,
          })
          return { row, text: JSON.stringify(storedWrite(`op-${index}`, entry.queuedAt, row, entry.unstamped ? {} : { versions: { "todo-sending": from } })) }
        })
        const rows = stored.map(({ text }) => carried(text, upgraded(text)))
        // No write is lost, parked or reordered, and each keeps when it was queued.
        must(rows.every((row) => row !== undefined && Schema.is(TodoSending)(row)), "a sound queued write did not reach this build's shape")
        must(same(rows.map((row) => [row?.["id"], row?.["queuedAt"]]), stored.map(({ row }) => [row["id"], row["queuedAt"]])), "the queue's order or times changed")
        const byQueued = (list: ReadonlyArray<Row | undefined>) => list.map((row, index) => ({ row, index }))
          .sort((left, right) => Number(left.row?.["queuedAt"]) - Number(right.row?.["queuedAt"]) || left.index - right.index).map(({ index }) => index)
        must(same(byQueued(rows), byQueued(stored.map(({ row }) => row))), "the order by queue time changed")
        // The route's body: its op id is the row's id, and one op id is one body, whichever build queued it.
        const requests = new Map<string, string>()
        for (const row of rows) {
          if (row === undefined || !Schema.is(TodoSending)(row)) continue
          const request = requestOf(row)
          must(request.opId === row.id, "a request's op id is not its row's id")
          const body = JSON.stringify(request)
          must((requests.get(request.opId) ?? body) === body, `op id ${request.opId} carries two different requests`)
          requests.set(request.opId, body)
        }
        must(requests.size === new Set(stored.map(({ row }) => row["id"])).size, "the queue's op ids are not its writes' ids")
        return true
      }), pureExecutions)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// A device store brought forward (SQLite, through TanStack DB's own persistence)
// ---------------------------------------------------------------------------------------------------------------------

/** The rows local store `store` opens with on the device at `path`, as this build opens it. */
const opened = <A extends object>(path: string, store: Migrations.Local<A, string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const collection = yield* Collection.persisted(store)
      yield* collection.restored
      return (yield* collection.toArray).map(plain)
    }),
  ).pipe(Effect.provide(persistenceOn(path, deviceRegistry)), Effect.orDie)

const byId = (rows: ReadonlyArray<Row>) => [...rows].sort((left, right) => String(left["id"]).localeCompare(String(right["id"])))

describe("a device store an older or newer build left", () => {
  it("is brought forward once: sound rows migrate as they were, damaged and future rows are set aside by reason, and a second run does nothing", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      drafts: Schema.Array(Schema.Struct({ title: Schema.String.check(Schema.isMaxLength(16)), issue: Schema.NullOr(int(1, 99)), answered: Schema.Boolean }))
        .check(Schema.isMaxLength(3)),
      draftsAt: Schema.Literals([1, 1, 2, 3, 40]),
      requested: Schema.Array(Schema.Struct({ title: Schema.String.check(Schema.isMaxLength(16)), drop: Schema.Boolean, refused: Schema.Boolean, number: int(1, 99) }))
        .check(Schema.isMaxLength(3)),
      requestedAt: Schema.Literals([1, 2, 3, 4, 5, 5, 6, 7]),
      damaged: Schema.Array(Schema.Literals(["field-missing", "field-mistyped", "only-a-key", "list-null"])).check(Schema.isMaxLength(2)),
    }))
    await holds(arbitrary, (input) =>
      Effect.gen(function* () {
        const drafts: ReadonlyArray<Row> = input.drafts.map((draft, index) => ({
          id: `draft-${index}`, repo: "octo/hello", repoId: "github/octo/hello", title: draft.title, prompt: "Do it.", acceptance: ["Passes"],
          answerId: draft.answered ? `answer-${index}` : null, createdAt: 1_762_000_000_000 + index, ...(draft.issue === null ? {} : { issue: draft.issue }),
        }))
        const requested: ReadonlyArray<Row> = input.requested.map((change, index) => ({
          id: `op-${index}`, repo: "octo/hello", op: change.drop ? "drop" : "commit", title: change.drop ? "" : change.title, prompt: change.drop ? "" : "Do it.",
          acceptance: [], number: change.drop ? change.number : 0, repoId: "github/octo/hello", queuedAt: 1_762_000_000_000 + index,
          status: change.refused ? "not_sent" : "requested", reason: change.refused ? "forbidden" : null, taken: change.refused ? null : change.number,
          ...(input.requestedAt >= 4 ? { answeredAt: 1_762_000_000_500 + index } : {}),
        }))
        // Rows no version's schema reads, as a crashed or foreign writer could leave them. This build's own version is
        // opened as stored, so they are left out of a store already current.
        const broken = (prefix: string, sound: Row): ReadonlyArray<Row> =>
          input.damaged.map((damage, index) => {
            const id = `${prefix}-damaged-${index}`
            const { title: _title, ...untitled } = sound
            return damage === "field-missing" ? { ...untitled, id } : damage === "field-mistyped" ? { ...sound, id, title: 7 }
              : damage === "only-a-key" ? { id } : { ...sound, id, acceptance: null }
          })
        const draftSample: Row = { id: "", repo: "octo/hello", repoId: "github/octo/hello", title: "t", prompt: "p", acceptance: [], answerId: null, createdAt: 1 }
        const requestedSample: Row = { ...draftSample, op: "commit", number: 0, queuedAt: 1, status: "requested", reason: null, taken: 1 }
        const brokenDrafts = input.draftsAt === TodoDraftsStore.schemaVersion ? [] : broken("draft", draftSample)
        const brokenRequested = input.requestedAt === TodoRequestedStore.schemaVersion ? [] : broken("op", requestedSample)

        const { path } = yield* Effect.promise(() =>
          deviceFrom({
            build: "fuzz",
            collections: {
              "todo-drafts": { kind: "local", key: "id", version: input.draftsAt, rows: [...drafts, ...brokenDrafts] },
              "todo-requested": { kind: "local", key: "id", version: input.requestedAt, rows: [...requested, ...brokenRequested] },
            },
            outbox: {},
          }))
        const report = yield* Effect.promise(() => prepare(path, deviceRegistry))

        const expected = (store: { readonly id: string; readonly schemaVersion: number }, at: number, sound: number, damaged: number) =>
          at === store.schemaVersion
            ? `${store.id} current ${at}→${store.schemaVersion} migrated 0 kept 0`
            : at > store.schemaVersion
            ? `${store.id} reset ${at}→${store.schemaVersion} migrated 0 kept ${sound + damaged}`
            : `${store.id} migrated ${at}→${store.schemaVersion} migrated ${sound} kept ${damaged}`
        const lines = report.collections.map((each) => `${each.collection} ${each.outcome} ${each.from}→${String(each.to)} migrated ${each.migrated} kept ${each.kept}`).sort()
        must(same(lines, [
          expected(TodoDraftsStore, input.draftsAt, drafts.length, brokenDrafts.length),
          expected(TodoRequestedStore, input.requestedAt, requested.length, brokenRequested.length),
        ]), `the report says ${lines.join("; ")}`)
        must(report.collections.every((each) => each.dropped === 0), "a store that keeps its rows dropped one")

        // What the app opens: every sound row of an older build as it was; nothing of a newer build's.
        const openDrafts = yield* opened(path, TodoDraftsStore)
        const openRequested = yield* opened(path, TodoRequestedStore)
        must(same(byId(openDrafts), input.draftsAt > TodoDraftsStore.schemaVersion ? [] : byId(drafts)), "the drafts the app opens are not the sound ones")
        must(same(byId(openRequested), input.requestedAt > TodoRequestedStore.schemaVersion ? [] : byId(requested)), "the changes the app opens are not the sound ones")
        must(openDrafts.every(Schema.is(TodoDraft)) && openRequested.every(Schema.is(TodoRequested)), "an opened row is not this build's shape")

        // What was set aside: each row that could not come forward, once, by why.
        const aside = (id: string, at: number, version: number, sound: ReadonlyArray<Row>, damaged: ReadonlyArray<Row>) =>
          at > version ? [...sound, ...damaged].map((row) => `${id}/${String(row["id"])}/newer`) : damaged.map((row) => `${id}/${String(row["id"])}/decode`)
        const kept = (yield* Effect.promise(() => keptRows(path))).map((row) => `${row.collection_id}/${row.key.replace(/^s:/, "")}/${row.reason}`).sort()
        const expectedKept = [
          ...aside("todo-drafts", input.draftsAt, TodoDraftsStore.schemaVersion, drafts, brokenDrafts),
          ...aside("todo-requested", input.requestedAt, TodoRequestedStore.schemaVersion, requested, brokenRequested),
        ].sort()
        must(same(kept, expectedKept), `set aside ${kept.join(", ")}; expected ${expectedKept.join(", ")}`)

        // Idempotent: a second run finds every collection current and sets nothing more aside.
        const again = yield* Effect.promise(() => prepare(path, deviceRegistry))
        must(again.collections.every((each) => each.outcome === "current" && each.migrated + each.kept + each.dropped === 0), "a second run migrated again")
        must(same((yield* Effect.promise(() => keptRows(path))).length, expectedKept.length), "a second run set more rows aside")
        must(same(byId(yield* opened(path, TodoDraftsStore)), byId(openDrafts)), "a second run changed the drafts")
        return true
      }), ioExecutions)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Which store a collection belongs to, and which a repository's refusal wipes
// ---------------------------------------------------------------------------------------------------------------------

describe("the device's stores by repository", () => {
  const families = deviceRegistry.stores.flatMap((store) => store._tag === "Synced" && store.family ? [store] : [])

  it("every store is classified once: wiped with its repository, held in memory, unscoped, or named by something else", () => {
    const lists = [[...REPOSITORY_STORES], [...REPOSITORY_MEMORY], Object.keys(UNSCOPED_LOCAL), Object.keys(UNWIPED_FAMILIES)]
    const all = lists.flat()
    expect(all.filter((id, index) => all.indexOf(id) !== index)).toEqual([])
    const ids = deviceRegistry.stores.map((store) => store.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    // A store kept per repository is a synced family, or a cache this build may delete; and each is declared.
    for (const id of REPOSITORY_STORES) {
      const store = deviceRegistry.stores.find((each) => each.id === id)
      expect([id, store === undefined ? "undeclared" : store._tag === "Synced" ? store.family : store.discard]).toEqual([id, true])
    }
    for (const family of families) {
      expect([family.id, REPOSITORY_STORES.includes(family.id as never) !== (family.id in UNWIPED_FAMILIES)]).toEqual([family.id, true])
    }
    for (const reason of [...Object.values(UNSCOPED_LOCAL), ...Object.values(UNWIPED_FAMILIES)]) expect(reason.length).toBeGreaterThan(5)
  })

  it("a collection belongs to exactly its own store whatever its repository is called, at exactly its declared version and kind", async () => {
    const hostile = ["", ":", "a:b", "octo/hello", "../..", "\u0000", "todos", "todos:", "issue-items:github/octo/hello", "%", "é", "__proto__", " "]
    const arbitrary = Arbitrary.schema(Schema.Struct({
      store: int(0, deviceRegistry.stores.length - 1),
      other: int(0, deviceRegistry.stores.length - 1),
      owner: Schema.String.check(Schema.isMaxLength(24)),
      name: Schema.NullOr(int(0, hostile.length - 1)),
      skew: int(-3, 3),
      kind: Schema.Literals(["local", "synced"]),
    }))
    await holds(arbitrary, (input) =>
      Effect.sync(() => {
        const store = deviceRegistry.stores[input.store] ?? TodoDraftsStore
        const other = deviceRegistry.stores[input.other] ?? TodoDraftsStore
        const repository = repoId(input.owner, input.name === null ? "hello" : hostile[input.name] ?? "")
        const member = `${store.id}:${repository}`
        const isFamily = store._tag === "Synced" && store.family
        must(Migrations.declarationOf(deviceRegistry, store.id) === store, `${store.id} is not its own declaration`)
        // Only a family has members, and a member is its own family's, never another store's.
        must(Migrations.declarationOf(deviceRegistry, member) === (isFamily ? store : undefined), `${member.slice(0, 60)} belongs to another declaration`)
        if (store._tag === "Synced") must(Migrations.member(store, repository) === member, "a member's id is not its family and name")
        if (other !== store) {
          must(Migrations.declarationOf(deviceRegistry, `${other.id}:${repository}`) !== store, `${store.id} claims ${other.id}'s member`)
          must(`${other.id}:${repository}` !== member, "two stores share a member's id")
        }
        // A collection opens only at its declared version and kind (the app's Persistence refuses any other).
        const version = store.schemaVersion + input.skew
        const collection = isFamily ? member : store.id
        const refusal = Migrations.declared(deviceRegistry, collection, input.kind, version)
        const matches = input.skew === 0 && (store._tag === "Local") === (input.kind === "local")
        must((refusal === undefined) === matches, `${store.id} at ${version} as ${input.kind}: ${refusal === undefined ? "opens" : "refused"}`)
        if (refusal !== undefined) must(refusal.collection === collection && refusal.schemaVersion === version && refusal.kind === input.kind, "the refusal names another collection")
        // A retired store never opens, at any version.
        for (const retired of deviceRegistry.retired) {
          must(Migrations.declarationOf(deviceRegistry, retired.id)?._tag === "Retired", `${retired.id} is not retired`)
          must(Migrations.declared(deviceRegistry, retired.id, input.kind, retired.schemaVersion + input.skew) !== undefined, `${retired.id} opens`)
        }
        return true
      }), pureExecutions)
  })
})
