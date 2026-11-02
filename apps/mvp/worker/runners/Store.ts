import { AgentRunner } from "@smthrs/agent"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Fence from "./Fence.ts"

// The runner and agent tables an Admin writes (db/migrations/0078_agent_runners.ts, docs/features/agent-runners.md):
// each write runs in one transaction with its change record, once per invocation key, so a step run again writes once.
// Nothing here reads a token: a runner is registered by its token's SHA-256.

/**
 * One Admin write, made under the step's invocation key by `actorId`, and, from an Admin route, the fence it was
 * admitted with (`fenced`, worker/runners/Fence.ts): its authority, expiry and resource generation are checked in the
 * write's transaction, and its receipt recorded. Without one (a test's or the store's own write) nothing is checked.
 */
export interface By {
  readonly actorId: string
  readonly invocationKey: string
  readonly fenced?: Fenced | undefined
}

/** A write's fence, and the action its receipt names. */
export interface Fenced {
  readonly fence: Fence.Fence
  readonly kind: "runners" | "agents" | "overflow"
  readonly op: "put" | "delete"
}

/** A runner as an Admin registers it. */
export interface RunnerWrite {
  readonly repoId: string
  readonly name: string
  readonly tokenSha256: string
  readonly labels: ReadonlyArray<string>
  readonly capacity: number
  /**
   * Whether the route that admitted the write took the Admin role GitHub gives on the repository (decision 0148). A
   * write without it registers the runner unauthorized: it claims nothing until an Admin registers it again.
   */
  readonly repoAuthorized: boolean
}

/** An agent as an Admin sets it: its settings, and whether it is the repository's coding agent. */
export interface AgentWrite {
  readonly repoId: string
  readonly agent: AgentRunner.Agent
  readonly coding: boolean
}

/**
 * What a write did: changed the table now, nothing again (`repeat`), or nothing because its fence refused it
 * (`authorization_expired`, `superseded`: Fence.ts).
 */
export type Change = "set" | "removed" | "missing" | "repeat" | Fence.Refused

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

/** The key of a runner's or agent's generation (`admin_generations`). */
export const resourceKey = (table: "runners" | "agents", repoId: string, name: string) => `${table}:${repoId}:${name}`

/** The key of the generation of a repository's coding selection: which agent, if any, TODOs code with. */
export const codingKey = (repoId: string) => `coding:${repoId}`

/** The generation under `key`: 0 when nothing was ever written there. What a route admits an action against. */
export const generationOf = (key: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly generation: string }>`SELECT generation::text AS generation FROM admin_generations WHERE key = ${key}`,
      (rows) => rows[0] === undefined ? 0 : Number(rows[0].generation),
    ))

/** Bumps the generation under `key`: every write of the resource does, fenced or not. */
const bump = (key: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO admin_generations (key, generation) VALUES (${key}, 1)
      ON CONFLICT (key) DO UPDATE SET generation = admin_generations.generation + 1`)

/**
 * Takes each of `keys`' transaction locks, in order: a resource not written yet serializes too, so two first writes of
 * one name can't both be admitted against generation 0. Every write takes its resource's key, then the coding key.
 */
const lockKeys = (keys: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(keys, (key) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`, { discard: true }))

/**
 * Inside a write's transaction, before it writes, its keys locked first (`keys`: the resource's, then the coding
 * selection's when the write may change it). Unfenced, `repeat` when this invocation already wrote. Fenced: a replay of
 * the same action answers the outcome already recorded under its execution; else its authority and expiry are checked
 * (`authorization_expired`), then the generations against those it was admitted at (`superseded`), each refusal
 * recorded as the action's receipt; else `admitted`.
 */
