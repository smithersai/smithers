/**
 * The one core every client calls: a catalog of flows and queries, and four
 * verbs over it. `catalog` lists them, `submit` runs a flow, `read` answers a
 * query, `changes` follows one.
 *
 * A {@link CoreApi} is bound to a principal. The engine, not an adapter,
 * decides every refusal: person-only flows refuse every delegate, protected
 * flows need a single-use receipt, and a flow needs every capability it
 * declares. Each committed output carries a `CauseReceipt`.
 *
 * Adding a flow is one `register` call. No adapter names an operation.
 *
 * Nothing the core hands out is a way back in. It keeps its own frozen copy
 * of every registration, and every descriptor, row and output a caller gets
 * is a detached, deeply frozen value: only a committed flow changes state.
 *
 * @since 1.0.0
 */

import { BoundedJson } from "@smthrs/canonical"
import * as JsonSchema from "@smthrs/plugin/JsonSchema"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Cause from "./CauseReceipt.ts"
import * as Principal from "./Principal.ts"

/**
 * A JSON value.
 *
 * @category models
 * @since 1.0.0
 */
export type Json = Cause.Json

/**
 * A JSON object: a flow's payload, a query's params.
 *
 * @category models
 * @since 1.0.0
 */
export type Fields = { readonly [name: string]: Json }

/**
 * Why the core refused a call.
 *
 * @category models
 * @since 1.0.0
 */
export const Reason = Schema.Literals([
  "not_found",
  "person_only",
  "receipt_required",
  "capability_exceeded",
  "unauthorized",
  "invalid_payload",
  "provenance_missing",
  "operation_failed",
  "invalid_cursor",
  "invalid_registration"
])

/**
 * Why the core refused a call.
 *
 * @category models
 * @since 1.0.0
 */
export type Reason = typeof Reason.Type

/**
 * The core refused a call. `target` is the flow tag, query name or reference
 * the caller asked for; `code` narrows a failed flow or a refused receipt;
 * `missingFields` names required payload fields the caller left out.
 *
 * @category errors
 * @since 1.0.0
 */
export class CoreError extends Schema.TaggedError<CoreError>()("@smthrs/app-core/CoreError", {
  reason: Reason,
  target: Schema.String,
  detail: Schema.String,
  code: Schema.optional(Schema.String),
  missingFields: Schema.optional(Schema.Array(Schema.String))
}) {}

const refuse = (
  reason: Reason,
  target: string,
  detail: string,
  extra: { readonly code?: string; readonly missingFields?: ReadonlyArray<string> } = {}
): CoreError => new CoreError({ reason, target: target.slice(0, 256), detail, ...extra })

/**
 * A flow's typed failure: a stable code and a sentence. Nothing it wrote commits.
 *
 * @category models
 * @since 1.0.0
 */
export class Failed {
  readonly code: string
  readonly detail: string
  constructor(code: string, detail: string) {
    this.code = code
    this.detail = detail
  }
}

/**
 * What a running flow reads and writes. Writes commit together, only when the
 * flow returns a value.
 *
 * @category models
 * @since 1.0.0
 */
export interface Tx {
  readonly subject: string
  readonly act: Principal.Act | undefined
  /** A detached, frozen copy of one row. */
  readonly get: (collection: string, key: string) => Json | undefined
  /** Detached, frozen copies of a collection's rows. */
  readonly rows: (collection: string) => ReadonlyArray<Json>
  /** Writes a copy of `row` as it is now. Later edits to `row` do not reach the draft. */
  readonly put: (collection: string, key: string, row: Json) => void
  /** Names the plan revision that caused this output. The engine stamps it on the receipt. */
  readonly causedBy: (plan: Cause.PlanRef) => void
}

/**
 * A flow in the catalog: its tag, its payload schema, who may run it, and the
 * pure step that runs it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Flow {
  readonly tag: string
  readonly title: string
  readonly description?: string
  /** An object schema in the closed JSON Schema subset. */
  readonly payload: JsonSchema.Resolved
  readonly capabilities?: ReadonlyArray<string>
  /** Set means only the person may run it; the text says why. */
  readonly personOnly?: string
  /** Set means it also needs a single-use receipt the person confirmed. */
  readonly protected?: boolean
  /** Set means only its subject may read its outputs' provenance. */
  readonly private?: boolean
  readonly run: (payload: Fields, tx: Tx) => Json | Failed
}

