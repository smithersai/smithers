import { Control, ControlError } from "@smthrs/control"
import { waitFor } from "@smthrs/testing/Faults"
import { Effect, Stream } from "effect"
import { HttpServer } from "effect/http"
import { existsSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  editStore,
  invoke,
  project,
  recordEvents,
  remoteAddress,
  serverLayer,
  waitingProject
} from "./support/unified-cli.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const document = (result: Awaited<ReturnType<typeof invoke>>) => {
  expect(result.codes, result.stdout + result.stderr).not.toContain(1)
  expect(result.codes, result.stdout + result.stderr).not.toContain(2)
  return JSON.parse(result.stdout)
}
const storedRun = async (count = 0, native = false) => {
  const root = await project()
  roots.push(root)
  const runId = document(
    await invoke(["flow", "start", "echo", "--data", "{\"message\":\"stored\"}", "--root", root, "--json"])
  ).runId as string
  const ids = Array.from({ length: count }, (_, index) => `execution-${index}`)
  let sequences: Array<number>
  if (native) {
    editStore(root, "engine", (db) => {
      db.prepare(
        "INSERT OR IGNORE INTO flows_runs(run_id,status,created_at_ms,state_json,lineage_id,round_ordinal) VALUES(?,'succeeded',0,?,?,0)"
      )
        .run(runId, JSON.stringify({ version: 1, flowName: "echo", payload: {} }), runId)
      const insert = db.prepare(
        "INSERT INTO flows_runs(run_id,status,created_at_ms,state_json,parent_run_id,execution_parent_id,lineage_id,round_ordinal) VALUES(?,'cancelled',0,?,?,?,?,0)"
      )
      for (const id of ids) {
        insert.run(id, JSON.stringify({ version: 1, flowName: "echo/work", payload: {} }), runId, runId, id)
      }
    })
    sequences = recordEvents(
      root,
      runId,
      ids.map((executionId, index) => ({
        executionId,
        eventType: "flows.engine.run-decision",
        generation: 0,
        sequence: index + 1,
        payload: {
          executionFact: {
            observation: { executionId, flowName: "echo/work", status: "cancelled", parentRunId: runId }
          }
        }
      })),
      "control.engine.event"
    )
  } else {
    sequences = recordEvents(root, runId, ids.map((id) => ({ id })))
  }
  return { root, runId, ids, sequences }
}
/** Keep coordination history and the native observation consistent in read-only fixtures. */
const storedStatus = (root: string, runId: string, status: "parked" | "waiting-approval" | "failed" | "cancelled") => {
  const persisted = status === "parked" || status === "waiting-approval" ? "suspended" : status
  editStore(root, "control", (db) => {
    db.prepare("UPDATE flows_runs SET status = ?, state_json = json_set(state_json, '$.status', ?) WHERE run_id = ?")
      .run(persisted, status, runId)
  })
  editStore(root, "engine", (db) => {
    db.prepare("UPDATE flows_runs SET status = ?, waiting_reason = ?, waiting_token = ? WHERE run_id = ?")
      .run(
        persisted,
        status === "waiting-approval" ? "approval" : null,
        status === "waiting-approval" ? "historical-approval" : null,
        runId
      )
  })
}

const launch = Effect.fnUntraced(function*(remote: string, control: Control.Service, index = 0) {
  const card = document(
    yield* Effect.promise(() =>
      invoke([
        "flow",
        "plan",
        "wait",
        "--data",
        JSON.stringify({ message: `run-${index}` }),
        "--remote",
        remote,
        "--json"
      ])
    )
  )
  yield* control.approve({ ...card.approval, scope: "run" })
  return document(
    yield* Effect.promise(() =>
      invoke(["flow", "execute", JSON.stringify(card.approval), "--remote", remote, "--json"])
    )
  ).runId as string
})
const lines = (text: string) => text.trim().split("\n").map((line) => JSON.parse(line))

