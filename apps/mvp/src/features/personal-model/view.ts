import type { Role } from "../auth/contract"
import { MODEL_TIERS, type ModelTier } from "../model/contract"
import {
  type ConnectionKind,
  type ConnectionPut,
  DEFAULTS,
  type Defaults,
  hostOf,
  MODEL_KINDS,
  type ModelsPut,
  type Refusal,
  resolveTier,
  type SavedConnection,
  SINGLE_KINDS,
  TIER_FIELDS,
} from "./contract"
import { codeText, KIND_LABEL, keyPlaceholder, LATE, LINK_EXPIRED, LINK_WAITING, OK, REFUSAL_COPY, REMOVING, SAVING, UNKNOWN } from "./copy"
import type { AddView, Form, LinkRow, PersonalModelRow, TestResult, TestRow } from "./schema"

// What the Your model section shows, as pure rules its views read
// (docs/features/personal-model.md#the-settings-section). ChatApi is the authority on every write and on the rows;
// these only decide which controls, values and words show, and what each press sends: always the whole list.

/** Who the session says is signed in: sign-in's row (src/features/auth/schema.ts `Session`). */
export interface Reader {
  readonly status: string
  readonly role: Role | null
}

/** Whether a person may save and test a model of their own: anyone signed in, since it is their key (ruling AUTH-8). */
export const canSave = (session: Reader | undefined): boolean =>
  session !== undefined && session.status === "signed_in"


/** Whether a write is on its way: sent, or taken and not yet in the rows. A second one waits. */
export const onItsWay = (form: Pick<Form, "state">): boolean => form.state === "sending" || form.state === "confirming"

/** Whether the rows may still show a write landing: taken, late, or of unknown outcome. */
export const awaiting = (form: Pick<Form, "state">): boolean =>
  form.state === "confirming" || form.state === "late" || form.state === "unknown"

/** The rows' latest `updatedAt`, `null` with none: what a save remembers as `before`. */
export const latestUpdate = (rows: ReadonlyArray<PersonalModelRow>): string | null =>
  rows.reduce<string | null>((latest, row) => latest === null || row.updatedAt > latest ? row.updatedAt : latest, null)

/**
 * Whether the rows show a write landed: a remove, once there are none; a save, once the rows are the connections it
 * sent, in its order, and the latest `updatedAt` is another than the one before it was sent. A new connection has no id
 * to compare yet, and a Kimi connection's endpoint and models are the server's. The server's clock is never compared
 * with this device's.
 */
export const landed = (form: Pick<Form, "op" | "before" | "sent">, rows: ReadonlyArray<PersonalModelRow>): boolean => {
  if (form.op === "remove") return rows.length === 0
  const sent = form.sent
  if (sent === null || rows.length !== sent.connections.length || latestUpdate(rows) === form.before) return false
  return sent.connections.every((connection, index) => {
    const row = rows[index]!
    if (row.kind !== connection.kind || row.active !== connection.active) return false
    if (connection.id !== null && row.id !== connection.id) return false
    if (connection.kind === "moonshot") return true
    return row.protocol === connection.protocol && row.baseUrl === connection.baseUrl &&
      MODEL_TIERS.every((tier) => row[TIER_FIELDS[tier]] === (connection.models[tier] ?? null))
  })
}

/** The latest `updatedAt` of the person's Codex rows: what a link remembers as `before`. */
export const latestLink = (rows: ReadonlyArray<PersonalModelRow>): string | null =>
  latestUpdate(rows.filter((row) => row.kind === "codex_subscription"))

/** Whether a link waiting shows in the rows: a Codex row written since it started. */
export const linked = (link: Pick<LinkRow, "state" | "before">, rows: ReadonlyArray<PersonalModelRow>): boolean => {
  if (link.state !== "waiting") return false
  const latest = latestLink(rows)
  return latest !== null && latest !== link.before
}

/** Whether any tier resolves to a model: what the composer needs of a person's own connections. */
export const answers = (rows: ReadonlyArray<SavedConnection>): boolean => resolveTier(rows, "fast") !== undefined

/**
 * The defaults a check of the saved list needs: a saved Kimi connection's endpoint, which the deployment chose, so a
 * connection kept keeps its credential whatever endpoint this build's `DEFAULTS` name.
 */