/**
 * A query in the catalog: the rows of one collection, in the order they were
 * first written. `{ key }` narrows it to one row.
 *
 * @category models
 * @since 1.0.0
 */
export interface Projection {
  readonly name: string
  readonly title: string
  readonly description?: string
  readonly collection: string
  readonly capabilities?: ReadonlyArray<string>
}

/**
 * One catalog entry, as every client sees it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
  readonly kind: "flow" | "query"
  readonly tag: string
  readonly title: string
  readonly description: string
  readonly payload: JsonSchema.Resolved
  readonly capabilities: ReadonlyArray<string>
  /** Set means only the person may run it, through host-drawn UI. */
  readonly personOnly?: string
  readonly protected: boolean
  readonly readOnly: boolean
}

/**
 * One page of the catalog. `next` is the cursor of the following page.
 *
 * @category models
 * @since 1.0.0
 */
export interface CatalogPage {
  readonly entries: ReadonlyArray<Entry>
  readonly next?: string
}

/**
 * A request to run a flow. `receipt` confirms a protected one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Intent {
  readonly operation: string
  readonly payload?: unknown
  readonly receipt?: string
}

/**
 * A committed run: its output, and the receipt the engine stamped on it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Requested {
  readonly runId: string
  readonly outputRef: string
  readonly journalSeq: number
  readonly output: Json
  readonly cause: Cause.CauseReceipt
}

/**
 * A request to read a query.
 *
 * @category models
 * @since 1.0.0
 */
export interface Query {
  readonly query: string
  readonly params?: unknown
}

/**
 * A query's rows, and the journal position they were read at.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page {
  readonly rows: ReadonlyArray<Json>
  readonly cursor: string
}

/**
 * A query's rows after a commit changed them.
 *
 * @category models
 * @since 1.0.0
 */
export type Change = Page

/**
 * The core, bound to one principal.
 *
 * @category models
 * @since 1.0.0
 */
export interface CoreApi {
  readonly catalog: (cursor?: string) => Effect.Effect<CatalogPage, CoreError>
  readonly submit: (intent: Intent) => Effect.Effect<Requested, CoreError>
  readonly read: (query: Query) => Effect.Effect<Page, CoreError>
  /** The rows as they stand when they differ from `after`, then again after each commit that changes them. */
  readonly changes: (query: Query, after: string) => Stream.Stream<Change, CoreError>
}

/**
 * The core service, bound to the principal of the layer that provides it.
 *
 * @category services
 * @since 1.0.0
 */
export class SmithersCore extends Context.Service<SmithersCore, CoreApi>()("@smthrs/app-core/SmithersCore") {}

/**
 * The unbound core: its state, journal and catalog.
 *
 * @category models
 * @since 1.0.0
 */
export interface Engine {
  /** Adds a flow or a query to the catalog. Every client sees it on its next call. */
  readonly register: (item: Flow | Projection) => Effect.Effect<void, CoreError>
  /**
   * Mints the principal the evidence allows and binds the core to it. It picks
   * one of the door-specific openers below by the evidence's kind and door,
   * and refuses `unknown_door` for anything else.
   */
  readonly open: (evidence: Principal.DoorEvidence) => Effect.Effect<CoreApi, Principal.AuthRefused>
  /** The MCP door. Reads only the transport and token reference; always an agent. */
  readonly openMcp: (
    from: { readonly transport: "stdio" | "http"; readonly tokenRef: string }
  ) => Effect.Effect<CoreApi, Principal.AuthRefused>
  /** The CLI and skill door. Reads only the session file; always an agent. */
  readonly openIncur: (from: { readonly sessionFile: string }) => Effect.Effect<CoreApi, Principal.AuthRefused>
  /** The SDK door. Reads only the run credential; always a flow. */
  readonly openSdk: (
    from: { readonly runCredential: Principal.SdkEvidence["runCredential"] }
  ) => Effect.Effect<CoreApi, Principal.AuthRefused>
  /** A plugin frame's door. Reads only the session and plugin; always an app, never the person. */
  readonly openFrame: (
    from: { readonly session: string; readonly plugin: string }
  ) => Effect.Effect<CoreApi, Principal.AuthRefused>
  /** A host-drawn door. Reads only the session and one of the four person doors (`strip` when left out). */
  readonly openPerson: (
    from: { readonly session: string; readonly door?: Principal.PersonDoor }
  ) => Effect.Effect<CoreApi, Principal.AuthRefused>
  /**
   * Binds the core to a minted principal. A forged one, or one another
   * credential issuer minted, is refused `unauthorized` on every call.
   */
  readonly bind: (principal: Principal.Principal) => CoreApi
  /**
   * The person confirms one protected intent: a receipt good once, for 60 seconds, for exactly this payload.
   * The evidence must be well-formed GUI person evidence; anything else, a missing door included, refuses `unknown_door`.
   */
  readonly confirm: (
    evidence: Principal.PersonEvidence,
    intent: Intent
  ) => Effect.Effect<string, Principal.AuthRefused | CoreError>
  /** Canonical JSON of every collection and every receipt. Equal histories give equal bytes. */
  readonly snapshot: () => string
}