describe("unified exact native observations", () => {
  it("reads 405 persisted children in serial 200-ID batches and retains each source revision", async () => {
    const { root, runId, ids } = await storedRun(405, true)
    const requests: Array<ReadonlyArray<string>> = []
    const revisions: Array<number | undefined> = []
    const order: Array<string> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const output = document(
          yield* Effect.promise(() => invoke(["runs", "show", runId, "--remote", remote, "--json"]))
        )
        const requested = requests.flat()
        expect(requested.filter((id) => ids.includes(id))).toEqual(ids)
        expect(new Set(requested).size).toBe(requested.length)
        expect(requests.map((batch) => batch.length)).toEqual([200, 200, requested.length - 400])
        expect(order).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"])
        expect(output.executionSnapshots.map((row: { executionId: string }) => row.executionId)).toEqual(
          requests.flat()
        )
        expect(output.executionSnapshots.map((row: { revision: number }) => row.revision))
          .toEqual(revisions)
        expect(
          output.executionSnapshots.filter((row: { executionId: string }) => ids.includes(row.executionId))
            .every((row: { state: string }) => row.state === "cancelled")
        ).toBe(true)
        expect(output.executions).toHaveLength(20)
        expect(output.executionsOmitted).toBe(requests.flat().filter((id) => id !== runId).length - 20)
      }).pipe(
        Effect.provide(serverLayer(root, (control) =>
          Control.make({
            ...control,
            list: (request) => {
              if (request._tag !== "executions") return control.list(request)
              const batch = requests.length
              requests.push(request.executionIds)
              return Effect.gen(function*() {
                order.push(`start:${batch}`)
                const page = yield* control.list(request)
                if (page._tag === "executions") {
                  revisions.push(...page.items.map((row) => row._tag === "Unavailable" ? undefined : row.revision))
                }
                order.push(`end:${batch}`)
                return page
              })
            }
          }))),
        Effect.scoped
      )
    )
  }, 120_000)

  it.each(["wrong-tag", "source-replaced", "read-failed"] as const)(
    "refuses partial activity when a later real batch is %s",
    async (mode) => {
      const { root, runId } = await storedRun(201, true)
      let batches = 0
      await Effect.runPromise(
        Effect.gen(function*() {
          const remote = remoteAddress(yield* HttpServer.HttpServer)
          const result = yield* Effect.promise(() => invoke(["runs", "show", runId, "--remote", remote, "--json"]))
          expect(result.codes).toContain(1)
          expect(batches).toBe(2)
          const output = JSON.parse(result.stdout)
          expect(output).not.toHaveProperty("executions")
          expect(output).not.toHaveProperty("executionSnapshots")
          expect(result.stdout).toContain(
            mode === "wrong-tag"
              ? "execution observation is unavailable"
              : mode === "source-replaced"
              ? "execution source changed"
              : "native observation failed"
          )
        }).pipe(
          Effect.provide(serverLayer(root, (control) =>
            Control.make({
              ...control,
              list: (request) => {
                if (request._tag !== "executions" || ++batches !== 2) return control.list(request)
                if (mode === "wrong-tag") return Effect.succeed({ _tag: "runs", items: [] })
                if (mode === "read-failed") {
                  return Effect.fail(
                    new ControlError.TransportError({ message: "native observation failed", retryable: false })
                  )
                }
                return control.list(request).pipe(
                  Effect.map((page) => page._tag === "executions" ? { ...page, source: "replaced-source" } : page)
                )
              }
            }))),
          Effect.scoped
        )
      )
    },
    120_000
  )
})

