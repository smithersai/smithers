/**
 * One memory policy applied to a whole flow tree.
 *
 * A delegated plan generates work the author never named, so the policy that
 * work runs under cannot be an argument threaded through every call. It is a
 * flow annotation instead: {@link withMemory} attaches the policy to a flow and
 * to every flow that flow declares, and the memory bindings in
 * `./Flows.ts` read it back when they resolve a namespace, a recall budget, or
 * whether a write is retained at all.
 *
 * The annotation takes no part in flow identity, so a policy never changes the
 * graph a flow plans. See https://memory.smithers.sh/reference/api/.
 *
 * @since 0.1.0
 */
import * as Annotations from "@smthrs/core/Annotations"
import * as Flow from "@smthrs/core/Flow"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { MemoryError } from "./MemoryError.ts"
import * as Namespace from "./Namespace.ts"
import { MaxTokens } from "./Recall.ts"

/**
 * The memory policy a flow tree inherits: which namespace its memory lives in,
 * whether recall runs unasked, the byte budget recall answers within, and
 * whether writes are retained.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Policy = Schema.Struct({
  namespace: Namespace.Namespace,
  recall: Schema.Literals(["auto", "none"]),
  maxTokens: MaxTokens,
  retain: Schema.Literals(["on-complete", "never"])
})

/**
 * The memory policy a flow tree inherits.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = typeof Policy.Type

/**
 * Annotation key carrying the memory policy on a flow.
 *
 * @category annotations
 * @since 0.1.0
 */
export const MemoryPolicy = Context.Service<Policy>("flows/memory/Annotations/MemoryPolicy")

/**
 * A flow read as its full declaration. Every flow is one; `Flow.Any` is the
 * existential the patterns pass around, and it hides the fields a decorator
 * has to read.
 */
type Declaration = Flow.Flow<Schema.Top, Schema.Top, unknown>

const declaration = (flow: Flow.Any): Declaration => flow as unknown as Declaration

/**
 * Lists the collaborators a flow declares, callable flows and unresolved
 * registry names alike.
 *
 * Only a dynamic flow, one whose body a model fills in from a declared flow
 * list, carries collaborators as data. A flow with a body reaches its
 * collaborators by calling them, and those calls are graph nodes rather than a
 * list, so this returns nothing for one.
 *
 * @category introspection
 * @since 0.1.0
 */
export const references = (flow: Flow.Any): ReadonlyArray<Flow.Reference> => {
  const implementation = declaration(flow).implementation
  return implementation === undefined || implementation._tag !== "Dynamic" ? [] : implementation.flows
}

/**
 * Lists the callable flows a flow declares. A name a registry has not resolved
 * yet is not one, so {@link references} is the wider view.
 *
 * @category introspection
 * @since 0.1.0
 */
export const children = (flow: Flow.Any): ReadonlyArray<Flow.Any> =>
  references(flow).filter((reference): reference is Flow.Any => Flow.isFlow(reference))

/**
 * Reads the memory policy a flow carries, or `undefined` when it carries none.
 *
 * @category introspection
 * @since 0.1.0
 */
export const policyOf = (flow: Flow.Any): Policy | undefined =>
  Option.getOrUndefined(Annotations.getOption(declaration(flow).annotations, MemoryPolicy))

const rebuild = (flow: Flow.Any, policy: Policy): Declaration => {
  const self = declaration(flow)
  const implementation = self.implementation
  if (implementation === undefined || implementation._tag !== "Dynamic") return self
  return Flow.withFlows(
    self,
    implementation.flows.map((reference) => Flow.isFlow(reference) ? attach(reference, policy) : reference)
  )
}

const attach = (flow: Flow.Any, policy: Policy): Flow.Any => Flow.annotate(rebuild(flow, policy), MemoryPolicy, policy)

const snapshot = (input: Policy): Policy => {
  let decoded: Policy
  try {
    decoded = Schema.decodeUnknownSync(Policy)(input)
  } catch {
    throw new MemoryError({
      code: "invalid_argument",
      message: "memory policy is invalid"
    })
  }
  return Object.freeze({
    ...decoded,
    namespace: Object.freeze({ ...decoded.namespace })
  })
}

/**
 * Returns a copy of `flow` carrying `policy`, with every flow it declares
 * carrying the same policy.
 *
 * The copy keeps the declaration's input and output schemas, so a host can
 * bind it: `FlowBinding.make` types the handler from `flow.input`, and an
 * answer of {@link Flow.Any} would leave nothing to type it from.
 *
 * The original flow is untouched, and every annotation the tree already carried
 * comes across: a placement, a lane, and any other key a host reads survive the
 * rebuild. A nested flow that already carries a policy is replaced by this one:
 * the tree a policy is applied to runs under exactly one policy, which is what
 * makes the inherited answer predictable.
 * The policy is decoded, detached, and deeply frozen before any annotation is
 * attached. Invalid policies throw a typed `MemoryError` at graph-build time.
 *
 * @category combinators
 * @since 0.1.0
 */
export function withMemory<Input extends Schema.Top, Output extends Schema.Top, E>(
  flow: Flow.Flow<Input, Output, E>,
  policy: Policy
): Flow.Flow<Input, Output, E>

/**
 * Returns a copy of a flow held as the existential {@link Flow.Any} carrying
 * `policy`, with every flow it declares carrying the same policy.
 *
 * A pattern carries the flows it composes as `Flow.Any`, so this is the
 * signature `MemoryTrellis` reaches. It answers the same existential: a caller
 * that erased the schemas cannot get them back here.
 *
 * @category combinators
 * @since 0.1.0
 */
export function withMemory(flow: Flow.Any, policy: Policy): Flow.Any

export function withMemory(flow: Flow.Any, policy: Policy): Flow.Any {
  return attach(flow, snapshot(policy))
}