/**
 * The most entries one catalog page holds.
 *
 * @category limits
 * @since 1.0.0
 */
export const catalogPageSize = 64

const limits: BoundedJson.Limits = {
  maxBytes: 65_536,
  maxDepth: 32,
  maxMembers: 4_096,
  maxNodes: 16_384,
  maxStringBytes: 65_536,
  maxKeyBytes: 256
}

const protectedReason = "A protected act needs the person's confirmation."

const tagPattern = /^[a-z][a-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/

// A detached, deeply frozen copy of a JSON value. Throws for what is not JSON.
const copyOf = (value: unknown): unknown => {
  if (value === null) return value
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("not JSON")
      return value
    case "object": {
      if (Array.isArray(value)) return Object.freeze(Array.from(value, copyOf))
      const copy: { [key: string]: unknown } = {}
      for (const key of Object.keys(value)) {
        const member: unknown = (value as { readonly [key: string]: unknown })[key]
        if (member === undefined) continue
        // An own data property, whatever the key: `__proto__` is a field, not a prototype.
        Object.defineProperty(copy, key, { value: copyOf(member), enumerable: true, writable: true, configurable: true })
      }
      return Object.freeze(copy)
    }
    default:
      throw new TypeError("not JSON")
  }
}

const immutable = <A>(value: A): A => copyOf(value) as A

const noParams: JsonSchema.Resolved = immutable<JsonSchema.Resolved>({
  type: "object",
  properties: { key: { type: "string", minLength: 1 } },
  additionalProperties: false
})

const causeEntry: Entry = immutable<Entry>({
  kind: "query",
  tag: Cause.query,
  title: "Cause of an output",
  description: "The run, attempt and plan revision that produced an output.",
  payload: {
    type: "object",
    properties: { ref: { type: "string", minLength: 1 } },
    required: ["ref"],
    additionalProperties: false
  },
  capabilities: [],
  protected: false,
  readOnly: true
})

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Copies the caller's value as bounded, inert JSON, then checks it against the schema.
const admit = (target: string, schema: JsonSchema.Resolved, input: unknown): Fields | CoreError => {
  const admitted = BoundedJson.admit(input === undefined ? {} : input, limits)
  if (!admitted.ok) return refuse("invalid_payload", target, admitted.complaint)
  const value: unknown = admitted.value
  if (!isFields(value)) return refuse("invalid_payload", target, "the payload is not an object")
  const failed = JsonSchema.validate(schema, value)
  if (Option.isSome(failed)) {
    const missingFields = (schema.required ?? []).filter((name) => !Object.hasOwn(value, name))
    return refuse(
      "invalid_payload",
      target,
      `the payload fails its schema at ${failed.value}`,
      missingFields.length === 0 ? {} : { missingFields }
    )
  }
  return immutable(value)
}

const fromResult = <A>(result: A | CoreError): Effect.Effect<A, CoreError> =>
  result instanceof CoreError ? Effect.fail(result) : Effect.succeed(result)

