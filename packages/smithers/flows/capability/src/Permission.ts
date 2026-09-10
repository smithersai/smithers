/**
 * Typed permission failures and capability policy rules.
 *
 * The schema ids below are identity, not display text: a stored decision keeps
 * those exact strings and is read back through them.
 *
 * Reference: https://capability.smithers.sh/concepts/authorization-model/
 *
 * @since 0.1.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import { Option, Schema, SchemaIssue } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import {
  Action,
  Capability,
  CapabilityPattern,
  EffectTier,
  format,
  matches,
  maxResourceLength,
  withinMatchBudget
} from "./Capability.ts"

import type { PermissionErrorPayload } from "./PermissionErrorPayload.ts"

export type { PermissionErrorPayload } from "./PermissionErrorPayload.ts"

const PermissionMeta = Schema.Record(Schema.String, Schema.Json)

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Match the kernel GrantStore envelope without depending on the kernel.
const maximumMetadataDepth = 16
const maximumMetadataMembers = 1_024
const maximumMetadataBytes = 64 * 1024
const metadataEncoder = new TextEncoder()

const invalidMetadata = (path: string, reason: string): Schema.SchemaError =>
  new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: `Expected JSON value at ${path}: ${reason}` }))

const metadataStringBytes = (value: string, path: string): number => {
  // Check before escaping/encoding so a single huge string cannot allocate an
  // unbounded temporary serialization. JSON's UTF-8 size is at least this long.
  if (value.length > maximumMetadataBytes) {
    throw invalidMetadata(path, `metadata exceeds ${maximumMetadataBytes} bytes`)
  }
  return metadataEncoder.encode(JSON.stringify(value)).byteLength
}

type MetadataSnapshot = {
  readonly value: Schema.Json
  readonly members: number
  readonly bytes: number
  readonly height: number
}

type MetadataFrame = {
  readonly input: object
  readonly path: string
  readonly depth: number
  readonly key: string
  readonly array: boolean
  readonly keys: Iterator<string>
  readonly entries: Array<[string, Schema.Json]>
  members: number
  bytes: number
  height: number
}

const metadataKeys = function*(value: Record<string, unknown> | Array<unknown>): Generator<string> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) yield String(index)
  } else {
    for (const key in value) {
      if (Object.hasOwn(value, key)) yield key
    }
  }
}

const permissionMetaSnapshot = (
  meta: Readonly<Record<string, unknown>>
): Readonly<Record<string, Schema.Json>> => {
  if (!isPlainObject(meta)) throw invalidMetadata("meta", "metadata must be a plain record")
  const snapshots = new WeakMap<object, MetadataSnapshot>()
  const active = new WeakSet<object>()
  const stack: Array<MetadataFrame> = []
  let visitedMembers = 0

  const push = (input: Record<string, unknown> | Array<unknown>, path: string, depth: number, key: string) => {
    active.add(input)
    stack.push({
      input,
      path,
      depth,
      key,
      array: Array.isArray(input),
      keys: metadataKeys(input),
      entries: [],
      members: 0,
      bytes: 2,
      height: 0
    })
  }
  const append = (frame: MetadataFrame, key: string, child: MetadataSnapshot, path: string) => {
    // Count repeated references as expanded JSON, but reuse their computed
    // totals. Neither validation nor copying expands a shared DAG into a tree.
    frame.members += 1 + child.members
    frame.height = Math.max(frame.height, 1 + child.height)
    if (frame.depth + frame.height > maximumMetadataDepth) {
      throw invalidMetadata(path, `metadata exceeds depth ${maximumMetadataDepth}`)
    }
    if (frame.members > maximumMetadataMembers) {
      throw invalidMetadata(path, `metadata exceeds ${maximumMetadataMembers} members`)
    }
    frame.bytes += child.bytes + (frame.entries.length === 0 ? 0 : 1) +
      (frame.array ? 0 : metadataStringBytes(key, path) + 1)
    if (frame.bytes > maximumMetadataBytes) {
      throw invalidMetadata(path, `metadata exceeds ${maximumMetadataBytes} bytes`)
    }
    frame.entries.push([key, child.value])
  }

  push(meta, "meta", 0, "")
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    const next = frame.keys.next()
    if (next.done) {
      // fromEntries installs own data properties, including __proto__. Only
      // copy a container after its depth, members and encoded size are checked.
      const snapshot: MetadataSnapshot = {
        value: Object.freeze(frame.array ? frame.entries.map(([, value]) => value) : Object.fromEntries(frame.entries)),
        members: frame.members,
        bytes: frame.bytes,
        height: frame.height
      }
      snapshots.set(frame.input, snapshot)
      active.delete(frame.input)
      stack.pop()
      if (stack.length > 0) append(stack[stack.length - 1]!, frame.key, snapshot, frame.path)
      continue
    }

    const key = next.value
    // Bound key encoding before putting it in an error path, too.
    metadataStringBytes(key, frame.path)
    const path = `${frame.path}[${JSON.stringify(key)}]`
    if (++visitedMembers > maximumMetadataMembers) {
      throw invalidMetadata(path, `metadata exceeds ${maximumMetadataMembers} members`)
    }
    const value = (frame.input as Record<string, unknown>)[key]
    if (value === undefined && !frame.array) {
      if (++frame.members > maximumMetadataMembers) {
        throw invalidMetadata(path, `metadata exceeds ${maximumMetadataMembers} members`)
      }
      continue
    }
    const depth = frame.depth + 1
    if (depth > maximumMetadataDepth) throw invalidMetadata(path, `metadata exceeds depth ${maximumMetadataDepth}`)
    if (value !== null && typeof value === "object") {
      if (active.has(value)) throw invalidMetadata(path, "metadata must not contain cycles")
      const existing = snapshots.get(value)
      if (existing !== undefined) {
        append(frame, key, existing, path)
      } else if (Array.isArray(value) || isPlainObject(value)) {
        push(value, path, depth, key)
      } else {
        throw invalidMetadata(path, "metadata objects must be plain records")
      }
      continue
    }
    let bytes: number
    if (typeof value === "string") bytes = metadataStringBytes(value, path)
    else if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      bytes = JSON.stringify(value).length
    } else {
      throw invalidMetadata(path, "metadata must be JSON data")
    }
    append(frame, key, { value, bytes, members: 0, height: 0 }, path)
  }
  return snapshots.get(meta)!.value as Readonly<Record<string, Schema.Json>>
}

const capabilitySnapshot = (capability: Capability): Capability => {
  const snapshot = new Capability({ action: capability.action, resource: capability.resource })
  for (const field of ["action", "resource"] as const) {
    Object.defineProperty(snapshot, field, {
      value: snapshot[field],
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
  return snapshot
}

/**
 * A permission request that must be resolved by an attended surface.
 *
 * The capability is always the exact adapter request, never a wildcard. The
 * error retains neither the caller's metadata object nor the caller's
 * `Capability` instance, and its `meta` and `capability` slots are non-writable.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PermissionRequired extends Schema.TaggedError<PermissionRequired>()(
  "@smthrs/capability/PermissionRequired",
  {
    code: Schema.Literal("permission_required"),
    requestId: Schema.String,
    runId: Schema.optional(Schema.String),
    capability: Capability,
    tier: EffectTier,
    /**
     * Journal-safe permission context.
     *
     * Only JSON-representable values survive the grant journal. Construction
     * takes a deep-frozen snapshot and does not retain the caller's object. An
     * undefined property value is dropped, mirroring `JSON.stringify`, so the
     * encoded payload is unchanged and a host can pass an optional field it
     * does not have, such as a spawn with no explicit cwd. Undefined array
     * elements are rejected because JSON serialization would change them to
     * null rather than omit them. Own `__proto__` data properties are preserved.
     * Metadata is limited to depth 16 (root 0), 1024 members and 64 KiB of
     * UTF-8 JSON. Shared references retain one snapshot but count at every
     * occurrence toward the limits. Cycles and excesses fail naming the field.
     *
     * @since 0.1.0
     * @category models
     */
    meta: PermissionMeta
  }
) {
  constructor(props: {
    readonly code?: "permission_required"
    readonly requestId: string
    readonly runId?: string | undefined
    readonly capability: Capability
    readonly tier: EffectTier
    readonly meta: Readonly<Record<string, unknown>>
  }) {
    const meta = permissionMetaSnapshot(props.meta)
    super({ ...props, code: "permission_required", meta })
    Object.defineProperty(this, "capability", {
      value: capabilitySnapshot(props.capability),
      enumerable: true,
      writable: false,
      configurable: false
    })
    Object.defineProperty(this, "meta", {
      value: meta,
      enumerable: true,
      writable: false,
      configurable: false
    })
    // Do not freeze a Schema.Class instance: Effect needs to populate its
    // symbol-keyed hash and equality caches after construction.
  }
}

