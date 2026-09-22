/**
 * Read-only plan introspection types.
 *
 * @since 0.0.0
 */

/**
 * A serializable projection of a node's placement directive: the placement
 * tag plus its option payload (image/profile/target style host selection).
 *
 * @since 0.0.0
 * @category models
 */
export interface PlanPlacementLike {
  readonly tag: string
  readonly options: Readonly<Record<string, unknown>>
}

/**
 * One plan node, in the shape the plan assertions read.
 *
 * The fields mirror what `@smthrs/flow`'s `Graph.GraphNode` carries. A
 * conflict strategy and an inherited envelope are not among them: write
 * overlap is `Plan.compile`'s verdict, and an effect envelope is a build-time
 * ceiling `Graph.build` checks a declaration against rather than a fact it
 * records on a node.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanNodeLike {
  readonly id: string
  readonly key: string
  readonly kind: string
  readonly placement?: PlanPlacementLike
  /** Declared `read:` / `write:` / `remove:` entries from fromGraph; empty when undeclared. */
  readonly effects: ReadonlyArray<string>
  /** Boundary mode from the node's own effect declaration, absent when undeclared (`hard` | `expected`). */
  readonly mode?: string
  /** The tier the node is keyed under (`sealed` | `compensable` | `irreversible`). */
  readonly tier: string
  readonly sealed: boolean
}

/**
 * A compiled plan, in the shape the plan assertions read.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanLike {
  readonly nodes: ReadonlyArray<PlanNodeLike>
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>
  readonly envelope?: Record<string, unknown>
  readonly digest?: string
}