/**
 * Builds an engine over a credential service, with the flows and queries it
 * starts with.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly credentials: Principal.Credentials
  readonly flows?: ReadonlyArray<Flow>
  readonly projections?: ReadonlyArray<Projection>
}): Effect.Effect<Engine, CoreError> =>
  Effect.suspend(() => {
    const { credentials } = options
    // What the engine keeps of a registration: its own frozen descriptor, and
    // the facts it authorizes by. The caller's objects are never read again.
    interface Registered {
      readonly entry: Entry
      readonly run: Flow["run"]
      readonly personOnly: string | undefined
      readonly protected: boolean
      readonly private: boolean
    }
    const flows = new Map<string, Registered>()
    const projections = new Map<string, { readonly entry: Entry; readonly collection: string }>()
    const order: Array<string> = [Cause.query]
    const state = new Map<string, Map<string, Json>>()
    const ledger = Cause.ledger()
    const listeners = new Set<() => void>()
    let head = 0

    const entryOf = (tag: string): Entry | undefined =>
      tag === Cause.query ? causeEntry : flows.get(tag)?.entry ?? projections.get(tag)?.entry

    const registerNow = (item: Flow | Projection): void | CoreError => {
      const tag = "run" in item ? item.tag : item.name
      if (typeof tag !== "string" || tag.length > 256 || !tagPattern.test(tag)) {
        return refuse("invalid_registration", String(tag), "the tag is outside the flow tag grammar")
      }
      if (entryOf(tag) !== undefined) return refuse("invalid_registration", tag, "the tag is already registered")
      try {
        if ("run" in item) {
          if (item.payload.type !== "object") {
            return refuse("invalid_registration", tag, "a flow's payload schema must be an object")
          }
          const isProtected = item.protected === true
          const personOnly = item.personOnly ?? (isProtected ? protectedReason : undefined)
          const entry = immutable<Entry>({
            kind: "flow",
            tag,
            title: item.title,
            description: item.description ?? item.title,
            payload: item.payload,
            capabilities: item.capabilities ?? [],
            ...(personOnly === undefined ? {} : { personOnly }),
            protected: isProtected,
            readOnly: false
          })
          // Frozen, and the handler is called without it as `this`: a flow
          // cannot reach, let alone edit, the facts that authorize it.
          flows.set(tag, Object.freeze({
            entry,
            run: item.run,
            personOnly: item.personOnly === undefined ? undefined : entry.personOnly,
            protected: isProtected,
            private: item.private === true
          }))
        } else {
          const entry = immutable<Entry>({
            kind: "query",
            tag,
            title: item.title,
            description: item.description ?? item.title,
            payload: noParams,
            capabilities: item.capabilities ?? [],
            protected: false,
            readOnly: true
          })
          projections.set(tag, Object.freeze({ entry, collection: String(item.collection) }))
        }
      } catch {
        return refuse("invalid_registration", tag, "the registration's metadata is not JSON")
      }
      order.push(tag)
    }

    const held = (facts: Principal.Authority, target: string, needs: ReadonlyArray<string>): CoreError | undefined => {
      const lacking = needs.filter((capability) => !facts.capabilities.includes(capability))
      return lacking.length === 0
        ? undefined
        : refuse("capability_exceeded", target, `the caller lacks ${lacking.join(", ")}`)
    }

    const who = (principal: Principal.Principal, target: string): Principal.Authority | CoreError =>
      // The engine's own issuer answers. A principal another issuer minted has no entry there.
      credentials.authority(principal) ??
        refuse("unauthorized", target, "the principal was not minted by this core's Credentials")

    // Committed rows never leave the engine: a reader gets a detached, frozen copy.
    const page = (rows: ReadonlyArray<Json>, cursor: string): Page => Object.freeze({ rows: immutable(rows), cursor })

    const readNow = (principal: Principal.Principal, query: Query): Page | CoreError => {
      const name = String(query.query)
      const facts = who(principal, name)
      if (facts instanceof CoreError) return facts
      const entry = entryOf(name)
      if (entry === undefined || entry.kind !== "query") return refuse("not_found", name, "no such query")
      const lacking = held(facts, name, entry.capabilities)
      if (lacking !== undefined) return lacking
      const params = admit(name, entry.payload, query.params)
      if (params instanceof CoreError) return params
      const cursor = String(head)
      if (name === Cause.query) {
        const ref = String(params["ref"])
        const found = ledger.lookup(ref, facts.subject)
        if (found._tag === "Missing") {
          return refuse("provenance_missing", ref, "no receipt was stamped for this reference")
        }
        if (found._tag === "Private") {
          return refuse("unauthorized", ref, "this output's provenance is private")
        }
        return page([found.receipt], cursor)
      }
      const rows = state.get(projections.get(name)!.collection) ?? new Map<string, Json>()
      const key = params["key"]
      if (typeof key === "string") return page(rows.has(key) ? [rows.get(key) as Json] : [], cursor)
      return page(Array.from(rows.values()), cursor)
    }

    interface Prepared {
      readonly facts: Principal.Authority
      readonly flow: Registered
      readonly payload: Fields
    }

    // Every refusal that needs no clock and no hash, in the order a caller may learn them.
    const prepare = (principal: Principal.Principal, intent: Intent): Prepared | CoreError => {
      const tag = String(intent.operation)
      const facts = who(principal, tag)
      if (facts instanceof CoreError) return facts
      const flow = flows.get(tag)
      if (flow === undefined) return refuse("not_found", tag, "no such flow")
      if ((flow.personOnly !== undefined || flow.protected) && facts.act !== undefined) {
        return refuse("person_only", tag, flow.personOnly ?? protectedReason, { code: facts.act })
      }
      const lacking = held(facts, tag, flow.entry.capabilities)
      if (lacking !== undefined) return lacking
      const payload = admit(tag, flow.entry.payload, intent.payload)
      if (payload instanceof CoreError) return payload
      return { facts, flow, payload }
    }

    // One synchronous step: run the flow on a draft, then commit the writes,
    // the journal position and the receipt together, or nothing.
    const commit = ({ facts, flow, payload }: Prepared, promptHash: string): Requested | CoreError => {
      const tag = flow.entry.tag
      const draft = new Map<string, Map<string, Json>>()
      const cause: { plan?: Cause.PlanRef } = {}
      const merged = (collection: string): Map<string, Json> => {
        const rows = new Map(state.get(collection))
        for (const [key, row] of draft.get(collection) ?? []) rows.set(key, row)
        return rows
      }
      const tx: Tx = {
        subject: facts.subject,
        act: facts.act,
        // A flow holds copies only. Editing one changes neither the draft nor
        // committed state, so a flow that fails leaves nothing behind.
        get: (collection, key) => {
          const row = merged(collection).get(key)
          return row === undefined ? undefined : immutable(row)
        },
        rows: (collection) => immutable(Array.from(merged(collection).values())),
        put: (collection, key, row) => {
          const rows = draft.get(collection) ?? new Map<string, Json>()
          rows.set(String(key), immutable(row))
          draft.set(collection, rows)
        },
        causedBy: (plan) => {
          cause.plan = { page: plan.page, blockId: plan.blockId, rev: plan.rev }
        }
      }
      let result: Json | Failed
      try {
        result = Reflect.apply(flow.run, undefined, [payload, tx])
      } catch {
        return refuse("operation_failed", tag, "the flow threw", { code: "defect" })
      }
      if (result instanceof Failed) return refuse("operation_failed", tag, result.detail, { code: result.code })
      const output = BoundedJson.admit(result, limits)
      if (!output.ok) {
        return refuse("operation_failed", tag, "the flow's output is not JSON", { code: "invalid_output" })
      }
      for (const [collection, rows] of draft) state.set(collection, merged(collection)), rows.clear()
      head += 1
      const runId = `run-${head}`
      const receipt = Cause.stamp({
        outputRef: `out/${runId}`,
        runId,
        nodeId: tag,
        attempt: 1,
        journalSeq: head,
        planRef: cause.plan ?? { origin: "direct" },
        promptHash
      })
      ledger.record(receipt, flow.private ? facts.subject : undefined)
      for (const listener of Array.from(listeners)) listener()
      return Object.freeze({
        runId,
        outputRef: receipt.outputRef,
        journalSeq: head,
        output: immutable(output.value),
        cause: receipt
      })
    }

    const bind = (principal: Principal.Principal): CoreApi => ({
      catalog: (cursor) =>
        Effect.suspend(() => {
          const facts = who(principal, "catalog")
          if (facts instanceof CoreError) return Effect.fail(facts)
          const start = cursor === undefined ? 0 : /^\d{1,9}$/.test(cursor) ? Number(cursor) : -1
          if (start < 0 || start > order.length) {
            return Effect.fail(refuse("invalid_cursor", "catalog", "the cursor is not one a catalog page gave"))
          }
          // Each entry is the engine's frozen descriptor: a reader cannot edit what authorizes a call.
          const entries = Object.freeze(order.slice(start, start + catalogPageSize).map((tag) => entryOf(tag) as Entry))
          const next = start + catalogPageSize
          return Effect.succeed<CatalogPage>(
            Object.freeze(next < order.length ? { entries, next: String(next) } : { entries })
          )
        }),
      submit: (intent) =>
        Effect.gen(function*() {
          const prepared = yield* fromResult(prepare(principal, intent))
          const promptHash = yield* Cause.promptHash(prepared.flow.entry.tag, prepared.payload)
          if (prepared.flow.protected) {
            const tag = prepared.flow.entry.tag
            if (intent.receipt === undefined) {
              return yield* Effect.fail(
                refuse("receipt_required", tag, "a protected act needs a receipt the person confirmed")
              )
            }
            yield* credentials.redeem(intent.receipt, principal, { operation: tag, target: promptHash }).pipe(
              Effect.mapError((refused) => refuse("receipt_required", tag, refused.detail, { code: refused.reason }))
            )
          }
          return yield* fromResult(commit(prepared, promptHash))
        }),
      read: (query) => Effect.suspend(() => fromResult(readNow(principal, query))),
      changes: (query, after) =>
        Stream.unwrap(Effect.suspend(() => {
          if (!/^\d{1,15}$/.test(after)) {
            return Effect.fail(refuse("invalid_cursor", String(query.query), "the cursor is not one a page gave"))
          }
          // Refuse now what would refuse later: a stream never starts for a query the caller may not read.
          const first = readNow(principal, query)
          if (first instanceof CoreError) return Effect.fail(first)
          return Effect.succeed(
            Stream.callback<Change, CoreError>((queue) =>
              Effect.gen(function*() {
                let last = Number(after) < head ? undefined : Cause.canonical(first.rows)
                const emit = () => {
                  const page = readNow(principal, query)
                  if (page instanceof CoreError) return
                  const text = Cause.canonical(page.rows)
                  if (text === last) return
                  last = text
                  Queue.offerUnsafe(queue, page)
                }
                emit()
                listeners.add(emit)
                yield* Effect.addFinalizer(() => Effect.sync(() => listeners.delete(emit)))
              })
            )
          )
        }))
    })

    const refuseDoor = (reason: "unknown_door" | "door_mismatch", detail: string) =>
      Effect.fail(new Principal.AuthRefused({ reason, detail }))

    // One door: mint from evidence this function built, then check the
    // issuer minted what the door is for. A frame that comes back as anything
    // but an app, or a person door that comes back as a delegate, is refused.
    const through = (
      evidence: Principal.DoorEvidence,
      act: Principal.Act | undefined
    ): Effect.Effect<Principal.Principal, Principal.AuthRefused> =>
      Effect.flatMap(credentials.mint(evidence), (principal) => {
        const facts = credentials.authority(principal)
        return facts === undefined || facts.act !== act
          ? refuseDoor("door_mismatch", "the credential service minted another door's principal")
          : Effect.succeed(principal)
      })

    const person = (from: { readonly session: string; readonly door?: Principal.PersonDoor }) => {
      const door = from.door ?? "strip"
      return door === "strip" || door === "key" || door === "slash" || door === "palette"
        ? through({ kind: "gui", door, session: from.session }, undefined)
        : refuseDoor("unknown_door", "a person door is one of strip, key, slash or palette")
    }

    const openMcp: Engine["openMcp"] = (from) =>
      Effect.map(through({ kind: "mcp", transport: from.transport, tokenRef: from.tokenRef }, "agent"), bind)
    const openIncur: Engine["openIncur"] = (from) =>
      Effect.map(through({ kind: "incur", sessionFile: from.sessionFile }, "agent"), bind)
    const openSdk: Engine["openSdk"] = (from) =>
      Effect.map(through({ kind: "sdk", runCredential: from.runCredential }, "flow"), bind)
    const openFrame: Engine["openFrame"] = (from) =>
      Effect.map(through({ kind: "gui", door: "frame", session: from.session, plugin: from.plugin }, "app"), bind)
    const openPerson: Engine["openPerson"] = (from) => Effect.map(person(from), bind)

    const engine: Engine = {
      register: (item) => Effect.suspend(() => fromResult(registerNow(item))),
      open: (input) =>
        Effect.suspend(() => {
          const evidence = Principal.evidenceOf(input)
          if (evidence instanceof Principal.AuthRefused) return Effect.fail(evidence)
          switch (evidence.kind) {
            case "mcp":
              return openMcp(evidence)
            case "incur":
              return openIncur(evidence)
            case "sdk":
              return openSdk(evidence)
            case "gui":
              return evidence.door === "frame" ? openFrame(evidence) : openPerson(evidence)
          }
        }),
      openMcp,
      openIncur,
      openSdk,
      openFrame,
      openPerson,
      bind,
      confirm: (evidence, intent) =>
        Effect.gen(function*() {
          // The whole evidence is checked, kind and door included: nothing
          // defaults, and only a person door confirms.
          const checked = Principal.evidenceOf(evidence)
          if (checked instanceof Principal.AuthRefused) return yield* Effect.fail(checked)
          if (checked.kind !== "gui" || checked.door === "frame") {
            return yield* refuseDoor("unknown_door", "only a person door (strip, key, slash or palette) confirms")
          }
          const principal = yield* through(checked, undefined)
          const prepared = yield* fromResult(prepare(principal, intent))
          const target = yield* Cause.promptHash(prepared.flow.entry.tag, prepared.payload)
          return yield* credentials.receipt(principal, { operation: prepared.flow.entry.tag, target })
        }),
      snapshot: () =>
        Cause.canonical({
          head,
          collections: Object.fromEntries(
            Array.from(state, ([collection, rows]) => [collection, Object.fromEntries(rows)])
          ),
          causes: ledger.receipts()
        })
    }

    for (const item of [...(options.flows ?? []), ...(options.projections ?? [])]) {
      const refused = registerNow(item)
      if (refused instanceof CoreError) return Effect.fail(refused)
    }
    return Effect.succeed(engine)
  })

/**
 * The core service for one door.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  engine: Engine,
  evidence: Principal.DoorEvidence
): Layer.Layer<SmithersCore, Principal.AuthRefused> => Layer.effect(SmithersCore, engine.open(evidence))

/**
 * The whole catalog, every page.
 *
 * @category accessors
 * @since 1.0.0
 */
