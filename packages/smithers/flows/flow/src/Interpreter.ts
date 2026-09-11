/**
 * The body interpreter: what a flow does when it runs.
 *
 * A `Flow` has no handler to register — its `body` IS the behavior, per
 * `docs/concepts/flows-and-actions.md` — so something has to turn
 * the graph that body describes into execution. That is this
 * module. {@link layer} registers a flow with the runtime, and the
 * handler it installs builds the graph with {@link module:Graph.build} and
 * walks it: each node settles once, in dependency order, and the root's value
 * is the flow's result.
 *
 * What each variant does is the run-time half of what the AST recorded. An
 * `ActionCall` runs its declaration's implementation — looked up by tag in
 * {@link module:Implementations.Implementations} before the walk starts — as
 * the ordinary durable action `toLayer` built, so a node driven here takes
 * the same attempt journal, retry policy, and tier as the same action called
 * from a handler. Its invocation identity additionally folds this node's
 * structural address, keeping concurrent graph sites replay-stable. A `Map`
 * applies its deferred function to the real upstream value. A `Branch`
 * evaluates its digested predicate on the real
 * subject and settles ONLY the arm it took: the other arm is topology the plan
 * shows and the run skipped, and it is reported as such rather than silently
 * absent. An `All` joins its members by name, a `Succeed` yields its value, and
 * an inline `FlowCall` was already flattened by graph building, so it settles
 * with the body spliced beneath it. A `FlowCall` the author wrote as
 * `.child(payload)` is the one node that is NOT flattened: it opens a real child
 * execution under a deterministically derived id
 * ({@link childExecutionId}), which is what gives it its own journal lineage and
 * makes the parent's interruption and the child's suspension travel between
 * them.
 *
 * Planned references are resolved the way the plan names them: a payload
 * placeholder carries the `Ref` `{from, path}` its key material recorded, so
 * `result.files` reads `files` off the settled value of the node that produced
 * it.
 *
 * The walk is demand-driven from the root rather than a sweep over the node
 * list, because dependency order puts BOTH branch arms before the branch that
 * chooses between them, and executing an arm to discover it was not taken is
 * exactly what static topology exists to avoid.
 *
 * @since 0.1.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import { DerivedKey, digest } from "@smthrs/keys"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { type Implementation, Implementations, layerImplementations } from "./Action/Implementations.ts"
import { DispatchSite } from "./Action/StepIdentity.ts"
import type { Any as AnyFlow, AnyStructSchema, AnyWithProps, Flow } from "./Flow/Flow.ts"
import * as Outcome from "./Flow/Outcome.ts"
import { Handoff } from "./Flow/Result.ts"
import { suspend } from "./Flow/Runtime.ts"
import { TypeId as FlowTypeId } from "./Flow/TypeId.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import { annotateWaiting } from "./FlowRuntime/WaitingAnnotation.ts"
import * as Graph from "./Graph.ts"
import { OutcomeValueTypeId } from "./internal/OutcomeMarker.ts"

/**
 * A graph the interpreter will not drive.
 *
 * Every code names something the run cannot recover from on its own: a graph
 * whose topology is incomplete, an action with no implementation wired up, a
 * call the interpreter does not execute, and a deferred function that did not
 * survive serialization beside its AST. `missing_implementation_version`
 * names a content-reusable action that lacks the canonical version contract;
 * `implementation_version_mismatch` names a declaration and registry that
 * disagree. Both are preflight failures, before action dispatch.
 *
 * @category errors
 * @since 0.1.0
 */
export class InterpreterError extends Schema.TaggedError<InterpreterError>()(
  "@smthrs/flow/InterpreterError",
  {
    code: Schema.Literals([
      "incomplete_graph",
      "duplicate_node_id",
      "unresolved_action",
      "implementation_version_mismatch",
      "missing_implementation_version",
      "unresolved_reference",
      "unsupported_call",
      "missing_operation"
    ]),
    flow: Schema.String,
    node: Schema.String,
    message: Schema.String
  }
) {}

