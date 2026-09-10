/**
 * Projection of plan values and schemas into canonical-JSON-compatible
 * identity.
 *
 * A node's key material is derived from what its declaration says, so every
 * value a plan can carry needs one stable encoding: primitives, the Effect
 * data types, host built-ins, containers, errors, schemas, and the proxies
 * that stand in for a value a later step will supply. The walk is bounded by
 * one depth limit and one member budget shared across every level of a value,
 * so a wide or deep plan is refused rather than expanded. Refusals are
 * `GraphBuildError` for the limits and `Node.NodeBuildError` for a value the
 * encoding cannot represent.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 1.0.0-rc.0
 */
import { Chunk, Option, Result, Schema, SchemaAST } from "effect"
import type * as Context from "effect/Context"
import type * as Effects from "../Effects.ts"
import * as Flow from "../Flow.ts"
import type * as KeyMaterial from "../KeyMaterial.ts"
import * as Node from "../Node.ts"
import { GraphBuildError } from "./diagnostic.ts"
import { boundedEffects } from "./effects.ts"
import * as internal from "./node.ts"

/**
 * The declaration fields a flow carries into identity. `Flow.Any` is the
 * public callable surface; identity reads the private record behind it.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface FlowDetails extends Flow.Any {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly annotations: Context.Context<never>
  readonly body: ((input: unknown) => Node.Node<unknown, unknown>) | undefined
  readonly implementation: Flow.Implementation | undefined
}

const PlannedValueTypeId = Symbol("flows/core/Graph/PlannedValue")

interface PlannedValueDescriptor {
  readonly from: string
  readonly path: ReadonlyArray<string>
}

/**
 * Maximum nesting accepted while projecting a plan value into identity.
 *
 * @category limits
 * @private
 * @since 0.1.0
 * @slop
 */
export const maximumDepth = 128

/**
 * Maximum number of members one plan value may expand to while it is
 * projected into identity: object keys, array items and holes, map entries,
 * set and chunk values, and bytes, summed across every level of that value.
 * A flow call's input and a declaration body are budgeted separately.
 *
 * @category limits
 * @private
 * @since 1.0.0-rc.0
 */
export const maximumMembers = 100_000

const reflectionTags: ReadonlySet<string> = Object.freeze(
  new Set([
    "PlannedInput",
    "Undefined",
    "Number",
    "CyclicAnnotations",
    "BigInt",
    "Symbol",
    "Function",
    "Flow",
    "CircularFlow",
    "Circular",
    "Schema",
    "Accessor",
    "Array",
    "Hole",
    "Date",
    "RegExp",
    "Error",
    "Map",
    "Set",
    "Option",
    "Result",
    "Chunk",
    "URL",
    "Bytes",
    "Escaped"
  ])
)

const optionNonePrototype = Object.getPrototypeOf(Option.none())
const optionSomePrototype = Object.getPrototypeOf(Option.some(undefined))
const resultSuccessPrototype = Object.getPrototypeOf(Result.succeed(undefined))
const resultFailurePrototype = Object.getPrototypeOf(Result.fail(undefined))
const chunkPrototype = Object.getPrototypeOf(Chunk.empty())

const symbolIdentities = new WeakMap<object, string>() as unknown as {
  readonly get: (key: symbol) => string | undefined
  readonly set: (key: symbol, value: string) => unknown
}
let symbolOrdinal = 0

interface SymbolIdentity {
  readonly scope: "registered" | "well-known" | "process-local"
  readonly id: string
}

let wellKnownSymbolNames: ReadonlyMap<symbol, string> | undefined

const wellKnownSymbols = (): ReadonlyMap<symbol, string> => {
  if (wellKnownSymbolNames === undefined) {
    const names = new Map<symbol, string>()
    for (const key of Object.getOwnPropertyNames(Symbol)) {
      const descriptor = Object.getOwnPropertyDescriptor(Symbol, key)
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "symbol") {
        names.set(descriptor.value, key)
      }
    }
    wellKnownSymbolNames = names
  }
  return wellKnownSymbolNames
}

