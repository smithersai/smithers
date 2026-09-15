/**
 * Pipeable, pure-data nodes used to describe flow graphs.
 *
 * Constructing and combining nodes records an inspectable AST. Graph planning
 * evaluates pure `andThen` builders against symbolic values to reveal static
 * topology; it never executes a flow node, an Effect, or a value mapper.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */
import type * as Context from "effect/Context"
import { dual } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Annotations from "./Annotations.ts"
import type * as Effects from "./Effects.ts"
import * as internal from "./internal/node.ts"
import type * as Placement from "./Placement.ts"

/**
 * Runtime type identifier carried by every `Node`.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export const TypeId: TypeId = internal.TypeId

/**
 * Type-level representation of the `Node` runtime type identifier.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export type TypeId = "~flows/core/Node"

/**
 * The inspectable AST stored by a `Node`.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Ast = internal.NodeAst

/**
 * A pure graph-building value with covariant success and error channels.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
  readonly ast: Ast
}

/**
 * A type representing any `Node`.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Any = Node<unknown, unknown>

/**
 * Binds a frozen plain copy of inert captures as the callback's this receiver.
 *
 * Use a function expression to read the snapshot while keeping the ordinary
 * callback arguments: Node.capture({ factor: 3 }, function(value: number) {
 *   return value * this.factor
 * }). Caller objects remain unchanged; lexical aliases still name originals
 * and must not be used as mutable semantic inputs. Nested captures retain the
 * inner callback's snapshot and compose the two identities.
 *
 * Admission walks original descriptors once, rejects built-in brands and
 * non-plain prototypes without evaluating getters, then uses structuredClone
 * to refuse Proxies. Hosts without that API refuse object capture. Only the
 * owned frozen copy enters identity and the wrapper. Sealed, non-extensible,
 * frozen and Immer ordinary data are supported equally. Unsupported values
 * raise a TypeError naming the path. See core docs/api.md#nodecapture for the
 * complete algorithm and the migration from original-object locking.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const capture = <C extends Readonly<Record<string, unknown>>, Args extends ReadonlyArray<unknown>, A>(
  captures: C,
  operation: (this: Readonly<C>, ...args: Args) => A
): (...args: Args) => A => internal.capture(captures, operation)

/**
 * Identifies an operation by its source and declared captures, or by
 * process-local entropy when its captures are undeclared.
 *
 * @category utilities
 * @since 1.0.0
 */
export const functionIdentity: typeof internal.functionIdentity = internal.functionIdentity

/**
 * Extracts the success type of a `Node`.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Success<N> = N extends Node<infer A, infer _E> ? A : never

/**
 * Extracts the error type of a `Node`.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Error<N> = N extends Node<infer _A, infer E> ? E : never

/**
 * Options recorded by a dynamic model node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface DynamicOptions {
  readonly model?: string | undefined
  readonly flows?: ReadonlyArray<string | { readonly "~flows/core/Flow": object }> | undefined
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: Effects.Declaration | undefined
}

/**
 * Stable code emitted by node construction or continuation failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export const NodeBuildErrorCode = Schema.Literals([
  "invalid_all_member",
  "invalid_continuation",
  "invalid_priority",
  "unrepresentable_value"
])

/**
 * Stable code emitted by node construction or continuation failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type NodeBuildErrorCode = typeof NodeBuildErrorCode.Type

/**
 * A failure to construct or elaborate a valid node AST.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export class NodeBuildError extends Schema.TaggedError<NodeBuildError>()("flows/core/NodeBuildError", {
  code: NodeBuildErrorCode,
  member: Schema.String,
  message: Schema.String
}) {}

/**
 * Checks whether an unknown value is a `Node`.
 *
 * @category guards
 * @since 0.0.0
 * @slop
 */
export const isNode = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId)