/**
 * A capability rejected by policy or by the current capability ceiling. The
 * error retains a defensive copy rather than the caller's `Capability`
 * instance, and its `capability` slot is non-writable.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
  "@smthrs/capability/PermissionDenied",
  {
    code: Schema.Literal("permission_denied"),
    capability: Capability,
    reason: Schema.String
  }
) {
  constructor(props: {
    readonly code?: "permission_denied"
    readonly capability: Capability
    readonly reason: string
  }) {
    super({ ...props, code: "permission_denied" })
    Object.defineProperty(this, "capability", {
      value: capabilitySnapshot(props.capability),
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
}

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const GrantStoreErrorCode = Schema.Literals([
  "duplicate_request",
  "request_not_found",
  "journal_failed",
  "store_closed",
  "invalid_resolution"
])

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type GrantStoreErrorCode = typeof GrantStoreErrorCode.Type

/**
 * A failure to register, persist, or resolve a grant request.
 *
 * `message` and `cause` are optional operation context for persistence
 * adapters; callers branch on the stable `code`.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class GrantStoreError extends Schema.TaggedError<GrantStoreError>()(
  "@smthrs/capability/GrantStoreError",
  {
    code: GrantStoreErrorCode,
    message: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Schema for decisions made by matching permission rules.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const RuleEffect = Schema.Literals(["allow", "deny", "ask"] as const)

/**
 * The decision made by a matching permission rule.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RuleEffect = typeof RuleEffect.Type

/**
 * A capability pattern and the decision it applies.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Rule extends Schema.Class<Rule>("@smthrs/capability/Rule")({
  effect: RuleEffect,
  // Require a constructed pattern at the type boundary; decoding still uses
  // the original wire schema. Nested Class construction would coerce requests.
  pattern: CapabilityPattern.pipe(Schema.decodeTo(Schema.declare(Schema.is(CapabilityPattern))))
}) {}

/**
 * Evaluates ordered permission rules.
 *
 * Matching rules are last-match-wins across all rulesets and the default is
 * `ask`. `rulesets[0]` is the configured policy ruleset. The function first
 * reduces that ruleset with the same last-match rule, then treats its effective
 * denial as a hard veto. A configured deny superseded by a later configured
 * allow or ask in that ruleset is therefore not a veto.
 *
 * A rule the matcher cannot decide within `Capability.maxMatchWork` vetoes the
 * decision and `evaluate` returns `deny`. Skipping it could let an undecidable
 * deny fall through to a later allow. The kernel turns that `deny` into a
 * {@link PermissionDenied}.
 *
 * @category policy
 * @since 0.1.0
 * @slop
 */
