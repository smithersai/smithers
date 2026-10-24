import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import type { SandboxBranch } from "../branch/Sandboxes.ts"

// The machine a TODO's attempt works on (decision 0016, the factory simplified): its own branch machine, one per attempt
// (`todo-<attemptId>`), checking out the attempt's branch on GitHub, the TODO's branch, and running each tool as the
// person who committed the TODO. The `todo` run's steps, its agent's tools and the checks on its head all reach it here.
// Its branch says `forge: "github"`: `todo/Begin` makes the branch on GitHub, so the machine reads it there even where the
// deployment's forge is the Code Storage mirror, which never has it (worker/branch/Forge.ts `forgeOf`).

/** An attempt's machine: the branch it serves, and the person its tools run as. */
export interface TodoMachine {
  readonly branch: SandboxBranch
  readonly ownerId: string
}

/** Attempt `attemptId`'s machine: its branch machine's id. */
export const machineId = (attemptId: string): string => `todo-${attemptId}`

/** The machine of `repoId`'s attempt `attemptId` on `branch`, run as `ownerId`. */
export const machineOf = (options: {
  readonly attemptId: string
  readonly repoId: string
  readonly branch: string
  readonly ownerId: string
}): TodoMachine => {
  const [owner = "", name = ""] = options.repoId.replace(/^github\//, "").split("/")
  return {
    branch: { branchId: machineId(options.attemptId), owner, name, branch: options.branch, forge: "github" },
    ownerId: options.ownerId,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The machine of the `todo` run whose execution is `executionId`, once its branch is made: `None` for any other run, or
 * an attempt with no branch yet. Reads only.
 */
export const ofExecution = (executionId: string) =>
  Effect.gen(function* () {
    const attemptId = executionId.slice("todo:".length)
    if (todoExecutionId(attemptId) !== executionId || !UUID.test(attemptId)) return Option.none<TodoMachine>()
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly repoId: string; readonly branch: string | null; readonly ownerId: string }>`
      SELECT t.repo_id AS "repoId", t.branch, t.created_by AS "ownerId"
      FROM todo_attempts a JOIN todos t ON t.id = a.todo_id WHERE a.id = ${attemptId}::uuid`
    if (row === undefined || row.branch === null) return Option.none<TodoMachine>()
    return Option.some(machineOf({ attemptId, repoId: row.repoId, branch: row.branch, ownerId: row.ownerId }))
  })

/**
 * The person a `todo` run's execution is for: who committed its TODO, so their own model answers its agent
 * (docs/features/personal-model.md#todo-runs). `None` for any other run. Reads only.
 */
export const ownerOf = (executionId: string) =>
  Effect.gen(function* () {
    const attemptId = executionId.slice("todo:".length)
    if (todoExecutionId(attemptId) !== executionId || !UUID.test(attemptId)) return Option.none<string>()
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly ownerId: string }>`
      SELECT t.created_by AS "ownerId" FROM todo_attempts a JOIN todos t ON t.id = a.todo_id WHERE a.id = ${attemptId}::uuid`
    return Option.fromNullishOr(row?.ownerId)
  })