/**
 * Identifies a symbol as precisely as the host allows.
 *
 * A registered or well-known symbol has a name every process agrees on. An
 * unregistered symbol has no cross-process identity at all, so it receives the
 * same process-local treatment as an unannotated function: a nonce-seeded
 * ordinal that is stable within one process and deliberately different in the
 * next, reported through the encoding's `scope` field.
 */
const symbolIdentity = (value: symbol): SymbolIdentity => {
  const key = Symbol.keyFor(value)
  if (key !== undefined) return { scope: "registered", id: `global:${key}` }
  const wellKnown = wellKnownSymbols().get(value)
  if (wellKnown !== undefined) return { scope: "well-known", id: `well-known:${wellKnown}` }
  let id = symbolIdentities.get(value)
  if (id === undefined) {
    id = `${internal.processNonce()}:${symbolOrdinal++}`
    symbolIdentities.set(value, id)
  }
  return { scope: "process-local", id }
}

const payloadDepthError = (nodeId: string): GraphBuildError =>
  new GraphBuildError({ code: "payload_too_deep", paths: [], nodeId })

/**
 * Members already produced while projecting one plan value. One budget spans
 * every level of the value, so a wide object cannot dodge the limit by
 * spreading its members across many small containers.
 */
interface MemberBudget {
  used: number
}

const memberBudget = (): MemberBudget => ({ used: 0 })

/**
 * Accounts for the members a container is about to expand to. The charge is
 * taken before the members are materialized, so a sparse array with a huge
 * `length` is refused by its length rather than after its holes are built.
 */
const charge = (budget: MemberBudget, members: number, nodeId: string, path: string): void => {
  budget.used += members
  if (budget.used > maximumMembers) {
    throw new GraphBuildError({ code: "payload_too_large", paths: [path], nodeId })
  }
}

/**
 * Projects the effects a flow value carries into identity, charging each path
 * to the member budget so a flow placed inside a plan value cannot smuggle an
 * unbounded envelope past {@link maximumMembers}.
 */
const reflectedEffects = (
  declaration: Effects.Declaration | undefined,
  nodeId: string,
  path: string,
  budget: MemberBudget
): Effects.Declaration | undefined => {
  if (declaration === undefined) return undefined
  const effects = boundedEffects(
    declaration,
    maximumMembers - budget.used,
    () => new GraphBuildError({ code: "payload_too_large", paths: [path], nodeId })
  )
  charge(budget, effects.reads.length + effects.writes.length, nodeId, path)
  return effects
}

// The intrinsic getters read the collection's internal slot, so an own `size`
// property on a hostile subclass cannot understate the members about to be
// expanded.
const mapSize = (value: Map<unknown, unknown>): number =>
  Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!.call(value) as number

const setSize = (value: Set<unknown>): number =>
  Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!.call(value) as number

class CyclicAnnotationsSignal extends Error {}

const propertyPath = (path: string, key: string): string => `${path}.${key}`

const compareJsonText = (left: unknown, right: unknown): number => {
  const leftText = String(JSON.stringify(left))
  const rightText = String(JSON.stringify(right))
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
}

/**
 * Names a value for a refusal message.
 *
 * The immediate prototype is not enough: an `Option`, an `Either`, and most
 * other Effect data types carry no own `constructor`, so reading one level
 * reports `Unknown` for exactly the values authors are most likely to place in
 * a plan. The chain is walked first, then the structural labels those values do
 * carry.
 */
const constructorName = (value: object): string => {
  for (
    let current = Object.getPrototypeOf(value) as object | null;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    const constructor = Object.getOwnPropertyDescriptor(current, "constructor")
    if (constructor === undefined || !("value" in constructor) || typeof constructor.value !== "function") continue
    const name = Object.getOwnPropertyDescriptor(constructor.value, "name")
    if (name !== undefined && "value" in name && typeof name.value === "string" && name.value.length > 0) {
      return name.value
    }
  }
  for (const key of [Symbol.toStringTag, "_tag"]) {
    const label = dataProperty(value, key)
    if (typeof label === "string" && label.length > 0) return label
  }
  return "Unknown"
}