export const evaluate = (
  rulesets: ReadonlyArray<ReadonlyArray<Rule>>,
  capability: Capability
): RuleEffect => {
  // One indexed pass: an undecidable rule anywhere vetoes, so returning on the
  // first one is equivalent to a separate budget preflight. Each rule is
  // matched once; index 0 additionally tracks the configured last-match.
  let configuredEffect: RuleEffect = "ask"
  let effect: RuleEffect = "ask"
  for (const [index, ruleset] of rulesets.entries()) {
    for (const rule of ruleset) {
      if (!withinMatchBudget(rule.pattern, capability)) {
        return "deny"
      }
      if (matches(rule.pattern, capability)) {
        effect = rule.effect
        if (index === 0) {
          configuredEffect = rule.effect
        }
      }
    }
  }
  return configuredEffect === "deny" ? "deny" : effect
}

/**
 * Constructs a permission request for an exact capability.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const permissionRequired = (options: {
  readonly requestId: string
  readonly runId?: string | undefined
  readonly capability: Capability
  readonly tier: EffectTier
  readonly meta?: Readonly<Record<string, unknown>> | undefined
}): PermissionRequired =>
  new PermissionRequired({
    code: "permission_required",
    requestId: options.requestId,
    runId: options.runId,
    capability: options.capability,
    tier: options.tier,
    meta: options.meta ?? {}
  })

/**
 * Constructs a denied permission failure.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const permissionDenied = (capability: Capability, reason: string): PermissionDenied =>
  new PermissionDenied({
    code: "permission_denied",
    capability,
    reason
  })

/**
 * Every failure the capability kernel can add to a guarded Host call.
 *
 * A protected service names this union in its own interface, so a caller that
 * holds the service cannot forget that an operation may be suspended, denied,
 * or left undecided by a broken grant store.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PermissionError = PermissionRequired | PermissionDenied | GrantStoreError

/**
 * Schema for every failure the capability kernel adds to a guarded Host call.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const PermissionError = Schema.Union([PermissionRequired, PermissionDenied, GrantStoreError])

const isAction = Schema.is(Action)
const isEffectTier = Schema.is(EffectTier)
// Inspect descriptors rather than feeding unknown containers to Schema.Json,
// whose property reads can execute user getters. Track the active path to
// reject cycles while allowing repeated references to already checked data.
const isPermissionMeta = (input: unknown): boolean => {
  if (!isPlainObject(input)) return false
  const active = new WeakSet<object>()
  const checked = new WeakSet<object>()
  const stack: Array<{ readonly value: unknown; readonly exit?: boolean }> = [{ value: input }]
  while (stack.length > 0) {
    const { value, exit } = stack.pop()!
    if (value === null || typeof value === "string" || typeof value === "boolean") continue
    if (typeof value === "number" && Number.isFinite(value)) continue
    if (typeof value !== "object" || value === null) return false
    if (exit) {
      active.delete(value)
      checked.add(value)
      continue
    }
    if (active.has(value)) return false
    if (checked.has(value)) continue
    const array = Array.isArray(value)
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isPlainObject(value)) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    let elements = 0
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string]!
      if (typeof key !== "string" || !("value" in descriptor)) return false
      if (array) {
        if (key === "length") continue
        const index = Number(key)
        if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length) return false
        elements++
      }
    }
    if (array && elements !== value.length) return false
    active.add(value)
    stack.push({ value, exit: true })
    for (const key of Object.keys(descriptors)) {
      if (!array || key !== "length") stack.push({ value: descriptors[key]!.value })
    }
  }
  return true
}
const grantStoreErrorCodes: ReadonlySet<string> = new Set(GrantStoreErrorCode.literals)
const missing = Symbol("missing")
const accessorOrInherited = Symbol("accessorOrInherited")
const ownData = (input: Readonly<Record<PropertyKey, unknown>>, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined) return key in input ? accessorOrInherited : missing
  return "value" in descriptor ? descriptor.value : accessorOrInherited
}
const isGrantStoreError = Schema.is(GrantStoreError)
const isGrantStoreMessage = (input: Readonly<Record<PropertyKey, unknown>>): boolean => {
  const message = ownData(input, "message")
  if (message === missing || message === undefined || typeof message === "string") return true
  if (Object.hasOwn(input, "message")) return false
  // Effect errors with no explicit message inherit Error's empty data field.
  // Use schema identity for dual-package instances, after checking descriptors.
  let prototype = Object.getPrototypeOf(input)
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "message")
    if (descriptor !== undefined) {
      return "value" in descriptor && descriptor.value === "" && isGrantStoreError(input)
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return false
}
const hasOnlyEnumerableFields = (
  input: Readonly<Record<PropertyKey, unknown>>,
  allowed: ReadonlySet<string>
): boolean => Object.keys(input).every((key) => allowed.has(key))
const requiredFields = new Set(["_tag", "code", "requestId", "runId", "capability", "tier", "meta"])
const deniedFields = new Set(["_tag", "code", "capability", "reason"])
const grantStoreFields = new Set(["_tag", "code", "message", "cause"])
const capabilityFields = new Set(["action", "resource"])
const isCapability = (input: unknown): boolean =>
  isRecord(input) &&
  hasOnlyEnumerableFields(input, capabilityFields) &&
  typeof ownData(input, "resource") === "string" &&
  (ownData(input, "resource") as string).length <= maxResourceLength &&
  isAction(ownData(input, "action"))

/**
 * Refines an unknown value to data-only permission fields, not a yieldable
 * error instance. Own accessors and inherited fields are rejected; metadata
 * is checked through descriptors at every depth. This establishes structure,
 * not the producer or request identity. Use the package-root decodePermissionError to construct
 * an error instance after validation.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isPermissionError = (input: unknown): input is PermissionErrorPayload => {
  if (!isRecord(input)) {
    return false
  }
  switch (ownData(input, "_tag")) {
    case "@smthrs/capability/PermissionRequired":
      return hasOnlyEnumerableFields(input, requiredFields) &&
        ownData(input, "code") === "permission_required" &&
        typeof ownData(input, "requestId") === "string" &&
        (ownData(input, "runId") === missing ||
          ownData(input, "runId") === undefined ||
          typeof ownData(input, "runId") === "string") &&
        isEffectTier(ownData(input, "tier")) &&
        isCapability(ownData(input, "capability")) &&
        isPermissionMeta(ownData(input, "meta"))
    case "@smthrs/capability/PermissionDenied":
      return hasOnlyEnumerableFields(input, deniedFields) &&
        ownData(input, "code") === "permission_denied" &&
        typeof ownData(input, "reason") === "string" &&
        isCapability(ownData(input, "capability"))
    case "@smthrs/capability/GrantStoreError":
      return hasOnlyEnumerableFields(input, grantStoreFields) &&
        ownData(input, "cause") !== accessorOrInherited &&
        typeof ownData(input, "code") === "string" &&
        grantStoreErrorCodes.has(ownData(input, "code") as string) &&
        isGrantStoreMessage(input)
    default:
      return false
  }
}

/**
 * Maximum UTF-16 length of one field in a permission-error rendering.
 *
 * The limit includes the visible truncation marker. It bounds unattended log
 * output while preserving ordinary Unicode and visible control escapes.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxDisplayFieldLength = 256

const truncationMarker = "…[truncated]"

const displayChunk = (unit: string): string => {
  if (unit === "\n") {
    return "\\n"
  }
  if (unit === "\r") {
    return "\\r"
  }
  if (unit === "\t") {
    return "\\t"
  }
  // Encode each UTF-16 code unit so astral format characters also use
  // complete \uXXXX escapes, kept together by displayField's chunk budget.
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(unit)
    ? unit.split("").map((part) => `\\u${part.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join("")
    : unit
}

const displayField = (value: string): string => {
  const chunks: Array<string> = []
  let length = 0
  let truncated = false
  for (const unit of value) {
    const chunk = displayChunk(unit)
    if (length + chunk.length > maxDisplayFieldLength) {
      truncated = true
      break
    }
    chunks.push(chunk)
    length += chunk.length
  }
  if (!truncated) {
    return chunks.join("")
  }
  const contentLength = maxDisplayFieldLength - truncationMarker.length
  while (length > contentLength) {
    length -= chunks.pop()!.length
  }
  return `${chunks.join("")}${truncationMarker}`
}

/**
 * Renders a permission failure as the one-line `description` a `SystemError`
 * carries, which is the string a log line or an unattended report shows.
 *
 * Every field escapes C0/C1 controls, Unicode format characters (including
 * bidi controls), and line/paragraph separators. Each encoded field is limited to
 * {@link maxDisplayFieldLength} UTF-16 code units and ends with a visible
 * marker when truncated. Ordinary non-ASCII text remains unchanged.
 *
 * @category formatting
 * @since 0.1.0
 * @slop
 */