const admit = (
  table: "runners" | "agents",
  repoId: string,
  name: string,
  by: By,
  coding: "compare" | "ignore",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const resource = resourceKey(table, repoId, name)
    yield* lockKeys(coding === "compare" ? [resource, codingKey(repoId)] : [resource])
    if (by.fenced === undefined) {
      const [done] = table === "runners"
        ? yield* sql`SELECT 1 FROM runner_changes WHERE invocation_key = ${by.invocationKey}`
        : yield* sql`SELECT 1 FROM agent_changes WHERE invocation_key = ${by.invocationKey}`
      return done !== undefined ? "repeat" as const : "admitted" as const
    }
    const { fence, kind, op } = by.fenced
    const before = yield* Fence.recorded(fence.execution)
    if (before !== undefined) return before
    // The rows the write changes, locked before anything is judged: runner activity locks a runner's row without the
    // resource's key, so a write that checked first could wait on it past its fence and write after.
    yield* lockRows(table, repoId, name)
    const refuse = (outcome: Fence.Refused) =>
      Effect.as(Fence.receipt(fence.execution, { repoId, kind, name }, op, outcome, by.actorId), outcome)
    if (!(yield* Fence.authorityHolds(fence))) return yield* refuse("authorization_expired")
    if ((yield* generationOf(resource)) !== fence.generation) return yield* refuse("superseded")
    if (coding === "compare" && (yield* generationOf(codingKey(repoId))) !== (fence.coding ?? 0)) {
      return yield* refuse("superseded")
    }
    // Any lock the write still waits on gives up at the fence's expiry: the transaction fails, and the step's retry is
    // refused `authorization_expired`.
    yield* Fence.untilExpiry(fence)
    return "admitted" as const
  })

/**
 * Locks the rows a write of `table`'s `name` changes: the runner's row; or every agent of the repository, since making
 * one the coding agent clears it on the others.
 */
const lockRows = (table: "runners" | "agents", repoId: string, name: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    table === "runners"
      ? sql`SELECT 1 FROM runners WHERE repo_id = ${repoId} AND name = ${name} FOR UPDATE`
      : sql`SELECT 1 FROM agents WHERE repo_id = ${repoId} FOR UPDATE`)

/**
 * Inside a write's transaction that does more than `Store`'s own write (`Overflow.set`, `Overflow.remove`): the
 * resource's key locked, and the outcome already recorded under the write's execution when this is a replay of it,
 * which the caller answers with before it changes anything. None unfenced, or for an action not done yet.
 */
export const replayed = (table: "runners" | "agents", repoId: string, name: string, by: By) =>
  by.fenced === undefined
    ? Effect.succeed(undefined)
    : Effect.andThen(lockKeys([resourceKey(table, repoId, name)]), Fence.recorded(by.fenced.fence.execution))

/** Records a write's change once: `repeat` when this invocation already did, which the caller answers with. */
const once = (table: "runner_changes" | "agent_changes", op: string, repoId: string, name: string, by: By) =>
  Effect.map(record(table, op, repoId, name, by), (recorded) => recorded ? "recorded" as const : "repeat" as const)

/** Records a fenced write's receipt: how it changed the table. */
const written = <C extends "set" | "removed" | "missing">(repoId: string, name: string, by: By, change: C) =>
  by.fenced === undefined
    ? Effect.succeed(change)
    : Effect.as(
      Fence.receipt(by.fenced.fence.execution, { repoId, kind: by.fenced.kind, name }, by.fenced.op, change, by.actorId),
      change,
    )

/**
 * Registers runner `write.name` on its repository with its token's SHA-256, labels and capacity. Adding a name again
 * replaces them and brings a removed runner back; its old token is refused from then on. The runner is marked
 * authorized (`repo_authorized_at`, decision 0148) only when `write.repoAuthorized` says the route took the Admin role
 * GitHub gives on the repository; else it is cleared. Fenced, only as `admit` allows.
 */