const unrepresentableInstance = (value: object, path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message: `Graph.build cannot derive identity for a "${
      constructorName(value)
    }" instance at ${path}; plan values must be plain data`
  })

const nonFiniteNumber = (path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message:
      `Graph.build cannot derive identity for a number at ${path} because it is not finite; plan values must be plain data`
  })

const symbolKeyedProperty = (key: symbol, path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message: `Graph.build cannot derive identity for the symbol-keyed property ${
      String(key)
    } at ${path}; plan values must use string keys`
  })

const dataProperty = (value: object, key: PropertyKey): unknown => {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

const regexpSource = (value: RegExp): string => {
  const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")
  return descriptor !== undefined && descriptor.get !== undefined
    ? descriptor.get.call(value) as string
    : ""
}

const regexpFlags = (value: RegExp): string => {
  const flags: ReadonlyArray<readonly [string, string]> = [
    ["d", "hasIndices"],
    ["g", "global"],
    ["i", "ignoreCase"],
    ["m", "multiline"],
    ["s", "dotAll"],
    ["u", "unicode"],
    ["v", "unicodeSets"],
    ["y", "sticky"]
  ]
  return flags.flatMap(([flag, property]) => {
    const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, property)
    return descriptor !== undefined && descriptor.get !== undefined && descriptor.get.call(value) ? [flag] : []
  }).join("")
}

const opaqueSchema = (path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message: `Graph.build cannot derive identity for the declared schema at ${path} because its guard is opaque; ` +
      "annotate it, for example with an identifier, so distinct declarations key differently"
  })

const emptyRecord = (value: unknown): boolean =>
  typeof value !== "object" || value === null || Reflect.ownKeys(value).length === 0

/**
 * Selects semantic AST fields, excluding Effect's derived parser caches.
 * Children stay as ASTs until the bounded walk reaches them.
 */
const schemaFields = (source: SchemaAST.AST): object => {
  const common = {
    tag: source._tag,
    annotations: source.annotations ?? null,
    typeParameters: [],
    checks: source.checks,
    encoding: source.encoding,
    context: source.context
  }
  switch (source._tag) {
    case "Declaration":
      return {
        ...common,
        typeParameters: source.typeParameters,
        encodingChecks: source.encodingChecks,
        encodingRun: source.encodingRun
      }
    case "Arrays":
      return {
        ...common,
        isMutable: source.isMutable,
        elements: source.elements,
        rest: source.rest,
        encodingChecks: source.encodingChecks
      }
    case "Objects":
      return {
        ...common,
        propertySignatures: source.propertySignatures,
        indexSignatures: source.indexSignatures,
        encodingChecks: source.encodingChecks
      }
    case "Union":
      return { ...common, types: source.types, mode: source.mode, encodingChecks: source.encodingChecks }
    case "TemplateLiteral":
      return { ...common, parts: source.parts }
    case "Enum":
      return { ...common, enums: source.enums }
    case "Literal":
      return { ...common, literal: source.literal }
    case "UniqueSymbol":
      return { ...common, symbol: source.symbol }
    case "Suspend":
      // Evaluate only after the walk has checked depth and registered this AST
      // as active, so recursive schemas become references rather than loops.
      return { ...common, suspended: source.thunk() }
    default:
      return common
  }
}

/**
 * Walks ASTs and their public structural records (properties, links, contexts,
 * checks and transformations). Each container is charged before expansion.
 * Opaque transformation/filter functions use the ordinary function identity;
 * declarations retain the explicit annotation/type-parameter contract.
 */