export const formatError = (error: PermissionErrorPayload): string => {
  switch (error._tag) {
    case "@smthrs/capability/PermissionRequired":
      return `${displayField(error.code)}: ${displayField(format(error.capability))} (tier ${
        displayField(error.tier)
      }, request ${displayField(error.requestId)})`
    case "@smthrs/capability/PermissionDenied":
      return `${displayField(error.code)}: ${displayField(format(error.capability))}: ${displayField(error.reason)}`
    case "@smthrs/capability/GrantStoreError":
      // `message` is optional in the schema, but the `Error` base always
      // materializes it. An unset one is the empty string, not `undefined`.
      return `grant store ${displayField(error.code)}${error.message ? `: ${displayField(error.message)}` : ""}`
  }
}

/**
 * Projects a permission failure into Effect's `PlatformError` channel.
 *
 * Effect owns `FileSystem` and `ChildProcessSpawner`, and their tags fix the
 * error channel to `PlatformError`. Rather than mint a second tag whose only
 * difference is a wider error type, the kernel decorates those tags in place
 * and maps its own failures through here.
 *
 * The structured failure is preserved: the normalized reason is always `PermissionDenied` — the
 * operation did not happen because the capability kernel refused, suspended,
 * or could not decide it — `description` carries the human rendering from
 * {@link formatError}, and `cause` carries the structured failure itself, so
 * {@link fromPlatformError} hands the attended surface back the original
 * `capability`, `tier`, `requestId`, and `reason`.
 * Module, method, and string paths use the same escaping and field limit as
 * the description. The projected path is display text; the raw capability
 * resource remains in the cause. Numeric descriptors are unchanged.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const toPlatformError = (options: {
  readonly module: string
  readonly method: string
  readonly pathOrDescriptor?: string | number | undefined
  readonly error: PermissionError
}): PlatformError =>
  systemError({
    _tag: "PermissionDenied",
    module: displayField(options.module),
    method: displayField(options.method),
    description: formatError(options.error),
    ...(options.pathOrDescriptor === undefined ? {} : {
      pathOrDescriptor: typeof options.pathOrDescriptor === "string"
        ? displayField(options.pathOrDescriptor)
        : options.pathOrDescriptor
    }),
    cause: options.error
  })

/**
 * Recovers the structured permission failure a {@link toPlatformError}
 * projection carries, so an attended surface can still reply to the request
 * and an unattended report can still name the capability. Any PermissionDenied
 * reason with a valid structural cause is accepted, including foreign errors.
 * Callers crossing a trust boundary must establish producer or request identity
 * separately. The result guarantees data fields, not class operations.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const fromPlatformError = (error: PlatformError): Option.Option<PermissionErrorPayload> =>
  error.reason._tag === "PermissionDenied" && isPermissionError(error.reason.cause)
    ? Option.some(error.reason.cause)
    : Option.none()