describe("unified bulk cancellation", () => {
  it.each(["healthy", "malformed-page", "failed-mutation"] as const)(
    "cancels real runs with %s service behavior",
    async (mode) => {
      const root = await waitingProject()
      roots.push(root)
      const cancelled: Array<string> = []
      const runs: Array<string> = []
      const pageCursors: Array<string | undefined> = []
      const stages: Array<string> = []
      let paging = false
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const remote = remoteAddress(yield* HttpServer.HttpServer)
          for (let index = 0; index < 3; index++) runs.push(yield* launch(remote, control, index))
          yield* Effect.promise(() =>
            waitFor(
              () =>
                existsSync(join(root, "wait.log")) &&
                runs.every((_, index) => readFileSync(join(root, "wait.log"), "utf8").includes(`run-${index}\n`)),
              "all real actions to run",
              15_000
            )
          )
          const before = mode === "malformed-page" ? undefined : yield* control.list({ _tag: "runs" })
          const order = before?._tag === "runs" ? before.items.map((run) => run.runId) : []
          paging = true
          const result = yield* Effect.promise(() => invoke(["runs", "cancel-all", "--remote", remote, "--json"]))
          paging = false
          expect(pageCursors).toHaveLength(mode === "malformed-page" ? 2 : 3)
          expect(pageCursors[0]).toBeUndefined()
          expect(pageCursors.slice(1).every((cursor) => typeof cursor === "string" && cursor.length > 0)).toBe(true)
          expect(stages).toEqual(
            mode === "malformed-page" ?
              ["page", "page"] :
              ["page", "page", "page", ...Array.from({ length: mode === "healthy" ? 3 : 2 }, () => "cancel")]
          )
          expect(result.codes).toEqual(mode === "healthy" ? [] : [1])
          expect(cancelled).toEqual(
            mode === "malformed-page" ? [] : mode === "failed-mutation" ? order.slice(0, 2) : order
          )
          if (mode !== "malformed-page") {
            const expectedFinalizers = mode === "healthy" ? 3 : 1
            yield* Effect.promise(() =>
              waitFor(
                () =>
                  readFileSync(join(root, "wait.log"), "utf8").split("\n").filter((line) => line === "cancelled")
                    .length === expectedFinalizers,
                "cancelled actions to unwind",
                15_000
              )
            )
          }
          const page = yield* control.list({ _tag: "runs" })
          if (mode !== "malformed-page") {
            expect(page._tag).toBe("runs")
            if (page._tag === "runs") {
              expect(page.items.filter((run) => run.status === "cancelled")).toHaveLength(mode === "healthy" ? 3 : 1)
            }
          }
          if (mode !== "healthy") expect(JSON.parse(result.stdout)).not.toHaveProperty("receipts")
        }).pipe(
          Effect.provide(serverLayer(root, (control) =>
            Control.make({
              ...control,
              list: (request) => {
                if (!paging || request._tag !== "runs") return control.list(request)
                stages.push("page")
                pageCursors.push(request.cursor)
                if (mode === "malformed-page" && request.cursor !== undefined) {
                  return Effect.succeed({ _tag: "flows", items: [] })
                }
                return control.list({ ...request, limit: 1 })
              },
              cancel: (request) => {
                stages.push("cancel")
                cancelled.push(request.runId)
                return mode === "failed-mutation" && cancelled.length === 2
                  ? Effect.fail(
                    new ControlError.TransportError({ message: "cancel mutation failed", retryable: false })
                  )
                  : control.cancel(request)
              }
            }))),
          Effect.scoped
        )
      )
    },
    120_000
  )
})

describe("unified wait exit statuses", () => {
  it.each(["parked", "waiting-approval", "failed", "cancelled"] as const)(
    "preserves the persisted %s exit status locally and remotely",
    async (status) => {
      const { root, runId } = await storedRun()
      storedStatus(root, runId, status)
      const expected = status === "failed" ? 1 : status === "cancelled" ? 130 : 3
      const local = await invoke(["runs", "wait", runId, "--timeout", "0", "--root", root, "--json"])
      expect(local.codes, local.stdout + local.stderr).toEqual([expected])
      expect(JSON.parse(local.stdout)).toMatchObject({ code: status })
      await Effect.runPromise(
        Effect.gen(function*() {
          const remote = remoteAddress(yield* HttpServer.HttpServer)
          const result = yield* Effect.promise(() =>
            invoke([
              "runs",
              "wait",
              runId,
              "--timeout",
              "0",
              "--remote",
              remote,
              "--json"
            ])
          )
          expect(result.codes, result.stdout + result.stderr).toEqual([expected])
          expect(JSON.parse(result.stdout)).toMatchObject({ code: status })
        }).pipe(Effect.provide(serverLayer(root)), Effect.scoped)
      )
    },
    120_000
  )
})

