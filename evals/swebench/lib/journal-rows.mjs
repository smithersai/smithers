/**
 * Reads one archived run's journal rows, wherever the CLI wrote them.
 *
 *   import { journalRows } from "./lib/journal-rows.mjs"
 *   const rows = journalRows("journals/<id>/engine.db", ["control.agent.model-settled"])
 *
 * A run journals into two databases beside each other: `engine.db` holds the
 * engine's own events (attempts, snapshots, `flows.time-travel.*` effect
 * boundaries) and `control.db` holds the control plane's, which is where every
 * `control.agent.*` event now lands. Older runs wrote everything into
 * `engine.db`. A reader handed only `engine.db` therefore sees a current run
 * as a run with no frames and no model calls: `run-cost.mjs` reported $0 and
 * `fullbench-instance.sh` failed every instance as "no model call served".
 *
 * `control.*` rows are taken from `control.db` when it carries any, and from
 * `engine.db` otherwise, so a legacy journal and a current one read the same
 * and a run journaled into both is never counted twice. Every other row comes
 * from `engine.db`. The two sequences are merged by `emitted_at_ms`, keeping
 * each database's own `seq` order, because each database numbers `seq` on its
 * own and the numbers are not comparable across them.
 *
 * @since 0.1.0
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const select = (path, where) => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare(
      `select seq, emitted_at_ms, event_type, payload_json from flows_journal_events where ${where} order by seq`
    ).all()
  } finally {
    database.close()
  }
}

/**
 * Rows of the run's journal whose `event_type` matches `where` (an SQL
 * predicate over `event_type`), `control.db` included, in emission order.
 *
 * @param {string} databasePath the archived `engine.db`
 * @param {string} where an SQL predicate over the `event_type` column
 */
export const journalRows = (databasePath, where) => {
  const engine = select(databasePath, `(${where})`)
  const controlPath = join(dirname(databasePath), "control.db")
  if (!existsSync(controlPath)) return engine
  let control
  try {
    control = select(controlPath, `(${where}) and event_type like 'control.%'`)
  } catch {
    // A control database with no events table is one the run never wrote to.
    return engine
  }
  if (control.length === 0) return engine
  const rest = engine.filter((row) => !row.event_type.startsWith("control."))
  const merged = []
  let i = 0
  let j = 0
  while (i < rest.length || j < control.length) {
    if (j >= control.length || (i < rest.length && rest[i].emitted_at_ms <= control[j].emitted_at_ms)) {
      merged.push(rest[i++])
    } else {
      merged.push(control[j++])
    }
  }
  return merged
}
