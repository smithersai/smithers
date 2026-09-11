import type { StandardSchemaV1 } from "@standard-schema/spec"
import { openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence"
import { localOnlyCollectionOptions } from "@tanstack/db"
import type { InferSchemaOutput, StorageApi, StorageEventApi } from "@tanstack/db"
import { createCollection, createTransaction } from "@tanstack/react-db"
import type { Transaction } from "@tanstack/react-db"
import {
  APP_SCHEMA_VERSION,
  PERSISTED_KEY_PREFIX,
  PERSISTENCE_BACKEND_STORAGE_KEY,
  SCHEMA_VERSION_STORAGE_KEY,
  enforceSchemaVersion,
  readRecordedBackend,
  recordBackend
} from "../chain/SchemaVersion"
import { openSqliteRowStorage } from "../chain/SqliteRowStorage"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { readSqliteRecovery, StorageRecoveryError } from "../chain/StorageRecovery"
import type { RecoveryTable, StorageRecoverySnapshot, EnumerableRecoveryStorage } from "../chain/StorageRecovery"
import { captureBrowserStorageRecovery, recoveryStorage } from "./BrowserStorageRecovery"
import { createCollectionPersistence, durableCollectionOptions } from "../chain/DurableCollection"
import type { DurableRowSink } from "../chain/DurableCollection"
import { retiredLineageKey } from "../chain/LineageRetirement"
import type { CollectionPersistence } from "../chain/DurableCollection"
import { ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY, matchesStoredStringId, openTransactionalStorage } from "../chain/TransactionalStorage"
import type { TransactionalStorage } from "../chain/TransactionalStorage"
import { PALETTE_MIRROR_KEY, rememberAppearance, THEME_MIRROR_KEY } from "./Appearance"
import { archiveNotice, conversationNotes } from "./ConversationArchive"
import { createWorkspaceViews, projectWorkspaceCard, snapshotCard } from "./WorkspaceViews"
import { framePath } from "../runtime/FrameHistory"
import {
  AgentRoleSchema,
  BillingAccountSchema,
  BranchSchema,
  CardSchema,
  CardPatchSchema,
  cardFrameId,
  ChainEventRecordSchema,
  RetiredChainLineageSchema,
  ChangeRowSchema,
  CloudRepositorySchema,
  CloudSessionRowSchema,
  CloudWorkspaceRowSchema,
  ConnectorOperationSchema,
  DEFAULT_PALETTE,
  DEFAULT_BRANCH_ID,
  DEFAULT_WORKSPACE_ID,
  FrameSchema,
  GitHubAppStatusRowSchema,
  HarnessSchema,
  IdentitySessionSchema,
  initialBillingAccount,
  initialCloudSession,
  initialConnectorOperation,
  initialIdentitySession,
  initialSession,
  initialWorldDocuments,
  LinearIntegrationRowSchema,
  LocalRepositoryConnectorSchema,
  conversationTabIdOf,
  inConversation,
  MAIN_TAB_ID,
  mainTab,
  MessageSchema,
  PinnedRepoSchema,
  RECOMMENDATION_ID,
  RepoTreeRowSchema,
  RepositoryFlowsRowSchema,
  repoTreeRowId,
  StarredTargetSchema,
  RecommendationSchema,
  repoIdFromRemote,
  repoKeyOf,
  RepoSchema,
  rootFrameId,
  parseRepoSelection,
  SessionSchema,
  TabSchema,
  ToastSchema,
  ToolCallRecordSchema,
  TransitionRecordSchema,
  WorkingCopySchema,
  WorkspaceSchema,
  WorldDocumentSchema
} from "./AppState"
import type {
  AppTransition,
  Card,
  ChangeRow,
  CloudRepository,
  CloudSessionRow,
  CloudWorkspaceRow,
  Frame,
  FrameSnapshot,
  GitHubAppStatusRow,
  GuideState,
  LinearIntegrationRow,
  LocalRepositoryConnector,
  Message,
  Palette,
  Recommendation,
  RepoTreeRow,
  RepositoryCapabilityPattern,
  Session,
  TabRow,
  Toast,
  WorkingCopy,
  WorldDocument
} from "./AppState"

const SESSION_ID = "main"
/** The recents ledger keeps this many items (§5): enough for seven days of opens, never a wall. */
const PALETTE_RECENTS_CAP = 50

/*
 * Retention bounds for derived diagnostic logs (apps/ui/docs/persistence.md §
 * "Retention and compaction"). Compaction runs inside the same dispatch
 * transaction that appends, so it is part of the atomic commit, and it keeps
 * the newest records: the debuggable tail is the valuable end of a log.
 */
export const MAX_TRANSITION_RECORDS = 500
export const MAX_TOOL_CALL_RECORDS = 250

/*
 * Composer keystrokes share one durable commit (docs/persistence.md "Composer
 * drafts"). It lands after this pause in typing, and never later than the
 * second bound after the first unsaved keystroke.
 */
const DRAFT_COMMIT_IDLE_MS = 250
const DRAFT_COMMIT_MAX_MS = 1_000

/**
 * The keys of the records beyond `keep`, oldest first. `order` is the row's
 * position in the log (a revision, a createdAt); ties fall to the key so the
 * choice is stable.
 */
const staleLogKeys = <T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
  keep: number,
  order: (row: T) => number
): Array<string> => {
  if (rows.length <= keep) return []
  return [...rows]
    .sort((left, right) => order(left) - order(right) || left.id.localeCompare(right.id))
    .slice(0, rows.length - keep)
    .map((row) => row.id)
}

/** The /theme picker's stable id: one picker at a time, upserted. */
export const THEME_PICKER_CARD_ID = "theme-picker"

const preferredTheme = (): Session["theme"] =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"

const applyTheme = (theme: Session["theme"]): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme
  // §20.4: the next boot paints this before the store is even open.
  rememberAppearance(THEME_MIRROR_KEY, theme)
}

/*
 * The color theme, stamped on the same element as data-theme and read by the
 * palette blocks in styles/tokens.css. The default is stamped explicitly too,
 * so the attribute always states which palette is live (tokens.css falls back
 * to night-owl either way).
 */
const applyPalette = (palette: Palette): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.palette = palette
  rememberAppearance(PALETTE_MIRROR_KEY, palette)
}

const transitionPayload = (transition: AppTransition): string => {
  const { actor: _actor, type: _type, ...payload } = transition
  // Native bearer capabilities are ephemeral, even if an untyped caller
  // accidentally puts one in a transition. The journal and verbose share this.
  return JSON.stringify(payload, (key, value) => key === "authorizationId" ? undefined : value)
}

/** The id prefix of every verbose trace line, so switching off can remove them all. */
export const TRACE_MESSAGE_PREFIX = "message-trace-"
export const VERBOSE_ON_TEXT = "Verbose on — showing every flow, including hidden and background ones"
export const VERBOSE_OFF_TEXT = "Verbose off"

/*
 * Transitions verbose never traces: the per-keystroke and per-token streams
 * would bury everything else, and a user's own flow acts are already traced
 * as the `flow.invoked` record that settles them.
 */
const UNTRACED_TRANSITIONS: ReadonlySet<string> = new Set([
  "composer.changed",
  "message.response.delta",
  // Already a visible marker line in every transcript.
  "message.tool.executed",
  "verbose.toggled"
])

const TRACE_PAYLOAD_MAX = 160

/**
 * The one-line trace a transition renders under /verbose, or undefined when it
 * is not traced. Every flow invocation is traced (user, agent, hidden, alias,
 * deferred); beyond that, every transition an actor other than the user
 * dispatched — the background, system, and agent work a normal transcript
 * never shows.
 */
export const verboseTrace = (transition: AppTransition): string | undefined => {
  if (transition.type === "flow.invoked") {
    const who = transition.actor === "smithers" ? "Smithers" : "You"
    const args = transition.args === null ? "" : ` ${transition.args}`
    const detail = transition.detail === null ? "" : ` (${transition.detail})`
    const hidden = transition.hidden ? " [hidden]" : ""
    return `${who} ran /${transition.name}${args}${hidden} → ${transition.outcome}${detail} · ${transition.durationMs}ms`
  }
  if (transition.actor === "user" || UNTRACED_TRANSITIONS.has(transition.type)) return undefined
  const payload = transitionPayload(transition)
  const shown = payload === "{}"
    ? ""
    : ` ${payload.length > TRACE_PAYLOAD_MAX ? `${payload.slice(0, TRACE_PAYLOAD_MAX)}…` : payload}`
  return `${transition.actor}: ${transition.type}${shown}`
}

type ApprovalRequest = Extract<Card, { kind: "approval" | "approvals-inbox" }>
/*
 * The turn a session persisted before it recorded `turnId` was answering.
 * Only a submission row (`message-<turnId>-user`) names a turn: steering
 * inserts `message-steer-<revision>` user bubbles, so the newest user
 * message is not the turn in flight.
 */
const latestSubmittedTurnId = (messages: Iterable<Message>): string | undefined =>
  [...messages]
    .filter((message) => message.role === "user")
    .sort((left, right) => left.ordinal - right.ordinal)
    .reverse()
    .map((message) => message.id.match(/^message-(.+)-user$/)?.[1])
    .find((id) => id !== undefined)

const isApprovalRequest = (card: Card | undefined): card is ApprovalRequest =>
  card?.kind === "approval" || card?.kind === "approvals-inbox"

const freezeRequest = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeRequest(child)
    Object.freeze(value)
  }
  return value
}

type ApprovalCard = Extract<Card, { kind: "approval" }>

/**
 * The gate an approval card asks about — the thing a decision decides.
 *
 * A workflow gate is the run's own request id; the ask's wording is not part
 * of it, so restating the same gate in different words is still the same
 * decision. A chain park has no request id: the runtime reuses one card id per
 * lineage, and what changes between parks is the capability being asked for, so
 * that is the gate's identity there.
 */
const approvalGateKey = (card: ApprovalCard): string => {
  const { runId = "", requestId, chain, flow = "", capability } = card.payload
  return requestId === undefined
    ? `ask:${runId}:${chain === true}:${flow}:${capability}`
    : `gate:${runId}:${requestId}`
}

/**
 * The card, when it carries a decision a human already made.
 *
 * A recorded decision — not the "acted" status — is what freezes an approval.
 * The status is a generic terminal marker any card kind uses and a streamed
 * frame can set; the decision is the human's authorisation, and it is the thing
 * that must never be given twice. `AppController.runAwaitsApproval` reads the
 * same field to decide whether a run is still parked on a human.
 */
const decidedApproval = (card: Card | undefined): ApprovalCard | undefined =>
  card !== undefined && card.kind === "approval" && card.payload.decision !== undefined
    ? card
    : undefined

/**
 * Which store the running app is reading. "memory" is the degraded launch: the
 * store that holds the user's data could not be opened, so nothing is read and
 * nothing is written over it.
 */
export type PersistenceMode = "opfs" | "localStorage" | "memory"

export type PersistenceBackend =
  | {
    readonly kind: "opfs"
    readonly storage: StorageApi
    readonly storageEventApi: StorageEventApi
    readonly beginBatch: () => void
    readonly commitBatch: () => void
    readonly abortBatch: () => void
    readonly flush: () => Promise<void>
    readonly close: () => Promise<void>
    /** Read on the owning connection, serialized with writes. Older injected hosts may refuse recovery. */
    readonly readRecovery?: () => Promise<ReadonlyArray<RecoveryTable>>
    /** Normalized row writes. Older injected hosts only accept whole collections. */
    readonly applyRows?: DurableRowSink["applyRows"]
  }
  | {
    readonly kind: "localStorage"
    readonly storage?: StorageApi
  }

/** The store a launch reads, as `resolvePersistence` chose it. */
export interface ResolvedPersistence {
  readonly backend: PersistenceBackend
  readonly mode: PersistenceMode
  /** True when the store holding the user's data could not be opened. */
  readonly degraded: boolean
  /** Record adoption only after the selected legacy store validates and initializes. */
  readonly recordSuccessfulOpen?: () => void
}

const OPFS_DATABASE_NAME = "smithers-mvp.sqlite"


