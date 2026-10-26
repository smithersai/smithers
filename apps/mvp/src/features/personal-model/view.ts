import { mayAsk, type Role } from "../auth/contract"
import { MODEL_TIERS, type ModelTier } from "../model/contract"
import { hostOf, type Protocol, PROTOCOLS, type Refusal, resolveTier, type SavedKey, TIER_FIELDS } from "./contract"
import { codeText, LATE, OK, REFUSAL_COPY, REMOVING, SAVING, UNKNOWN } from "./copy"
import type { Form, Hidden, PersonalModelRow, TestResult, TestRow } from "./schema"

// What the Your model section and its toast show, as pure rules their views read
// (docs/features/personal-model.md#the-settings-section). ChatApi is the authority on every write and on the rows;
// these only decide which controls, values and words show, and what the form sends.

/** Who the session says is signed in: sign-in's row (src/features/auth/schema.ts `Session`). */
export interface Reader {
  readonly status: string
  readonly role: Role | null
}

/** Whether a person may save and test a model of their own: signed in as a Member or above, who may ask Smithers. */
export const canSave = (session: Reader | undefined): boolean =>
  session !== undefined && session.status === "signed_in" && mayAsk(session.role)


/** Whether a write is on its way: sent, or taken and not yet in the rows. A second one waits. */
export const onItsWay = (form: Pick<Form, "state">): boolean => form.state === "sending" || form.state === "confirming"

/** Whether the rows may still show a write landing: taken, late, or of unknown outcome. */
export const awaiting = (form: Pick<Form, "state">): boolean =>
  form.state === "confirming" || form.state === "late" || form.state === "unknown"

/** The rows' latest `updatedAt`, `null` with none: what a save remembers as `before`. */
export const latestUpdate = (rows: ReadonlyArray<PersonalModelRow>): string | null =>
  rows.reduce<string | null>((latest, row) => latest === null || row.updatedAt > latest ? row.updatedAt : latest, null)

/**
 * Whether the rows show a write landed: a remove, once there are none; a save, once there is a row for each key it sent,
 * at its base URL, and no other, each row's tiers' models are the ones it sent for that key, and the latest
 * `updatedAt` is another than the one before it was sent. The server's clock is never compared with this device's.
 */
export const landed = (form: Pick<Form, "op" | "before" | "sent">, rows: ReadonlyArray<PersonalModelRow>): boolean => {
  if (form.op === "remove") return rows.length === 0
  const sent = form.sent
  if (sent === null || rows.length !== sent.keys.length || latestUpdate(rows) === form.before) return false
  return sent.keys.every(({ protocol, baseUrl }) => {
    const row = rows.find((each) => each.protocol === protocol)
    return row !== undefined && row.baseUrl === baseUrl && MODEL_TIERS.every((tier) => {
      const choice = sent.models[tier]
      return row[TIER_FIELDS[tier]] === (choice?.protocol === protocol ? choice.modelId : null)
    })
  })
}

/** The saved key of `protocol`, if the person saved one. */
export const keyOf = (rows: ReadonlyArray<PersonalModelRow>, protocol: Protocol): PersonalModelRow | undefined =>
  rows.find((row) => row.protocol === protocol)

/**
 * What a tier's fields show: the model the person named for it (`model`, `""` when none), the model it uses when its
 * field is left empty (`placeholder`: a preset or the tier it falls back to; none when nothing would answer it), and
 * the key its select starts on: the named model's, else the one it would use, else the first saved key, else the
 * first protocol.
 */
export const tierView = (
  rows: ReadonlyArray<PersonalModelRow>,
  tier: ModelTier,
): { readonly model: string; readonly placeholder: string | undefined; readonly protocol: Protocol } => {
  const field = TIER_FIELDS[tier]
  const named = rows.find((row) => row[field] !== null)
  // What the tier uses with its field left empty: the same keys, none naming it.
  const unnamed = resolveTier(rows.map((row): SavedKey => ({
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    fastModel: tier === "fast" ? null : row.fastModel,
    implementModel: tier === "implement" ? null : row.implementModel,
    hardModel: tier === "hard" ? null : row.hardModel,
  })), tier)
  return {
    model: named?.[field] ?? "",
    placeholder: unnamed?.modelId,
    protocol: named?.protocol ?? unnamed?.protocol ?? PROTOCOLS.find((protocol) => keyOf(rows, protocol)) ??
      PROTOCOLS[0],
  }
}

/** The form's field names: each protocol's base URL and key, and each tier's model and key. */
export const FIELDS = {
  baseUrl: (protocol: Protocol) => `baseUrl:${protocol}`,
  key: (protocol: Protocol) => `key:${protocol}`,
  model: (tier: ModelTier) => `${tier}Model`,
  tierKey: (tier: ModelTier) => `${tier}Key`,
} as const

/** What Save sends from the form: each key whose base URL was filled in, and each tier whose model was. */
export interface SaveForm {
  readonly keys: ReadonlyArray<{ readonly protocol: string; readonly baseUrl: string; readonly key: string }>
  readonly models: Readonly<Record<string, { readonly protocol: string; readonly modelId: string }>>
}

