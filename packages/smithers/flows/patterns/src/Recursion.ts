/**
 * Trellis-style bounded recursive expansion declarations.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import type { Node as FlowNode } from "@smthrs/core/Node"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Parent-supplied recursion envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface Envelope {
  readonly fuel: number
  readonly depth: number
  readonly fanout: number
}

/**
 * Configuration accepted by {@link recurse}.
 *
 * `child` is the only collaborator. Bounds may be narrowed by nested calls;
 * they may never exceed the parent envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface RecurseOptions extends Envelope {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly child: Flow.Any
  readonly parent?: Envelope | undefined
}

/**
 * A recursively expanded input branch.
 *
 * @category models
 * @since 0.1.0
 */
export interface Branch {
  readonly input: unknown
  readonly children?: ReadonlyArray<Branch> | undefined
}

const valid = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const boundError = (message: string): never => {
  throw new PatternError({ code: "recursion_bound", message })
}

/**
 * Validates and returns an envelope-bounded recursive tree flow.
 *
 * A plain input is a leaf. A `{ input, children }` branch expands recursively:
 * fuel is shared by the whole tree, depth is decremented per level, and every
 * child list is checked against fan-out before any child is admitted.
 * Very large depth and fan-out bounds build a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recurse = (options: RecurseOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const envelope = { fuel: options.fuel, depth: options.depth, fanout: options.fanout }
  const child = options.child
  if (!valid(envelope.fuel) || !valid(envelope.depth) || !valid(envelope.fanout)) {
    return boundError("Recursion bounds must be positive safe integers")
  }
  const parent = options.parent
  if (parent !== undefined) {
    for (const field of ["fuel", "depth", "fanout"] as const) {
      if (!valid(parent[field])) {
        return boundError(
          `Recursion parent ${field} must be a positive safe integer, received ${parent[field]}`
        )
      }
    }
    if (
      envelope.fuel > parent.fuel ||
      envelope.depth > parent.depth ||
      envelope.fanout > parent.fanout
    ) {
      return boundError("Nested recursion may attenuate but cannot widen its parent envelope")
    }
  }
  const { name, description } = Compose.label("recurse", {
    fuel: envelope.fuel,
    depth: envelope.depth,
    fanout: envelope.fanout
  }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [child],
    body: Node.capture({ depth: envelope.depth, fanout: envelope.fanout, fuel: envelope.fuel }, (input) => {
      if (typeof input === "function") {
        return boundError("Recursion input must be a literal tree available while planning")
      }
      const ledger = { remaining: envelope.fuel }
      const visit = (
        value: unknown,
        depth: number
      ): FlowNode<unknown, unknown> => {
        if (ledger.remaining < 1) return boundError("Recursion fuel is exhausted")
        const branch: Branch = typeof value === "object" && value !== null && Object.hasOwn(value, "input")
          ? value as unknown as Branch
          : { input: value }
        let children: ReadonlyArray<Branch> = []
        if (Object.hasOwn(branch, "children")) {
          const declaredChildren = (branch as { readonly children?: unknown }).children
          if (!Array.isArray(declaredChildren)) {
            return boundError(
              `Recursive branch children must be an array when present, received ${typeof declaredChildren}`
            )
          }
          children = declaredChildren as ReadonlyArray<Branch>
        }
        if (children.length > envelope.fanout) {
          return boundError("Recursive child fan-out exceeds the envelope")
        }
        if (children.length > 0 && depth <= 1) {
          return boundError("Recursive child depth exceeds the envelope")
        }
        ledger.remaining--
        const current = (child as unknown as (
          input: unknown
        ) => FlowNode<unknown, unknown>)({
          input: branch.input,
          envelope: {
            fuel: ledger.remaining,
            depth: depth - 1,
            fanout: envelope.fanout
          }
        })
        if (children.length === 0) return current
        return Node.andThen(
          current,
          Node.capture({ depth }, () => {
            const members: Record<string, FlowNode<unknown, unknown>> = {}
            children.forEach((child, index) => {
              members[`child-${index}`] = visit(child, depth - 1)
            })
            return Node.all(members)
          })
        )
      }
      return visit(input, envelope.depth)
    })
  })
}
