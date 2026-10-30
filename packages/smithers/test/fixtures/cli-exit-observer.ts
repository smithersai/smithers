/** Safe process-lifetime receipts for a CLI that exits before returning its document. */
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isMainThread, threadId } from "node:worker_threads"

const directory = process.env.SMITHERS_TEST_CLI_EXIT_DIR
const root = directory === undefined ? process.cwd() : dirname(dirname(directory))
const failureCode = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error ? String(error.code) : "diagnostic_failed"

const read = (name: string) => {
  const filename = join(root, ".flows", name)
  if (!existsSync(filename)) return { present: false }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(filename, { readOnly: true })
    const executions = database.prepare(`
      SELECT run_id, status, owner_pid, cancel_requested_at_ms, waiting_reason,
             json_extract(state_json, '$.result._tag') AS result_tag
      FROM flows_runs
      WHERE json_extract(state_json, '$.flowName') IS NOT 'smithers/health/Discovery'
      ORDER BY run_id LIMIT 32
    `).all()
    const events = database.prepare(`
      SELECT run_id, seq, event_type,
             json_extract(payload_json, '$.decision') AS decision,
             json_extract(payload_json, '$.fault.tag') AS fault_tag,
             json_extract(payload_json, '$.fault.class') AS fault_class
      FROM flows_journal_events
      WHERE run_id = 'run-2'
        AND event_type IN ('control.run.failed', 'control.run.completed', 'control.run.claimed',
                           'control.run.resume', 'control.run.resumed', 'flows.engine.run-decision')
      ORDER BY seq DESC LIMIT 16
    `).all()
    const lifetime = database.prepare(`
      SELECT json_extract(payload_json, '$.stages') AS stages,
             json_extract(payload_json, '$.endedAtMs') AS ended_at_ms
      FROM flows_journal_events
      WHERE event_type = 'flows.host.lifetime.v1' AND json_extract(payload_json, '$.pid') = ?
      ORDER BY seq DESC LIMIT 1
    `).all(process.pid)
    return { executions, events, lifetime }
  } catch (error) {
    return { error: failureCode(error) }
  } finally {
    database?.close()
  }
}

/** Stage names only: never command arguments, model input or service payloads. */
export const recordStage = (stage: string, spanId?: string): void => {
  if (directory === undefined) return
  try {
    mkdirSync(directory, { recursive: true })
    appendFileSync(
      join(directory, `${process.pid}.jsonl`),
      `${
        JSON.stringify({
          stage,
          threadId,
          isMainThread,
          ...(spanId === undefined ? {} : { spanId }),
          elapsedMs: Math.round(performance.now())
        })
      }\n`
    )
  } catch { /* Diagnostics cannot change the command outcome. */ }
}

if (directory !== undefined) {
  const record = (stage: string, code: number) => {
    if (code === 0) return
    try {
      mkdirSync(directory, { recursive: true })
      appendFileSync(
        join(directory, `${process.pid}.jsonl`),
        `${
          JSON.stringify({
            stage,
            code,
            pid: process.pid,
            threadId,
            isMainThread,
            workspaceChanged: process.cwd() !== root,
            resources: process.getActiveResourcesInfo(),
            control: read("control.db"),
            engine: read("engine.db")
          })
        }\n`
      )
    } catch { /* A diagnostic must not replace the process's outcome. */ }
  }
  process.once("beforeExit", (code) => record("beforeExit", code))
  process.once("exit", (code) => record("exit", code))
}
