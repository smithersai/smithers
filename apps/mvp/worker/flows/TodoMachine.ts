import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import type { SandboxBranch } from "../branch/Sandboxes.ts"

// The machine a TODO's attempt works on (decision 0016, the factory simplified): its own branch machine, one per attempt
// (`todo-<attemptId>`), checking out the attempt's base commit, and running each tool as the person who committed the
// TODO. The `todo` run's steps and its agent's tools reach it here.
// It checks out the base commit alone, detached, as a CI job's machine does (worker/branch/Checkout.ts): `todo/Begin`
// only reserves the branch's name, and `todo/Publish` creates the branch on GitHub with its one commit, so while the
// agent works the branch exists nowhere (ruling GH-11). Its branch says `forge: "github"`: the base is the head of the
// default branch or of the TODO below's published branch, read from GitHub, which the Code Storage mirror may not have
// yet (worker/branch/Forge.ts `forgeOf`).

/** An attempt's machine: the branch machine it is, and the person its tools run as. */
export interface TodoMachine {
  readonly branch: SandboxBranch
  readonly ownerId: string
}

/** Attempt `attemptId`'s machine: its branch machine's id. */
export const machineId = (attemptId: string): string => `todo-${attemptId}`

/**
 * The machine of `repoId`'s attempt `attemptId`, run as `ownerId`, checking out `checkout` from GitHub: the attempt's
 * base commit (`Begun.baseSha`), its 40-hex id, which the machine fetches alone and checks out detached.
 */
export const machineOf = (options: {
  readonly attemptId: string
  readonly repoId: string
  readonly checkout: string
  readonly ownerId: string
}): TodoMachine => {
  const [owner = "", name = ""] = options.repoId.replace(/^github\//, "").split("/")
  return {
    branch: { branchId: machineId(options.attemptId), owner, name, branch: options.checkout, forge: "github" },
    ownerId: options.ownerId,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The machine of the `todo` run whose execution is `executionId`, at the base commit its `todo/Begin` reported for
 * that attempt (`todo_attempts.base_sha`): `None` for any other run, or an attempt with no base yet. Reads only.
 */
export const ofExecution = (executionId: string) =>
  Effect.gen(function* () {
    const attemptId = executionId.slice("todo:".length)
    if (todoExecutionId(attemptId) !== executionId || !UUID.test(attemptId)) return Option.none<TodoMachine>()
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly repoId: string; readonly baseSha: string | null; readonly ownerId: string }>`
      SELECT t.repo_id AS "repoId", a.base_sha AS "baseSha", t.created_by AS "ownerId"
      FROM todo_attempts a JOIN todos t ON t.id = a.todo_id WHERE a.id = ${attemptId}::uuid`
    if (row === undefined || row.baseSha === null) return Option.none<TodoMachine>()
    return Option.some(machineOf({ attemptId, repoId: row.repoId, checkout: row.baseSha, ownerId: row.ownerId }))
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
