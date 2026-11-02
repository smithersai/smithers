import { AgentRunner } from "@smthrs/agent"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

// The runner and agent tables an Admin writes (db/migrations/0078_agent_runners.ts, docs/features/agent-runners.md):
// each write runs in one transaction with its change record, once per invocation key, so a step run again writes once.
// Nothing here reads a token: a runner is registered by its token's SHA-256.

/** One Admin write, made under the step's invocation key by `actorId`. */
export interface By {
  readonly actorId: string
  readonly invocationKey: string
}

/** A runner as an Admin registers it. */
export interface RunnerWrite {
  readonly repoId: string
  readonly name: string
  readonly tokenSha256: string
  readonly labels: ReadonlyArray<string>
  readonly capacity: number
}

/** An agent as an Admin sets it: its settings, and whether it is the repository's coding agent. */
export interface AgentWrite {
  readonly repoId: string
  readonly agent: AgentRunner.Agent
  readonly coding: boolean
}

/** What a write did: changed the table now, or nothing again (`repeat`). */
export type Change = "set" | "removed" | "missing" | "repeat"

const textArray = (values: ReadonlyArray<string>) => JSON.stringify(values)

/** Records change `op` once: whether this call recorded it. */
const record = (table: "runner_changes" | "agent_changes", op: string, repoId: string, name: string, by: By) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      table === "runner_changes"
        ? sql`
          INSERT INTO runner_changes (invocation_key, repo_id, name, op, changed_by)
          VALUES (${by.invocationKey}, ${repoId}, ${name}, ${op}, ${by.actorId})
          ON CONFLICT (invocation_key) DO NOTHING RETURNING invocation_key`
        : sql`
          INSERT INTO agent_changes (invocation_key, repo_id, name, op, changed_by)
          VALUES (${by.invocationKey}, ${repoId}, ${name}, ${op}, ${by.actorId})
          ON CONFLICT (invocation_key) DO NOTHING RETURNING invocation_key`,
      (rows) => rows.length > 0,
    ))

/**
 * Registers runner `write.name` on its repository with its token's SHA-256, labels and capacity. Adding a name again
 * replaces them and brings a removed runner back; its old token is refused from then on. The Admin route admitted the
 * write by the role GitHub gives on the repository, so the runner is marked authorized there (`repo_authorized_at`,
 * decision 0148): only such a runner is handed a git credential.
 */
export const addRunner = (write: RunnerWrite, by: By): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      if (!(yield* record("runner_changes", "add", write.repoId, write.name, by))) return "repeat" as const
      yield* sql`
        INSERT INTO runners (repo_id, name, labels, capacity, token_sha256, added_by, repo_authorized_at)
        VALUES (${write.repoId}, ${write.name}, ARRAY(SELECT jsonb_array_elements_text(${textArray(write.labels)}::jsonb)),
          ${write.capacity}, ${write.tokenSha256}, ${by.actorId}, now())
        ON CONFLICT (repo_id, name) DO UPDATE SET labels = EXCLUDED.labels, capacity = EXCLUDED.capacity,
          token_sha256 = EXCLUDED.token_sha256, added_by = EXCLUDED.added_by, added_at = now(), seen_at = NULL,
          removed_at = NULL, repo_authorized_at = now()`
      return "set" as const
    })))

/** Retires runner `name`: its token is refused from now on. Its jobs keep their rows. */
export const removeRunner = (
  write: { readonly repoId: string; readonly name: string },
  by: By,
): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      if (!(yield* record("runner_changes", "remove", write.repoId, write.name, by))) return "repeat" as const
      const rows = yield* sql`
        UPDATE runners SET removed_at = now()
        WHERE repo_id = ${write.repoId} AND name = ${write.name} AND removed_at IS NULL RETURNING id`
      return rows.length > 0 ? "removed" as const : "missing" as const
    })))

/** Sets agent `write.agent.name` on its repository; made the coding agent, it takes that from any other. */
export const setAgent = (write: AgentWrite, by: By): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      const { agent } = write
      if (!(yield* record("agent_changes", "set", write.repoId, agent.name, by))) return "repeat" as const
      if (write.coding) {
        yield* sql`UPDATE agents SET coding = false WHERE repo_id = ${write.repoId} AND coding AND name <> ${agent.name}`
      }
      yield* sql`
        INSERT INTO agents (repo_id, name, labels, profile, max_hours, restarts, coding, updated_by)
        VALUES (${write.repoId}, ${agent.name}, ARRAY(SELECT jsonb_array_elements_text(${textArray(agent.labels)}::jsonb)),
          ${agent.profile}, ${agent.maxHours}, ${agent.restarts}, ${write.coding}, ${by.actorId})
        ON CONFLICT (repo_id, name) DO UPDATE SET labels = EXCLUDED.labels, profile = EXCLUDED.profile,
          max_hours = EXCLUDED.max_hours, restarts = EXCLUDED.restarts, coding = EXCLUDED.coding,
          updated_by = EXCLUDED.updated_by, updated_at = now()`
      return "set" as const
    })))

/** Removes agent `name`; a repository whose coding agent it was codes with Smithers' own again. */
export const removeAgent = (
  write: { readonly repoId: string; readonly name: string },
  by: By,
): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      if (!(yield* record("agent_changes", "remove", write.repoId, write.name, by))) return "repeat" as const
      const rows = yield* sql`DELETE FROM agents WHERE repo_id = ${write.repoId} AND name = ${write.name} RETURNING name`
      return rows.length > 0 ? "removed" as const : "missing" as const
    })))

const decodeAgent = Schema.decodeUnknownEffect(AgentRunner.Agent)

/** Agent `name` of repository `repoId`, once its write landed: its name and whether TODOs code with it. */
export const agent = (repoId: string, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly name: string; readonly coding: boolean }>`
      SELECT name, coding FROM agents WHERE repo_id = ${repoId} AND name = ${name}`
    return Option.fromNullishOr(row)
  })

/** Repository `repoId`'s coding agent, or none when it codes with Smithers' own. A row the schema refuses dies. */
export const codingAgent = (repoId: string): Effect.Effect<Option.Option<AgentRunner.Agent>, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<Record<string, unknown>>`
      SELECT name, labels, profile, max_hours AS "maxHours", restarts FROM agents WHERE repo_id = ${repoId} AND coding`
    if (row === undefined) return Option.none()
    return Option.some(yield* Effect.orDie(decodeAgent(row)))
  })