/**
 * What one interpretation produced: the root's value, every node that settled
 * with the value it settled with, and the nodes the run never reached because
 * a branch went the other way.
 *
 * @category models
 * @since 0.1.0
 */
export interface Interpretation {
  readonly value: unknown
  readonly settled: ReadonlyMap<string, unknown>
  /** Typed failures observed before a catch recovered them. */
  readonly failed: ReadonlyMap<string, unknown>
  readonly skipped: ReadonlyArray<string>
}

/**
 * The services a driven node needs: the runtime that executes an action, and
 * the execution it is part of.
 *
 * @private
 */
type Services = Crypto.Crypto | FlowRuntime | FlowInstance | Implementations

/** Reads one own data property without invoking an accessor or letting a proxy trap escape. */
const ownDataProperty = (value: unknown, key: PropertyKey): unknown => {
  if (Object(value) !== value) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/**
 * The execution id a `.child()` boundary runs its child under.
 *
 * DECIDED: the id is DERIVED from the parent
 * execution and the child node's structural address, not minted. That is what
 * makes a boundary at-most-once under replay, exactly as
 * `docs/concepts/trampoline-rounds.md` requires of a round handoff: a
 * parent that is re-driven re-derives the same id, so the engine lands on the
 * child execution that already exists instead of starting a second copy of it.
 * The canonical tuple includes the callee and a canonical payload digest, so
 * delimiter splicing and a changed invocation cannot alias an earlier child.
 * SHA-256 uses the same injected derivation services as the repository's
 * other durable identities. The versioned key prefix is dropped because the
 * child-id wire format is the bare digest. `digest` owns the
 * prefix knowledge, so this package never guesses at a stored-key format.
 *
 * @since 0.1.0
 * @category constructors
 */
export const childExecutionId = (
  parentExecutionId: string,
  nodeId: string,
  calleeTag: string,
  payload: unknown
): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const payloadDigest = yield* Schema.decodeUnknownEffect(DerivedKey)(payload).pipe(Effect.orDie)
    const tupleDigest = yield* Schema.decodeUnknownEffect(DerivedKey)([
      parentExecutionId,
      nodeId,
      calleeTag,
      payloadDigest
    ]).pipe(Effect.orDie)
    return digest(tupleDigest)
  })

/**
 * Interprets a flow body, or a bare node, against real values.
 *
 * The graph is built first and in full — planning is a pure function of the
 * declarations and the payload, so the whole shape of the round is known before
 * the first action runs — and then driven. The low-level default permits
 * process-local callbacks; pass `callbackIdentity: "stable"` for reproducible
 * callback identity. {@link layerWithImplementations} selects that policy by
 * default.
 *
 * @since 0.1.0
 * @category constructors
 */
export const interpret = (
  flowOrNode: Parameters<typeof Graph.build>[0],
  payload?: unknown,
  options: Graph.BuildOptions = {}
): Effect.Effect<Interpretation, unknown, Services> => interpretWithPolicy(flowOrNode, payload, options, false)