describe("unified catalog and approval pagination", () => {
  it("finds a remote flow after an empty page using the real opaque cursor", async () => {
    const root = await waitingProject()
    roots.push(root)
    const cursors: Array<string | undefined> = []
    let nextCursor: string | undefined
    await Effect.runPromise(
      Effect.gen(function*() {
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const shown = document(
          yield* Effect.promise(() => invoke(["flow", "show", "wait", "--remote", remote, "--json"]))
        )
        expect(shown).toMatchObject({ flowId: "wait", description: "Wait until cancelled" })
        expect(nextCursor).toBeDefined()
        expect(cursors).toEqual([undefined, nextCursor])
      }).pipe(
        Effect.provide(serverLayer(root, (control) =>
          Control.make({
            ...control,
            list: (request) => {
              if (request._tag !== "flows") return control.list(request)
              cursors.push(request.cursor)
              return control.list({ ...request, limit: 1 }).pipe(Effect.map((page) => {
                if (page._tag !== "flows" || request.cursor !== undefined) return page
                expect(page.items[0]?.flowId).toBe("echo")
                nextCursor = page.nextCursor
                // A sparse catalog page can carry a valid cursor and no visible rows.
                return { ...page, items: [] }
              }))
            }
          }))),
        Effect.scoped
      )
    )
  }, 120_000)

  it.each(["all", "filtered", "malformed-page"] as const)(
    "reads exact persisted approval payloads over every page: %s",
    async (mode) => {
      const { root, runId } = await storedRun()
      const runIds = [
        runId,
        document(
          await invoke([
            "flow",
            "start",
            "echo",
            "--data",
            JSON.stringify({ message: "second stored run" }),
            "--root",
            root,
            "--json"
          ])
        ).runId as string
      ]
      const approvals = []
      for (const index of runIds.keys()) {
        approvals.push(
          document(
            await invoke([
              "flow",
              "plan",
              "echo",
              "--data",
              JSON.stringify({ message: "input-" + index }),
              "--root",
              root,
              "--json"
            ])
          ).approval
        )
      }
      const expected: Array<{ runId: string; flowId: string; question: string; approval: string }> = []
      for (const [index, id] of runIds.entries()) {
        const approval = approvals[index]
        storedStatus(root, id, "waiting-approval")
        const question = "Approve input " + index + "?"
        recordEvents(root, id, [{ question, payload: approval }], "control.approval.requested")
        recordEvents(root, id, [{ runId: id, status: "waiting-approval" }], "control.run.waiting-approval")
        expected.push({ runId: id, flowId: "echo", question, approval: JSON.stringify(approval) })
      }
      const cursors: Array<string | undefined> = []
      const watches: Array<string | undefined> = []
      let nextCursor: string | undefined
      await Effect.runPromise(
        Effect.gen(function*() {
          const remote = remoteAddress(yield* HttpServer.HttpServer)
          const result = yield* Effect.promise(() =>
            invoke([
              "approvals",
              "list",
              ...(mode === "filtered" ? ["--run", runId] : []),
              "--remote",
              remote,
              "--json"
            ])
          )
          if (mode === "filtered") {
            expect(cursors).toEqual([undefined])
          } else {
            expect(nextCursor).toBeDefined()
            expect(cursors).toEqual([undefined, nextCursor])
          }
          if (mode === "malformed-page") {
            expect(result.codes).toEqual([1])
            expect(result.stdout).toContain("run_list_unexpected")
            expect(watches).toEqual([])
          } else {
            const selected = mode === "filtered" ? expected.slice(0, 1) : expected
            expect(document(result)).toEqual(selected.map((row) => expect.objectContaining(row)))
            expect(watches).toEqual(selected.map((row) => row.runId))
          }
        }).pipe(
          Effect.provide(serverLayer(root, (control) =>
            Control.make({
              ...control,
              list: (request) => {
                if (request._tag !== "runs" || request.filters?.status !== "waiting-approval") {
                  return control.list(request)
                }
                cursors.push(request.cursor)
                expect(request.filters).toEqual({
                  status: "waiting-approval",
                  ...(mode === "filtered" ? { runId } : {})
                })
                if (mode === "malformed-page" && request.cursor !== undefined) {
                  return Effect.succeed({ _tag: "flows", items: [] })
                }
                return control.list({ ...request, limit: 1 }).pipe(Effect.tap((page) =>
                  Effect.sync(() => {
                    if (page._tag === "runs" && request.cursor === undefined) nextCursor = page.nextCursor
                  })
                ))
              },
              watch: (filter) => {
                watches.push(filter.runId)
                return control.watch(filter)
              }
            }), false)),
          Effect.scoped
        )
      )
    },
    120_000
  )
})