/**
 * Constructs a node that succeeds with a constant value.
 *
 * The value is retained by reference and read when {@link Graph.build} runs.
 * Mutating it between node construction and graph construction therefore
 * changes the recorded identity.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const succeed = <A>(value: A): Node<A> => internal.makeNode<A>(internal.succeed(value, Annotations.empty))

/**
 * A node that always fails with the given typed error.
 *
 * Use it to re-raise inside a `catch` recovery arm, so a plan shows that the
 * arm cleans up and hands the failure back rather than absorbing it. The error
 * enters key material, so two failures carrying different data are two
 * declarations.
 *
 * The error is retained by reference and read when {@link Graph.build} runs.
 * Mutating it between node construction and graph construction therefore
 * changes the recorded identity.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const fail = <E>(error: E): Node<never, E> =>
  internal.makeNode<never, E>(internal.fail(error, Annotations.empty))

/**
 * Constructs a node that combines a record of independent child nodes.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const all = <const R extends Readonly<Record<string, Any>>>(
  nodes: R
): Node<
  Types.Simplify<{ readonly [K in keyof R]: Success<R[K]> }>,
  Error<R[keyof R]>
> => {
  const asts = Object.create(null) as Record<string, Ast>
  for (const [member, node] of Object.entries(nodes)) {
    if (!isNode(node)) {
      throw new NodeBuildError({
        code: "invalid_all_member",
        member,
        message: `Node.all expected a Node at member "${member}"`
      })
    }
    Object.defineProperty(asts, member, {
      configurable: false,
      enumerable: true,
      value: node.ast,
      writable: false
    })
  }
  if (Object.keys(asts).length !== Object.keys(nodes).length) {
    throw new NodeBuildError({
      code: "invalid_all_member",
      member: "*",
      message: "Node.all could not retain every member"
    })
  }
  return internal.makeNode(internal.all(asts, Annotations.empty))
}

/**
 * Constructs an unelaborated dynamic model node with a typed output schema.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export function dynamic<A>(
  options: DynamicOptions & { readonly output?: { readonly Type: A } }
): Node<A>

/**
 * Constructs an unelaborated dynamic model node.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export function dynamic(options: DynamicOptions): Node<unknown>

export function dynamic(options: DynamicOptions): Node<unknown> {
  return internal.makeNode(internal.dynamic({
    ...options,
    flows: options.flows ?? []
  }, Annotations.empty))
}

/**
 * Maps the eventual success value of a node with a deferred pure function.
 *
 * @category mapping
 * @since 0.0.0
 * @slop
 */
export const map: {
  <A, B>(f: (a: A) => B): <E>(self: Node<A, E>) => Node<B, E>
  <A, E, B>(self: Node<A, E>, f: (a: A) => B): Node<B, E>
} = dual(
  2,
  <A, E, B>(self: Node<A, E>, f: (a: A) => B): Node<B, E> =>
    internal.makeNode<B, E>(
      internal.map(self.ast, (value) => f(value as A), f, Annotations.empty)
    )
)

/**
 * Sequences a pure node-producing builder after a node.
 *
 * A node value may be supplied directly when the first success value is not
 * needed by the next step. Graph planning evaluates the builder once against
 * a symbolic value so the downstream topology and its input references are
 * known before execution.
 *
 * The symbolic value is a placeholder, not the eventual result, and the
 * builder is typed against the success type only so member access reads
 * naturally. Reading a member records an input reference and is the intended
 * use. Computing on the placeholder is not: arithmetic and string
 * interpolation coerce it to the literal text `[planned:<path>]`, and a
 * conditional on it always takes the truthy branch, so only that branch is
 * planned. Either result is baked into the plan's identity with no diagnostic.
 * Decide with real values inside the step that produces them, and use the
 * placeholder only to name what a later step reads. The member name `then` is
 * reserved by the placeholder: reading it yields `undefined` so the
 * placeholder is never mistaken for a thenable, so rename a legitimate `then`
 * field or read it inside the step that produces it.
 *
 * @category sequencing
 * @since 0.0.0
 * @slop
 */
export const andThen: {
  <A, B, E2>(f: (a: A) => Node<B, E2>): <E>(self: Node<A, E>) => Node<B, E | E2>
  <B, E2>(next: Node<B, E2>): <A, E>(self: Node<A, E>) => Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, f: (a: A) => Node<B, E2>): Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, next: Node<B, E2>): Node<B, E | E2>
} = dual(
  2,
  <A, E, B, E2>(
    self: Node<A, E>,
    next: Node<B, E2> | ((a: A) => Node<B, E2>)
  ): Node<B, E | E2> =>
    internal.makeNode<B, E | E2>(
      typeof next === "function"
        ? internal.andThen(
          self.ast,
          (value) => next(value as A),
          next,
          Annotations.empty
        )
        : internal.andThenNode(self.ast, next.ast, Annotations.empty)
    )
)

