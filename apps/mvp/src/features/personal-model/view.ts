import { mayAsk, type Role } from "../auth/contract"
import { hostOf, type Refusal } from "./contract"
import { codeText, LATE, OK, REFUSAL_COPY, SAVING, UNKNOWN } from "./copy"
import type { Form, Hidden, PersonalModelRow, TestResult, TestRow } from "./schema"

// What the Your model section and its toast show, as pure rules their views read
// (docs/features/personal-model.md#the-settings-section). ChatApi is the authority on every write and on the row;
// these only decide which controls and words show.

/** Who the session says is signed in: sign-in's row (src/features/auth/schema.ts `Session`). */
export interface Reader {
  readonly status: string
  readonly role: Role | null
}

/** Whether the section shows: to a person signed in as a Member or above, who may ask Smithers. */
export const showsSection = (session: Reader | undefined): boolean =>
  session !== undefined && session.status === "signed_in" && mayAsk(session.role)

/** Whether a write is on its way: sent, or taken and not yet in the row. A second one waits. */
export const onItsWay = (form: Pick<Form, "state">): boolean => form.state === "sending" || form.state === "confirming"

/** Whether the row may still show a write landing: taken, late, or of unknown outcome. */
export const awaiting = (form: Pick<Form, "state">): boolean =>
  form.state === "confirming" || form.state === "late" || form.state === "unknown"

/**
 * Whether the row shows a write landed: a remove, once there is no row; a save, once the row is there with what it
 * sent and an `updatedAt` other than the one before it was sent. The server's clock is never compared with this
 * device's.
 */
export const landed = (form: Pick<Form, "op" | "before" | "sent">, row: PersonalModelRow | undefined): boolean => {
  if (form.op === "remove") return row === undefined
  return row !== undefined && row.updatedAt !== form.before && form.sent !== null &&
    row.protocol === form.sent.protocol && row.baseUrl === form.sent.baseUrl && row.modelId === form.sent.modelId
}

/** A test's result in words: `OK`, `<host> · HTTP <status>`, or `<host> · <why>` when there was no status. */
export const testText = (result: TestResult): string => {
  if (result.ok) return OK
  return result.status === null ? `${result.host} · ${codeText(result.code)}` : `${result.host} · HTTP ${result.status}`
}

/** A refusal's phrase. */
export const refusalText = (refusal: Refusal): string => REFUSAL_COPY[refusal]

/**
 * What the one status line says: words (`text`), or the row's failure with when it happened (`failure`, `at` in epoch
 * milliseconds), or nothing.
 */
export type Status =
  | { readonly _tag: "None" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Failure"; readonly text: string; readonly at: number }

const none: Status = { _tag: "None" }
const text = (words: string): Status => ({ _tag: "Text", text: words })

/** The row's failure: `<host> refused · HTTP <status>`, at `failedAt`; nothing while the row has none. */
const failureOf = (row: PersonalModelRow | undefined): Status =>
  row === undefined || row.failureStatus === null || row.failedAt === null
    ? none
    : { _tag: "Failure", text: `${hostOf(row.baseUrl)} refused · HTTP ${row.failureStatus}`, at: Date.parse(row.failedAt) }

/**
 * The status line, the latest first: a save on its way says `Saving`; the last write's refusal, unknown outcome or
 * lateness says so, unless a test came since (`quiet`); then the last test's result or refusal, unless the row records
 * a failure newer than it (a real call that failed since); then the row's failure.
 */
export const statusOf = (
  row: PersonalModelRow | undefined,
  form: Form | undefined,
  test: TestRow | undefined,
): Status => {
  if (form !== undefined && !form.quiet) {
    if (form.op === "save" && onItsWay(form)) return text(SAVING)
    if (form.state === "failed" && form.failure !== null) return text(refusalText(form.failure))
    if (form.state === "unknown") return text(UNKNOWN)
    if (form.state === "late") return text(LATE)
  }
  const failure = failureOf(row)
  const newer = failure._tag === "Failure" && row!.failedAt !== test?.failedAt
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
 * The failure toast: while the signed-in person's row records a failure this device hasn't hidden. Hiding marks that
 * `failedAt`, so the next failure shows again.
 */
export const toastOf = (
  session: Reader | undefined,
  row: PersonalModelRow | undefined,
  hidden: Hidden | undefined,
): FailureToast | undefined => {
  if (session?.status !== "signed_in" || row === undefined || row.failureStatus === null || row.failedAt === null) {
    return undefined
  }
  if (hidden?.failedAt === row.failedAt) return undefined
  return { detail: `${hostOf(row.baseUrl)} · HTTP ${row.failureStatus}`, failedAt: row.failedAt }
}