export const defaultsFrom = (rows: ReadonlyArray<Pick<SavedConnection, "kind" | "baseUrl">>): Defaults => {
  const baseUrl = rows.find((row) => row.kind === "moonshot")?.baseUrl ?? DEFAULTS.moonshot.baseUrl
  return { moonshot: { ...DEFAULTS.moonshot, baseUrl } }
}

/** What Save sends: the whole list, in the person's order. A key is `""` or absent where the saved one stays. */
export type SaveForm = ModelsPut

/** A saved connection as a save keeps it: no credential, and only the fields its kind carries. */
const keptOf = (row: PersonalModelRow): ConnectionPut => {
  const models = Object.fromEntries(MODEL_TIERS.flatMap((tier) => {
    const model = row[TIER_FIELDS[tier]]
    return model === null ? [] : [[tier, model]]
  }))
  return {
    id: row.id,
    kind: row.kind,
    active: row.active,
    ...(row.kind === "api_key" ? { protocol: row.protocol! } : {}),
    ...(row.baseUrl === null || row.kind === "moonshot" ? {} : { baseUrl: row.baseUrl }),
    ...(MODEL_KINDS.includes(row.kind) ? { models } : {}),
  }
}

/** The saved list as a save sends it, each credential kept. */
export const listOf = (rows: ReadonlyArray<PersonalModelRow>): ReadonlyArray<ConnectionPut> => rows.map(keptOf)

/** `list` with no other active connection of `connection`'s kind when that kind allows one active. */
const single = (list: ReadonlyArray<ConnectionPut>, connection: ConnectionPut) =>
  (connection.active ?? true) && SINGLE_KINDS.includes(connection.kind as ConnectionKind)
    ? list.map((each) => (each.kind === connection.kind && each.id !== connection.id ? { ...each, active: false } : each))
    : list

/** `list` with `added` last. */
export const withAdded = (list: ReadonlyArray<ConnectionPut>, added: ConnectionPut): ReadonlyArray<ConnectionPut> => [
  ...single(list, added),
  added,
]

/** `list` with `id` active or not. Turning on a kind that allows one active turns its other one off. */
export const withActive = (list: ReadonlyArray<ConnectionPut>, id: string, active: boolean): ReadonlyArray<ConnectionPut> => {
  const next = list.map((each) => (each.id === id ? { ...each, active } : each))
  return single(next, next.find((each) => each.id === id)!)
}

/** `list` with `id` moved one place, up (`-1`) or down (`1`); as it was at either end. */
export const withMoved = (list: ReadonlyArray<ConnectionPut>, id: string, by: -1 | 1): ReadonlyArray<ConnectionPut> => {
  const from = list.findIndex((each) => each.id === id)
  const to = from + by
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  next[from] = list[to]!
  next[to] = list[from]!
  return next
}

/** `list` without `id`. */
export const without = (list: ReadonlyArray<ConnectionPut>, id: string): ReadonlyArray<ConnectionPut> =>
  list.filter((each) => each.id !== id)

/** The Add form's field names. */
export const FIELDS = {
  protocol: "protocol",
  baseUrl: "baseUrl",
  key: "key",
  model: (tier: ModelTier) => `${tier}Model`,
} as const

/** The connection a kind's Add form says, its fields read by `field` (`""` for a missing one). */
export const readAdd = (kind: ConnectionKind, field: (name: string) => string): ConnectionPut => {
  if (kind !== "api_key") return { kind, key: field(FIELDS.key) }
  return {
    kind,
    protocol: field(FIELDS.protocol),
    baseUrl: field(FIELDS.baseUrl),
    key: field(FIELDS.key),
    models: Object.fromEntries(MODEL_TIERS.flatMap((tier) => {
      const modelId = field(FIELDS.model(tier))
      return modelId.trim() === "" ? [] : [[tier, modelId]]
    })),
  }
}

/** Whether a row shows Test: a Claude subscription can't be checked from here. */
export const testable = (row: Pick<PersonalModelRow, "kind">): boolean => row.kind !== "claude_subscription"