/**
 * The statically planned recovery arm, and the optional schema selecting which
 * typed failures it handles.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CatchOptions<E, B, E2, Handled = E> {
  readonly error?: Schema.Schema<Handled> | undefined
  readonly onFailure: (error: Handled) => Node<B, E2>
}

/**
 * Recovers a node's typed failures with a statically planned arm.
 *
 * The arm is built once, while planning, against a symbolic error that names
 * the protected node, so the recovery topology is visible before anything
 * runs. With no schema the whole typed error channel is handled; with one, the
 * remainder stays in the error type.
 *
 * The symbolic error carries the same placeholder caveat as {@link andThen}:
 * read members from it, never compute on it or branch on it, and its `then`
 * member is likewise reserved and reads as `undefined`.
 *
 * @category sequencing
 * @since 0.1.0
 * @slop
 */
const catch_: {
  <Handled, B, E2>(
    options: CatchOptions<unknown, B, E2, Handled> & { readonly error: Schema.Schema<Handled> }
  ): <A, E>(self: Node<A, E>) => Node<A | B, Exclude<E, Handled> | E2>
  <E, B, E2>(
    options: CatchOptions<E, B, E2> & { readonly error?: undefined }
  ): <A>(self: Node<A, E>) => Node<A | B, E2>
  <A, E, Handled, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2, Handled> & { readonly error: Schema.Schema<Handled> }
  ): Node<A | B, Exclude<E, Handled> | E2>
  <A, E, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2> & { readonly error?: undefined }
  ): Node<A | B, E2>
} = dual(
  2,
  <A, E, Handled, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2, Handled>
  ): Node<A | B, Exclude<E, Handled> | E2> =>
    internal.makeNode<A | B, Exclude<E, Handled> | E2>(
      internal.catch_(
        self.ast,
        (error) => options.onFailure(error as Handled),
        options.onFailure,
        options.error,
        Annotations.empty
      )
    )
)

export {
  /**
   * Recovers a node's typed failures with a statically planned arm.
   *
   * @category sequencing
   * @since 0.1.0
   * @slop
   */
  catch_ as catch
}

const annotate = <A, E, I, S>(
  self: Node<A, E>,
  key: Context.Key<I, S>,
  value: S
): Node<A, E> =>
  internal.makeNode<A, E>(
    internal.withAnnotations(
      self.ast,
      Annotations.add(self.ast.annotations, key, value)
    )
  )

/**
 * Adds a placement annotation to a node without changing the original.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const within: {
  (placement: Placement.Placement): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, placement: Placement.Placement): Node<A, E>
} = dual(
  2,
  <A, E>(self: Node<A, E>, placement: Placement.Placement): Node<A, E> =>
    annotate(self, Annotations.Placement, placement)
)

/**
 * Adds a scheduling priority annotation to a node without changing the
 * original.
 *
 * A scheduler runs ready work with a higher number first. Children inherit the
 * value lexically, so annotating a container prioritizes everything under it
 * that does not state its own. Priority never enters key material: it orders
 * work without changing what the work produces.
 *
 * @category annotations
 * @since 0.1.0
 * @slop
 */
export const priority: {
  (value: number): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, value: number): Node<A, E>
} = dual(
  2,
  <A, E>(self: Node<A, E>, value: number): Node<A, E> => {
    if (!Number.isSafeInteger(value)) {
      throw new NodeBuildError({
        code: "invalid_priority",
        member: "priority",
        message: `Node.priority expects a safe integer, received ${value}`
      })
    }
    return annotate(self, Annotations.Priority, value)
  }
)

/**
 * Adds a worktree lane annotation to a node without changing the original.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const lane: {
  (options: Annotations.LaneOptions): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, options: Annotations.LaneOptions): Node<A, E>
} = dual(
  2,
  <A, E>(self: Node<A, E>, options: Annotations.LaneOptions): Node<A, E> => annotate(self, Annotations.Lane, options)
)

/**
 * Adds an effect declaration annotation to a node without changing the
 * original.
 *
 * On a non-work node, the declaration narrows the envelope inherited by its
 * children and enters that container node's identity. Only `Dynamic` work
 * nodes participate in {@link Graph.conflicts}; containers are not counted a
 * second time against their own children.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const withEffects: {
  (declaration: Effects.Declaration): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, declaration: Effects.Declaration): Node<A, E>
} = dual(
  2,
  <A, E>(self: Node<A, E>, declaration: Effects.Declaration): Node<A, E> =>
    annotate(self, Annotations.Effects, declaration)
)