const schemaStructure = (
  value: unknown,
  nodeId: string,
  depth: number,
  path: string,
  budget: MemberBudget,
  active: Map<object, string>
): unknown => {
  if (depth > maximumDepth) throw payloadDepthError(nodeId)
  if (value === null || typeof value !== "object") {
    return reflection(value, nodeId, new Set(), depth, path, false, budget)
  }
  const reference = active.get(value)
  if (reference !== undefined) return { _tag: "SchemaReference", path: reference }
  active.set(value, path)
  try {
    if (Array.isArray(value)) {
      charge(budget, value.length, nodeId, path)
      return value.map((item, index) => schemaStructure(item, nodeId, depth + 1, `${path}[${index}]`, budget, active))
    }
    const isAst = SchemaAST.isAST(value)
    if (isAst && value._tag === "Declaration" && value.typeParameters.length === 0 && emptyRecord(value.annotations)) {
      throw opaqueSchema(path)
    }
    const fields = isAst ? schemaFields(value) : value
    const keys = Object.keys(fields).sort()
    charge(budget, keys.length + (isAst ? 2 : 0), nodeId, path)
    const result: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      const member = Object.getOwnPropertyDescriptor(fields, key)!
      const memberPath = `${path}${isAst ? ".ast" : ""}.${key}`
      if (key === "annotations" && "value" in member) {
        try {
          result[key] = reflection(member.value, nodeId, new Set(), depth + 1, memberPath, true, budget)
        } catch (cause) {
          if (!(cause instanceof CyclicAnnotationsSignal)) throw cause
          result[key] = { _tag: "CyclicAnnotations" }
        }
      } else {
        result[key] = "value" in member
          ? schemaStructure(member.value, nodeId, depth + 1, memberPath, budget, active)
          : reflectedMember(member, nodeId, new Set(), depth, memberPath, false, budget)
      }
    }
    return isAst ? { _tag: "Schema", ast: result } : result
  } finally {
    active.delete(value)
  }
}

/**
 * Bounds every structural child before JSON Schema generation. The generated
 * document shares the AST's budget; only generation failures use the fallback,
 * so a typed refusal while charging the document cannot be swallowed.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export function schemaIdentity(
  schema: Schema.Top,
  nodeId: string,
  depth: number,
  path: string,
  budget: MemberBudget = memberBudget()
): unknown {
  // Read the caller's AST once for the projection. JSON Schema generation has
  // its own read, whose failure must not discard the structural identity.
  const identity = schemaStructure(schema.ast, nodeId, depth, path, budget, new Map()) as object
  let document: unknown
  try {
    document = Schema.toJsonSchemaDocument(schema)
  } catch {
    return identity
  }
  charge(budget, 1, nodeId, `${path}.document`)
  return {
    ...identity,
    document: reflection(document, nodeId, new Set(), depth + 1, `${path}.document`, false, budget)
  }
}

const plannedDescriptor = (value: unknown): PlannedValueDescriptor | undefined => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined
  return (value as { readonly [PlannedValueTypeId]?: PlannedValueDescriptor })[PlannedValueTypeId]
}

/**
 * Stands in for a value a later step supplies. Reading any member returns
 * another stand-in that remembers the path it was read through, so a plan can
 * describe what it will use before the value exists.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const plannedValue = (from: string, path: ReadonlyArray<string> = []): unknown => {
  const target = Function.prototype
  return new Proxy(target, {
    get: (_target, key) => {
      if (key === PlannedValueTypeId) return { from, path }
      if (key === Symbol.toPrimitive) return () => `[planned:${path.join(".")}]`
      if (key === "then") return undefined
      return plannedValue(from, [...path, String(key)])
    },
    apply: () => plannedValue(from, path)
  })
}

type PlannedInputRef = Extract<KeyMaterial.InputRef, { readonly _tag: "Ref" }>

/**
 * Collects every planned-value reference a plan value carries, in the order
 * the bounded member walk reaches them.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const plannedInputRefs = (
  value: unknown,
  nodeId: string,
  seen: Set<object> = new Set(),
  depth = 0,
  path = "$",
  budget: MemberBudget = memberBudget()
): ReadonlyArray<PlannedInputRef> => {
  if (depth > maximumDepth) throw payloadDepthError(nodeId)
  const descriptor = plannedDescriptor(value)
  if (descriptor !== undefined) {
    return [{ _tag: "Ref", from: descriptor.from, path: descriptor.path }]
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return []
  if (seen.has(value)) return []
  seen.add(value)
  try {
    const refs: Array<PlannedInputRef> = []
    for (const { member, path: memberPath } of planMembers(value, nodeId, path, budget)) {
      if (member !== undefined && "value" in member) {
        refs.push(...plannedInputRefs(member.value, nodeId, seen, depth + 1, memberPath, budget))
      }
    }
    return refs
  } finally {
    seen.delete(value)
  }
}

const define = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

const isArrayIndex = (key: string, length: number): boolean => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length

interface PlanMember {
  readonly key: string
  readonly member: PropertyDescriptor | undefined
  readonly path: string
  readonly errorArgs?: boolean
}

const errorArgsSymbol = Symbol.for("effect/Data/Error/plainArgs")

/**
 * The shared member contract for identity and planned references. Charge
 * containers before expansion, preserve holes and non-enumerable properties,
 * and inspect descriptors without invoking accessors. Error stacks are volatile.
 */