/** The canonical composition requires versions before permitting content-key reuse. @private */
const interpretWithPolicy = (
  flowOrNode: Parameters<typeof Graph.build>[0],
  payload: unknown,
  options: Graph.BuildOptions,
  requireReusableVersions: boolean
): Effect.Effect<Interpretation, unknown, Services> =>
  Effect.gen(function*() {
    const table = yield* Implementations
    const name = "_tag" in flowOrNode ? flowOrNode._tag : "node"
    const refuse = (
      code: InterpreterError["code"],
      node: string,
      message: string
    ): Effect.Effect<never, InterpreterError> => Effect.fail(new InterpreterError({ code, flow: name, node, message }))

    const graph = yield* Effect.try({
      try: () => Graph.build(flowOrNode, payload, options),
      catch: (cause) => {
        // Graph.build normalizes its own refusals to GraphBuildError, but the
        // flow body runs inside this boundary and a body throws whatever it
        // throws. Reading `node` and `message` off the value without checking
        // built an InterpreterError its own schema rejects, and the
        // constructor's "Schema validation failed" then replaced the reason
        // the author needed. All three fields are read through own data
        // descriptors and narrowed here so a plain Error from a body arrives
        // as a typed failure that still says why. A body that threw produced no
        // topology, so it reports `incomplete_graph`.
        const refusalNode = ownDataProperty(cause, "node")
        const refusalCode = ownDataProperty(cause, "code")
        const refusalMessage = ownDataProperty(cause, "message")
        const node = typeof refusalNode === "string" ? refusalNode : ""
        const reported = typeof refusalMessage === "string" ? refusalMessage : ""
        return new InterpreterError({
          code: refusalCode === "duplicate_node" ? "duplicate_node_id" : "incomplete_graph",
          flow: name,
          node,
          message: reported === "" ? `building the graph of flow ${name} threw ${String(cause)}` : reported
        })
      }
    })

    const graphNodes = Graph.nodes(graph)
    const byId = new Map(graphNodes.map((node) => [node.id, node]))

    if (graph.diagnostics.length > 0) {
      const first = graph.diagnostics[0]!
      return yield* refuse(
        "incomplete_graph",
        first.node,
        `Graph of "${name}" is missing topology and cannot be driven: ${first.message}`
      )
    }

    // Everything the walk needs that the built graph can be asked for before it
    // runs, is asked for here — so no such refusal can surface halfway through a
    // body with the actions ahead of it already committed.
    //
    // A reference out of the graph is the first: a round may be PLANNED against
    // a node an earlier generation settled — `Plan.append` exists for exactly
    // that — but one interpretation settles one graph, so there is nothing to
    // read it from. A missing implementation is the second, and it is a wiring
    // error rather than a run-time contingency: every action the graph names
    // is resolved up front, including the ones only an untaken branch arm would
    // have reached, because the plan is the declared ceiling of what may run.
    // Deferred operations must likewise survive beside every AST, even when
    // the walk would skip their branch or catch arm.
    const implementations = new Map<string, Implementation>()
    const handoffDeclarations = new Map<string, AnyFlow>()
    const childDeclarations = new Map<string, AnyWithProps>()
    for (const node of graphNodes) {
      const ast = node.ast
      if (ast._tag === "Map" && Node.mapper(ast) === undefined) {
        return yield* refuse("missing_operation", node.id, `Map at "${node.id}" lost its mapper.`)
      }
      if (ast._tag === "Branch" && Node.predicate(ast) === undefined) {
        return yield* refuse("missing_operation", node.id, `Branch at "${node.id}" lost its predicate.`)
      }
      if (ast._tag === "Catch" && ast.filter !== undefined && Node.catchFilter(ast) === undefined) {
        return yield* refuse("missing_operation", node.id, `Catch at "${node.id}" lost its schema filter.`)
      }
      for (const dependency of KeyMaterial.dependencies(node.draft.material)) {
        if (byId.has(dependency)) continue
        return yield* refuse(
          "unresolved_reference",
          node.id,
          `Node "${node.id}" reads "${dependency}", which this graph does not hold.`
        )
      }
      if (node.ast._tag === "FlowCall" && node.ast.mode === "handoff") {
        const declaration = Node.declaration(node.ast)
        if (!Predicate.hasProperty(declaration, FlowTypeId)) {
          return yield* refuse(
            "unsupported_call",
            node.id,
            `Handoff to flow "${node.ast.flow}" at "${node.id}" lost its declaration. ` +
              "Build and interpret the authored node in the same process so its payload can be encoded."
          )
        }
        handoffDeclarations.set(node.id, declaration as unknown as AnyFlow)
        continue
      }
      if (node.ast._tag === "FlowCall" && node.ast.mode === "boundary") {
        // A boundary is one node here and a real execution underneath, so what
        // it needs resolved up front is the callee itself: the declaration is
        // what `execute` is called on, and losing it is a wiring error rather
        // than a run-time contingency, exactly like an unimplemented action.
        const declaration = Node.declaration(node.ast)
        if (!Predicate.hasProperty(declaration, FlowTypeId)) {
          return yield* refuse(
            "unsupported_call",
            node.id,
            `Child boundary to flow "${node.ast.flow}" at "${node.id}" lost its declaration. ` +
              "Build and interpret the authored node in the same process so the child can be executed."
          )
        }
        childDeclarations.set(node.id, declaration as unknown as AnyWithProps)
        continue
      }
      if (node.ast._tag !== "ActionCall") continue
      const implementation = yield* table.get(node.ast.action)
      if (Option.isNone(implementation)) {
        return yield* refuse(
          "unresolved_action",
          node.id,
          `Action "${node.ast.action}" has no implementation. ` +
            `Provide ONE Action.layerImplementations under both ${node.ast.action}.toLayer(execute) and ` +
            "this interpreter layer: an implementation files itself with the table that is in scope " +
            "while IT is built, so a table merged beside it, or a second one built above it, is not the " +
            "table this driver reads."
        )
      }
      const declaration = Node.declaration(node.ast)
      const declaredVersion = ownDataProperty(declaration, "implementationVersion")
      if (requireReusableVersions) {
        const tier = ownDataProperty(declaration, "tier")
        if (tier === undefined) {
          return yield* refuse(
            "incomplete_graph",
            node.id,
            `Action "${node.ast.action}" lost its declaration, so its implementation identity cannot be checked. ` +
              "Build the canonical composition from the authored action nodes."
          )
        }
        if (
          tier === "sealed" && ownDataProperty(declaration, "idempotencyKey") !== undefined &&
          declaredVersion === undefined
        ) {
          return yield* refuse(
            "missing_implementation_version",
            node.id,
            `Sealed action "${node.ast.action}" declares an idempotency key and can reuse recorded content. ` +
              "Declare implementationVersion on Action.make and attest the same version in toLayer."
          )
        }
      }
      if (declaredVersion !== implementation.value.implementationVersion) {
        return yield* refuse(
          "implementation_version_mismatch",
          node.id,
          `Action "${node.ast.action}" does not match its registered implementationVersion. ` +
            "Register the declared version and start a newly planned execution when its semantics change."
        )
      }
      implementations.set(node.ast.action, implementation.value)
    }
    // The children a node settles with, in the order graph building recorded
    // them: `first` then the arms of a branch, `first` then the continuation of
    // a sequence, the members of a combination, the spliced body of an inline
    // call. Payload references are NOT here — they are named by the key
    // material, and settled from it.
    const sources = new Map<string, Array<string>>()
    for (const edge of Graph.edges(graph)) {
      if (edge.reason !== "value") continue
      sources.set(edge.to, [...sources.get(edge.to) ?? [], edge.from])
    }

    const settled = new Map<string, unknown>()
    const failed = new Map<string, unknown>()

    /**
     * Projects a settled value along the property path a `Ref` recorded —
     * through `StepKey.project`, the one projection semantics for the value
     * channel. The scheduler digests exactly what this returns; resolving a
     * `Ref` any other way here would let two executions that key identically
     * consume different values.
     */
    const project = StepKey.project

    /**
     * Replaces every placeholder in a hydrated payload with what it stands for.
     *
     * The record is rebuilt with a null prototype and `defineProperty`, for the
     * reason {@link module:Graph.build}'s cloners are: `output[key] = …` on an
     * object literal routes `__proto__` through `Object.prototype`'s accessor,
     * which drops an own `__proto__` field carrying a primitive and reparents
     * the clone when it carries an object. A graph hydrates that field as data,
     * so the value handed to an action has to keep it as data too.
     */
    const resolve = (value: unknown): unknown => {
      const reference = Planned.reference(value)
      if (reference !== undefined) {
        return project(
          settled.has(reference.node) ? settled.get(reference.node) : failed.get(reference.node),
          reference.path
        )
      }
      if (Array.isArray(value)) return value.map((item) => resolve(item))
      if (!isRecord(value)) return value
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(value)) {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: resolve(value[key]),
          writable: true
        })
      }
      const outcome = Object.getOwnPropertyDescriptor(value, OutcomeValueTypeId)
      if (outcome !== undefined && "value" in outcome) {
        Object.defineProperty(output, OutcomeValueTypeId, {
          configurable: false,
          enumerable: false,
          value: outcome.value,
          writable: false
        })
      }
      return output
    }

    /**
     * The settlement currently in flight for a node, for as long as it is.
     *
     * `settled.has(id)` alone is not a memo once the walk runs concurrently: it
     * answers "has this node FINISHED", and two demands that arrive while the
     * node is still running both see `false` and both execute it. A diamond
     * would then run its shared node twice, which for an action with effects is
     * a correctness bug rather than a wasted cycle.
     *
     * The check-and-register below is the whole reason this is a `suspend` and
     * not a generator: the callback runs synchronously, so no other fiber can
     * observe the gap between the lookup and the insert.
     *
     * Every computation runs on a fiber forked into `nodes`, the
     * interpretation's own scope, and every demand — the first included — is a
     * join on the node's deferred. Ownership by the interpretation rather than
     * by whichever demand arrived first is what makes a ref-diamond sound: a
     * failing `All` interrupts its member JOINS, never a shared node's
     * execution, so recovery arms above can still join the shared work; and
     * when the walk itself ends, closing the scope interrupts whatever is
     * still running, so an orphaned execution cannot outlive the
     * interpretation or write a phantom success into `settled` afterwards
     * (Skyframe's and `MemoMap`'s ownership model).
     */
    const inFlight = new Map<string, Deferred.Deferred<unknown, unknown>>()
    const nodes = yield* Scope.make()

    const settleNode = (id: string): Effect.Effect<unknown, unknown, Services> =>
      Effect.suspend(() => {
        if (settled.has(id)) return Effect.succeed(settled.get(id))
        const waiting = inFlight.get(id)
        // A later demand joins the execution rather than starting one.
        if (waiting !== undefined) return Deferred.await(waiting)
        const deferred = Deferred.makeUnsafe<unknown, unknown>()
        inFlight.set(id, deferred)
        const execution = compute(byId.get(id)!).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              settled.set(id, value)
            })
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              failed.set(id, error)
            })
          ),
          Effect.onExit((exit) => {
            // An interrupted execution is evicted, not memoized: current
            // joiners observe the interruption, but a LATER demand — a
            // recovery arm, a re-driven walk — re-executes the node instead
            // of replaying an interrupt that says nothing about it.
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) inFlight.delete(id)
            return Deferred.done(deferred, exit)
          })
        )
        // `startImmediately` keeps the first demand's latency identical to the
        // old inline execution: the node runs synchronously until its first
        // real suspension, so a body that parks does so before the driver's
        // next tick — the same observable cadence a sequential walk had.
        return Effect.forkIn(execution, nodes, { startImmediately: true }).pipe(
          Effect.andThen(Deferred.await(deferred))
        )
      })

    const compute: (node: Graph.GraphNode) => Effect.Effect<unknown, unknown, Services> = Effect.fnUntraced(
      function*(node: Graph.GraphNode) {
        const children = sources.get(node.id) ?? []
        const ast = node.ast
        if (ast._tag === "AndThen" && ast.next !== undefined) {
          // An explicit sequence is a success boundary for the WHOLE next
          // subtree. Joining first and then concurrently lets a nested All,
          // Map, or inline call start effects before its prerequisite settles.
          // bindPlanned is distinct: it declares data dependencies and can
          // expose independent work while the producer is still running.
          yield* settleNode(children[0]!)
          return yield* settleNode(children[1]!)
        }
        if (ast._tag === "Branch") {
          // The predicate decides on the REAL value, and only the arm it chose
          // is settled. Both arms are still in the plan; the untaken one is
          // reported as skipped.
          const decide = Node.predicate(ast)!
          const subject = yield* settleNode(children[0]!)
          return yield* settleNode(decide(subject) ? children[1]! : children[2]!)
        }
        if (ast._tag === "Catch") {
          // DECIDED: catch observes only typed
          // failures from ordinary protected execution. Interpreter refusals
          // propagate unchanged. Effect defects and
          // compensation failures remain outside this interpreter's error
          // channel, so recovery cannot conceal a broken invariant or weaken
          // withRollback's compensation guarantees.
          const protectedId = children[0]!
          return yield* Effect.matchEffect(settleNode(protectedId), {
            onFailure: (error) => {
              if (Schema.is(InterpreterError)(error)) return Effect.fail(error)
              const filter = Node.catchFilter(ast)
              if (filter !== undefined && !Schema.is(filter)(error)) {
                return Effect.fail(error)
              }
              // The failure arm's planned subject resolves through the
              // protected node id. Filing the typed failure as that settlement
              // also prevents its static failure edge from re-running the
              // protected graph while the recovery arm is driven.
              failed.set(protectedId, error)
              return settleNode(children[1]!)
            },
            onSuccess: Effect.succeed
          })
        }
        // Dependency order, from the key material: the same `Ref` and `Pending`
        // inputs the plan turns into edges, settled before the node that reads
        // them — and settled CONCURRENTLY, because independent dependencies are
        // exactly what the scheduler admits under separate permits. Two
        // execution surfaces disagreeing about concurrency is a correctness
        // hazard, not just a latency one.
        yield* Effect.forEach(
          KeyMaterial.dependencies(node.draft.material).filter((dependency) => !failed.has(dependency)),
          settleNode,
          { concurrency: "unbounded", discard: true }
        )
        switch (ast._tag) {
          case "ActionCall":
            // Resolved by the pre-pass above, which refuses the whole graph
            // when an action it names has no implementation. The structural
            // node address is durable dispatch identity, scoped to this one
            // implementation call; it never comes from fiber arrival order.
            return yield* implementations.get(ast.action)!.action(resolve(node.payload)).pipe(
              Effect.provideService(DispatchSite, node.id)
            )
          case "Succeed":
            return resolve(node.payload)
          case "Map": {
            const transform = Node.mapper(ast)!
            return transform(yield* settleNode(children[0]!))
          }
          case "All": {
            // `All` is a combination, so its members settle concurrently — the
            // same semantics `PlanScheduler` gives the same graph. Fail-fast
            // matches `Effect.forEach`'s default and the scheduler's halt
            // rule — with the ownership caveat: what a failure interrupts is
            // each sibling's JOIN, not the node execution itself, which the
            // interpretation owns and interrupts when the walk ends. A node
            // whose execution was interrupted is evicted from the memo and
            // records nothing, so it reports as skipped rather than as a
            // phantom success.
            const members = Object.keys(ast.nodes)
            const values = yield* Effect.forEach(members, (_, index) => settleNode(children[index]!), {
              concurrency: "unbounded"
            })
            const joined: Record<string, unknown> = Object.create(null) as Record<string, unknown>
            for (let index = 0; index < members.length; index++) {
              Object.defineProperty(joined, members[index]!, {
                configurable: true,
                enumerable: true,
                value: values[index],
                writable: true
              })
            }
            return joined
          }
          case "AndThen":
            return yield* settleNode(children[1]!)
          case "FlowCall": {
            if (ast.mode === "handoff") {
              const declaration = handoffDeclarations.get(node.id)!
              // DECIDED: a handoff target's schema
              // services come from the context registration captured. A
              // body's type cannot enumerate declarations hidden in its
              // topology, so erase only that dynamic service parameter after
              // resolving the concrete declaration here.
              const payload = yield* Effect.flatMap(
                Effect.orDie(declaration.payloadSchema.makeEffect(resolve(node.payload) as never)),
                (decoded) =>
                  Effect.orDie(
                    Schema.encodeEffect(Schema.toCodecJson(declaration.payloadSchema))(decoded)
                  )
              ) as unknown as Effect.Effect<unknown, never, Services>
              const outcome = {
                _tag: "To",
                flow: ast.flow,
                payload
              } satisfies Outcome.To<unknown>
              Object.defineProperty(outcome, OutcomeValueTypeId, {
                configurable: false,
                enumerable: false,
                value: "To",
                writable: false
              })
              return outcome
            }
            if (ast.mode === "boundary") {
              // The real boundary of `docs/guides/run-a-child-flow.md`: an
              // ordinary child execution, opened through the same `execute` a
              // handler would call. The parent's `FlowInstance` is in scope, so
              // the engine records the lineage edge, interrupts the child with
              // the parent, and turns a suspended child into a suspended
              // parent — genuine nesting, not a spliced imitation of it. It is
              // deliberately NOT `Effect.scoped`: the interrupt link the engine
              // installs is a finalizer of the PARENT's scope, and closing a
              // scope of our own here would run it the moment the child
              // settled. The same dynamic schema-service erasure the handoff
              // above records applies to the cast: a body's type cannot
              // enumerate the declarations hidden in its topology.
              const declaration = childDeclarations.get(node.id)!
              const instance = yield* FlowInstance
              const childPayload = resolve(node.payload)
              const executionId = yield* (childExecutionId(
                instance.executionId,
                node.id,
                declaration._tag,
                childPayload
              ) as unknown as Effect.Effect<string, never, Services>)
              return yield* (declaration.execute(childPayload, {
                executionId
              }) as Effect.Effect<unknown, unknown, Services>)
            }
            const spliced = children[0]
            if (spliced === undefined) {
              return yield* refuse(
                "unsupported_call",
                node.id,
                `Flow "${ast.flow}" is called at "${node.id}" as a leaf, which this interpreter does not drive. ` +
                  "An inline .call() is spliced into the graph with the callee's body and driven with it, and " +
                  "only a call that lost its declaration has no body to splice. Build and interpret the authored " +
                  `node in the same process, or call it as ${ast.flow}.child(payload) to run it as its own execution.`
              )
            }
            return yield* settleNode(spliced)
          }
        }
      }
    )

    // Closing the node scope on every exit — value, failure, or the
    // interpretation's own interruption — is the fail-fast half of the
    // ownership model: whatever is still running when the walk ends is
    // interrupted before the interpretation reports, so no execution
    // outlives it.
    const value = yield* settleNode(options.root ?? "root").pipe(
      Effect.onExit((exit) => Scope.close(nodes, exit))
    )
    return {
      value,
      settled,
      failed,
      skipped: Graph.nodes(graph).filter((node) => !settled.has(node.id) && !failed.has(node.id)).map((node) => node.id)
    }
  })