/** Attempts spent waiting out a locked access-handle pool. See `openOpfsDatabase`. */
const OPFS_OPEN_ATTEMPTS = 5
/** The whole OPFS open, retries included. A store that never answers must not hang boot. */
const OPFS_OPEN_BUDGET_MS = 4_000

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A localStorage-shaped store that lives only as long as this document. */
const memoryStorage = (): StorageApi & EnumerableRecoveryStorage => {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/* OPFS has no window `storage` events; localStorage events name another host. */
const inertStorageEvents: StorageEventApi = {
  addEventListener: () => {},
  removeEventListener: () => {}
}

/*
 * Where the boot stamps live. Always window.localStorage, whichever backend
 * holds the data: it is the one store that is synchronous and readable before
 * anything else is open. A browser with storage disabled throws on the property
 * itself, so the read is guarded.
 */
const bootRecordStorage = (): StorageApi | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Read-only existence check for the installed OPFSCoopSyncVFS's database path. */
const browserDatabaseExists = async (): Promise<boolean> => {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return false
  const root = await navigator.storage.getDirectory()
  try {
    await root.getFileHandle(OPFS_DATABASE_NAME)
    return true
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false
    throw error
  }
}

const hasLegacyLocalState = (storage: StorageApi): boolean => {
  const keys = [ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY, ...PERSISTED_COLLECTION_SPECS.map((spec) => `${PERSISTED_KEY_PREFIX}${spec.id}`)]
  if (keys.some((key) => storage.getItem(key) !== null)) return true
  // Include historical collection names the current schema no longer lists.
  const scannable = storage as StorageApi & { readonly length?: number; readonly key?: (index: number) => string | null }
  if (typeof scannable.length === "number" && typeof scannable.key === "function") {
    const length = scannable.length
    for (let index = 0; index < length; index++) {
      const key = scannable.key(index)
      if (key !== null && key.startsWith(PERSISTED_KEY_PREFIX) && key !== SCHEMA_VERSION_STORAGE_KEY &&
        key !== PERSISTENCE_BACKEND_STORAGE_KEY && key !== THEME_MIRROR_KEY && key !== PALETTE_MIRROR_KEY &&
        storage.getItem(key) !== null) return true
    }
  }
  return false
}

export class AmbiguousPersistenceBackendError extends Error {
  constructor() {
    super("Saved local browser data has no recorded backend and another database may exist. Opening either could select a stale history. Recover or explicitly select the existing backend before continuing; neither store was reset.")
  }
}

/*
 * Stamping the backend is bookkeeping, not the boot. A storage that refuses the
 * write (a full or blocked localStorage) costs the next launch its shortcut; it
 * must never cost this one its start.
 */
const stampBackend = (storage: StorageApi, backend: "opfs" | "localStorage"): void => {
  try {
    recordBackend(storage, backend)
  } catch (error) {
    console.warn("Smithers: could not record which store holds this app's data.", error)
  }
}

/*
 * Open the OPFS database, retrying while the access-handle pool is still held.
 *
 * A reload overlaps two documents: the outgoing one still owns wa-sqlite's
 * access handles when the incoming one asks for them, so the first open throws
 * for a database that is present and healthy. Retrying turns that race into a
 * short wait. Callers pass one attempt when nothing is known to live in OPFS,
 * so a browser without OPFS at all still boots without paying the backoff.
 */
const openOpfsDatabase = async (attempts: number) => {
  let failure: unknown = new Error("OPFS was never attempted")
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(100 * 2 ** (attempt - 1))
    try {
      return await openBrowserWASQLiteOPFSDatabase({ databaseName: OPFS_DATABASE_NAME })
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/*
 * The same open under a wall-clock budget. A worker that neither answers nor
 * fails would otherwise leave the app on a splash screen forever. A database
 * that arrives after the budget is closed rather than abandoned, so it does not
 * sit on the access handles the next launch needs.
 */
const openOpfsDatabaseWithinBudget = async (attempts: number) => {
  const open = openOpfsDatabase(attempts)
  let timer: ReturnType<typeof setTimeout> | undefined
  let won = false
  try {
    const database = await Promise.race([
      open,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OPFS did not open within ${OPFS_OPEN_BUDGET_MS}ms`)),
          OPFS_OPEN_BUDGET_MS
        )
      })
    ])
    won = true
    return database
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (!won) void open.then((database) => database.close?.()).catch(() => {})
  }
}

/** Raw recovery never invokes AppStore initialization, migrations or backend selection. */
const existingBrowserDatabaseRecovery = async (): Promise<ReadonlyArray<RecoveryTable> | undefined> => {
  if (!await browserDatabaseExists()) return undefined
  const database = await openOpfsDatabaseWithinBudget(OPFS_OPEN_ATTEMPTS)
  try {
    return await readSqliteRecovery(database)
  } finally {
    await database.close?.()
  }
}

const browserSqliteRecoveryReader = () => typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function"
  ? existingBrowserDatabaseRecovery
  : undefined

/** Lazily imported by the startup panel only when the human requests a download. */
export const readUnopenedBrowserRecovery = (): Promise<StorageRecoverySnapshot> => captureBrowserStorageRecovery({
  session: "unopened",
  localStorage: recoveryStorage(bootRecordStorage()),
  sqlite: browserSqliteRecoveryReader()
})

/*
 * Choose the store this launch reads, and honour the choice the last launch
 * made (E3.6).
 *
 * The two backends cannot be merged, so "try OPFS, fall back on any error" is
 * not a fallback at all: the launch after a fallback opens the other store,
 * finds it empty, and the user's whole transcript is gone with no message. The
 * recorded backend is therefore authoritative.
 *
 * A recorded OPFS store that will not open is the one case with no good answer.
 * Reading localStorage instead would present a stale store as the current
 * conversation, and writing into it would fork the history; refusing to boot
 * would strand the user completely. This launch runs on a memory store instead:
 * the app starts, the real store is untouched and returns on the next launch,
 * and `persistenceDegraded` plus a console error say so rather than passing the
 * empty surface off as a fresh start.
 *
 * Only failure to acquire the database may take that path. Once it is open,
 * any read, validation, migration or commit failure must refuse this launch.
 * An unreadable execution journal is not permission to start work from zero.
 */
/** Browser-owned capabilities; injected hosts exercise the actual boot resolver without module mocks. */
export interface BrowserPersistenceHost {
  readonly bootRecord: () => StorageApi | undefined
  readonly openDatabase: (attempts: number) => Promise<SqliteRowDatabase>
  /** Inspect existence without opening/creating SQLite; needed only for unstamped legacy data. */
  readonly databaseExists?: () => Promise<boolean>
}

export const resolvePersistence = async (host: BrowserPersistenceHost = {
  bootRecord: bootRecordStorage,
  openDatabase: openOpfsDatabaseWithinBudget,
  databaseExists: browserDatabaseExists
}): Promise<ResolvedPersistence> => {
  const record = host.bootRecord()
  const recorded = record === undefined ? null : readRecordedBackend(record)
  if (recorded === "localStorage") {
    return {
      backend: { kind: "localStorage", storage: record },
      mode: "localStorage",
      degraded: false
    }
  }
  if (recorded === null && record !== undefined && hasLegacyLocalState(record)) {
    if (host.databaseExists === undefined || await host.databaseExists()) throw new AmbiguousPersistenceBackendError()
    return {
      backend: { kind: "localStorage", storage: record },
      mode: "localStorage",
      degraded: false,
      recordSuccessfulOpen: () => stampBackend(record, "localStorage")
    }
  }
  let database: SqliteRowDatabase
  try {
    database = await host.openDatabase(recorded === "opfs" ? OPFS_OPEN_ATTEMPTS : 1)
  } catch (error) {
    if (recorded === "opfs") {
      console.error(
        "Smithers: this app's data lives in OPFS SQLite and that store could not be opened, so this session starts empty and saves nothing. The conversation is still on disk and comes back once the store opens again.",
        error
      )
      return { backend: { kind: "localStorage", storage: memoryStorage() }, mode: "memory", degraded: true }
    }
    if (record === undefined) {
      console.error(
        "Smithers: neither OPFS SQLite nor localStorage is available in this browser context, so this session saves nothing.",
        error
      )
      return { backend: { kind: "localStorage", storage: memoryStorage() }, mode: "memory", degraded: true }
    }
    console.warn(
      "Smithers: OPFS SQLite persistence is unavailable in this browser context; falling back to localStorage persistence.",
      error
    )
    stampBackend(record, "localStorage")
    return { backend: { kind: "localStorage", storage: record }, mode: "localStorage", degraded: false }
  }
  const sqlite = await openSqliteRowStorage(database, {
    collections: PERSISTED_COLLECTION_SPECS,
    schemaVersion: APP_SCHEMA_VERSION
  }).catch(async (error) => {
    try {
      await database.close?.()
    } catch {
      // Do not mask the original refusal, or log private database error data.
      console.warn("Smithers: the refused SQLite store could not be closed; reload before retrying recovery.")
    }
    throw error
  })
  if (record !== undefined) stampBackend(record, "opfs")
  return {
    backend: {
      kind: "opfs",
      storage: sqlite.storage,
      storageEventApi: inertStorageEvents,
      beginBatch: sqlite.beginBatch,
      commitBatch: sqlite.commitBatch,
      abortBatch: sqlite.abortBatch,
      flush: sqlite.flush,
      close: sqlite.close,
      readRecovery: sqlite.readRecovery,
      applyRows: sqlite.applyRows
    },
    mode: "opfs",
    degraded: false
  }
}

/*
 * The storage object a localStorage-backed store actually reads, so the schema
 * gate runs over the same bytes as the durable collection coordinator. An
 * omitted host resolves to the boot record store, then to an isolated memory
 * store when browser storage is unavailable.
 */
const storageOf = (backend: PersistenceBackend): StorageApi | undefined =>
  backend.kind === "opfs" ? backend.storage : (backend.storage ?? bootRecordStorage())

export type StoredCollections = {
  readonly [K in keyof typeof COLLECTION_DEFINITIONS]: ReturnType<typeof COLLECTION_DEFINITIONS[K]["create"]>
}

export type AppCollections = Omit<StoredCollections, "cards" | "workingCopies" | "approvalRequests"> & ReturnType<typeof createWorkspaceViews>

export interface WorldStateSnapshot {
  readonly capturedAt: number
  readonly revision: number
  readonly documents: ReadonlyArray<WorldDocument>
  readonly markdown: string
}

export interface AgentContextSnapshot {
  readonly capturedAt: number
  readonly revision: number
  readonly messages: ReadonlyArray<Message>
  readonly connectors: ReadonlyArray<LocalRepositoryConnector>
  /** Every open tab in strip order: Smithers is the first and knows the rest. */
  readonly tabs: ReadonlyArray<TabRow>
  readonly worldState: WorldStateSnapshot
}

export interface AppStore {
  readonly collections: AppCollections
  /**
   * Apply one transition. Its change is visible in `collections` when this
   * returns, before it is saved. The returned transaction is the durability
   * receipt: await `isPersisted.promise` before treating the change as saved,
   * for example before a reload or an outbound side effect.
   *
   * ```ts
   * await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
   * ```
   *
   * A transition the reducer refuses changes nothing and its receipt resolves
   * at once; an impossible request (a conversation id already in use) throws
   * here. A failed commit rejects the receipt and rolls the change back, with
   * any queued transition derived from it. After `app.reset`, every dispatch
   * returns the reset's receipt and changes nothing. Consecutive
   * `composer.changed` keystrokes share one receipt, which resolves when the
   * draft commits: after a pause in typing, the next other dispatch, page hide
   * or `dispose`.
   */
  readonly dispatch: (transition: AppTransition) => Transaction
  /** Immutable runtime request; legacy model-authored cards have no authority. */
  readonly approvalRequest: (id: string) => ApprovalRequest | undefined
  readonly persistenceMode: PersistenceMode
  /**
   * True when the store holding this user's data could not be opened, so the
   * session runs on memory and saves nothing. A surface that shows a
   * conversation must say this rather than render the empty one as current.
   */
  readonly persistenceDegraded: boolean
  readonly session: () => Session
  readonly worldStateSnapshot: () => WorldStateSnapshot
  readonly agentContextSnapshot: () => AgentContextSnapshot
  /** Private host capability, never a model/tool payload. */
  readonly readRecovery: () => Promise<StorageRecoverySnapshot>
  /** Commit a pending draft, then release persistence resources acquired for this store. */
  readonly dispose?: () => void | Promise<void>
}

/** A persisted collection declares its storage identity and row schema once. */
const persistedCollection = <TSchema extends StandardSchemaV1>(
  id: string,
  schema: TSchema,
  getKey: (row: InferSchemaOutput<TSchema>) => string,
  recovery: { readonly invalidRows?: "refuse"; readonly validateKey?: typeof matchesStoredStringId } = {}
) => ({
  id,
  schema,
  persisted: true as const,
  ...recovery,
  /* Every collection shares one coordinator, so a dispatch is one atomic commit. */
  create: (persistence: CollectionPersistence) =>
    createCollection({ ...durableCollectionOptions(persistence, { id, schema, getKey }), schema })
})

const byId = (row: { readonly id: string }): string => row.id
const strictJournalRows = { invalidRows: "refuse" as const, validateKey: matchesStoredStringId }

/** Construction, recovery, preload, and the public collection types share this roster. */
const COLLECTION_DEFINITIONS = {
  sessions: persistedCollection("app-sessions", SessionSchema, byId),
  messages: persistedCollection("app-messages", MessageSchema, byId),
  connectors: persistedCollection("app-connectors", LocalRepositoryConnectorSchema, byId),
  connectorOperations: persistedCollection("app-connector-operations", ConnectorOperationSchema, byId),
  worldDocuments: persistedCollection("world-documents", WorldDocumentSchema, byId),
  cards: persistedCollection("app-cards", CardSchema, byId),
  approvalRequests: persistedCollection("app-approval-requests", CardSchema, byId),
  transitions: persistedCollection("app-transitions", TransitionRecordSchema, byId),
  identitySessions: persistedCollection("app-identity-sessions", IdentitySessionSchema, byId),
  billingAccounts: persistedCollection("app-billing-accounts", BillingAccountSchema, byId),
  toasts: persistedCollection("app-toasts", ToastSchema, byId),
  toolCalls: persistedCollection("app-tool-calls", ToolCallRecordSchema, byId),
  chainEvents: persistedCollection("app-chain-events", ChainEventRecordSchema, byId, strictJournalRows),
  retiredChainLineages: persistedCollection("app-retired-chain-lineages", RetiredChainLineageSchema, byId, strictJournalRows),
  tabs: persistedCollection("app-tabs", TabSchema, byId),
  harnesses: persistedCollection("app-harnesses", HarnessSchema, byId),
  agents: persistedCollection("app-agents", AgentRoleSchema, byId),
  repos: persistedCollection("app-repos", RepoSchema, byId),
  pinnedRepos: persistedCollection("app-pinned-repos", PinnedRepoSchema, byId),
  starredTargets: persistedCollection("app-starred-targets", StarredTargetSchema, byId),
  workspaces: persistedCollection("app-workspaces", WorkspaceSchema, byId),
  branches: persistedCollection("app-branches", BranchSchema, byId),
  recommendations: persistedCollection("app-recommendations", RecommendationSchema, byId),
  frames: persistedCollection("app-frames", FrameSchema, byId),
  repositories: persistedCollection("app-cloud-repositories", CloudRepositorySchema, byId),
  workingCopies: persistedCollection("app-working-copies", WorkingCopySchema, byId),
  cloudSessions: persistedCollection("app-cloud-sessions", CloudSessionRowSchema, byId),
  cloudWorkspaces: persistedCollection("app-cloud-workspaces", CloudWorkspaceRowSchema, byId),
  changes: persistedCollection("app-changes", ChangeRowSchema, byId),
  linearIntegrations: persistedCollection("app-linear-integrations", LinearIntegrationRowSchema, byId),
  githubAppStatuses: persistedCollection("app-github-app-statuses", GitHubAppStatusRowSchema, (row) => row.repo),
  repoTree: {
    persisted: false as const,
    create: (_persistence: CollectionPersistence) => createCollection(localOnlyCollectionOptions({
      id: "app-repo-tree", schema: RepoTreeRowSchema, getKey: byId
    }))
  },
  repositoryFlows: {
    persisted: false as const,
    create: (_persistence: CollectionPersistence) => createCollection(localOnlyCollectionOptions({
      id: "app-repository-flows", schema: RepositoryFlowsRowSchema, getKey: byId
    }))
  }
} as const

const PERSISTED_COLLECTION_SPECS = Object.values(COLLECTION_DEFINITIONS).filter((definition) => definition.persisted)

/** The strip's order: main first, then creation order. */
const orderedTabs = (collections: Pick<StoredCollections, "tabs">): Array<TabRow> =>
  [...collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal)

/*
 * Remove tabs from the strip in one transaction: the nearest surviving tab
 * to the left of the active one takes over (else main), a pending close
 * question about a removed tab is answered, and a harness tab's agent card
 * follows its process. Main is never removed.
 */
const closeTabRows = (
  collections: Pick<StoredCollections, "tabs" | "sessions" | "cards">,
  ids: ReadonlyArray<string>,
  revision: number
): void => {
  const closing: Array<TabRow> = []
  for (const id of ids) {
    const tab = collections.tabs.get(id)
    if (tab !== undefined && tab.kind !== "main") closing.push(tab)
  }
  if (closing.length === 0) return
  const closingIds = new Set(closing.map((tab) => tab.id))
  const activeId = collections.sessions.get(SESSION_ID)?.activeTabId ?? MAIN_TAB_ID
  let fallback: string | undefined
  if (closingIds.has(activeId)) {
    const ordered = orderedTabs(collections)
    const index = ordered.findIndex((candidate) => candidate.id === activeId)
    fallback = MAIN_TAB_ID
    for (let left = index - 1; left >= 0; left -= 1) {
      const candidate = ordered[left]!
      if (!closingIds.has(candidate.id)) {
        fallback = candidate.id
        break
      }
    }
  }
  collections.tabs.delete([...closingIds])
  for (const tab of closing) {
    if (tab.kind !== "harness") continue
    // Closing a subagent's tab stops its process; its card says so with no exit code to claim.
    for (const card of collections.cards.values()) {
      if (card.kind === "agent" && card.payload.tabId === tab.id && card.payload.phase === "running") {
        collections.cards.update(card.id, (draft) => {
          if (draft.kind !== "agent") return
          draft.payload.phase = "exited"
          draft.payload.exitCode = null
          draft.status = "acted"
        })
      }
    }
  }
  collections.sessions.update(SESSION_ID, (draft) => {
    if (fallback !== undefined) draft.activeTabId = fallback
    if (draft.pendingTabCloseId !== undefined && draft.pendingTabCloseId !== null && closingIds.has(draft.pendingTabCloseId)) {
      draft.pendingTabCloseId = null
    }
    draft.revision = revision
  })
}

/** The terminal tabs attached to cloud workspaces — all of them, or those of the named workspaces. */
const workspaceTabIds = (collections: Pick<StoredCollections, "tabs">, workspaceIds?: ReadonlySet<string>): Array<string> =>
  [...collections.tabs.values()]
    .filter((tab) =>
      tab.kind === "terminal" && tab.workspaceId !== undefined && (workspaceIds === undefined || workspaceIds.has(tab.workspaceId))
    )
    .map((tab) => tab.id)

const seed = async (collections: StoredCollections): Promise<void> => {
  await Promise.all(Object.values(collections).map((collection) => collection.preload()))

  if (collections.sessions.get(SESSION_ID) === undefined) {
    await collections.sessions.insert(initialSession(preferredTheme())).isPersisted.promise
  } else {
    /*
     * Heal a session row persisted before newer required fields existed
     * (updates validate the FULL row, so one missing field would wedge every
     * later dispatch — composer typing included). Seed values fill exactly
     * the absent keys, once, so the schema stays strict with no migration
     * table. Generic over the seed so the next added field heals too.
     */
    const persisted = collections.sessions.get(SESSION_ID) as unknown as Record<string, unknown>
    const seed = initialSession(preferredTheme()) as unknown as Record<string, unknown>
    const missing = Object.keys(seed).filter((key) => persisted[key] === undefined)
    if (missing.length > 0) {
      collections.sessions.update(SESSION_ID, (draft) => {
        const target = draft as unknown as Record<string, unknown>
        for (const key of missing) target[key] = seed[key]
      })
    }
    /*
     * The 16-lesson build numbered the guide with the light lesson standing
     * alone at step 2; the 15-lesson build folds it into the theme lesson, so
     * every later lesson moved one down. A version-1 guide names its lesson
     * in the old order — remap it once, by version, so a returning user lands
     * on the lesson they were on (and a finished tutorial stays finished).
     */
    const persistedGuide = collections.sessions.get(SESSION_ID)?.guide
    if (persistedGuide !== undefined && persistedGuide.version === 1) {
      const remapped: GuideState = {
        ...persistedGuide,
        version: 2,
        step: persistedGuide.step <= 1 ? persistedGuide.step : persistedGuide.step - 1
      }
      collections.sessions.update(SESSION_ID, (draft) => {
        draft.guide = remapped
      })
    }
  }
  // Wave 14 §1: nothing seeds the transcript. Signed out, the auth message is
  // the whole conversation; signed in, the transcript opens clean and the
  // inventory seam fills the repositories. See AppState's note.
  if (collections.connectorOperations.get("connector-operation") === undefined) {
    await collections.connectorOperations
      .insert(initialConnectorOperation())
      .isPersisted.promise
  }
  if (collections.worldDocuments.size === 0) {
    await collections.worldDocuments.insert([...initialWorldDocuments()]).isPersisted.promise
  }
  if (collections.identitySessions.get("identity") === undefined) {
    await collections.identitySessions.insert(initialIdentitySession()).isPersisted.promise
  }
  if (collections.billingAccounts.get("billing") === undefined) {
    await collections.billingAccounts.insert(initialBillingAccount()).isPersisted.promise
  }
  if (collections.cloudSessions.get("cloud") === undefined) {
    await collections.cloudSessions.insert(initialCloudSession()).isPersisted.promise
  }
  if (collections.tabs.get(MAIN_TAB_ID) === undefined) {
    await collections.tabs.insert(mainTab()).isPersisted.promise
  }
  if (collections.workspaces.get(DEFAULT_WORKSPACE_ID) === undefined) {
    await collections.workspaces.insert({
      id: DEFAULT_WORKSPACE_ID,
      title: "Smithers",
      createdAt: Date.now(),
      revision: 0
    }).isPersisted.promise
  }
  if (collections.branches.get(DEFAULT_BRANCH_ID) === undefined) {
    await collections.branches.insert({
      id: DEFAULT_BRANCH_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: "Main",
      parentBranchId: null,
      forkedFromFrameId: null,
      forkedAtRevision: null,
      createdAt: Date.now(),
      revision: 0
    }).isPersisted.promise
  }
  const defaultRootFrameId = rootFrameId(DEFAULT_BRANCH_ID)
  if (collections.frames.get(defaultRootFrameId) === undefined) {
    await collections.frames.insert({
      id: defaultRootFrameId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      branchId: DEFAULT_BRANCH_ID,
      kind: "root",
      parentFrameId: null,
      cardId: null,
      presentation: "embedded",
      stateRevision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 0
    }).isPersisted.promise
  }
  const session = collections.sessions.get(SESSION_ID)
  const workspaceId = session?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
  const branchId = session?.activeBranchId ?? DEFAULT_BRANCH_ID
  for (const card of collections.cards.values()) {
    const id = cardFrameId(branchId, card.id)
    if (collections.frames.get(id) !== undefined) continue
    await collections.frames.insert({
      id,
      workspaceId,
      branchId,
      kind: "card",
      parentFrameId: rootFrameId(branchId),
      cardId: card.id,
      presentation: session?.maximizedCardId === card.id ? "maximized" : "embedded",
      stateRevision: session?.revision ?? 0,
      createdAt: card.createdAt,
      updatedAt: Date.now(),
      revision: session?.revision ?? 0
    }).isPersisted.promise
  }
  if (session?.maximizedCardId !== null && session?.maximizedCardId !== undefined) {
    const id = cardFrameId(branchId, session.maximizedCardId)
    if (collections.frames.get(id) !== undefined && session.activeFrameId !== id) {
      await collections.sessions.update(SESSION_ID, (draft) => {
        draft.activeWorkspaceId = workspaceId
        draft.activeBranchId = branchId
        draft.activeFrameId = id
      }).isPersisted.promise
    }
  }
}

const repositoryCapabilities = (
  root: string,
  access: LocalRepositoryConnector["access"]
): ReadonlyArray<RepositoryCapabilityPattern> => {
  const resource = `${root.replace(/\/$/, "")}/**`
  return [
    { action: "fs:read", resource },
    ...(access === "read-write" ? ([{ action: "fs:write", resource }] as const) : [])
  ]
}

/*
 * The next place at the END of the transcript.
 *
 * Messages and cards are ONE ordered list, so they must number themselves off
 * one counter. Numbering a message over the messages alone put every message
 * posted after a card above that card — and because the ordinals persist, the
 * wrong order survived a reload (§7.5).
 */
/*
 * Everything on screen that belonged to the account that just left.
 *
 * The transcript, its cards and the balance are persisted, so signing out and
 * reloading still rendered the previous account's repository names, balance
 * and open cards — on a shared machine, to whoever sits down next (§2.4).
 * Signing out empties them.
 *
 * World notes are deliberately NOT dropped: they are the product's memory of
 * the work on this machine, sign-out is not "delete my data", and losing them
 * is not undoable.
 */
const forgetAccountState = (collections: StoredCollections): void => {
  // Private journal contents leave with the account, but their identities
  // cannot become executable again. Refusal and deletion are one transaction.
  const lineages = new Set([...collections.chainEvents.values()].map((event) => event.lineageId))
  for (const lineage of lineages) {
    const id = retiredLineageKey(lineage)
    if (!collections.retiredChainLineages.has(id)) collections.retiredChainLineages.insert({ id })
  }
  for (
    const collection of [
      collections.messages,
      collections.cards,
      collections.approvalRequests,
      collections.toasts,
      collections.toolCalls,
      collections.chainEvents,
      collections.transitions,
      collections.recommendations,
      collections.repositories,
      collections.workingCopies,
      collections.cloudWorkspaces,
      collections.changes,
      collections.linearIntegrations,
      collections.githubAppStatuses,
      collections.repoTree,
      collections.repositoryFlows
    ]
  ) {
    const keys = [...(collection as { keys: () => Iterable<string> }).keys()]
    if (keys.length > 0) (collection as { delete: (keys: string[]) => void }).delete(keys)
  }
  // Cloud Wiki content and unsent CRDT updates belong to the signed-in account.
  const cloudNotes = [...collections.worldDocuments.values()].filter((row) => row.cloud !== undefined).map((row) => row.id)
  if (cloudNotes.length > 0) collections.worldDocuments.delete(cloudNotes)
  // Card tabs and cloud terminals also carry private repository names.
  closeTabRows(collections, [
    ...workspaceTabIds(collections),
    ...[...collections.tabs.values()].filter((tab) => tab.kind === "card").map((tab) => tab.id)
  ], collections.sessions.get(SESSION_ID)!.revision)
  collections.cloudSessions.update("cloud", (draft) => Object.assign(draft, initialCloudSession()))
  const cardFrameKeys = [...collections.frames.values()]
    .filter((frame) => frame.kind === "card")
    .map((frame) => frame.id)
  if (cardFrameKeys.length > 0) collections.frames.delete(cardFrameKeys)
  // Archived conversations must obey the same account boundary as the live projection.
  for (const branch of collections.branches.values()) {
    if (branch.snapshot !== undefined) collections.branches.update(branch.id, (draft) => { delete draft.snapshot })
  }
  for (const frame of collections.frames.values()) {
    if (frame.snapshot !== undefined) collections.frames.update(frame.id, (draft) => { delete draft.snapshot })
  }
  collections.sessions.update(SESSION_ID, (draft) => {
    const branchId = draft.activeBranchId ?? DEFAULT_BRANCH_ID
    draft.draft = ""
    draft.pendingCommand = null
    draft.phase = "idle"
    draft.composerOwner = "user"
    draft.turnTabId = null
    draft.turnId = null
    draft.devtoolsOpen = false
    draft.resetConfirmOpen = false
    draft.paletteActionsRef = null
    draft.paletteLastQuery = ""
    draft.paletteRecents = []
    if (draft.selectedWorldDocumentId !== null && cloudNotes.includes(draft.selectedWorldDocumentId)) {
      draft.selectedWorldDocumentId = [...collections.worldDocuments.values()][0]?.id ?? null
    }
    draft.activeRepoKey = null
    draft.maximizedCardId = null
    draft.activeFrameId = rootFrameId(branchId)
  })
  const reset = initialBillingAccount()
  if (collections.billingAccounts.get("billing") === undefined) {
    collections.billingAccounts.insert(reset)
  } else {
    collections.billingAccounts.update("billing", (draft) => {
      draft.state = reset.state
      draft.totalUsd = reset.totalUsd
      draft.allowedToStartWork = reset.allowedToStartWork
      draft.lifetimeChargedUsd = reset.lifetimeChargedUsd
      draft.chargeCount = reset.chargeCount
      draft.refreshedAt = reset.refreshedAt
      draft.revision = reset.revision
    })
  }
}

const nextOrdinal = (collections: Pick<StoredCollections, "messages" | "cards">): number => {
  let highest = -1
  for (const message of collections.messages.values()) highest = Math.max(highest, message.ordinal)
  for (const card of collections.cards.values()) highest = Math.max(highest, card.ordinal)
  return highest + 1
}

/*
 * No argument resolves the browser's store. A bare backend is a healthy store
 * of its own kind; a resolution (from `resolvePersistence` with an injected
 * host) carries its mode and degraded flag, so a memory launch boots as one.
 */
export const createAppStore = async (
  persistence?: PersistenceBackend | ResolvedPersistence
): Promise<AppStore> => {
  const resolved: ResolvedPersistence = persistence === undefined
    ? await resolvePersistence()
    : "backend" in persistence ? persistence : { backend: persistence, mode: persistence.kind, degraded: false }
  try {
    const store = await initializeAppStore(resolved)
    resolved.recordSuccessfulOpen?.()
    return store
  } catch (error) {
    if (resolved.backend.kind === "opfs") {
      try { await resolved.backend.close() } catch {
        // Preserve the boot failure; close can repeat a failed durable flush.
        console.warn("Smithers: closing the failed app store also failed; reload before retrying recovery.")
      }
    }
    throw error
  }
}

/** Ownership transfers to the returned store only after every boot step succeeds. */
const initializeAppStore = async (resolved: ResolvedPersistence): Promise<AppStore> => {
  let resolvedBackend = resolved.backend
  /* Validate persisted rows before creating collections. Compatible older
   * rows migrate; a newer store stays untouched. Only a successful open
   * advances the version stamp. */
  const persistedLocally = storageOf(resolvedBackend)
  let transactional: TransactionalStorage | undefined
  if (persistedLocally !== undefined && resolvedBackend.kind === "localStorage") {
    enforceSchemaVersion(persistedLocally, { onMismatch: "validate" })
    /* Open recovers any interrupted localStorage commit and validates the
     * envelope before the first collection reads it. */
    transactional = await openTransactionalStorage(persistedLocally, { collections: PERSISTED_COLLECTION_SPECS })
    persistedLocally.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
    resolvedBackend = { ...resolvedBackend, storage: transactional.storage }
  }
  /* A normalized host takes row deltas, so an append costs its own rows rather
   * than the whole retained collection. Whole-collection JSON stays the
   * localStorage envelope's format, and any host without row writes. */
  const rowSink = resolvedBackend.kind === "opfs" && resolvedBackend.applyRows !== undefined
    ? { applyRows: resolvedBackend.applyRows }
    : undefined
  const collectionPersistence = createCollectionPersistence({
    storage: storageOf(resolvedBackend) ?? memoryStorage(),
    batch: resolvedBackend.kind === "opfs" ? resolvedBackend : transactional,
    ...(resolvedBackend.kind === "opfs" ? { flush: resolvedBackend.flush } : {}),
    ...(rowSink === undefined ? {} : { rows: rowSink })
  })
  const collections = Object.fromEntries(
    Object.entries(COLLECTION_DEFINITIONS).map(([name, definition]) => [name, definition.create(collectionPersistence)])
  ) as StoredCollections

  await seed(collections)
  const views = createWorkspaceViews(collections)
  await Promise.all(Object.values(views).map((view) => view.preload()))
  if (resolvedBackend.kind === "opfs") await resolvedBackend.flush()
  applyTheme(collections.sessions.get(SESSION_ID)?.theme ?? "light")
  applyPalette(collections.sessions.get(SESSION_ID)?.palette ?? DEFAULT_PALETTE)

  const session = (): Session => {
    const current = collections.sessions.get(SESSION_ID)
    if (current === undefined) throw new Error("Smithers app state is not initialized")
    return current
  }

  const worldStateSnapshot = (): WorldStateSnapshot => {
    const capturedAt = Date.now()
    const documents = [...collections.worldDocuments.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
    const markdown = documents
      .map(
        (document) =>
          `<!-- world-document: ${document.path}; confidence: ${document.confidence}; sources: ${
            document.sources.join(", ")
          } -->\n${document.body.trim()}`
      )
      .filter((document) => document.length > 0)
      .join("\n\n---\n\n")
    return { capturedAt, revision: session().revision, documents, markdown }
  }

  const agentContextSnapshot = (): AgentContextSnapshot => {
    const capturedAt = Date.now()
    return {
      capturedAt,
      revision: session().revision,
      // The model sees the conversation it is answering in, never another tab's.
      messages: [...collections.messages.values()]
        .filter((message) => inConversation(message, conversationTabIdOf(session())))
        .sort((left, right) => left.ordinal - right.ordinal),
      connectors: [...collections.connectors.values()].sort((left, right) => left.name.localeCompare(right.name)),
      tabs: orderedTabs(collections),
      worldState: worldStateSnapshot()
    }
  }

  const persist = async (transaction: Parameters<typeof collections.sessions.utils.acceptMutations>[0]) => {
    // The coordinator commits every durable projection before local-only sync
    // confirms any of them. A failed commit can therefore roll back optimism
    // without retaining failed rows in an adapter cache or the live collection.
    await collectionPersistence.persist(transaction)
    for (const collection of Object.values(collections)) {
      collection.utils.acceptMutations(transaction)
    }
  }

  const approvalRequest = (id: string): ApprovalRequest | undefined => {
    const request = collections.approvalRequests.get(id)
    return isApprovalRequest(request) ? freezeRequest(structuredClone(CardSchema.parse(request)) as ApprovalRequest) : undefined
  }

  // Reset fences late streams and command-settlement writes until the new boot.
  let resetTransaction: Transaction | undefined

  /*
   * The draft commit still open to keystrokes. A localStorage commit rewrites
   * the whole envelope, so one commit per keystroke copied every saved
   * collection per character. The draft is live at once; its commit waits for
   * a pause in typing, the next dispatch, page hide or dispose. The journal
   * keeps one record per commit, carrying the final draft.
   */
  let pendingDraft: { readonly transaction: Transaction; readonly revision: number; readonly deadline: number } | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  const commitDraft = (): void => {
    clearTimeout(draftTimer)
    const pending = pendingDraft
    pendingDraft = undefined
    // A failed commit this draft depended on may already have rolled it back.
    // A failure of its own rejects the receipt its callers hold.
    if (pending?.transaction.state === "pending") pending.transaction.commit().catch(() => {})
  }
  const awaitTypingPause = (deadline: number): void => {
    clearTimeout(draftTimer)
    draftTimer = setTimeout(commitDraft, Math.max(0, Math.min(DRAFT_COMMIT_IDLE_MS, deadline - Date.now())))
  }

  const dispatch = (transition: AppTransition): Transaction => {
    if (resetTransaction !== undefined) return resetTransaction
    if (transition.type === "composer.changed" && pendingDraft?.transaction.state === "pending") {
      const { transaction, revision, deadline } = pendingDraft
      const text = transition.draft
      const payload = transitionPayload(transition)
      transaction.mutate(() => {
        collections.sessions.update(SESSION_ID, (draft) => { draft.draft = text })
        collections.transitions.update(`transition-${revision}`, (record) => { record.payload = payload })
      })
      awaitTypingPause(deadline)
      return transaction
    }
    // Every other act builds on the draft's session row, so the draft commits first.
    commitDraft()
    // The transition journal persists its input as well as the card collection.
    // Redact before either writer or the verbose trace can observe env values.
    if (transition.type === "card.upsert" && transition.card.kind === "env") {
      transition = { ...transition, card: CardSchema.parse(transition.card) }
    } else if (transition.type === "card.updated" &&
      (transition.patch.kind ?? collections.cards.get(transition.id)?.kind) === "env") {
      transition = { ...transition, patch: CardPatchSchema.parse({ ...transition.patch, kind: "env" }) }
    }
    const current = session()
    const revision = current.revision + 1
    const createdAt = Date.now()
    const transaction = createTransaction({
      id: `app-transition-${revision}`,
      autoCommit: transition.type !== "composer.changed",
      metadata: { actor: transition.actor, type: transition.type },
      mutationFn: ({ transaction }) => persist(transaction)
    })

    if (transition.type === "app.reset") resetTransaction = transaction
    transaction.mutate(() => {
      const activeWorkspaceId = current.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
      const activeBranchId = current.activeBranchId ?? DEFAULT_BRANCH_ID
      const currentCard = (card: Card): Card => projectWorkspaceCard(
        card, card.kind === "workspace" ? collections.cloudWorkspaces.get(card.payload.workspaceId) : undefined
      )
      const snapshot = (): FrameSnapshot => ({
        revision,
        messages: [...collections.messages.values()],
        cards: [...collections.cards.values()].map((card) => snapshotCard(currentCard(card))),
        worldDocuments: [...collections.worldDocuments.values()],
        draft: collections.sessions.get(SESSION_ID)?.draft ?? "",
        selectedWorldDocumentId: collections.sessions.get(SESSION_ID)?.selectedWorldDocumentId ?? null
      })
      const restoreSnapshot = (saved: FrameSnapshot): void => {
        const messageIds = new Set(saved.messages.map((row) => row.id))
        const cardIds = new Set(saved.cards.map((row) => row.id))
        const worldIds = new Set(saved.worldDocuments.map((row) => row.id))
        const messageKeys = [...collections.messages.keys()].filter((id) => !messageIds.has(id))
        const cardKeys = [...collections.cards.keys()].filter((id) => !cardIds.has(id))
        const worldKeys = [...collections.worldDocuments.keys()].filter((id) => !worldIds.has(id))
        if (messageKeys.length > 0) collections.messages.delete(messageKeys)
        if (cardKeys.length > 0) collections.cards.delete(cardKeys)
        if (worldKeys.length > 0) collections.worldDocuments.delete(worldKeys)
        const replace = (draft: object, row: object): void => {
          const target = draft as Record<string, unknown>
          for (const key of Object.keys(target)) if (!(key in row)) delete target[key]
          Object.assign(draft, row)
        }
        for (const row of saved.messages) {
          if (collections.messages.get(row.id) === undefined) collections.messages.insert(row)
          else collections.messages.update(row.id, (draft) => replace(draft, row))
        }
        for (const savedCard of saved.cards) {
          const row = snapshotCard(savedCard)
          if (collections.cards.get(row.id) === undefined) collections.cards.insert(row)
          else collections.cards.update(row.id, (draft) => replace(draft, row))
        }
        for (const savedRow of saved.worldDocuments) {
          // A recorded Wiki projection cannot revive a transport or publish its pending edits.
          const row = savedRow.cloud === undefined || savedRow.cloud.phase === "deleted" ? savedRow :
            { ...savedRow, cloud: { ...savedRow.cloud, phase: "cached" as const } }
          if (collections.worldDocuments.get(row.id) === undefined) collections.worldDocuments.insert(row)
          else collections.worldDocuments.update(row.id, (draft) => replace(draft, row))
        }
        collections.sessions.update(SESSION_ID, (draft) => {
          draft.draft = saved.draft
          draft.selectedWorldDocumentId = saved.selectedWorldDocumentId !== undefined
            ? saved.selectedWorldDocumentId
            : saved.worldDocuments[0]?.id ?? null
        })
      }
      /*
       * The conversation every row written by this dispatch belongs to
       * (docs/LOCAL-APP.md "Tabs"): undefined, the one Smithers conversation.
       * Read from `current` so a turn's replies land where the turn started;
       * the two helpers are the only way a message or a card enters its
       * collection here.
       */
      const conversationTabId = conversationTabIdOf(current)
      const insertMessage = (row: Message): void => {
        collections.messages.insert(conversationTabId === undefined ? row : { ...row, tabId: conversationTabId })
      }
      const insertCard = (row: Card): void => {
        collections.cards.insert(conversationTabId === undefined ? row : { ...row, tabId: conversationTabId })
      }
      const ensureCardFrame = (cardId: string): Frame => {
        const id = cardFrameId(activeBranchId, cardId)
        const existing = collections.frames.get(id)
        if (existing !== undefined) return existing
        const frame: Frame = {
          id,
          workspaceId: activeWorkspaceId,
          branchId: activeBranchId,
          kind: "card",
          parentFrameId: rootFrameId(activeBranchId),
          cardId,
          presentation: "embedded",
          stateRevision: revision,
          createdAt,
          updatedAt: createdAt,
          revision
        }
        collections.frames.insert(frame)
        return frame
      }
      switch (transition.type) {
        case "composer.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = transition.draft
            draft.revision = revision
          })
          break

        case "message.submitted": {
          const text = transition.text.trim()
          if (text === "" || current.phase !== "idle") return
          insertMessage({
            id: `message-${transition.turnId}-user`,
            role: "user",
            text,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "responding"
            // The turn belongs to the conversation it was asked in, whatever tab is active later.
            draft.turnTabId = conversationTabId ?? null
            draft.turnId = transition.turnId
            draft.revision = revision
          })
          break
        }

        case "message.response.delta": {
          if (transition.delta === "" || current.phase !== "responding") return
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            insertMessage({
              id: messageId,
              role: "smithers",
              text: transition.channel === "text" ? transition.delta : "",
              reasoning: transition.channel === "reasoning" ? transition.delta : undefined,
              status: "complete",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              if (transition.channel === "reasoning") {
                draft.reasoning = (draft.reasoning ?? "") + transition.delta
              } else {
                draft.text += transition.delta
              }
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "message.response.completed":
          // A chain turn may legitimately complete with no prose bubble
          // (act rows or a park told the story), so completion settles the
          // phase unconditionally.
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.revision = revision
          })
          break

        case "message.response.failed": {
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            insertMessage({
              id: messageId,
              role: "smithers",
              text: `I couldn't complete that turn. ${transition.message}`,
              status: "failed",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              draft.status = "failed"
              draft.statusDetail = transition.message
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.revision = revision
          })
          break
        }

        case "message.retried": {
          // The turn's own answer (and its act rows) make way for the
          // re-run; the user's message stays exactly where it was.
          if (current.phase !== "idle") return
          const userMessage = collections.messages.get(`message-${transition.turnId}-user`)
          if (userMessage === undefined) return
          const answerId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(answerId) !== undefined) {
            collections.messages.delete(answerId)
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "responding"
            draft.turnId = transition.turnId
            draft.revision = revision
          })
          break
        }

        case "message.response.cancelled": {
          const messageId = `message-${transition.turnId}-smithers`
          const detail = transition.detail ?? "Stopped the current response."
          if (collections.messages.get(messageId) !== undefined) {
            collections.messages.update(messageId, (draft) => {
              draft.status = "interrupted"
              draft.statusDetail = detail
            })
          } else {
            // Killed before the first delta: there is no response to mark
            // up, so say what happened on that turn rather than leaving the
            // user's message hanging with nothing after it — same discipline
            // as `session.turn.orphaned`. A kill must never read as silence.
            insertMessage({
              id: messageId,
              role: "smithers",
              text: detail,
              status: "interrupted",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.revision = revision
          })
          break
        }

        case "session.turn.orphaned": {
          // The restored session claimed a turn was streaming, but the app
          // was closed — that stream is gone. Mark that turn's response
          // interrupted with the honest line; never restore a silently stuck
          // pending surface.
          //
          // The session names the turn it was answering, and that turn's
          // response lives at the id derived from it — resolving it that way
          // (rather than "the last Smithers message") is what keeps the
          // reconciliation honest: if the app died between the submit and the
          // first delta there is no response yet, and an earlier turn that
          // genuinely completed must not be relabelled as interrupted.
          if (current.phase !== "responding") return
          const turnId = current.turnId ?? latestSubmittedTurnId(collections.messages.values())
          const orphaned = turnId === undefined
            ? undefined
            : collections.messages.get(`message-${turnId}-smithers`)
          if (orphaned !== undefined) {
            collections.messages.update(orphaned.id, (draft) => {
              draft.status = "interrupted"
              draft.statusDetail = "That turn was interrupted when the app closed."
            })
          } else if (turnId !== undefined) {
            // Died before the first delta: the turn has no response at all.
            // Say so on that turn rather than leaving the user's message
            // hanging with nothing after it (Launch Checklist B-1 asks for
            // restored work to be *correctly described*, not merely unstuck).
            insertMessage({
              id: `message-${turnId}-smithers`,
              role: "smithers",
              text: "That turn was interrupted when the app closed.",
              status: "interrupted",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.turnId = null
            draft.revision = revision
          })
          break
        }

        case "app.reset": {
          for (const [name, collection] of Object.entries(collections)) {
            if (name === "sessions") continue
            const keys = [...collection.keys()]
            if (keys.length > 0) collection.delete(keys)
          }
          collections.sessions.update(SESSION_ID, draft => {
            const target = draft as unknown as Record<string, unknown>
            // Updates merge fields; explicit undefined clears optional persisted values.
            for (const key of Object.keys(target)) target[key] = undefined
            Object.assign(target, initialSession("light"), { revision })
          })
          applyTheme("light")
          applyPalette(DEFAULT_PALETTE)
          break
        }

        case "conversation.reset": {
          // A reset clears the conversation it was asked in: a chat tab's own rows, or all of main's.
          const keys = [...collections.messages.values()]
            .filter((message) => inConversation(message, conversationTabId))
            .map((message) => message.id)
          if (keys.length > 0) collections.messages.delete(keys)
          // A reset conversation is empty — it does not re-seed a welcome.
          const cardKeys = [...collections.cards.values()]
            .filter((card) => inConversation(card, conversationTabId))
            .map((card) => card.id)
          if (cardKeys.length > 0) collections.cards.delete(cardKeys)
          const removedCards = new Set(cardKeys)
          const cardFrameKeys = [...collections.frames.values()]
            .filter((frame) => frame.branchId === activeBranchId && frame.kind === "card" && frame.cardId !== null && removedCards.has(frame.cardId))
            .map((frame) => frame.id)
          if (cardFrameKeys.length > 0) collections.frames.delete(cardFrameKeys)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "idle"
            draft.composerOwner = "user"
            draft.maximizedCardId = null
            draft.activeFrameId = rootFrameId(activeBranchId)
            draft.resetConfirmOpen = false
            draft.revision = revision
          })
          break
        }

        case "conversation.reset.asked":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.resetConfirmOpen = transition.open
            draft.revision = revision
          })
          break

        case "conversation.cleared": {
          const branchId = transition.branchId
          const rootId = rootFrameId(branchId)
          if (collections.branches.has(branchId) || collections.frames.has(rootId)) {
            throw new Error("The new conversation already exists")
          }
          const saved = { ...snapshot(), revision: current.revision }
          if (transition.interruptedTurnId !== undefined) {
            const responseId = `message-${transition.interruptedTurnId}-smithers`
            const detail = "This turn was stopped when the conversation was archived."
            const response = saved.messages.find((message) => message.id === responseId)
            saved.messages = response === undefined
              ? [...saved.messages, { id: responseId, role: "smithers", text: detail, status: "interrupted", createdAt, ordinal: nextOrdinal(collections), ...(conversationTabId === undefined ? {} : { tabId: conversationTabId }) }]
              : saved.messages.map((message) => message.id === responseId ? { ...message, status: "interrupted" as const, statusDetail: detail } : message)
          }
          collections.branches.update(activeBranchId, (draft) => { draft.snapshot = saved })
          collections.branches.insert({
            id: branchId, workspaceId: activeWorkspaceId, title: `Conversation ${new Date(createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
            parentBranchId: activeBranchId, forkedFromFrameId: rootFrameId(activeBranchId),
            forkedAtRevision: current.revision, createdAt, revision
          })
          collections.frames.insert({
            id: rootId, workspaceId: activeWorkspaceId, branchId, kind: "root", parentFrameId: null,
            cardId: null, presentation: "embedded", stateRevision: revision, createdAt, updatedAt: createdAt, revision
          })
          for (const note of conversationNotes(transition.notes, saved.worldDocuments, activeBranchId, current.revision, branchId, revision, createdAt)) {
            collections.worldDocuments.insert(note)
          }
          // Legacy conversation rows are recoverable data too. Only remove
          // this conversation from the new branch's live projection. All
          // outgoing frames remain owned by the archived branch.
          const keys = [...collections.messages.values()].filter((row) => inConversation(row, conversationTabId)).map((row) => row.id)
          if (keys.length > 0) collections.messages.delete(keys)
          const cardKeys = saved.cards.filter((row) => inConversation(row, conversationTabId)).map((row) => row.id)
          if (cardKeys.length > 0) collections.cards.delete(cardKeys)
          const previous = framePath({ workspaceId: activeWorkspaceId, branchId: activeBranchId, frameId: rootFrameId(activeBranchId) })
          const kept = transition.notes.length
          insertMessage({
            id: `message-${revision}-cleared`,
            role: "smithers",
            text: archiveNotice(kept, previous, resolved.mode === "memory"),
            status: "complete",
            createdAt,
            ordinal: 0
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "idle"
            draft.composerOwner = "user"
            draft.maximizedCardId = null
            draft.activeBranchId = branchId
            draft.activeFrameId = rootId
            draft.turnTabId = null
            draft.turnId = null
            draft.resetConfirmOpen = false
            draft.revision = revision
          })
          break
        }

        case "card.maximized":
          if (collections.cards.get(transition.id) === undefined) return
          {
            const frame = ensureCardFrame(transition.id)
            const previousFrameId = current.activeFrameId
            if (previousFrameId !== undefined && previousFrameId !== frame.id && collections.frames.get(previousFrameId) !== undefined) {
              collections.frames.update(previousFrameId, (draft) => {
                draft.presentation = "embedded"
                draft.updatedAt = createdAt
                draft.revision = revision
              })
            }
            collections.frames.update(frame.id, (draft) => {
              draft.presentation = "maximized"
              draft.stateRevision = revision
              draft.snapshot = snapshot()
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.maximizedCardId = transition.id
            draft.activeWorkspaceId = activeWorkspaceId
            draft.activeBranchId = activeBranchId
            draft.activeFrameId = cardFrameId(activeBranchId, transition.id)
            draft.revision = revision
          })
          break

        case "card.minimized":
          if (current.activeFrameId !== undefined && collections.frames.get(current.activeFrameId) !== undefined) {
            collections.frames.update(current.activeFrameId, (draft) => {
              draft.presentation = "embedded"
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.maximizedCardId = null
            draft.activeWorkspaceId = activeWorkspaceId
            draft.activeBranchId = activeBranchId
            draft.activeFrameId = rootFrameId(activeBranchId)
            draft.revision = revision
          })
          break

        case "frame.navigated": {
          const workspace = collections.workspaces.get(transition.workspaceId)
          const branch = collections.branches.get(transition.branchId)
          const frame = collections.frames.get(transition.frameId)
          if (
            workspace === undefined ||
            branch?.workspaceId !== workspace.id ||
            frame?.workspaceId !== workspace.id ||
            frame.branchId !== branch.id ||
            (frame.cardId !== null && collections.cards.get(frame.cardId) === undefined &&
              !branch.snapshot?.cards.some((card) => card.id === frame.cardId))
          ) return
          if (branch.id !== activeBranchId) {
            if (current.phase === "responding") return
            const outgoing = snapshot()
            collections.branches.update(activeBranchId, (draft) => { draft.snapshot = outgoing })
            if (branch.snapshot !== undefined) restoreSnapshot(branch.snapshot)
          }
          if (current.activeFrameId !== undefined && current.activeFrameId !== frame.id && collections.frames.get(current.activeFrameId) !== undefined) {
            collections.frames.update(current.activeFrameId, (draft) => {
              draft.presentation = "embedded"
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.frames.update(frame.id, (draft) => {
            draft.presentation = frame.kind === "card" ? "maximized" : "embedded"
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeWorkspaceId = workspace.id
            draft.activeBranchId = branch.id
            draft.activeFrameId = frame.id
            draft.maximizedCardId = frame.cardId
            draft.revision = revision
          })
          break
        }

        case "frame.forked":
          if (
            collections.branches.get(transition.branch.id) !== undefined ||
            collections.frames.get(transition.rootFrame.id) !== undefined ||
            collections.frames.get(transition.selectedFrame.id) !== undefined ||
            transition.branch.workspaceId !== transition.rootFrame.workspaceId ||
            transition.branch.workspaceId !== transition.selectedFrame.workspaceId ||
            transition.branch.id !== transition.rootFrame.branchId ||
            transition.branch.id !== transition.selectedFrame.branchId
          ) return
          if (current.phase === "responding") return
          collections.branches.update(activeBranchId, (draft) => { draft.snapshot = snapshot() })
          if (transition.branch.snapshot !== undefined) restoreSnapshot(transition.branch.snapshot)
          collections.branches.insert(transition.branch)
          collections.frames.insert(transition.rootFrame)
          if (transition.selectedFrame.id !== transition.rootFrame.id) collections.frames.insert(transition.selectedFrame)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeWorkspaceId = transition.branch.workspaceId
            draft.activeBranchId = transition.branch.id
            draft.activeFrameId = transition.selectedFrame.id
            draft.maximizedCardId = transition.selectedFrame.cardId
            draft.revision = revision
          })
          break

        case "devtools.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.devtoolsOpen = transition.open
            draft.revision = revision
          })
          break

        case "verbose.toggled": {
          // Off removes every trace line: the transcript reads exactly as it
          // would have without verbose. The transition log keeps the records.
          if (!transition.on) {
            const traceKeys = [...collections.messages.keys()].filter((key) => key.startsWith(TRACE_MESSAGE_PREFIX))
            if (traceKeys.length > 0) collections.messages.delete(traceKeys)
          }
          insertMessage({
            id: `message-verbose-${revision}`,
            role: "smithers",
            text: transition.on ? VERBOSE_ON_TEXT : VERBOSE_OFF_TEXT,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.verbose = transition.on
            draft.revision = revision
          })
          break
        }

        case "flow.invoked":
          // Recorded by the transition insert below; rendered by the verbose
          // trace after the switch. The session row moves like every dispatch.
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "surfaces-menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.surfacesMenuOpen = transition.open
            draft.revision = revision
          })
          break

        case "connect-menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.connectMenuOpen = transition.open
            draft.revision = revision
          })
          break

        case "add-menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.addMenuOpen = transition.open
            draft.revision = revision
          })
          break
        case "palette.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.paletteOpen = transition.open
            if (!transition.open) draft.paletteActionsRef = null
            if (transition.lastQuery !== undefined) draft.paletteLastQuery = transition.lastQuery
            draft.revision = revision
          })
          break

        case "palette.actions.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.paletteActionsRef = transition.ref
            draft.revision = revision
          })
          break

        case "palette.item.opened":
          collections.sessions.update(SESSION_ID, (draft) => {
            const rest = (draft.paletteRecents ?? []).filter((row) => row.ref !== transition.ref || row.kind !== transition.kind)
            const seen = (draft.paletteRecents ?? []).find((row) => row.ref === transition.ref && row.kind === transition.kind)
            draft.paletteRecents = [
              { ref: transition.ref, kind: transition.kind, count: (seen?.count ?? 0) + 1, lastSeen: transition.at },
              ...rest
            ].slice(0, PALETTE_RECENTS_CAP)
            draft.revision = revision
          })
          break

        case "command.deferred":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingCommand = {
              name: transition.name,
              args: transition.args,
              requirement: transition.requirement,
              requestedAt: createdAt
            }
            draft.revision = revision
          })
          break

        case "command.deferral.cleared":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingCommand = null
            draft.revision = revision
          })
          break

        case "command.ran":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.recentCommands = [
              transition.name,
              ...(draft.recentCommands ?? []).filter((name) => name !== transition.name)
            ].slice(0, 20)
            draft.revision = revision
          })
          break

        case "toolcall.recorded":
          collections.toolCalls.insert({
            id: `toolcall-${revision}`,
            turnId: transition.turnId,
            name: transition.name,
            arguments: transition.arguments,
            result: transition.result,
            createdAt
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "chain.lineage.retired": {
          const id = retiredLineageKey(transition.lineageId)
          if (!collections.retiredChainLineages.has(id)) collections.retiredChainLineages.insert({ id })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "chain.event.appended":
          collections.chainEvents.insert({
            id: `chain-${transition.lineageId}-${transition.seq}`,
            lineageId: transition.lineageId,
            seq: transition.seq,
            event: transition.event,
            createdAt
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "chain.turn.resumed":
          if (current.phase !== "idle") return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "responding"
            draft.turnId = transition.turnId
            draft.revision = revision
          })
          break

        case "guide.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.guide = transition.guide
            draft.revision = revision
          })
          break

        case "theme.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.theme = transition.theme
            draft.revision = revision
          })
          applyTheme(transition.theme)
          break

        case "palette.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.palette = transition.palette
            draft.revision = revision
          })
          applyPalette(transition.palette)
          break

        case "composer.control.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.composerOwner = transition.owner
            if (transition.draft !== undefined) draft.draft = transition.draft
            draft.revision = revision
          })
          break

        case "surface.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.surface = transition.surface
            draft.revision = revision
          })
          break

        /*
         * The plugin shelf: installing twice is the same shelf, so the write
         * is idempotent, and the order is the order a person added them.
         */
        case "plugin.installed":
          collections.sessions.update(SESSION_ID, (draft) => {
            const installed = draft.plugins ?? []
            if (!installed.includes(transition.plugin)) draft.plugins = [...installed, transition.plugin]
            draft.revision = revision
          })
          break

        case "plugin.removed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.plugins = (draft.plugins ?? []).filter((plugin) => plugin !== transition.plugin)
            draft.revision = revision
          })
          break

        case "world.document.selected":
          if (collections.worldDocuments.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.selectedWorldDocumentId = transition.id
            draft.revision = revision
          })
          break

        case "world.document.upserted": {
          const document: WorldDocument = {
            ...transition.document,
            updatedAt: createdAt,
            updatedBy: transition.actor,
            revision
          }
          if (collections.worldDocuments.get(document.id) === undefined) {
            collections.worldDocuments.insert(document)
          } else {
            collections.worldDocuments.update(document.id, (draft) => {
              Object.assign(draft, document)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            if (transition.select !== false) draft.selectedWorldDocumentId = document.id
            draft.revision = revision
          })
          break
        }

        case "wiki.pane.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.wikiPane = transition.pane
            draft.wikiGraphPath = transition.path
            draft.revision = revision
          })
          break

        case "world.delete.asked": {
          if (transition.id !== null && collections.worldDocuments.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingWorldDeleteId = transition.id
            draft.revision = revision
          })
          break
        }

        case "world.document.removed": {
          if (collections.worldDocuments.get(transition.id) === undefined) return
          collections.worldDocuments.delete(transition.id)
          const remaining = [...collections.worldDocuments.values()].find(
            (document) => document.id !== transition.id
          )
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.selectedWorldDocumentId = remaining?.id ?? null
            // The question this answered is closed with it.
            if (draft.pendingWorldDeleteId === transition.id) draft.pendingWorldDeleteId = null
            draft.revision = revision
          })
          break
        }

        case "connector.local.requested":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "selecting-local-repository"
            draft.requestedAccess = transition.access
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.local.cancelled":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.local.failed":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = transition.message
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.local.connected": {
          const id = `local-repository:${transition.repository.root}`
          const existing = collections.connectors.get(id)
          const connector: LocalRepositoryConnector = {
            id,
            kind: "local-repository",
            status: "connected",
            access: transition.access,
            name: transition.repository.name,
            root: transition.repository.root,
            head: transition.repository.head,
            branch: transition.repository.branch,
            remoteUrl: transition.repository.remoteUrl,
            capabilities: [...repositoryCapabilities(transition.repository.root, transition.access)],
            createdAt: existing?.createdAt ?? createdAt,
            updatedAt: createdAt,
            revision
          }
          if (existing === undefined) {
            collections.connectors.insert(connector)
          } else {
            collections.connectors.update(id, (draft) => {
              Object.assign(draft, connector)
            })
          }
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "connector.access.changed":
          if (collections.connectors.get(transition.id) === undefined) return
          collections.connectors.update(transition.id, (draft) => {
            draft.access = transition.access
            draft.capabilities = [
              ...repositoryCapabilities(draft.root, transition.access)
            ]
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.removal.asked":
          if (transition.id !== null && collections.connectors.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingConnectorRemovalId = transition.id
            draft.revision = revision
          })
          break

        case "connector.removed":
          if (collections.connectors.get(transition.id) === undefined) return
          collections.connectors.delete(transition.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            if (draft.pendingConnectorRemovalId === transition.id) draft.pendingConnectorRemovalId = null
            draft.revision = revision
          })
          break

        case "card.upsert": {
          const existing = collections.cards.get(transition.card.id)
          const trusted = approvalRequest(transition.card.id)
          const incoming = transition.card
          // Only runtime code creates approval authority. The model cannot
          // replace a protected id with a presentation card to bypass this.
          if ((isApprovalRequest(incoming) || isApprovalRequest(existing) || trusted !== undefined) &&
            transition.actor !== "system") return
          if (trusted !== undefined && !isApprovalRequest(incoming)) return
          // One pending gate owns both its wording and envelope until decided.
          if (trusted?.kind === "approval" && existing?.kind === "approval" &&
            existing.payload.decision === undefined) return
          /*
           * A decided approval owns its id. An approval is a human
           * authorising an action, so a frame from the model's own
           * stream must never be able to un-decide one — and a frame
           * that replaced the card with some other kind would launder
           * the freeze away, so nothing but a new gate displaces it.
           *
           * The freeze is per-decision, not per-card: the chain runtime
           * reuses `chain-approval-<lineage>` for every park on a
           * lineage, so freezing the id would swallow the NEXT ask and
           * strand the run with no gate on screen. A frame naming a
           * different gate is a different question, and it replaces the
           * answered one.
           */
          const decided = decidedApproval(existing)
          if (decided !== undefined) {
            const incoming = transition.card.kind === "approval" ? transition.card : undefined
            if (incoming === undefined || approvalGateKey(incoming) === approvalGateKey(decided)) return
          }
          let card = transition.card
          if (isApprovalRequest(card)) {
            // A refreshed inbox may add/remove rows, but a surviving request
            // keeps the exact description and envelope first shown to the human.
            if (card.kind === "approvals-inbox" && trusted?.kind === "approvals-inbox") {
              card = { ...card, title: trusted.title, payload: { ...trusted.payload, approvals: card.payload.approvals.map((row) => {
                const prior = trusted.payload.approvals.find((entry) => entry.requestId === row.requestId)
                return prior === undefined ? row : { ...row, runId: prior.runId, title: prior.title,
                  approval: prior.approval, requestedAt: prior.requestedAt }
              }) } }
            }
            const request = structuredClone(CardSchema.parse(card))
            card = structuredClone(request)
            if (trusted === undefined) collections.approvalRequests.insert(request)
            else collections.approvalRequests.update(card.id, (draft) => { Object.assign(draft, request) })
          }
          if (existing === undefined) {
            insertCard(card)
          } else {
            collections.cards.update(card.id, (draft) => { Object.assign(draft, card) })
          }
          const frame = ensureCardFrame(card.id)
          // A recorded frame keeps the revision it was maximized at; live card state is the card row.
          if (frame.snapshot === undefined) {
            collections.frames.update(frame.id, (draft) => {
              draft.stateRevision = revision
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "card.updated": {
          const existing = collections.cards.get(transition.id)
          if (existing === undefined) return
          if (existing.kind === "approval") return
          if (existing.kind === "approvals-inbox" && transition.actor === "smithers") return
          if (transition.patch.kind !== undefined && transition.patch.kind !== existing.kind) return
          const decoded = CardPatchSchema.safeParse({ ...transition.patch, kind: existing.kind })
          if (!decoded.success) return
          const candidate = CardSchema.safeParse({
            ...existing,
            ...decoded.data,
            payload: decoded.data.payload === undefined ? existing.payload :
              existing.kind === "repo-onboarding" ? decoded.data.payload : { ...existing.payload, ...decoded.data.payload }
          })
          if (!candidate.success) return
          let patch: typeof transition.patch = candidate.data
          if (existing.kind === "approvals-inbox") {
            const trusted = approvalRequest(transition.id)
            const merged = CardSchema.safeParse({ ...existing, ...patch })
            if (trusted?.kind !== "approvals-inbox" || !merged.success || merged.data.kind !== "approvals-inbox") return
            const updates = merged.data.payload.approvals
            // Generic inbox updates can only settle decision state, never
            // change which request a row or its wording refers to.
            patch = { status: patch.status, payload: { ...trusted.payload,
              approvals: trusted.payload.approvals.map((row) => {
                const update = updates.find((entry) => entry.requestId === row.requestId)
                return { ...row, decision: update?.decision, decidedAt: update?.decidedAt,
                  pending: update?.pending, decisionError: update?.decisionError }
              }) } }
            if (patch.status === undefined) delete patch.status
          }
          collections.cards.update(transition.id, (draft) => {
            Object.assign(draft, patch)
          })
          for (const frame of collections.frames.values()) {
            if (frame.cardId !== transition.id || frame.branchId !== activeBranchId || frame.snapshot !== undefined) continue
            collections.frames.update(frame.id, (draft) => {
              draft.stateRevision = revision
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "card.approval.decision.pending": {
          if (transition.actor !== "user" || approvalRequest(transition.id)?.kind !== "approval") return
          const card = collections.cards.get(transition.id)
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            if (draft.kind === "approval") {
              draft.payload.pending = true
              draft.payload.error = undefined
            }
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "card.approval.decision.failed": {
          if (transition.actor !== "system" || approvalRequest(transition.id)?.kind !== "approval") return
          const card = collections.cards.get(transition.id)
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            draft.status = "error"
            if (draft.kind === "approval") {
              draft.payload.pending = false
              draft.payload.error = transition.message
            }
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "card.approval.decided": {
          if (transition.actor !== "user" || approvalRequest(transition.id)?.kind !== "approval") return
          const card = collections.cards.get(transition.id)
          // A failed decision attempt stays retryable, so "error" can still decide.
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            draft.status = "acted"
            if (draft.kind === "approval") {
              draft.payload.decision = transition.decision
              draft.payload.decidedAt = transition.decidedAt
              draft.payload.pending = false
              draft.payload.error = undefined
            }
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.session.loaded": {
          const existing = collections.identitySessions.get("identity")
          if (existing === undefined) return
          // Availability is transient; ownership lasts until a definitive answer.
          // Legacy signed-in rows still name their owner. A legacy outage has
          // lost that name, so undefined conservatively means unknown owner.
          const owner = existing.accountOwnerLogin !== undefined
            ? existing.accountOwnerLogin
            : existing.state === "signed-in"
            ? existing.login
            : existing.state === "unavailable"
            ? undefined
            : null
          if (owner !== null && (
            transition.state === "signed-out" ||
            (transition.state === "signed-in" && owner !== transition.login)
          )) {
            forgetAccountState(collections)
          }
          collections.identitySessions.update("identity", (draft) => {
            draft.accountOwnerLogin = transition.state === "signed-in"
              ? transition.login
              : transition.state === "signed-out" ? null : owner
            draft.state = transition.state
            draft.login = transition.login
            draft.allowlisted = transition.allowlisted
            draft.admin = transition.admin
            if (transition.scopesPlain !== null) draft.scopesPlain = transition.scopesPlain
            if (transition.state !== "signed-in") draft.accessRequested = false
            if (transition.state === "signed-in") draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.access.requested": {
          const identity = collections.identitySessions.get("identity")
          if (identity === undefined || identity.state !== "signed-in") return
          collections.identitySessions.update("identity", (draft) => {
            draft.accessRequested = true
            draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.access.failed": {
          if (collections.identitySessions.get("identity") === undefined) return
          collections.identitySessions.update("identity", (draft) => {
            draft.accessError = transition.message
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.session.cleared": {
          if (collections.identitySessions.get("identity") === undefined) return
          forgetAccountState(collections)
          collections.identitySessions.update("identity", (draft) => {
            draft.state = "signed-out"
            draft.login = null
            draft.accountOwnerLogin = null
            draft.allowlisted = false
            draft.admin = false
            draft.accessRequested = false
            draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "billing.refreshed": {
          if (collections.billingAccounts.get("billing") === undefined) return
          collections.billingAccounts.update("billing", (draft) => {
            draft.state = transition.state
            draft.totalUsd = transition.totalUsd
            draft.allowedToStartWork = transition.allowedToStartWork
            draft.lifetimeChargedUsd = transition.lifetimeChargedUsd
            draft.chargeCount = transition.chargeCount
            draft.refreshedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "billing.unavailable": {
          const account = collections.billingAccounts.get("billing")
          if (account === undefined) return
          collections.billingAccounts.update("billing", (draft) => {
            // Keep the last known balance honest-but-stale; only an account
            // that never loaded falls back to plain "unavailable".
            if (draft.state === "unknown") draft.state = "unavailable"
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "toast.shown": {
          const id = `toast-${transition.key}`
          const existing = collections.toasts.get(id)
          const toast: Toast = {
            id,
            key: transition.key,
            title: transition.title,
            status: "running",
            detail: "",
            createdAt: existing?.createdAt ?? createdAt,
            updatedAt: createdAt
          }
          if (existing === undefined) {
            collections.toasts.insert(toast)
          } else {
            collections.toasts.update(id, (draft) => {
              Object.assign(draft, toast)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "toast.resolved": {
          const id = `toast-${transition.key}`
          if (collections.toasts.get(id) === undefined) return
          collections.toasts.update(id, (draft) => {
            draft.status = transition.status
            if (transition.title !== undefined) draft.title = transition.title
            draft.detail = transition.detail
            draft.updatedAt = createdAt
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "toast.dismissed":
          if (collections.toasts.get(transition.id) === undefined) return
          collections.toasts.delete(transition.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "card.removed":
          if (collections.cards.get(transition.id) === undefined) return
          collections.cards.delete(transition.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "message.steered": {
          const steered = transition.text.trim()
          if (steered === "" || current.phase !== "responding") return
          insertMessage({
            id: `message-steer-${revision}`,
            role: "user",
            text: steered,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          // The turn's prose continues AFTER the steer, so the turn bubble
          // moves below it; deltas keep appending to the same message.
          const turnBubble = collections.messages.get(`message-${transition.turnId}-smithers`)
          if (turnBubble !== undefined) {
            collections.messages.update(turnBubble.id, (draft) => {
              draft.ordinal = nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.revision = revision
          })
          break
        }

        case "message.tool.executed": {
          insertMessage({
            id: `message-act-${revision}`,
            role: "smithers",
            text: transition.text,
            act: transition.text,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "message.claim.substituted": {
          // The turn's whole answer becomes the deterministic line: a
          // partially-suppressed claim is still a claim on screen.
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            insertMessage({
              id: messageId,
              role: "smithers",
              text: transition.text,
              status: "complete",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              draft.text = transition.text
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "message.appended": {
          insertMessage({
            id: `message-appended-${revision}`,
            role: "smithers",
            text: transition.text,
            ...(transition.action === undefined ? {} : { action: transition.action }),
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        /*
         * The local-app tabs (docs/LOCAL-APP.md "Tabs"): main is seeded and
         * never inserted or removed; every other tab takes the next place
         * in the strip and becomes the active one as it opens.
         */
        case "tab.opened": {
          if (transition.tab.kind === "main" || collections.tabs.get(transition.tab.id) !== undefined) return
          let highest = 0
          for (const tab of collections.tabs.values()) highest = Math.max(highest, tab.ordinal)
          collections.tabs.insert({ ...transition.tab, ordinal: highest + 1 })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeTabId = transition.tab.id
            draft.tabMenuOpen = false
            draft.revision = revision
          })
          break
        }

        case "tab.selected":
          if (collections.tabs.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeTabId = transition.id
            draft.revision = revision
          })
          break

        case "tab.close.asked": {
          const asked = transition.id === null ? undefined : collections.tabs.get(transition.id)
          if (transition.id !== null && (asked === undefined || asked.kind === "main")) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingTabCloseId = transition.id
            draft.revision = revision
          })
          break
        }

        case "tab.closed":
          closeTabRows(collections, [transition.id], revision)
          break

        case "tab.menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.tabMenuOpen = transition.open
            draft.revision = revision
          })
          break

        case "pty.exited": {
          for (const tab of collections.tabs.values()) {
            if ((tab.kind === "terminal" || tab.kind === "harness") && tab.sessionId === transition.sessionId) {
              collections.tabs.update(tab.id, (draft) => {
                if (draft.kind === "terminal" || draft.kind === "harness") draft.exitCode = transition.code
              })
            }
          }
          // The subagent card follows its process: exited, with the code the PTY reported.
          for (const card of collections.cards.values()) {
            if (card.kind === "agent" && card.payload.sessionId === transition.sessionId) {
              collections.cards.update(card.id, (draft) => {
                if (draft.kind !== "agent") return
                draft.payload.phase = "exited"
                draft.payload.exitCode = transition.code
                draft.status = transition.code === 0 || transition.code === null ? "acted" : "error"
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        /*
         * A reload replaces the list: rows the server still names update in
         * place, new rows insert, the rest delete. One transaction cannot
         * delete and re-insert the same key ("Unhandled mutation combination:
         * delete-insert"), so a wholesale clear-then-insert threw on every
         * reload whose list overlapped the last one.
         */

        case "harnesses.loaded": {
          const next = new Set<string>(transition.harnesses.map((harness) => harness.id))
          const stale = [...collections.harnesses.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.harnesses.delete(stale)
          for (const harness of transition.harnesses) {
            if (collections.harnesses.get(harness.id) === undefined) collections.harnesses.insert({ ...harness })
            else {
              collections.harnesses.update(harness.id, (draft) => {
                Object.assign(draft, harness)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "agents.loaded": {
          // Same replace-in-place rule as the harnesses: update, insert, delete, never delete-then-insert one key.
          const next = new Set<string>(transition.agents.map((agent) => agent.id))
          const stale = [...collections.agents.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.agents.delete(stale)
          for (const agent of transition.agents) {
            if (collections.agents.get(agent.id) === undefined) collections.agents.insert({ ...agent })
            else {
              collections.agents.update(agent.id, (draft) => {
                Object.assign(draft, agent)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "repos.loaded": {
          const next = new Set(transition.repos.map((repo) => repo.id))
          const before = new Set([...collections.repos.values()].map((repo) => repoKeyOf(repo.path)))
          const stale = [...collections.repos.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.repos.delete(stale)
          for (const repo of transition.repos) {
            if (collections.repos.get(repo.id) === undefined) collections.repos.insert({ ...repo })
            else {
              collections.repos.update(repo.id, (draft) => {
                Object.assign(draft, repo)
              })
            }
          }
          /*
           * Opening pins (docs/LOCAL-APP.md "Tabs"): every open repository is
           * a pinned row, keyed by path so it survives the server's fresh id
           * on a reopen. The active repository stays the one named when it
           * is still open; otherwise the first open one takes over.
           */
          const now = Date.now()
          for (const repo of transition.repos) {
            const id = repoKeyOf(repo.path)
            const pin = { id, name: repo.name, path: repo.path, branch: repo.git?.branch ?? null, origin: "local" as const }
            if (collections.pinnedRepos.get(id) === undefined) collections.pinnedRepos.insert({ ...pin, pinnedAt: now })
            else {
              collections.pinnedRepos.update(id, (draft) => {
                Object.assign(draft, pin)
              })
            }
            /*
             * Lane piper: an open checkout is a local working copy. The
             * repoId comes from the checkout's remote when it parses, else
             * the checkout's own name (never an invented owner); the jj
             * probe fills ahead/readAt when the server ran one.
             */
            const copyId = id
            const existing = collections.workingCopies.get(copyId)
            const repoId = repoIdFromRemote(repo.git?.remote) ?? existing?.repoId ?? repo.name
            const copy: WorkingCopy = {
              id: copyId,
              repoId,
              kind: "local",
              label: repo.name,
              path: repo.path,
              ...(repo.jj?.ahead !== null && repo.jj?.ahead !== undefined ? { ahead: repo.jj.ahead } : {}),
              ...(repo.jj !== null && repo.jj !== undefined
                ? { readAt: { changeId: repo.jj.changeId, commitId: repo.jj.commitId } }
                : {}),
              updatedAt: now,
              revision
            }
            if (existing === undefined) collections.workingCopies.insert(copy)
            else {
              collections.workingCopies.update(copyId, (draft) => {
                Object.assign(draft, copy)
              })
            }
          }
          const openKeys = new Set(transition.repos.map((repo) => repoKeyOf(repo.path)))
          const byName = [...transition.repos].sort((left, right) => left.name.localeCompare(right.name))
          // A repository that just opened is the one the human asked for: it becomes the active one.
          const opened = byName.find((repo) => !before.has(repoKeyOf(repo.path)))
          collections.sessions.update(SESSION_ID, (draft) => {
            const named = draft.activeRepoKey ?? null
            if (opened !== undefined) draft.activeRepoKey = repoKeyOf(opened.path)
            else if (named === null || !openKeys.has(named)) {
              draft.activeRepoKey = byName[0] === undefined ? named : repoKeyOf(byName[0].path)
            }
            draft.revision = revision
          })
          break
        }
        case "repositories.loaded": {
          /*
           * Lane piper: the cloud inventory replaces the collection. A row
           * keeps its fresher head when the new answer carries none (the
           * per-repo bookmarks call failed this round): an absent answer is
           * not a fact about the repo.
           */
          const next = new Set(transition.repositories.map((repository) => repository.id))
          const stale = [...collections.repositories.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.repositories.delete(stale)
          for (const repository of transition.repositories) {
            const existing = collections.repositories.get(repository.id)
            const row: CloudRepository = {
              ...repository,
              head: repository.head ?? existing?.head ?? null,
              updatedAt: createdAt,
              revision
            }
            if (existing === undefined) collections.repositories.insert(row)
            else {
              collections.repositories.update(repository.id, (draft) => {
                Object.assign(draft, row)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "repository.upserted": {
          /*
           * One row, never the collection: the rows beside it keep their own
           * revision. A row keeps its fresher head when the upsert carries
           * none, the same reading `repositories.loaded` takes.
           */
          const { repository } = transition
          const existing = collections.repositories.get(repository.id)
          const row: CloudRepository = {
            ...repository,
            head: repository.head ?? existing?.head ?? null,
            updatedAt: createdAt,
            revision
          }
          if (existing === undefined) collections.repositories.insert(row)
          else {
            collections.repositories.update(repository.id, (draft) => {
              Object.assign(draft, row)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "workingcopies.workspaces.loaded": {
          /* The cloud workspace list replaces the workspace copies only. */
          const next = new Set(transition.copies.map((copy) => copy.id))
          const stale = [...collections.workingCopies.values()]
            .filter((copy) => copy.kind === "workspace" && !next.has(copy.id))
            .map((copy) => copy.id)
          if (stale.length > 0) collections.workingCopies.delete(stale)
          for (const copy of transition.copies) {
            const row: WorkingCopy = { ...copy, updatedAt: createdAt, revision }
            if (collections.workingCopies.get(copy.id) === undefined) collections.workingCopies.insert(row)
            else {
              collections.workingCopies.update(copy.id, (draft) => {
                Object.assign(draft, row)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "cloud.session.loaded": {
          const row: CloudSessionRow = {
            id: "cloud",
            state: transition.state,
            username: transition.username,
            expiresAt: transition.expiresAt,
            scopes: transition.scopes,
            updatedAt: createdAt,
            revision
          }
          if (collections.cloudSessions.get("cloud") === undefined) collections.cloudSessions.insert(row)
          else {
            collections.cloudSessions.update("cloud", (draft) => {
              Object.assign(draft, row)
            })
          }
          // Signed out, no workspace terminal can attach: its tabs close with the session, in this transaction.
          if (transition.state === "signed-out") closeTabRows(collections, workspaceTabIds(collections), revision)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        /*
         * Lane citc: the workspaces collection is the authority; the
         * workspace working copies and live card headers are query projections.
         * Ordinary updates write the workspace row.
         */
        case "workspaces.loaded": {
          const scope = transition.repoId
          const next = new Set(transition.workspaces.map((workspace) => workspace.id))
          const stale = [...collections.cloudWorkspaces.values()]
            .filter((workspace) => (scope === undefined || workspace.repoId === scope) && !next.has(workspace.id))
            .map((workspace) => workspace.id)
          if (stale.length > 0) {
            const removed = new Set(stale)
            // Leaving the live inventory captures the last observed facts once.
            for (const card of collections.cards.values()) {
              if (card.kind !== "workspace" || !removed.has(card.payload.workspaceId)) continue
              const captured = currentCard(card)
              collections.cards.update(card.id, (draft) => {
                Object.assign(draft, captured)
              })
            }
            collections.cloudWorkspaces.delete(stale)
            closeTabRows(collections, workspaceTabIds(collections, removed), revision)
          }
          const staleCopies = [...collections.workingCopies.values()]
            .filter((copy) =>
              copy.kind === "workspace" &&
              (scope === undefined || copy.repoId === scope) &&
              copy.workspaceId !== undefined &&
              !next.has(copy.workspaceId)
            )
            .map((copy) => copy.id)
          if (staleCopies.length > 0) collections.workingCopies.delete(staleCopies)
          for (const workspace of transition.workspaces) {
            const row: CloudWorkspaceRow = { ...workspace, updatedAt: createdAt, revision }
            if (collections.cloudWorkspaces.get(workspace.id) === undefined) collections.cloudWorkspaces.insert(row)
            else {
              collections.cloudWorkspaces.update(workspace.id, (draft) => {
                Object.assign(draft, row)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "workspace.updated": {
          const workspace = transition.workspace
          const row: CloudWorkspaceRow = { ...workspace, updatedAt: createdAt, revision }
          if (collections.cloudWorkspaces.get(workspace.id) === undefined) collections.cloudWorkspaces.insert(row)
          else {
            collections.cloudWorkspaces.update(workspace.id, (draft) => {
              Object.assign(draft, row)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "workspace.session.destroyed": {
          // The tab attached to the session closes and the card stops pointing at it, together.
          closeTabRows(
            collections,
            [...collections.tabs.values()]
              .filter((tab) => tab.kind === "terminal" && tab.workspaceId !== undefined && tab.sessionId === transition.sessionId)
              .map((tab) => tab.id),
            revision
          )
          for (const card of collections.cards.values()) {
            if (card.kind !== "workspace" || card.payload.terminalSessionId !== transition.sessionId) continue
            collections.cards.update(card.id, (draft) => {
              if (draft.kind !== "workspace") return
              delete draft.payload.terminalSessionId
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "workspace.deleted": {
          // Gone is a fact: the card, the collection row, its tree copy, and its terminal tabs leave in one transaction.
          const { workspaceId } = transition
          const cardId = `workspace-${workspaceId}`
          if (collections.cards.get(cardId) !== undefined) collections.cards.delete(cardId)
          if (collections.cloudWorkspaces.get(workspaceId) !== undefined) collections.cloudWorkspaces.delete(workspaceId)
          const copyId = `workspace:${workspaceId}`
          if (collections.workingCopies.get(copyId) !== undefined) collections.workingCopies.delete(copyId)
          closeTabRows(collections, workspaceTabIds(collections, new Set([workspaceId])), revision)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        /* Lane change: one change upsert; pinned cards read the current revision from here. */
        case "change.loaded": {
          const change = transition.change
          const row: ChangeRow = { ...change, updatedAt: createdAt, revision }
          if (collections.changes.get(change.id) === undefined) collections.changes.insert(row)
          else {
            collections.changes.update(change.id, (draft) => {
              Object.assign(draft, row)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        /* Lane sync (ADR 0005): the Linear integrations list replaced; one GitHub App status upserted. */
        case "linear.integrations.loaded": {
          const next = new Set(transition.integrations.map((integration) => integration.id))
          const stale = [...collections.linearIntegrations.values()]
            .filter((integration) => !next.has(integration.id))
            .map((integration) => integration.id)
          if (stale.length > 0) collections.linearIntegrations.delete(stale)
          for (const integration of transition.integrations) {
            const row: LinearIntegrationRow = { ...integration, updatedAt: createdAt, revision }
            if (collections.linearIntegrations.get(integration.id) === undefined) collections.linearIntegrations.insert(row)
            else {
              collections.linearIntegrations.update(integration.id, (draft) => {
                Object.assign(draft, row)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "github.app-status.loaded": {
          const status = transition.status
          const row: GitHubAppStatusRow = { ...status, updatedAt: createdAt, revision }
          if (collections.githubAppStatuses.get(status.repo) === undefined) collections.githubAppStatuses.insert(row)
          else {
            collections.githubAppStatuses.update(status.repo, (draft) => {
              Object.assign(draft, row)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "repo.pinned": {
          if (collections.pinnedRepos.get(transition.pin.id) === undefined) {
            collections.pinnedRepos.insert({ ...transition.pin })
          } else {
            collections.pinnedRepos.update(transition.pin.id, (draft) => {
              Object.assign(draft, transition.pin)
            })
          }
          // Lane piper: a pinned checkout is a local working copy row.
          if (collections.workingCopies.get(transition.pin.id) === undefined) {
            collections.workingCopies.insert({
              id: transition.pin.id,
              repoId: transition.pin.name,
              kind: "local",
              label: transition.pin.name,
              path: transition.pin.path,
              updatedAt: createdAt,
              revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "repo.unpinned": {
          if (collections.pinnedRepos.get(transition.id) === undefined) return
          collections.pinnedRepos.delete(transition.id)
          if (collections.workingCopies.get(transition.id)?.kind === "local") {
            collections.workingCopies.delete(transition.id)
          }
          const treeKeys = [...collections.repoTree.values()].filter((row) => row.copyId === transition.id).map((row) => row.id)
          if (treeKeys.length > 0) collections.repoTree.delete(treeKeys)
          collections.sessions.update(SESSION_ID, (draft) => {
            if (draft.activeRepoKey === transition.id) draft.activeRepoKey = null
            const selected = draft.activeRepoKey
            if (selected !== undefined && selected !== null && selected.endsWith(`#${transition.id}`)) {
              draft.activeRepoKey = null
            }
            draft.revision = revision
          })
          break
        }
        case "repo.selected": {
          /*
           * Lane piper grammar: `org/repo` selects the repository (its
           * head), `org/repo#copyId` one working copy, and `local:/path` a
           * checkout with no repository remote.
           */
          const selection = parseRepoSelection(transition.id)
          if (selection === null) return
          if ("repoId" in selection) {
            if (selection.copyId !== undefined) {
              if (views.workingCopies.get(selection.copyId) === undefined) return
            } else if (
              collections.repositories.get(selection.repoId) === undefined &&
              ![...views.workingCopies.values()].some((copy) => copy.repoId === selection.repoId)
            ) return
          } else if (
            collections.pinnedRepos.get(selection.localCopyId) === undefined &&
            views.workingCopies.get(selection.localCopyId) === undefined
          ) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeRepoKey = transition.id
            draft.revision = revision
          })
          break
        }
        case "repository-flows.loaded": {
          /*
           * One row per repository, replaced whole: the projection is the
           * catalog, so a reload keeps nothing of a stale one, and an absent
           * projection (an empty list) leaves no row and therefore no leaves.
           */
          const existing = collections.repositoryFlows.get(transition.repo)
          if (transition.flows.length === 0) {
            if (existing !== undefined) collections.repositoryFlows.delete(transition.repo)
          } else if (existing === undefined) {
            collections.repositoryFlows.insert({ id: transition.repo, flows: [...transition.flows], loadedAt: createdAt })
          } else {
            collections.repositoryFlows.update(transition.repo, (draft) => {
              draft.flows = [...transition.flows]
              draft.loadedAt = createdAt
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "repo-tree.toggled": {
          const id = repoTreeRowId(transition.copyId, transition.path)
          if (collections.repoTree.get(id) === undefined) return
          collections.repoTree.update(id, (draft) => {
            draft.expanded = transition.expanded
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "repo-tree.loading":
        case "repo-tree.loaded":
        case "repo-tree.failed": {
          /*
           * One row per directory: a first expand inserts it loading (and
           * expanded — the caret turns at once, the listing follows); the
           * route's answer rewrites the same row. A retry of a failed row
           * keeps nothing of the failure; a load keeps nothing of a stale
           * listing. `expanded` is the user's, so an answer never changes it.
           */
          const id = repoTreeRowId(transition.copyId, transition.path)
          const existing = collections.repoTree.get(id)
          const next: RepoTreeRow = transition.type === "repo-tree.loading"
            ? { id, copyId: transition.copyId, path: transition.path, expanded: true, state: "loading", entries: existing?.entries ?? [], loadedAt: createdAt }
            : transition.type === "repo-tree.loaded"
            ? {
              id,
              copyId: transition.copyId,
              path: transition.path,
              expanded: existing?.expanded ?? true,
              state: "loaded",
              entries: [...transition.entries],
              ...(transition.truncated ? { truncated: true } : {}),
              loadedAt: createdAt
            }
            : { id, copyId: transition.copyId, path: transition.path, expanded: existing?.expanded ?? true, state: "failed", entries: [], error: transition.error, loadedAt: createdAt }
          if (existing === undefined) {
            collections.repoTree.insert(next)
          } else {
            collections.repoTree.update(id, (draft) => {
              draft.expanded = next.expanded
              draft.state = next.state
              draft.entries = next.entries
              draft.error = next.error
              draft.truncated = next.truncated
              draft.loadedAt = next.loadedAt
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "workspace.renamed": {
          const name = transition.name.trim()
          if (name === "") return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.workspaceName = name
            draft.workspaceRenameOpen = false
            draft.revision = revision
          })
          break
        }
        case "workspace.rename.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.workspaceRenameOpen = transition.open
            draft.revision = revision
          })
          break
        case "target.starred":
        case "target.unstarred": {
          /*
           * The collection is the authority; the open targets card mirrors
           * the repository's stars in its payload so the table stays a
           * projection of one record and survives a reload the same way.
           */
          if (transition.type === "target.starred") {
            if (collections.starredTargets.get(transition.star.id) === undefined) {
              collections.starredTargets.insert({ ...transition.star })
            }
          } else if (collections.starredTargets.get(transition.id) !== undefined) {
            collections.starredTargets.delete(transition.id)
          }
          const repoKey = transition.type === "target.starred" ? transition.star.repoKey : transition.id.split("::")[0]
          const starred = [...collections.starredTargets.values()]
            .filter((star) => star.repoKey === repoKey)
            .map((star) => star.label)
            .sort()
          for (const card of collections.cards.values()) {
            if (card.kind !== "targets" || card.payload.repoId !== transition.repoId) continue
            /* Spread the stored value, not the draft: a drafted nested record fails zod's plain-object check. */
            const payload = { ...card.payload, starred }
            collections.cards.update(card.id, (draft) => {
              if (draft.kind === "targets") draft.payload = payload
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
        case "recommendations.updated": {
          /*
           * Latest state wins: a read made against an older revision than the
           * row already holds is stale (a slower agent answer landing after
           * the rule already answered the newer state) and is dropped.
           */
          const existing = collections.recommendations.get(RECOMMENDATION_ID)
          if (existing !== undefined && existing.revision > transition.revision) {
            collections.sessions.update(SESSION_ID, (draft) => {
              draft.revision = revision
            })
            break
          }
          const row: Recommendation = {
            id: RECOMMENDATION_ID,
            suggestions: transition.suggestions.map((suggestion) => ({ ...suggestion })),
            source: transition.source,
            revision: transition.revision,
            createdAt
          }
          if (existing === undefined) collections.recommendations.insert(row)
          else {
            collections.recommendations.update(RECOMMENDATION_ID, (draft) => {
              Object.assign(draft, row)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
      }

      /*
       * /verbose: the maintainer's view of everything. A traced transition
       * becomes one marker line in the transcript, and the logger writes the
       * same record to the console. Read from `current` (the session before
       * this dispatch) so the switch-off dispatch itself is not traced.
       */
      const traced = transition.type !== "app.reset" && current.verbose === true && (transition.type === "verbose.toggled" ? transition.on : true)
        ? verboseTrace(transition)
        : undefined
      if (traced !== undefined) {
        insertMessage({
          id: `${TRACE_MESSAGE_PREFIX}${revision}`,
          role: "smithers",
          text: traced,
          act: traced,
          status: "complete",
          createdAt,
          ordinal: nextOrdinal(collections)
        })
        console.debug(`[smithers ${revision}] ${traced}`, transitionPayload(transition))
      }

      collections.transitions.insert({
        id: `transition-${revision}`,
        revision,
        actor: transition.actor,
        type: transition.type,
        payload: transitionPayload(transition),
        createdAt
      })
      /*
       * Retention (docs/persistence.md): derived diagnostic logs compact inside
       * the appending transaction, so the bound is part of the atomic commit
       * and a crash can never leave a half-swept log.
       */
      const staleTransitions = staleLogKeys(
        [...collections.transitions.values()],
        MAX_TRANSITION_RECORDS,
        (record) => record.revision
      )
      if (staleTransitions.length > 0) collections.transitions.delete(staleTransitions)
      const staleToolCalls = staleLogKeys(
        [...collections.toolCalls.values()],
        MAX_TOOL_CALL_RECORDS,
        (record) => record.createdAt
      )
      if (staleToolCalls.length > 0) collections.toolCalls.delete(staleToolCalls)
      // chainEvents is execution authority, not a debug tail. Deleting even
      // a terminal lineage makes replay look new and can repeat its effects.
      // Retain it until an explicit archive/tombstone protocol exists.
    })

    if (transition.type === "app.reset") {
      void transaction.isPersisted.promise.catch(() => { resetTransaction = undefined })
    }
    if (transition.type === "composer.changed") {
      pendingDraft = { transaction, revision, deadline: createdAt + DRAFT_COMMIT_MAX_MS }
      awaitTypingPause(pendingDraft.deadline)
    }
    return transaction
  }

  const interruptedGuide = collections.sessions.get(SESSION_ID)?.guide
  if (interruptedGuide?.demoRun?.status === "running") {
    await dispatch({ type: "guide.changed", actor: "system", guide: {
      ...interruptedGuide, demoRun: { ...interruptedGuide.demoRun, status: "interrupted" },
    } }).isPersisted.promise
  }

  // Boot reconciliation: a persisted "responding" phase means the app went
  // away mid-turn — no done frame can ever arrive for that stream. Name it
  // through the dispatcher (journaled, actor system) instead of restoring a
  // silently stuck pending surface (Launch Checklist B-1).
  // Awaited like every other boot write in `seed`: the reconciliation is durable
  // before the store is handed out, and its persistence failure surfaces as a
  // rejected boot rather than an unhandled rejection nobody sees.
  if (collections.sessions.get(SESSION_ID)?.phase === "responding") {
    await dispatch({ type: "session.turn.orphaned", actor: "system" }).isPersisted.promise
  }

  // A submission belongs to the previous controller's lifetime. Preserve
  // its inputs, release the busy guard, and name the uncertain outcome so
  // the user can check for a completed side effect before retrying.
  for (const card of collections.cards.values()) {
    if (card.kind !== "flow-form" || card.payload.submitting !== true) continue
    await dispatch({
      type: "card.updated",
      actor: "system",
      id: card.id,
      patch: {
        status: "error",
        payload: {
          ...card.payload,
          submitting: false,
          error: "Submission was interrupted. Check the result before submitting again."
        }
      }
    }).isPersisted.promise
  }

  /*
   * Boot reconciliation: a question is not state either. A pending
   * `/world.delete` confirm that survived a restart opened its modal over an
   * app the user had not asked anything of — and the overlay swallowed every
   * pointer press, so the whole app was unreachable. An unanswered question
   * is dropped, never re-asked.
   */
  if (collections.sessions.get(SESSION_ID)?.pendingWorldDeleteId != null) {
    await dispatch({ type: "world.delete.asked", actor: "system", id: null }).isPersisted.promise
  }

  // Boot reconciliation: toasts are notifications, not state — a toast left
  // behind by a closed session would resurrect a "running" notice for work
  // that is gone. They never survive a restart.
  for (const key of [...collections.toasts.keys()]) {
    await dispatch({ type: "toast.dismissed", actor: "system", id: key }).isPersisted.promise
  }

  /*
   * Boot reconciliation for the tabs: a terminal or harness tab names a PTY
   * session of the server that is gone with the last launch, and a card tab
   * whose card was cleared has nothing to show. Both close, through the
   * dispatcher, so the strip never opens onto a dead process. The selected
   * tab falls back to main when it no longer exists, and neither the `+`
   * menu nor a pending close question survives a restart (a question is
   * not state).
   */
  for (const tab of orderedTabs(collections)) {
    const stale = tab.kind === "terminal" || tab.kind === "harness" ||
      (tab.kind === "card" && collections.cards.get(tab.cardId) === undefined)
    if (stale) await dispatch({ type: "tab.closed", actor: "system", id: tab.id }).isPersisted.promise
  }
  if (collections.tabs.get(collections.sessions.get(SESSION_ID)?.activeTabId ?? MAIN_TAB_ID) === undefined) {
    await dispatch({ type: "tab.selected", actor: "system", id: MAIN_TAB_ID }).isPersisted.promise
  }
  if (collections.sessions.get(SESSION_ID)?.tabMenuOpen === true) {
    await dispatch({ type: "tab.menu.toggled", actor: "system", open: false }).isPersisted.promise
  }
  if (collections.sessions.get(SESSION_ID)?.pendingTabCloseId != null) {
    await dispatch({ type: "tab.close.asked", actor: "system", id: null }).isPersisted.promise
  }

  /*
   * A degraded launch runs on a memory store: the transcript is empty and
   * nothing typed in this session will survive it. Refusing to read or
   * overwrite the recorded store is the right call, but the person looking at
   * the empty surface has to be told why, or an honest recovery reads as
   * silent data loss. The failure toast is the one notice that stays until
   * dismissed, which is what this state needs — it is true for the whole
   * session, not for 300ms.
   *
   * Raised after the stale-toast sweep above so it is not swept with them.
   */
  if (resolved.degraded) {
    await dispatch({
      type: "toast.shown",
      actor: "system",
      key: "store.degraded",
      title: "This session will not be saved"
    }).isPersisted.promise
    await dispatch({
      type: "toast.resolved",
      actor: "system",
      key: "store.degraded",
      status: "failed",
      title: "This session will not be saved",
      detail:
        "The saved conversation could not be opened, so this session is running in memory. Nothing typed now will be kept. The saved conversation is untouched and returns on the next launch."
    }).isPersisted.promise
  }

  // A hidden page may never run the typing-pause timer; commit what was typed.
  const page = typeof window === "undefined" || typeof window.addEventListener !== "function" ? undefined : window
  page?.addEventListener("pagehide", commitDraft)

  const { approvalRequests: _approvalRequests, ...publicCollections } = collections
  return {
    collections: { ...publicCollections, ...views },
    dispatch,
    approvalRequest,
    persistenceMode: resolved.mode,
    persistenceDegraded: resolved.degraded,
    session,
    worldStateSnapshot,
    agentContextSnapshot,
    readRecovery: () => captureBrowserStorageRecovery({
      session: resolved.mode,
      localStorage: recoveryStorage(resolved.mode === "localStorage" ? persistedLocally : bootRecordStorage()),
      sqlite: resolvedBackend.kind === "opfs"
        ? resolvedBackend.readRecovery ?? (() => Promise.reject(new StorageRecoveryError("unreadable")))
        : browserSqliteRecoveryReader(),
      ...(resolved.mode === "memory" ? { memory: recoveryStorage(persistedLocally) } : {})
    }),
    dispose: async () => {
      page?.removeEventListener("pagehide", commitDraft)
      const draft = pendingDraft?.transaction
      commitDraft()
      // Its failure rejects the dispatch receipt; release the store either way.
      await draft?.isPersisted.promise.catch(() => {})
      await Promise.all(Object.values(views).map((view) => view.cleanup()))
      if (resolvedBackend.kind === "opfs") await resolvedBackend.close()
    }
  }
}