describe("unified bounded journal streams", () => {
  it("does not invent a continuation for an empty finite transcript", async () => {
    const { root, runId } = await storedRun()
    await Effect.runPromise(
      Effect.gen(function*() {
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const control = yield* Control.Control
        const transcript = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        const after = transcript.at(-1)!.sequence
        const result = yield* Effect.promise(() =>
          invoke([
            "runs",
            "logs",
            runId,
            "--after",
            String(after),
            "--remote",
            remote,
            "--audience",
            "agent",
            "--format",
            "jsonl"
          ])
        )
        expect(result.codes).toEqual([])
        expect(lines(result.stdout)).toEqual([expect.objectContaining({ type: "done", ok: true })])
        expect(result.stdout).not.toContain("--after")
      }).pipe(Effect.provide(serverLayer(root)), Effect.scoped)
    )
  }, 120_000)

  it("returns 100 exact events by default, then resumes at event 101", async () => {
    const { root, runId, sequences } = await storedRun(101)
    await Effect.runPromise(
      Effect.gen(function*() {
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const at = ["--remote", remote, "--format", "jsonl"]
        const first = yield* Effect.promise(() =>
          invoke(["runs", "logs", runId, "--after", String(sequences[0]! - 1), "--audience", "agent", ...at])
        )
        expect(first.codes).toEqual([])
        const chunks = lines(first.stdout).filter((line) => line.type === "chunk")
        expect(chunks.map((line) => line.data.sequence)).toEqual(sequences.slice(0, 100))
        expect(first.stdout).toContain(`--after ${sequences[99]}`)
        const next = yield* Effect.promise(() =>
          invoke(["runs", "logs", runId, "--after", String(sequences[99]), "--limit", "2", ...at])
        )
        expect(lines(next.stdout).filter((line) => line.type === "chunk").map((line) => line.data.sequence)).toEqual([
          sequences[100]
        ])
        const follow = yield* Effect.promise(() =>
          invoke(["runs", "logs", runId, "--after", String(sequences[0]! - 1), "--follow", ...at])
        )
        expect(follow.codes).toEqual([])
        expect(lines(follow.stdout).filter((line) => line.type === "chunk")).toHaveLength(101)
        expect(follow.stdout).not.toContain("--after")
      }).pipe(Effect.provide(serverLayer(root)), Effect.scoped)
    )
  }, 120_000)

  it("stops before a fault at event 101 of the default pull", async () => {
    const { root, runId, sequences } = await storedRun(101)
    await Effect.runPromise(
      Effect.gen(function*() {
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const result = yield* Effect.promise(() =>
          invoke([
            "runs",
            "logs",
            runId,
            "--after",
            String(sequences[0]! - 1),
            "--remote",
            remote,
            "--audience",
            "agent",
            "--format",
            "jsonl"
          ])
        )
        expect(result.codes).toEqual([])
        expect(lines(result.stdout).filter((line) => line.type === "chunk")).toHaveLength(100)
        expect(result.stdout).not.toContain("event 101 was read")
      }).pipe(
        Effect.provide(serverLayer(root, (control) =>
          Control.make({
            ...control,
            watch: (filter) =>
              control.watch(filter).pipe(
                Stream.take(100),
                Stream.concat(
                  Stream.fail(new ControlError.TransportError({ message: "event 101 was read", retryable: false }))
                )
              )
          }))),
        Effect.scoped
      )
    )
  }, 120_000)

  it("keeps emitted events and redacts a later stream failure", async () => {
    const { root, runId, sequences } = await storedRun(2)
    await Effect.runPromise(
      Effect.gen(function*() {
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const result = yield* Effect.promise(() =>
          invoke(["runs", "logs", runId, "--after", String(sequences[0]! - 1), "--remote", remote, "--format", "jsonl"])
        )
        expect(result.codes).toEqual([1])
        const output = lines(result.stdout)
        expect(output[0]).toMatchObject({ type: "chunk", data: { runId, sequence: sequences[0] } })
        expect(output.at(-1)).toMatchObject({ type: "error", ok: false })
        expect(result.stdout).not.toContain("private-fixture")
      }).pipe(
        Effect.provide(serverLayer(root, (control) =>
          Control.make({
            ...control,
            watch: (filter) =>
              control.watch(filter).pipe(
                Stream.take(1),
                Stream.concat(
                  Stream.fail(
                    new ControlError.TransportError({
                      message: "Authorization: Bearer private-fixture",
                      retryable: false
                    })
                  )
                )
              )
          }))),
        Effect.scoped
      )
    )
  }, 120_000)
})