/** The form Add shows: its kind, or none for nothing or the menu. */
export const addKind = (view: AddView | undefined): ConnectionKind | undefined =>
  view === undefined || view === "closed" || view === "menu" ? undefined : view

/** What identifies a row after its kind: its host, else its credential's last characters. */
export const rowDetail = (row: Pick<PersonalModelRow, "baseUrl" | "keyLast4">): string =>
  row.baseUrl === null ? keyPlaceholder(row.keyLast4) : hostOf(row.baseUrl)

/** A test's result in words: `OK`, `<host> · HTTP <status>`, or `<host> · <why>` when there was no status. */
export const testText = (result: TestResult): string => {
  if (result.ok) return OK
  return result.status === null ? `${result.host} · ${codeText(result.code)}` : `${result.host} · HTTP ${result.status}`
}

/** A refusal's phrase. */
export const refusalText = (refusal: Refusal | "unsaved"): string => REFUSAL_COPY[refusal]

/**
 * What a status line says: words (`text`), or a saved connection's failure with when it happened (`failure`, `at` in
 * epoch milliseconds), or nothing.
 */
export type Status =
  | { readonly _tag: "None" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Failure"; readonly text: string; readonly at: number }

const none: Status = { _tag: "None" }
const text = (words: string): Status => ({ _tag: "Text", text: words })

/** A test's outcome in words; nothing while it runs. */
const testStatus = (test: TestRow): Status => {
  if (test.state === "done" && test.result !== null) return text(testText(test.result))
  if (test.state === "failed" && test.failure !== null) return text(refusalText(test.failure))
  return none
}

/** The row's last refusal, by its host, else its kind: `<name> refused · HTTP <status>`, at `failedAt`. */
const failureOf = (row: PersonalModelRow): Status =>
  row.failureStatus === null || row.failedAt === null
    ? none
    : {
      _tag: "Failure",
      text: `${row.baseUrl === null ? KIND_LABEL[row.kind] : hostOf(row.baseUrl)} refused · HTTP ${row.failureStatus}`,
      at: Date.parse(row.failedAt),
    }

/**
 * A row's refusal line: the last test of it, unless the row records a failure newer than it (a real call that failed
 * since); then the row's failure.
 */
export const rowStatusOf = (row: PersonalModelRow, test: TestRow | undefined): Status => {
  const failure = failureOf(row)
  if (test === undefined || test.connection !== row.id) return failure
  const tested = testStatus(test)
  return tested._tag === "None" || (failure._tag === "Failure" && row.failedAt !== test.failedAt) ? failure : tested
}

/**
 * The section's status line: a save on its way says `Saving`, a remove `Removing`; the last write's refusal, unknown
 * outcome or lateness says so, unless a test or a dialog came since (`quiet`); then a test of no one connection.
 */
export const statusOf = (form: Form | undefined, test: TestRow | undefined): Status => {
  if (form !== undefined && !form.quiet) {
    if (onItsWay(form)) return text(form.op === "save" ? SAVING : REMOVING)
    if (form.state === "failed" && form.failure !== null) return text(refusalText(form.failure))
    if (form.state === "unknown") return text(UNKNOWN)
    if (form.state === "late") return text(LATE)
  }
  return test === undefined || test.connection !== null ? none : testStatus(test)
}

/** What a Codex link shows: the code while it waits, what a press may do, and its status line. */
export const linkView = (link: LinkRow | undefined): {
  readonly code: { readonly userCode: string; readonly verificationUrl: string } | undefined
  readonly canLink: boolean
  readonly status: string | undefined
} => {
  if (link?.state === "waiting") {
    return { code: { userCode: link.userCode!, verificationUrl: link.verificationUrl! }, canLink: false, status: LINK_WAITING }
  }
  if (link?.state === "starting") return { code: undefined, canLink: false, status: undefined }
  if (link?.state === "expired") return { code: undefined, canLink: true, status: LINK_EXPIRED }
  if (link?.state === "failed") return { code: undefined, canLink: true, status: refusalText(link.failure!) }
  return { code: undefined, canLink: true, status: undefined }
}

/** Whether the buttons wait: a write is on its way, or a test runs. */
export const busy = (form: Form | undefined, test: TestRow | undefined): boolean =>
  (form !== undefined && onItsWay(form)) || test?.state === "testing"