/**
 * Turns a body's root value into the settlement the engine acts on.
 *
 * Three of them exist, and only three
 * (`docs/concepts/trampoline-rounds.md`): `done(value)` is the answer, so the
 * value passes straight through; `Next.to(payload)` is the next round, recorded in the instance's
 * handoff slot so `Flow.intoResult` answers `Flow.Handoff`; and `park(reason)`
 * is a durable suspension, declared through the ordinary waiting vocabulary so
 * a durable driver parks the run under the flow's own reason and wake token
 * rather than the derived `timer`/`event` default. Anything else is an ordinary
 * value and is the answer as it stands, which is what keeps a body that never
 * heard of the trampoline working unchanged.
 *
 * @private
 */
const settleOutcome = (value: unknown): Effect.Effect<unknown, never, FlowInstance> => {
  if (!Outcome.isOutcome(value)) return Effect.succeed(value)
  switch (value._tag) {
    case "Done":
      return Effect.succeed(value.value)
    case "To":
      return Effect.flatMap(
        FlowInstance,
        (instance) =>
          Effect.sync(() => {
            instance.handoff = new Handoff({ flow: value.flow, payload: value.payload })
          })
      )
    case "Park":
      return Effect.andThen(
        annotateWaiting(value.reason),
        Effect.flatMap(FlowInstance, suspend)
      )
  }
}

