/**
 * The run-parent insertion executed by the store and inspected by query-plan tests.
 *
 * @since 1.0.0
 */

import type { SqlClient } from "effect/sql/SqlClient"
import type { RunParentEdge } from "../DurableEngineState.ts"

/**
 * Inserts an edge with the next global sequence, preserving an existing pair.
 *
 * @category queries
 * @since 1.0.0
 */
export const insert = (sql: SqlClient, childId: string, parentId: string) =>
  // MAX(seq)+1 reads what has committed. Every writer of an edge holds its
  // child's partition and its parent's, or the whole schema, so the seq rises
  // along each child's edges and along each parent's, which is the order the
  // readers page by; two unrelated edges may share one.
  sql<RunParentEdge>`
    INSERT INTO flows_run_parents (child_id, parent_id, seq)
    SELECT ${childId}, ${parentId}, COALESCE(MAX(seq), 0) + 1
    FROM flows_run_parents
    WHERE TRUE
    ON CONFLICT (child_id, parent_id) DO NOTHING
    RETURNING
      child_id AS "childId",
      parent_id AS "parentId",
      seq AS "seq"
  `
