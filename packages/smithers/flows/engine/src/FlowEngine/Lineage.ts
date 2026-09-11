/**
 * Journal lineage identity for a running flow.
 *
 * A frame in `docs/specs/Concepts/Time Travel.md` is a journal position
 * `(lineageId, seq)`, and `docs/specs/Concepts/Subflows.md` defines the
 * lineage id as "the run id followed by the node-id path from the run root".
 * The engine is where that identity is minted, because the engine is what
 * knows the run and the node path; every durable record a run writes carries
 * the result as `meta.lineageId`.
 *
 * A subflow is a **separate run** with its own journal, so its records address
 * its own root lineage and the two lineages are joined by a lineage edge
 * rather than by a shared id. The node path therefore only ever grows inside
 * one run, and today no engine node contributes a segment, so only
 * {@link root} is exported. A path constructor returns with the node that
 * contributes the first segment.
 *
 * Two different ids in this tree are called a lineage, and this is the JOURNAL
 * one. What {@link module:Round.Round} carries as `rootExecutionId`, and what
 * `RunStore` persists in the `lineage_id` column, is the TRAMPOLINE lineage of
 * `docs/specs/Concepts/Trampoline Loops.md`: round 0's execution id, naming the
 * chain of round executions rather than a journal position. The shapes differ
 * — a journal lineage id is a versioned encoded tuple, while a trampoline one
 * is a bare execution id — so a value from one space is not an
 * address in the other, and `meta.lineageId` on an engine record means this
 * space. Each space carries its own brand, so the compiler refuses a swap.
 *
 * @since 0.1.0
 */

declare const JournalLineageIdTypeId: unique symbol

/**
 * An injective journal address minted from one run and node path.
 *
 * @category models
 * @since 1.0.0
 */
export type JournalLineageId = string & { readonly [JournalLineageIdTypeId]: typeof JournalLineageIdTypeId }

/**
 * The lineage id of a run's root node: the tuple of the run id and an empty
 * node path.
 *
 * @since 0.1.0
 * @category constructors
 */
export const root = (runId: string): JournalLineageId =>
  `smithers-journal-lineage/v1:${JSON.stringify([runId])}` as JournalLineageId