export const entries = (core: CoreApi): Effect.Effect<ReadonlyArray<Entry>, CoreError> => {
  const from = (
    cursor: string | undefined,
    seen: ReadonlyArray<Entry>
  ): Effect.Effect<ReadonlyArray<Entry>, CoreError> =>
    Effect.flatMap(core.catalog(cursor), (page) => {
      const all = [...seen, ...page.entries]
      return page.next === undefined ? Effect.succeed(all) : from(page.next, all)
    })
  return from(undefined, [])
}

/**
 * Whether a delegate (an agent, a framed app, a flow) may be offered an entry.
 * Person-only and protected flows are not: only host-drawn UI runs them.
 *
 * @category predicates
 * @since 1.0.0
 */
export const delegable = (entry: Entry): boolean => entry.personOnly === undefined && !entry.protected

/**
 * Calls a catalog entry by tag: `read` for a query, `submit` for anything
 * else, so the core answers for an unknown or person-only tag.
 *
 * @category accessors
 * @since 1.0.0
 */
export const call = (
  core: CoreApi,
  tag: string,
  payload?: unknown,
  receipt?: string
): Effect.Effect<Requested | Page, CoreError> =>
  Effect.flatMap(
    entries(core),
    (all): Effect.Effect<Requested | Page, CoreError> =>
      all.some((entry) => entry.tag === tag && entry.kind === "query")
        ? core.read({ query: tag, params: payload })
        : core.submit({ operation: tag, payload, ...(receipt === undefined ? {} : { receipt }) })
  )
