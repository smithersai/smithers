/**
 * A real process dies after it provisions a fork's jj workspace and before
 * the store commits the fork. The next build must forget the orphaned lane,
 * and the retried fork must land under a fresh id rather than asking jj for
 * the name the leftover on disk still holds.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Fork from "../src/internal/Fork.vibe"
import { TimeTravel } from "../src/TimeTravel.ts"
import { awaitCheckpoint, jjInstalled, killHard, runReal, runState, withRealFixture } from "./RealTimeTravelHarness.ts"

const childFixture = fileURLToPath(new URL("./fixtures/fork-crash-child.ts", import.meta.url))

/** The workspace names jj registers for `repository`, as `jj workspace list` prints them. */
const workspaceNames = (repository: string): ReadonlyArray<string> =>
  execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })
    .split("\n")
    .map((line) => line.split(":")[0]!.trim())
    .filter((name) => name.length > 0)

describe.skipIf(!jjInstalled)("fork crash recovery over file SQLite", () => {
  // The finite budget covers one real child process, SIGKILL, and two fresh service builds.
  it.effect(
    "reclaims the orphaned lane and retries under a fresh id after a real process death",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-fork-crash-", (fixture) =>
          Effect.gen(function*() {
            const runId = "run-fork-crash"
            yield* runReal(
              fixture.databaseFile,
              Effect.gen(function*() {
                const sql = yield* Effect.service(SqlClient.SqlClient)
                yield* sql`
                INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
                VALUES (${runId}, 'suspended', 0, ${runState("KilledFork")})
              `
                yield* sql`
                INSERT INTO flows_journal_events
                  (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                VALUES (${runId}, 0, ${`${runId}-0`}, 'killed-fork', 0, 0, 'baseline', '{}',
                        ${JSON.stringify({ lineageId: `${runId}/root` })})
              `
              })
            )
            // `jj workspace add` creates the lane itself, never the lane root.
            mkdirSync(join(fixture.repository, ".flows", "forks"), { recursive: true })
            const child = spawn(process.execPath, [childFixture, fixture.databaseFile, runId], {
              cwd: fixture.repository,
              env: { ...process.env, JJ_EDITOR: "true" }
            })
            try {
              expect(yield* Effect.promise(() => awaitCheckpoint<{ readonly stage: string }>(child, "crash child")))
                .toEqual({ stage: "provisioned" })
              yield* Effect.promise(() => killHard(child))

              // The crash image: a registered lane, a reservation, and no child.
              const orphanId = `${runId}:fork:0:1`
              const orphanLane = Fork.workspaceNameFor(orphanId)
              expect(workspaceNames(fixture.repository)).toContain(orphanLane)
              const image = yield* runReal(
                fixture.databaseFile,
                Effect.gen(function*() {
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const intents = yield* sql<
                    { readonly child_run_id: string; readonly reclaimed_at_ms: number | null }
                  >`
                  SELECT child_run_id, reclaimed_at_ms FROM flows_time_travel_fork_intents
                `
                  const children = yield* sql<{ readonly run_id: string }>`
                  SELECT run_id FROM flows_runs WHERE run_id <> ${runId}
                `
                  // The child reserved under the wall clock; the lifetimes below
                  // run under the test clock, so the reservation is aged the way
                  // wall-clock time ages a process that never came back.
                  yield* sql`UPDATE flows_time_travel_fork_intents SET reserved_at_ms = 0`
                  return { intents, children }
                })
              )
              expect(image.intents).toEqual([{ child_run_id: orphanId, reclaimed_at_ms: null }])
              expect(image.children).toEqual([])
              // The first build ran inside the staleness window and left the
              // young reservation alone.
              expect(workspaceNames(fixture.repository)).toContain(orphanLane)

              yield* TestClock.adjust("6 minutes")
              const retried = yield* runReal(
                fixture.databaseFile,
                Effect.gen(function*() {
                  const timeTravel = yield* TimeTravel
                  const afterBuild = workspaceNames(fixture.repository)
                  const fork = yield* timeTravel.fork({ runId, frame: { lineageId: `${runId}/root`, seq: 0 } })
                  const afterFork = workspaceNames(fixture.repository)
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const intents = yield* sql<{ readonly child_run_id: string; readonly reclaimed_at_ms: number }>`
                  SELECT child_run_id, reclaimed_at_ms FROM flows_time_travel_fork_intents ORDER BY child_run_id
                `
                  return { afterBuild, afterFork, fork, intents }
                })
              )

              expect(retried.afterBuild).not.toContain(orphanLane)
              expect(retried.fork.runId).toBe(`${runId}:fork:0:2`)
              expect(retried.afterFork).toContain(Fork.workspaceNameFor(retried.fork.runId))
              expect(retried.afterFork).not.toContain(orphanLane)
              // The reclaimed reservation keeps its ordinal; the committed one is consumed.
              expect(retried.intents).toEqual([{ child_run_id: orphanId, reclaimed_at_ms: 360_000 }])
            } finally {
              yield* Effect.promise(() => killHard(child))
            }
          }))
      }),
    { timeout: 120_000 }
  )
})
