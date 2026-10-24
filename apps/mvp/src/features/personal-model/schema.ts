import { Schema } from "effect"
import { PROTOCOLS, REFUSALS, type TestResult as ContractTestResult } from "./contract"

// A person's own model on the tab (decision 0096, docs/features/personal-model.md), as the Effect Schemas its
// collections check rows with. No row has a field for a key: the key lives in the form's password field until Save,
// then in one request (actions.ts). The synced row matches `PERSONAL_MODEL_SHAPE_COLUMNS`, camelCased; its times are
// ISO 8601. A row kept on the device is read by the next version of the app too: change its shape only with its
// collection's `schemaVersion` (src/device/registry.ts).

/** The person's own row of Postgres `personal_models` as the shape sends it: where their model answers, never its key. */
export const PersonalModelRow = Schema.Struct({
  personId: Schema.String,
  protocol: Schema.Literals(PROTOCOLS),
  baseUrl: Schema.String,
  modelId: Schema.String,
  /** The key's last characters: all the browser sees of it again. */
  keyLast4: Schema.String,
  /** The provider's status when the person's key was last refused or ran out on a real call; `null` since a success. */
  failureStatus: Schema.NullOr(Schema.Number),
  failedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})
export type PersonalModelRow = typeof PersonalModelRow.Type

/** What `POST /api/me/model/test` answers (contract.ts `TestResult`): `model/test`'s success. */
export const TestResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), latencyMs: Schema.Number, sample: Schema.String }),
  Schema.Struct({
    ok: Schema.Literal(false),
    latencyMs: Schema.Number,
    code: Schema.String,
    status: Schema.NullOr(Schema.Number),
    host: Schema.String,
  }),
])
export type TestResult = typeof TestResult.Type

/** Whether two types are the same, both ways. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** The schema decodes exactly the contract's type: the compiler refuses this line if either drifts. */
export const testResultMatchesContract: Same<TestResult, ContractTestResult> = true

/** `model/remove`'s success. */
export const Removed = Schema.Struct({ removed: Schema.Literal(true) })
export type Removed = typeof Removed.Type

/** Why ChatApi refused a write or a test: one of its `REFUSALS`. */
export const Refusal = Schema.Literals(REFUSALS)

/** The one form row's key, and the one test row's. */
export const FORM = "form"
export const TEST = "test"

/**
 * Where the form's last write is: `sending` until ChatApi answers (a remove: until its flow ends); `confirming` once it
 * took it until the synced row shows it landed; `late` when that took longer than the deadline; `done` once it landed;
 * `failed` when refused (`failure`); `unknown` when no whole answer came, so it may or may not have landed.
 */
export const FormState = Schema.Literals(["sending", "confirming", "late", "done", "failed", "unknown"])
export type FormState = typeof FormState.Type

/** What a save sent, to tell its row from another: never the key. */
export const Sent = Schema.Struct({ protocol: Schema.Literals(PROTOCOLS), baseUrl: Schema.String, modelId: Schema.String })
export type Sent = typeof Sent.Type

/**
 * The form's last write on this tab: Save (`save`) or Remove (`remove`), where it is, why it was refused, the row's
 * `updatedAt` before it was sent (`before`, `null` with no row), what a save sent, how many writes ChatApi took
 * (`saved`), which keys the form, so a taken save clears its key field, and whether a test since took the status line
 * (`quiet`). Never the key.
 */
export const Form = Schema.Struct({
  id: Schema.String,
  op: Schema.Literals(["save", "remove"]),
  state: FormState,
  failure: Schema.NullOr(Refusal),
  before: Schema.NullOr(Schema.String),
  sent: Schema.NullOr(Sent),
  saved: Schema.Number,
  quiet: Schema.Boolean,
})
export type Form = typeof Form.Type

/**
 * The last Test on this tab: `testing` until `model/test` ends, then `done` with its result, or `failed` with ChatApi's
 * refusal (`unavailable` when the flow couldn't run); and the row's `failedAt` when the result came, so a later
 * failure of a real call shows in its place.
 */
export const TestRow = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["testing", "done", "failed"]),
  result: Schema.NullOr(TestResult),
  failure: Schema.NullOr(Refusal),
  failedAt: Schema.NullOr(Schema.String),
})
export type TestRow = typeof TestRow.Type

/** The one hidden row's key. */
export const HIDDEN = "failure"

/** The failure whose toast this device hid, by the row's `failedAt`: a later failure shows again. */
export const Hidden = Schema.Struct({ id: Schema.String, failedAt: Schema.String })
export type Hidden = typeof Hidden.Type