export const addRunner = (write: RunnerWrite, by: By): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      const admitted = yield* admit("runners", write.repoId, write.name, by, "ignore")
      if (admitted !== "admitted") return admitted
      if ((yield* once("runner_changes", "add", write.repoId, write.name, by)) === "repeat") return "repeat" as const
      yield* sql`
        INSERT INTO runners (repo_id, name, labels, capacity, token_sha256, added_by, repo_authorized_at)
        VALUES (${write.repoId}, ${write.name}, ARRAY(SELECT jsonb_array_elements_text(${textArray(write.labels)}::jsonb)),
          ${write.capacity}, ${write.tokenSha256}, ${by.actorId}, CASE WHEN ${write.repoAuthorized}::boolean THEN now() END)
        ON CONFLICT (repo_id, name) DO UPDATE SET labels = EXCLUDED.labels, capacity = EXCLUDED.capacity,
          token_sha256 = EXCLUDED.token_sha256, added_by = EXCLUDED.added_by, added_at = now(), seen_at = NULL,
          removed_at = NULL, repo_authorized_at = EXCLUDED.repo_authorized_at`
      yield* bump(resourceKey("runners", write.repoId, write.name))
      return yield* written(write.repoId, write.name, by, "set")
    })))

/** Retires runner `name`: its token is refused from now on. Its jobs keep their rows. Fenced, only as `admit` allows. */
export const removeRunner = (
  write: { readonly repoId: string; readonly name: string },
  by: By,
): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      const admitted = yield* admit("runners", write.repoId, write.name, by, "ignore")
      if (admitted !== "admitted") return admitted
      if ((yield* once("runner_changes", "remove", write.repoId, write.name, by)) === "repeat") return "repeat" as const
      const rows = yield* sql`
        UPDATE runners SET removed_at = now()
        WHERE repo_id = ${write.repoId} AND name = ${write.name} AND removed_at IS NULL RETURNING id`
      yield* bump(resourceKey("runners", write.repoId, write.name))
      return yield* written(write.repoId, write.name, by, rows.length > 0 ? "removed" : "missing")
    })))

/** The repository's coding agent's name, if any. */
const codingName = (repoId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(sql<{ readonly name: string }>`SELECT name FROM agents WHERE repo_id = ${repoId} AND coding`, (rows) =>
      rows[0]?.name))

/**
 * Sets agent `write.agent.name` on its repository; made the coding agent, it takes that from any other. A write that
 * changes which agent TODOs code with bumps the coding selection's generation. Fenced, only as `admit` allows, the
 * coding selection's generation included.
 */
export const setAgent = (write: AgentWrite, by: By): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      const { agent } = write
      const admitted = yield* admit("agents", write.repoId, agent.name, by, "compare")
      if (admitted !== "admitted") return admitted
      if ((yield* once("agent_changes", "set", write.repoId, agent.name, by)) === "repeat") return "repeat" as const
      const coding = yield* codingName(write.repoId)
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
      yield* bump(resourceKey("agents", write.repoId, agent.name))
      if ((yield* codingName(write.repoId)) !== coding) yield* bump(codingKey(write.repoId))
      return yield* written(write.repoId, agent.name, by, "set")
    })))

/**
 * Removes agent `name`; a repository whose coding agent it was codes with Smithers' own again. Its generation stays,
 * so an action admitted before the removal never writes the agent added again in its name. Fenced, only as `admit`
 * allows, the coding selection's generation included.
 */
export const removeAgent = (
  write: { readonly repoId: string; readonly name: string },
  by: By,
): Effect.Effect<Change, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      const admitted = yield* admit("agents", write.repoId, write.name, by, "compare")
      if (admitted !== "admitted") return admitted
      if ((yield* once("agent_changes", "remove", write.repoId, write.name, by)) === "repeat") return "repeat" as const
      const rows = yield* sql<{ readonly coding: boolean }>`
        DELETE FROM agents WHERE repo_id = ${write.repoId} AND name = ${write.name} RETURNING coding`
      yield* bump(resourceKey("agents", write.repoId, write.name))
      if (rows[0]?.coding === true) yield* bump(codingKey(write.repoId))
      return yield* written(write.repoId, write.name, by, rows.length > 0 ? "removed" : "missing")
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