/**
 * Registers a flow with the runtime, driven by its body.
 *
 * This is the only way a flow's behavior reaches the runtime, and the reason a
 * flow has no `toLayer`: a flow has one behavior and it is the body, so there
 * is no second, opaque one to attach. An Action is what carries an
 * implementation, and it attaches that implementation with its own `toLayer`.
 * Compose this beside the action implementation layers the body calls, over the
 * {@link module:Implementations.layerImplementations} table they file
 * themselves in — the table goes UNDER them, because filing happens while an
 * implementation layer is built:
 *
 * ```ts
 * Layer.mergeAll(Read.toLayer(read), Write.toLayer(write), Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * It accepts a flow whatever its requirement channel says, and requires only
 * the table. Registering a body is not running one: the handler installed here
 * resolves each call by tag when the run reaches it, which is the same thing a
 * driver does for a plan read back out of a journal. `Flow.execute` is where
 * the requirements are asked for.
 *
 * This low-level registration keeps the `process-local` callback policy for
 * compatibility. Select `callbackIdentity: "stable"`, or use
 * {@link layerWithImplementations}, to refuse unstable callbacks before
 * dispatch. Without that selection it makes no reproducible-plan guarantee.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = <
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  flow: Flow<Tag, Payload, Success, Error, any>,
  options: Graph.BuildOptions = {}
) => makeLayer(flow, options, false)

/** Registers one interpreter policy without changing the low-level compatibility surface. @private */
const makeLayer = <
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  flow: Flow<Tag, Payload, Success, Error, any>,
  options: Graph.BuildOptions,
  requireReusableVersions: boolean
): Layer.Layer<
  never,
  never,
  | FlowRuntime
  | Implementations
  | Payload["DecodingServices"]
  | Payload["EncodingServices"]
  | Success["DecodingServices"]
  | Success["EncodingServices"]
  | Error["DecodingServices"]
  | Error["EncodingServices"]
> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const runtime = yield* FlowRuntime
    yield* runtime.register(
      flow,
      ((payload: Payload["Type"]) =>
        Effect.flatMap(
          interpretWithPolicy(flow, payload, options, requireReusableVersions),
          (interpretation) => settleOutcome(interpretation.value)
        )) as (payload: Payload["Type"], executionId: string) => Effect.Effect<
          Success["Type"],
          Error["Type"],
          Crypto.Crypto | Implementations
        >
    )
  }))

/**
 * Composes one flow and its implementation layers around one isolated registry.
 *
 * The implementation layer must provide every action requirement carried by the
 * flow. Callback identity defaults to `stable`: raw callbacks are refused before
 * dispatch, with a diagnostic naming the callback and `Node.capture`. Captures
 * must cover semantic configuration and implementation versions, including
 * behavior reached through imports. Explicit `callbackIdentity: "process-local"`
 * is available for local experimentation, without a reproducible-plan claim.
 * Sealed actions with an idempotency key must declare `implementationVersion`
 * and register that exact version. This rule is independent of callback policy:
 * those declarations can reuse recorded content even if their code changes.
 * Keyless sealed actions use invocation identity; compensable and irreversible
 * actions do not use content-key caching. Their versions remain optional.
 * Versions must cover semantic handler and service changes; callback stability
 * cannot establish that declaration's completeness.
 *
 * The interpreter validates all named graph actions before dispatching any
 * of them. Conflicting registrations fail while the layer builds; use an explicit
 * `toLayer(handler, { override: true })` only for intentional scoped substitution.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithImplementations = <
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  Provided,
  E,
  R
>(
  flow: Flow<Tag, Payload, Success, Error, Requires>,
  implementations:
    & Layer.Layer<Provided, E, R>
    & (
      [NoInfer<Requires>] extends [Provided] ? unknown
        : { readonly missingActionImplementations: Exclude<Requires, Provided> }
    ),
  options: Graph.BuildOptions = {}
) =>
  Layer.merge(
    implementations,
    makeLayer(flow, { ...options, callbackIdentity: options.callbackIdentity ?? "stable" }, true)
  )
    .pipe(
      Layer.provide(Layer.fresh(layerImplementations))
    )
