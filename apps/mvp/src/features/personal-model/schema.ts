import { Schema } from "effect"
import {
  CONNECTION_KINDS,
  type CodexLinkStart as ContractCodexLinkStart,
  PROTOCOLS,
  REFUSALS,
  type SavedConnection,
  type TestResult as ContractTestResult,
} from "./contract"

// A person's own models on the tab (decisions 0096, 0107 and 0134, docs/features/personal-model.md), as the Effect
// Schemas its collections check rows with. No row has a field for a key: a key lives in the form's password field until
// Save, then in one request (actions.ts). Each synced row matches `PERSONAL_MODEL_SHAPE_COLUMNS`, camelCased; its times
// are ISO 8601. A row kept on the device is read by the next version of the app too: change its shape only with its
// collection's `schemaVersion` (src/device/registry.ts).

/**
 * One of the person's connections, a row of Postgres `personal_models` as the shape sends it: what it is, its place in
 * their list, whether routing reads it, its protocol and base URL when it has them, the model each tier names on it,
 * never the credential.
 */
export const PersonalModelRow = Schema.Struct({
  personId: Schema.String,
  id: Schema.String,
  kind: Schema.Literals(CONNECTION_KINDS),
  position: Schema.Number,
  active: Schema.Boolean,
  protocol: Schema.NullOr(Schema.Literals(PROTOCOLS)),
  baseUrl: Schema.NullOr(Schema.String),
  fastModel: Schema.NullOr(Schema.String),
  implementModel: Schema.NullOr(Schema.String),
  hardModel: Schema.NullOr(Schema.String),
  /** The credential's last characters: all the browser sees of it again. */
  keyLast4: Schema.String,
  /** The provider's status when this credential was last refused or ran out on a real call; `null` since a success. */
  failureStatus: Schema.NullOr(Schema.Number),
  failedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})
export type PersonalModelRow = typeof PersonalModelRow.Type

/** A synced row is a saved connection as routing reads it: the compiler refuses this line if either drifts. */
export const rowIsSavedConnection: PersonalModelRow extends SavedConnection ? true : false = true

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

/**
 * One connection a save sent, to tell its rows from another's, as ChatApi keeps it: its id (`null` for a new one), kind,
 * active, protocol, base URL and the model each tier names. Never a key.
 */
export const SentConnection = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  kind: Schema.Literals(CONNECTION_KINDS),
  active: Schema.Boolean,
  protocol: Schema.NullOr(Schema.Literals(PROTOCOLS)),
  baseUrl: Schema.NullOr(Schema.String),
  models: Schema.Struct({
    fast: Schema.optional(Schema.String),
    implement: Schema.optional(Schema.String),
    hard: Schema.optional(Schema.String),
  }),
})

/** What a save sent: the whole list, in the person's order. */
export const Sent = Schema.Struct({ connections: Schema.Array(SentConnection) })
export type Sent = typeof Sent.Type

/**
 * The form's last write on this tab: Save (`save`) or Remove (`remove`), where it is, why it was refused, the rows'
 * latest `updatedAt` before it was sent (`before`, `null` with no row), what a save sent, how many writes ChatApi took
 * (`saved`), whether it came from the Add dialog, which it closes once taken (`adding`), and whether a test or a dialog
 * since took the status line (`quiet`). Never the key.
 */
export const Form = Schema.Struct({
  id: Schema.String,
  op: Schema.Literals(["save", "remove"]),
  state: FormState,
  failure: Schema.NullOr(Refusal),
  before: Schema.NullOr(Schema.String),
  sent: Schema.NullOr(Sent),
  saved: Schema.Number,
  adding: Schema.Boolean,
  quiet: Schema.Boolean,
})
export type Form = typeof Form.Type

/**
 * The last Test on this tab: of which connection (`null`: every active one), `testing` until `model/test` ends, then
 * `done` with its result, or `failed` with ChatApi's refusal (`unavailable` when the flow couldn't run, `unsaved` when
 * the list on screen isn't the saved one); and that connection's `failedAt` when the result came, so a later failure of
 * a real call shows in its place.
 */
export const TestRow = Schema.Struct({
  id: Schema.String,
  connection: Schema.NullOr(Schema.String),
  state: Schema.Literals(["testing", "done", "failed"]),
  result: Schema.NullOr(TestResult),
  failure: Schema.NullOr(Schema.Literals([...REFUSALS, "unsaved"])),
  failedAt: Schema.NullOr(Schema.String),
})
export type TestRow = typeof TestRow.Type

/** What Link answers: the code the person types at OpenAI (contract.ts `CodexLinkStart`). */
export const CodexLinkStart = Schema.Struct({
  userCode: Schema.String,
  verificationUrl: Schema.String,
  expiresInSeconds: Schema.Number,
})
export type CodexLinkStart = typeof CodexLinkStart.Type

/** The schema decodes exactly the contract's type: the compiler refuses this line if either drifts. */
export const codexLinkMatchesContract: Same<CodexLinkStart, ContractCodexLinkStart> = true

/** The one Add row's key, and the one Link row's. */
export const ADD = "add"
export const LINK = "link"

/** What Add shows: nothing, its menu, or the form of a kind. */
export const AddView = Schema.Literals(["closed", "menu", ...CONNECTION_KINDS])
export type AddView = typeof AddView.Type

/** Which of Add's menu and forms shows on this tab. */
export const AddRow = Schema.Struct({ id: Schema.String, view: AddView })
export type AddRow = typeof AddRow.Type

/**
 * The last Codex link on this tab: `starting` until ChatApi answers, `waiting` with the code until the shape shows the
 * connection (`done`) or the code expires (`expired`), `failed` when refused (`failure`). `before` is the latest
 * `updatedAt` of the person's Codex rows when it started (`null` with none), `attempt` tells a link's deadline from a
 * later one's. In memory only, as every collection here.
 */
export const LinkRow = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["starting", "waiting", "done", "expired", "failed"]),
  userCode: Schema.NullOr(Schema.String),
  verificationUrl: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Refusal),
  before: Schema.NullOr(Schema.String),
  attempt: Schema.Number,
})
export type LinkRow = typeof LinkRow.Type

/** The one hidden row's key. */
export const HIDDEN = "failure"

/** Legacy device rows remain decodable; model failures now stay inline and no longer write hide marks. */
export const Hidden = Schema.Struct({ id: Schema.String, failedAt: Schema.String })
export type Hidden = typeof Hidden.Type
