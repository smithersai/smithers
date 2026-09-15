/**
 * Internal AST and runtime representation for pipeable flow nodes.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */
import { digestSync } from "@smthrs/crypto"
import type * as Context from "effect/Context"
import { identity } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type * as Types from "effect/Types"
import type * as Effects from "../Effects.ts"

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const TypeId = "~flows/core/Node" as const

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export type TypeId = typeof TypeId

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Succeed {
  readonly _tag: "Succeed"
  readonly value: unknown
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Fail {
  readonly _tag: "Fail"
  readonly error: unknown
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface All {
  readonly _tag: "All"
  readonly nodes: Readonly<Record<string, NodeAst>>
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Dynamic {
  readonly _tag: "Dynamic"
  readonly model?: string | undefined
  readonly flows: ReadonlyArray<unknown>
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: Effects.Declaration | undefined
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface AndThen {
  readonly _tag: "AndThen"
  readonly first: NodeAst
  readonly continuation: FunctionIdentity
  readonly next?: NodeAst | undefined
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Map {
  readonly _tag: "Map"
  readonly first: NodeAst
  readonly mapper: FunctionIdentity
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Catch {
  readonly _tag: "Catch"
  readonly first: NodeAst
  readonly handler: FunctionIdentity
  readonly error: unknown | undefined
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface FunctionIdentity {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4" | "static-node/v1"
  readonly digest: string
}

/** @private */
type OperationIdentity = FunctionIdentity & {
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4"
}

/** @private */
interface CapturedMetadata {
  readonly source: string
  readonly captures: string
}

/** @private */
const capturedMetadata = new WeakMap<object, CapturedMetadata>()

/** @private */
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

const ephemeralIdentities = new WeakMap<object, string>()
let ephemeralOrdinal = 0
let ephemeralNonce: string | undefined

/**
 * Returns the process-local nonce, seeding it on first use.
 *
 * The seed is deliberately lazy. Cloudflare Workers rejects any script that
 * calls `crypto.getRandomValues` while the module evaluates, with upload error
 * 10021, so reading entropy at module scope would stop every bundle containing
 * this package from deploying.
 *
 * @private
 */
const nonce = (): string => {
  if (ephemeralNonce === undefined) {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    ephemeralNonce = hex(bytes)
  }
  return ephemeralNonce
}

/**
 * Returns the process-local nonce shared by every ephemeral identity.
 *
 * Exposed so a second ephemeral encoding, such as the projection of an
 * unregistered symbol, folds in the same per-process value and can never
 * collide with a different value observed by another process.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const processNonce = (): string => nonce()

/** @private */
const captureError = (path: string, reason: string): TypeError =>
  new TypeError(`Node.capture: capture at ${path} ${reason}; captures must be finite, inert data`)

/** @private */
const maximumCaptureDepth = 256

/** @private */
interface CaptureSnapshot {
  readonly path: string
  readonly copy: object
  readonly members: Record<string, PropertyDescriptor>
}

// These intrinsics inspect brands without reading caller properties, iterating
// collections, invoking coercion, or consulting Symbol.toStringTag. A plain
// prototype is insufficient: callers can replace a built-in's prototype.
const brandToken = {}
const slotProbes: ReadonlyArray<(input: object) => unknown> = [
  (input) => Map.prototype.has.call(input, brandToken),
  (input) => Set.prototype.has.call(input, brandToken),
  (input) => WeakMap.prototype.has.call(input, brandToken),
  (input) => WeakSet.prototype.has.call(input, brandToken),
  (input) => Date.prototype.getTime.call(input),
  (input) => Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!.get!.call(input),
  (input) => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(input),
  (input) => Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!.call(input),
  (input) => Number.prototype.valueOf.call(input),
  (input) => String.prototype.valueOf.call(input),
  (input) => Boolean.prototype.valueOf.call(input),
  (input) => BigInt.prototype.valueOf.call(input),
  (input) => Symbol.prototype.valueOf.call(input),
  (input) => WeakRef.prototype.deref.call(input),
  (input) => FinalizationRegistry.prototype.unregister.call(input, brandToken)
]

/** @private */
const hasBuiltinSlots = (input: object): boolean =>
  ArrayBuffer.isView(input) || slotProbes.some((probe) => {
    try {
      probe(input)
      return true
    } catch {
      return false
    }
  })

/** @private */
const snapshotCapture = (
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
  depth: number,
  snapshots: globalThis.Map<object, CaptureSnapshot>
): void => {
  if (depth > maximumCaptureDepth) {
    throw captureError(path, `exceeds the maximum capture depth of ${maximumCaptureDepth}`)
  }
  if (input === null) return
  switch (typeof input) {
    case "boolean":
    case "string":
      return
    case "number":
      if (!Number.isFinite(input)) throw captureError(path, "is not finite")
      return
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw captureError(path, `has unsupported type ${typeof input}`)
  }

  if (ancestors.has(input)) throw captureError(path, "is cyclic")
  let snapshot = snapshots.get(input)
  if (snapshot === undefined) {
    if (hasBuiltinSlots(input)) throw captureError(path, "has built-in internal slots")
    let prototype: object | null
    let array: boolean
    let members: Record<string, PropertyDescriptor>
    try {
      prototype = Object.getPrototypeOf(input)
      array = Array.isArray(input)
    } catch {
      throw captureError(path, "could not inspect its own data (for example, a revoked Proxy)")
    }
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw captureError(path, "has a non-plain prototype")
    }
    try {
      members = Object.create(null)
      for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (descriptor === undefined) throw new TypeError()
        Object.defineProperty(members, key, { value: descriptor, enumerable: true })
      }
    } catch {
      throw captureError(path, "could not inspect its own data descriptors")
    }
    snapshot = { path, copy: array ? [] : {}, members }
    snapshots.set(input, snapshot)
  }
  const { copy, members } = snapshot
  ancestors.add(input)
  try {
    if (Array.isArray(copy)) {
      const length: number = members.length!.value
      if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
        throw captureError(path, "has an invalid array length")
      }
      for (const key of Reflect.ownKeys(members)) {
        if (key === "length") continue
        if (typeof key === "symbol" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
          throw captureError(path, `has unsupported array key ${String(key)}`)
        }
      }
      for (let index = 0; index < length; index++) {
        const descriptor = members[String(index)]
        if (descriptor === undefined) throw captureError(`${path}[${index}]`, "is an array hole")
        if (!("value" in descriptor)) throw captureError(`${path}[${index}]`, "is an accessor")
        if (!descriptor.enumerable) throw captureError(`${path}[${index}]`, "is non-enumerable")
        snapshotCapture(descriptor.value, `${path}[${index}]`, ancestors, depth + 1, snapshots)
      }
    } else {
      for (const key of Reflect.ownKeys(members)) {
        if (typeof key === "symbol") throw captureError(path, `has symbol key ${String(key)}`)
        const descriptor = members[key]!
        if (!("value" in descriptor)) throw captureError(`${path}.${key}`, "is an accessor")
        if (!descriptor.enumerable) throw captureError(`${path}.${key}`, "is non-enumerable")
        snapshotCapture(descriptor.value, `${path}.${key}`, ancestors, depth + 1, snapshots)
      }
    }
  } finally {
    ancestors.delete(input)
  }
}

/**
 * Probe originals only after structural admission. Reverse discovery order
 * probes children before parents and rejects a Proxy before cloning an earlier
 * object that its traps could have changed. Never retain the host's clone.
 *
 * @private
 */
const refuseExotic = (
  snapshots: globalThis.Map<object, CaptureSnapshot>,
  clone: typeof globalThis.structuredClone
): void => {
  if (typeof clone !== "function") throw captureError("$", "requires structuredClone to refuse Proxies")
  for (const [input, { path }] of [...snapshots].reverse()) {
    let cloned: object
    try {
      cloned = clone(input)
    } catch {
      throw captureError(path, "cannot be structured-cloned (for example, a Proxy)")
    }
    // Some brands, such as Error, have no side-effect-free JavaScript brand
    // check. The host reveals them on its clone, never on caller input.
    if (!Array.isArray(cloned) && Object.getPrototypeOf(cloned) !== Object.prototype) {
      throw captureError(path, "clones as a built-in object")
    }
  }
}

/** @private */
const freezeCapture = (snapshots: globalThis.Map<object, CaptureSnapshot>): void => {
  for (const { copy, members } of snapshots.values()) {
    // Canonical key insertion order also makes enumeration of equal copies
    // agree, even when callers inserted their record keys in different orders.
    for (const key of Object.keys(members).sort()) {
      const descriptor = members[key]!
      Object.defineProperty(copy, key, {
        value: snapshots.get(descriptor.value)?.copy ?? descriptor.value,
        enumerable: descriptor.enumerable!,
        configurable: false,
        writable: false
      })
    }
    Object.freeze(copy)
  }
}

/** Encodes only the owned frozen copy. @private */
const canonicalCapture = (input: unknown): string => {
  if (input === null) return "null"
  switch (typeof input) {
    case "boolean":
      return input ? "true" : "false"
    case "number":
      return Object.is(input, -0) ? "[\"number\",\"-0\"]" : `["number",${JSON.stringify(input)}]`
    case "string":
      return `["string",${JSON.stringify(input)}]`
    default:
      return Array.isArray(input)
        ? `["array",[${input.map(canonicalCapture).join(",")}]]`
        : `["object",{${
          Object.keys(input as object).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalCapture((input as Record<string, unknown>)[key])}`
          ).join(",")
        }}]`
  }
}

/**
 * A separate scope keeps the wrapper free of admission maps and originals.
 * The callback receives only the frozen copy as its explicit this receiver.
 *
 * @private
 */
const capturedOperation = <Args extends ReadonlyArray<unknown>, A>(
  operation: (...args: Args) => A,
  copy: object,
  metadata: CapturedMetadata
): (...args: Args) => A => {
  const wrapped = (...args: Args): A => Reflect.apply(operation, copy, args)
  capturedMetadata.set(wrapped, metadata)
  return wrapped
}

/**
 * Brands an operation with every inert value it closes over.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const capture = <C extends Readonly<Record<string, unknown>>, Args extends ReadonlyArray<unknown>, A>(
  captures: C,
  operation: (this: Readonly<C>, ...args: Args) => A
): (...args: Args) => A => {
  if (typeof operation !== "function") throw new TypeError("Node.capture requires a function operation")
  if (captures === null || typeof captures !== "object") throw captureError("$", "must be a record")
  const metadata = capturedMetadata.get(operation)
  const source = metadata?.source ?? Function.prototype.toString.call(operation)
  const clone = globalThis.structuredClone
  const snapshots = new Map<object, CaptureSnapshot>()
  snapshotCapture(captures, "$", new WeakSet(), 0, snapshots)
  refuseExotic(snapshots, clone)
  freezeCapture(snapshots)
  const copy = snapshots.get(captures)!.copy
  const outerCanonical = canonicalCapture(copy)
  const canonical = metadata === undefined
    ? outerCanonical
    : `["nested",${outerCanonical},${metadata.captures}]`
  return capturedOperation(operation, copy, { source, captures: canonical })
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface FlowCall {
  readonly _tag: "FlowCall"
  readonly target: unknown
  readonly input: unknown
  readonly annotations: Context.Context<never>
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export type NodeAst = Succeed | Fail | All | Dynamic | AndThen | Map | FlowCall | Catch

type Operation = (value: unknown) => unknown

const operations = new WeakMap<AndThen | Map | Catch, Operation>()
const flows = new WeakMap<FlowCall, unknown>()

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const functionIdentity = (operation: unknown): OperationIdentity => {
  if (typeof operation !== "function") throw new TypeError("function identity requires a function")
  const metadata = capturedMetadata.get(operation)
  const source = metadata?.source ?? Function.prototype.toString.call(operation)
  let ephemeral = ephemeralIdentities.get(operation)
  if (metadata === undefined && ephemeral === undefined) {
    ephemeral = `${nonce()}:${ephemeralOrdinal++}`
    ephemeralIdentities.set(operation, ephemeral)
  }
  return {
    _tag: "FunctionIdentity",
    algorithm: metadata === undefined ? "sha256-source-ephemeral/v4" : "sha256-source-captures/v4",
    digest: digestSync(metadata === undefined ? `${source}\0${ephemeral}` : `${source}\0${metadata.captures}`)
  }
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
  readonly ast: NodeAst
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const NodeProto = {
  [TypeId]: {
    _A: identity,
    _E: identity
  },
  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments)
  }
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const makeNode = <A = unknown, E = never>(ast: NodeAst): Node<A, E> =>
  Object.assign(Object.create(NodeProto), { ast })

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const succeed = (value: unknown, annotations: Context.Context<never>): Succeed => ({
  _tag: "Succeed",
  value,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const fail = (error: unknown, annotations: Context.Context<never>): Fail => ({
  _tag: "Fail",
  error,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const all = (
  nodes: Readonly<Record<string, NodeAst>>,
  annotations: Context.Context<never>
): All => ({
  _tag: "All",
  nodes,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const dynamic = (
  options: Omit<Dynamic, "_tag" | "annotations">,
  annotations: Context.Context<never>
): Dynamic => ({
  _tag: "Dynamic",
  ...options,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const andThen = (
  first: NodeAst,
  operation: Operation,
  identitySource: unknown,
  annotations: Context.Context<never>
): AndThen => {
  const ast: AndThen = {
    _tag: "AndThen",
    first,
    continuation: functionIdentity(identitySource),
    annotations
  }
  operations.set(ast, operation)
  return ast
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const andThenNode = (
  first: NodeAst,
  next: NodeAst,
  annotations: Context.Context<never>
): AndThen => ({
  _tag: "AndThen",
  first,
  continuation: {
    _tag: "FunctionIdentity",
    algorithm: "static-node/v1",
    digest: digestSync("static-node")
  },
  next,
  annotations
})

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const map = (
  first: NodeAst,
  operation: Operation,
  identitySource: unknown,
  annotations: Context.Context<never>
): Map => {
  const ast: Map = {
    _tag: "Map",
    first,
    mapper: functionIdentity(identitySource),
    annotations
  }
  operations.set(ast, operation)
  return ast
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const catch_ = (
  first: NodeAst,
  operation: Operation,
  identitySource: unknown,
  error: unknown | undefined,
  annotations: Context.Context<never>
): Catch => {
  const ast: Catch = {
    _tag: "Catch",
    first,
    handler: functionIdentity(identitySource),
    error,
    annotations
  }
  operations.set(ast, operation)
  return ast
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const operation = (ast: AndThen | Map | Catch): Operation | undefined => operations.get(ast)

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const flowCall = (
  flow: unknown,
  target: unknown,
  input: unknown,
  annotations: Context.Context<never>
): FlowCall => {
  const ast: FlowCall = {
    _tag: "FlowCall",
    target,
    input,
    annotations
  }
  flows.set(ast, flow)
  return ast
}

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const flow = (ast: FlowCall): unknown => flows.get(ast)

/**
 * @since 0.0.0
 * @private
 * @slop
 */
export const withAnnotations = (
  ast: NodeAst,
  annotations: Context.Context<never>
): NodeAst => {
  const annotated = {
    ...ast,
    annotations
  }
  if (ast._tag === "AndThen" || ast._tag === "Map" || ast._tag === "Catch") {
    const deferred = operations.get(ast)
    if (deferred !== undefined) operations.set(annotated as AndThen | Map | Catch, deferred)
  }
  if (ast._tag === "FlowCall") {
    const target = flows.get(ast)
    if (target !== undefined) flows.set(annotated as FlowCall, target)
  }
  return annotated
}
