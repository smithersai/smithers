import type { SqlClient, Statement } from "effect/sql"
import type { Kind } from "./Fleet.ts"

/** Current readers of each fleet incident, besides a run's committer where allowed. */
export const AUDIENCE: Readonly<Record<Kind, { readonly role: "maintainer" | "admin"; readonly committer: boolean }>> = {
  failed: { role: "maintainer", committer: true },
  stalled: { role: "maintainer", committer: true },
  waiting: { role: "maintainer", committer: false },
  cost: { role: "admin", committer: true },
  offline: { role: "admin", committer: false },
}

/** A stored fleet subject's current role/committer audience, in its caller's authority snapshot. */
export const permits = (sql: SqlClient.SqlClient, fields: {
  readonly role: Statement.Fragment
  readonly recipient: Statement.Fragment
  readonly subject: Statement.Fragment
  readonly repoId: Statement.Fragment
}): Statement.Fragment => sql`(
  ${fields.role} IN ('member', 'maintainer', 'admin') AND (
    ${fields.role} = 'admin' OR EXISTS (
      SELECT 1 FROM fleet_alerts alert
      LEFT JOIN todo_attempts attempt ON alert.kind = 'failed' AND attempt.id::text = alert.subject
      LEFT JOIN agent_runs run ON alert.kind <> 'failed' AND run.key = alert.subject AND run.repo_id = alert.repo_id
      LEFT JOIN todos todo ON todo.id = CASE WHEN alert.kind = 'failed' THEN attempt.todo_id ELSE run.todo_id END
        AND todo.repo_id = alert.repo_id
      WHERE 'fleet:' || alert.id = ${fields.subject} AND alert.repo_id = ${fields.repoId}
        AND ((${fields.role} = 'maintainer' AND (${JSON.stringify(AUDIENCE)}::jsonb -> alert.kind ->> 'role') = 'maintainer')
          OR ((${JSON.stringify(AUDIENCE)}::jsonb -> alert.kind ->> 'committer')::boolean AND todo.created_by = ${fields.recipient}))
    )
  )
)`