const planMembers = (value: object, nodeId: string, path: string, budget: MemberBudget): ReadonlyArray<PlanMember> => {
  if (value instanceof Map) {
    charge(budget, mapSize(value), nodeId, path)
    return [...Map.prototype.entries.call(value)].flatMap(([key, member], index) => [
      { key: String(index * 2), member: { value: key }, path: `${path}.entries[${index}][0]` },
      { key: String(index * 2 + 1), member: { value: member }, path: `${path}.entries[${index}][1]` }
    ])
  }
  if (value instanceof Set) {
    charge(budget, setSize(value), nodeId, path)
    return [...Set.prototype.values.call(value)].map((member, index) => ({
      key: String(index),
      member: { value: member },
      path: `${path}.values[${index}]`
    }))
  }
  if (Object.getPrototypeOf(value) === chunkPrototype) {
    charge(budget, Chunk.size(value as Chunk.Chunk<unknown>), nodeId, path)
    return Chunk.toReadonlyArray(value as Chunk.Chunk<unknown>).map((member, index) => ({
      key: String(index),
      member: { value: member },
      path: `${path}.values[${index}]`
    }))
  }
  const keys = Reflect.ownKeys(value)
  const symbol = keys.find((key): key is symbol =>
    typeof key === "symbol" && !(value instanceof Error && key === errorArgsSymbol)
  )
  if (symbol !== undefined) throw symbolKeyedProperty(symbol, path)
  const ownKeys = keys.filter((key): key is string =>
    typeof key === "string" && !(value instanceof Error && key === "stack")
  )
  if (Array.isArray(value)) {
    const extraKeys = ownKeys.filter((key) => key !== "length" && !isArrayIndex(key, value.length)).sort()
    charge(budget, value.length + extraKeys.length, nodeId, path)
    return [
      ...Array.from({ length: value.length }, (_, index) => ({
        key: String(index),
        member: Object.getOwnPropertyDescriptor(value, String(index)),
        path: `${path}[${index}]`
      })),
      ...extraKeys.map((key) => ({
        key,
        member: Object.getOwnPropertyDescriptor(value, key),
        path: propertyPath(path, key)
      }))
    ]
  }
  const errorArgs = value instanceof Error ? Object.getOwnPropertyDescriptor(value, errorArgsSymbol) : undefined
  charge(budget, ownKeys.length + (errorArgs === undefined ? 0 : 1), nodeId, path)
  return [
    ...ownKeys.sort().map((key) => ({
      key,
      member: Object.getOwnPropertyDescriptor(value, key),
      path: propertyPath(path, key)
    })),
    ...(errorArgs === undefined ? [] : [{ key: "args", member: errorArgs, path: `${path}.args`, errorArgs: true }])
  ]
}

/**
 * Projects one own property, describing an accessor instead of invoking it.
 */
const reflectedMember = (
  member: PropertyDescriptor,
  nodeId: string,
  seen: Set<object>,
  depth: number,
  path: string,
  rejectCycles: boolean,
  budget: MemberBudget
): unknown =>
  "value" in member
    ? reflection(member.value, nodeId, seen, depth + 1, path, rejectCycles, budget)
    : {
      _tag: "Accessor",
      get: member.get === undefined ? null : internal.functionIdentity(member.get),
      set: member.set === undefined ? null : internal.functionIdentity(member.set)
    }

