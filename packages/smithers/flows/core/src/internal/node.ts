/**
 * Internal AST and runtime representation for pipeable flow nodes.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */
import { digestSync } from "@smthrs/crypto"
import * as Identity from "@smthrs/crypto/Identity"
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

/** The subset {@link functionIdentity} can produce: a node's static marker is minted elsewhere. @private */
type OperationIdentity = FunctionIdentity & {
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4"
}

/**
 * Brands an operation with every inert value it closes over.
 *
 * One implementation, in `@smthrs/crypto`: the digest is the product, and both
 * node models embed the same identity.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const capture = Identity.capture

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
export const functionIdentity: (operation: unknown) => OperationIdentity = Identity.functionIdentity

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