/**
 * The save the form says, its fields read by `field` (`""` for a missing one): every protocol whose base URL is filled
 * in, with its key (`""` keeps the saved one), and every tier whose model is filled in, on the key its select names.
 */
export const readForm = (field: (name: string) => string): SaveForm => ({
  keys: PROTOCOLS.flatMap((protocol) => {
    const baseUrl = field(FIELDS.baseUrl(protocol))
    return baseUrl.trim() === "" ? [] : [{ protocol, baseUrl, key: field(FIELDS.key(protocol)) }]
  }),
  models: Object.fromEntries(MODEL_TIERS.flatMap((tier): Array<readonly [ModelTier, SaveForm["models"][string]]> => {
    const modelId = field(FIELDS.model(tier))
    return modelId.trim() === "" ? [] : [[tier, { protocol: field(FIELDS.tierKey(tier)), modelId }]]
  })),
})

/** A test's result in words: `OK`, `<host> · HTTP <status>`, or `<host> · <why>` when there was no status. */
export const testText = (result: TestResult): string => {
  if (result.ok) return OK
  return result.status === null ? `${result.host} · ${codeText(result.code)}` : `${result.host} · HTTP ${result.status}`
}

/** A refusal's phrase. */
export const refusalText = (refusal: Refusal): string => REFUSAL_COPY[refusal]

/**
 * What the one status line says: words (`text`), or a saved key's failure with when it happened (`failure`, `at` in epoch
 * milliseconds), or nothing.
 */
export type Status =
  | { readonly _tag: "None" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Failure"; readonly text: string; readonly at: number }

const none: Status = { _tag: "None" }
const text = (words: string): Status => ({ _tag: "Text", text: words })

/** The saved key whose last refusal is the latest, with its status and when; none while no key has one. */
export const lastFailure = (
  rows: ReadonlyArray<PersonalModelRow>,
): { readonly host: string; readonly status: number; readonly failedAt: string } | undefined =>
  rows.reduce<{ readonly host: string; readonly status: number; readonly failedAt: string } | undefined>(
    (latest, row) =>
      row.failureStatus === null || row.failedAt === null || (latest !== undefined && latest.failedAt >= row.failedAt)
        ? latest
        : { host: hostOf(row.baseUrl), status: row.failureStatus, failedAt: row.failedAt },
    undefined,
  )

/** The latest refusal of a saved key: `<host> refused · HTTP <status>`, at `failedAt`; nothing while no key has one. */
const failureOf = (rows: ReadonlyArray<PersonalModelRow>): Status => {
  const failure = lastFailure(rows)
  return failure === undefined
    ? none
    : { _tag: "Failure", text: `${failure.host} refused · HTTP ${failure.status}`, at: Date.parse(failure.failedAt) }
}

/**
 * The status line, the latest first: a save on its way says `Saving`, a remove `Removing`; the last write's refusal, unknown outcome or
 * lateness says so, unless a test came since (`quiet`); then the last test's result or refusal, unless a row records
 * a failure newer than it (a real call that failed since); then the latest row's failure.
 */
export const statusOf = (
  rows: ReadonlyArray<PersonalModelRow>,
  form: Form | undefined,
  test: TestRow | undefined,
): Status => {
  if (form !== undefined && !form.quiet) {
    if (onItsWay(form)) return text(form.op === "save" ? SAVING : REMOVING)
    if (form.state === "failed" && form.failure !== null) return text(refusalText(form.failure))
    if (form.state === "unknown") return text(UNKNOWN)
    if (form.state === "late") return text(LATE)
  }
  const failure = failureOf(rows)
  const newer = failure._tag === "Failure" && lastFailure(rows)!.failedAt !== test?.failedAt
  if (test !== undefined && !newer) {
    if (test.state === "done" && test.result !== null) return text(testText(test.result))
    if (test.state === "failed" && test.failure !== null) return text(refusalText(test.failure))
  }
  return failure
}

/** Whether the buttons wait: a write is on its way, or a test runs. */
export const busy = (form: Form | undefined, test: TestRow | undefined): boolean =>
  (form !== undefined && onItsWay(form)) || test?.state === "testing"

/** The toast a failure shows: its detail, `<host> · HTTP <status>`, and the `failedAt` its Hide marks. */
export interface FailureToast {
  readonly detail: string
  readonly failedAt: string
}

/**
 * The failure toast: while one of the signed-in person's rows records a failure this device hasn't hidden, the latest.
 * Hiding marks that `failedAt`, so the next failure shows again.
 */
export const toastOf = (
  session: Reader | undefined,
  rows: ReadonlyArray<PersonalModelRow>,
  hidden: Hidden | undefined,
): FailureToast | undefined => {
  const failure = lastFailure(rows)
  if (session?.status !== "signed_in" || failure === undefined || hidden?.failedAt === failure.failedAt) return undefined
  return { detail: `${failure.host} · HTTP ${failure.status}`, failedAt: failure.failedAt }
}