/**
 * Projects plan values into canonical-JSON-compatible identity. Own
 * properties are read through descriptors; symbol-keyed properties are
 * refused because canonical JSON cannot represent their keys.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export function reflection(
  value: unknown,
  nodeId: string,
  seen: Set<object> = new Set(),
  depth = 0,
  path = "$",
  rejectCycles = false,
  budget: MemberBudget = memberBudget()
): unknown {
  if (depth > maximumDepth) throw payloadDepthError(nodeId)
  const descriptor = plannedDescriptor(value)
  if (descriptor !== undefined) {
    return {
      _tag: "PlannedInput",
      path: descriptor.path
    }
  }
  if (value === undefined) return depth > 0 ? { _tag: "Undefined" } : value
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { _tag: "Number", value: "-0" }
    if (!Number.isFinite(value)) throw nonFiniteNumber(path)
    return value
  }
  if (typeof value === "bigint") return { _tag: "BigInt", value: String(value) }
  if (typeof value === "symbol") {
    const identity = symbolIdentity(value)
    return {
      _tag: "Symbol",
      key: Symbol.keyFor(value) ?? null,
      description: value.description ?? null,
      scope: identity.scope,
      id: identity.id
    }
  }
  if (Flow.isFlow(value)) {
    if (seen.has(value)) {
      if (rejectCycles) throw new CyclicAnnotationsSignal()
      return { _tag: "CircularFlow" }
    }
    seen.add(value)
    const flow = value as FlowDetails
    const result = {
      _tag: "Flow",
      input: schemaIdentity(flow.input, nodeId, depth + 1, `${path}.input`, budget),
      output: schemaIdentity(flow.output, nodeId, depth + 1, `${path}.output`, budget),
      capabilities: [...new Set(flow.capabilities)].sort(),
      effects: reflectedEffects(flow.effects, nodeId, `${path}.effects`, budget),
      implementation: reflection(
        flow.implementation,
        nodeId,
        seen,
        depth + 1,
        `${path}.implementation`,
        rejectCycles,
        budget
      )
    }
    seen.delete(value)
    return result
  }
  if (Schema.isSchema(value)) return schemaIdentity(value, nodeId, depth, path, budget)
  if (typeof value === "function") return { _tag: "Function", identity: internal.functionIdentity(value) }
  if (seen.has(value)) {
    if (rejectCycles) throw new CyclicAnnotationsSignal()
    return { _tag: "Circular" }
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype === optionNonePrototype || prototype === optionSomePrototype) {
    seen.add(value)
    try {
      if (prototype === optionNonePrototype) return { _tag: "Option", value: { _tag: "None" } }
      const member = Object.getOwnPropertyDescriptor(value, "value")
      if (member === undefined || !("value" in member)) throw unrepresentableInstance(value, path)
      return {
        _tag: "Option",
        value: {
          _tag: "Some",
          value: reflection(member.value, nodeId, seen, depth + 1, `${path}.value`, rejectCycles, budget)
        }
      }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype === resultSuccessPrototype || prototype === resultFailurePrototype) {
    seen.add(value)
    try {
      const key = prototype === resultSuccessPrototype ? "success" : "failure"
      const member = Object.getOwnPropertyDescriptor(value, key)
      if (member === undefined || !("value" in member)) throw unrepresentableInstance(value, path)
      return {
        _tag: "Result",
        value: prototype === resultSuccessPrototype
          ? {
            _tag: "Success",
            value: reflection(member.value, nodeId, seen, depth + 1, `${path}.success`, rejectCycles, budget)
          }
          : {
            _tag: "Failure",
            error: reflection(member.value, nodeId, seen, depth + 1, `${path}.failure`, rejectCycles, budget)
          }
      }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype === chunkPrototype) {
    seen.add(value)
    try {
      return {
        _tag: "Chunk",
        values: planMembers(value, nodeId, path, budget).map(({ member, path: memberPath }) =>
          reflectedMember(member!, nodeId, seen, depth, memberPath, rejectCycles, budget)
        )
      }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype === URL.prototype) {
    return { _tag: "URL", href: URL.prototype.toString.call(value) }
  }
  if (value instanceof Date) {
    const epochMilliseconds = Date.prototype.getTime.call(value)
    return { _tag: "Date", epochMilliseconds: Number.isNaN(epochMilliseconds) ? null : epochMilliseconds }
  }
  if (value instanceof RegExp) {
    return { _tag: "RegExp", source: regexpSource(value), flags: regexpFlags(value) }
  }
  if (value instanceof Error) {
    seen.add(value)
    try {
      const name = dataProperty(value, "name")
      const message = dataProperty(value, "message")
      const fields = Object.create(null) as Record<string, unknown>
      const args = Object.create(null) as Record<string, unknown>
      for (const { key, member, path: memberPath, errorArgs } of planMembers(value, nodeId, path, budget)) {
        define(
          errorArgs ? args : fields,
          key,
          reflectedMember(member!, nodeId, seen, depth, memberPath, rejectCycles, budget)
        )
      }
      return {
        _tag: "Error",
        ...args,
        name: typeof name === "string" ? name : "Error",
        message: typeof message === "string" ? message : "",
        fields
      }
    } finally {
      seen.delete(value)
    }
  }
  const sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer
  if (value instanceof ArrayBuffer || sharedArrayBuffer) {
    charge(budget, value.byteLength, nodeId, path)
    return {
      _tag: "Bytes",
      kind: constructorName(value),
      bytes: [...new Uint8Array(value)]
    }
  }
  if (ArrayBuffer.isView(value)) {
    charge(budget, value.byteLength, nodeId, path)
    return {
      _tag: "Bytes",
      kind: constructorName(value),
      bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
    }
  }
  seen.add(value)
  if (value instanceof Map) {
    try {
      const members = planMembers(value, nodeId, path, budget)
      const entries: Array<ReadonlyArray<unknown>> = []
      for (let index = 0; index < members.length; index += 2) {
        entries.push(
          members.slice(index, index + 2).map(({ member, path: memberPath }) =>
            reflectedMember(member!, nodeId, seen, depth, memberPath, rejectCycles, budget)
          )
        )
      }
      entries.sort(compareJsonText)
      return { _tag: "Map", entries }
    } finally {
      seen.delete(value)
    }
  }
  if (value instanceof Set) {
    try {
      const values = planMembers(value, nodeId, path, budget).map(({ member, path: memberPath }) =>
        reflectedMember(member!, nodeId, seen, depth, memberPath, rejectCycles, budget)
      )
      values.sort(compareJsonText)
      return { _tag: "Set", values }
    } finally {
      seen.delete(value)
    }
  }
  if (Array.isArray(value)) {
    try {
      const members = planMembers(value, nodeId, path, budget)
      const items = new Array<unknown>(value.length)
      const extra = Object.create(null) as Record<string, unknown>
      for (const { key, member, path: memberPath } of members) {
        define(
          isArrayIndex(key, value.length) ? items : extra,
          key,
          member === undefined
            ? { _tag: "Hole" }
            : reflectedMember(member, nodeId, seen, depth, memberPath, rejectCycles, budget)
        )
      }
      return members.length === value.length ? items : { _tag: "Array", items, extra }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value)
    throw unrepresentableInstance(value, path)
  }
  try {
    const members = planMembers(value, nodeId, path, budget)
    const result = Object.create(null) as Record<string, unknown>
    for (const { key, member, path: memberPath } of members) {
      define(result, key, reflectedMember(member!, nodeId, seen, depth, memberPath, rejectCycles, budget))
    }
    const tag = members.find(({ key }) => key === "_tag")?.member
    return tag !== undefined && "value" in tag && typeof tag.value === "string" && reflectionTags.has(tag.value)
      ? { _tag: "Escaped", value: result }
      : result
  } finally {
    seen.delete(value)
  }
}
