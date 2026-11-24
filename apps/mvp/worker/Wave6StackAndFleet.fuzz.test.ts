import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as DeploymentPolicy from "./DeploymentPolicy.vibe"
import * as FleetMcpTools from "./fleet/FleetMcpTools.vibe"
import * as FleetStore from "./fleet/FleetStore.vibe"
import type { McpPrincipal, McpToolContext } from "./mcp/Contract.ts"
import * as Stack from "./stack/Stack.ts"
import { foldCommit } from "./stack/StackFeed.ts"
import type { TodoState } from "../src/features/todos/contract.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const word = Arbitrary.schema(Schema.Literals(["alpha", "beta", "gamma", "delta"]))

const flattenSql = (
  strings: TemplateStringsArray,
  values: ReadonlyArray<unknown>
): { text: string; params: Array<unknown> } => {
  let text = ""
  const params: Array<unknown> = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const v = values[i] as { segments?: ReadonlyArray<{ sql?: string; params?: ReadonlyArray<unknown>; value?: unknown }> } | undefined
      if (v && typeof v === "object" && "segments" in v && Array.isArray(v.segments)) {
        for (const seg of v.segments) {
          if (seg && typeof seg === "object" && typeof seg.sql === "string") {
            text += seg.sql
            if (Array.isArray(seg.params)) params.push(...seg.params)
          } else if (seg && typeof seg === "object" && "value" in seg) {
            text += String(seg.value)
          }
        }
      } else {
        text += `$${params.length + 1}`
        params.push(v)
      }
    }
  }
  return { text, params }
}

const makeSqlLayer = (
  handler: (sqlText: string, params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | Error
): Layer.Layer<SqlClient.SqlClient> => {
  const fn = ((strings: TemplateStringsArray | string, ...values: ReadonlyArray<unknown>) => {
    if (typeof strings === "string") return { segments: [{ sql: strings, params: [] }] }
    const { text, params } = flattenSql(strings, values)
    return Effect.suspend(() => {
      const out = handler(text, params)
      return out instanceof Error ? Effect.fail(out as never) : Effect.succeed(out)
    })
  }) as unknown as SqlClient.SqlClient
  const client = Object.assign(fn, {
    in: (a: unknown, b?: ReadonlyArray<unknown>) => {
      if (Array.isArray(a)) return { segments: [{ sql: `(${a.map((_, i) => `$in${i}`).join(",")})`, params: [...a] }] }
      const arr = b ?? []
      return { segments: [{ sql: `${String(a)} IN (${arr.map((_, i) => `$in${i}`).join(",")})`, params: [...arr] }] }
    },
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
    unsafe: (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.suspend(() => {
        const out = handler(query, params)
        return out instanceof Error ? Effect.fail(out as never) : Effect.succeed(out)
      })
  })
  return Layer.succeed(SqlClient.SqlClient, client)
}

interface StackRowState {
  nextNumber: number
  lanes: number
  maxOpen: number
  base: "stacked" | "independent"
  version: number
}

interface TodoRowState {
  id: string
  repoId: string
  number: number
  title: string
  state: TodoState
  position: number | null
  revision: number
  attempt: number
  createdBy: string
  createdLogin: string
  issueNumber: number | null
  after: string | null
  branch: string | null
  baseSha: string | null
  baseRef: string | null
  headSha: string | null
  prNumber: number | null
  mergeSha: string | null
  failure: string | null
  note: string | null
  step: string | null
  waiting: string | null
  touched: boolean
}

interface AttemptRowState {
  id: string
  todoId: string
  repoId: string
  ordinal: number
  revision: number
  status: string
  branch: string | null
  baseRef: string | null
  baseSha: string | null
  prNumber: number | null
  publishedReport: { readonly starts: ReadonlyArray<Stack.AttemptStart> } | null
  finishedReport: { readonly event: Stack.RunEvent; readonly starts: ReadonlyArray<Stack.AttemptStart> } | null
}

const makeStackDb = (opts: { baseClosed?: boolean; attachTargetExists?: boolean; hasDeletedIssue?: boolean } = {}) => {
  const stacks = new Map<string, StackRowState>()
  const todos = new Map<string, TodoRowState>()
  const requests = new Map<string, { prompt: string; acceptance: ReadonlyArray<string> }>()
  const attempts = new Map<string, AttemptRowState>()
  const ops = new Map<string, { payloadHash: string; result: unknown }>()
  const notices = new Set<string>()
  let txSeq = 100

  const layer = makeSqlLayer((raw, params) => {
    const q = raw.replace(/\s+/g, " ").trim()
    if (q.startsWith("SET LOCAL ")) return []
    if (q.startsWith("INSERT INTO stacks (repo_id)")) {
      const repoId = String(params[0])
      if (!stacks.has(repoId)) {
        stacks.set(repoId, { nextNumber: 1, lanes: 2, maxOpen: 10, base: "stacked", version: 0 })
      }
      return []
    }
    if (q.includes("FROM stacks WHERE repo_id =") && q.includes("FOR UPDATE")) {
      const repoId = String(params[0])
      const st = stacks.get(repoId)
      if (!st) return []
      return [{ repo_id: repoId, nextNumber: st.nextNumber, lanes: st.lanes, maxOpen: st.maxOpen, base: st.base }]
    }
    if (q.includes("FROM stack_ops WHERE id =")) {
      const op = ops.get(String(params[0]))
      return op ? [{ payloadHash: op.payloadHash, result: op.result }] : []
    }
    if (q.includes("SELECT created_by AS \"createdBy\" FROM todos")) {
      const repoId = String(params[0])
      const num = Number(params[1])
      const t = [...todos.values()].find((x) => x.repoId === repoId && x.number === num)
      return t ? [{ createdBy: t.createdBy }] : []
    }
    if (q.includes("SELECT id, issue_number AS \"issueNumber\" FROM todos") || q.includes("issue_number AS \"issueNumber\"") && q.includes("AND number =")) {
      const repoId = String(params[0])
      const num = Number(params[1])
      const t = [...todos.values()].find((x) => x.repoId === repoId && x.number === num)
      return t ? [{ id: t.id, number: t.number, state: t.state, issueNumber: t.issueNumber, deleted: opts.hasDeletedIssue === true }] : []
    }
    if (q.includes("FROM items WHERE repo_id =") || q.includes("FROM items i")) {
      return opts.attachTargetExists === false ? [] : [{ number: Number(params[1] ?? 1), exists: true }]
    }
    if (q.includes("SELECT t.id, t.number, t.state, t.position, t.attempt, t.revision, t.after::text AS after, a.id AS \"attemptId\"")) {
      const repoId = String(params[0])
      const named = Number(params[1])
      return [...todos.values()]
        .filter((t) => t.repoId === repoId && (t.position !== null || t.number === named))
        .map((t) => {
          const att = [...attempts.values()].find((a) => a.todoId === t.id && a.ordinal === t.attempt)
          return {
            id: t.id,
            number: t.number,
            state: t.state,
            position: t.position,
            attempt: t.attempt,
            revision: t.revision,
            after: t.after,
            attemptId: att?.id ?? null,
            baseClosed: t.failure === "base_closed"
          }
        })
    }
    if (q.includes("SELECT t.id, t.number, t.state, t.position, t.attempt, t.revision, t.after::text AS after, t.base_ref AS \"baseRef\"")) {
      const repoId = String(params[0])
      const todoId = String(params[1])
      return [...todos.values()]
        .filter((t) => t.repoId === repoId && (t.position !== null || t.id === todoId))
        .map((t) => ({
          id: t.id,
          number: t.number,
          state: t.state,
          position: t.position,
          attempt: t.attempt,
          revision: t.revision,
          after: t.after,
          baseRef: t.baseRef,
          baseClosed: t.failure === "base_closed"
        }))
    }
    if (q.includes("INSERT INTO todos (")) {
      const [id, repoId, number, title, state, position, revision, attempt, createdBy, createdLogin, issueNumber, after] = params
      todos.set(String(id), {
        id: String(id),
        repoId: String(repoId),
        number: Number(number),
        title: String(title),
        state: state as TodoState,
        position: position === null ? null : Number(position),
        revision: Number(revision),
        attempt: Number(attempt),
        createdBy: String(createdBy),
        createdLogin: String(createdLogin),
        issueNumber: issueNumber === null || issueNumber === undefined ? null : Number(issueNumber),
        after: after === null || after === undefined ? null : String(after),
        branch: null,
        baseSha: null,
        baseRef: null,
        headSha: null,
        prNumber: null,
        mergeSha: null,
        failure: null,
        note: null,
        step: null,
        waiting: null,
        touched: true
      })
      return []
    }
    if (q.includes("INSERT INTO todo_requests")) {
      const [todoId, , prompt, accJson] = params
      requests.set(String(todoId), { prompt: String(prompt), acceptance: JSON.parse(String(accJson)) as Array<string> })
      return []
    }
    if (q.includes("INSERT INTO notifications")) {
      const key = `${String(params[0])}:${String(params[1])}`
      if (notices.has(key)) return []
      notices.add(key)
      return [{ subject: String(params[1]) }]
    }
    if (q.includes("UPDATE stacks SET lanes =")) {
      const [lanes, maxOpen, base, repoId] = params
      const st = stacks.get(String(repoId))
      if (st) {
        st.lanes = Number(lanes)
        st.maxOpen = Number(maxOpen)
        st.base = base as "stacked" | "independent"
      }
      return []
    }
    if (q.includes("UPDATE todos AS t SET state = v.state")) {
      const jsonArg = params.find((p) => typeof p === "string" && p.startsWith("["))
      if (typeof jsonArg === "string") {
        const list = JSON.parse(jsonArg) as Array<{ id: string; state: TodoState; position: number | null; attempt: number; after: string | null }>
        for (const v of list) {
          const t = todos.get(v.id)
          if (t) {
            if (t.state === "queued" && v.state === "failed") t.failure = "base_closed"
            t.state = v.state
            t.position = v.position
            t.attempt = v.attempt
            t.after = v.after
            t.touched = true
          }
        }
      }
      return []
    }
    if (q.includes("INSERT INTO todo_attempts")) {
      const [id, todoId, repoId, ordinal, revision] = params
      attempts.set(String(id), {
        id: String(id),
        todoId: String(todoId),
        repoId: String(repoId),
        ordinal: Number(ordinal),
        revision: Number(revision),
        status: "running",
        branch: null,
        baseRef: null,
        baseSha: null,
        prNumber: null,
        publishedReport: null,
        finishedReport: null
      })
      return []
    }
    if (q.includes("UPDATE stacks SET next_number =")) {
      const [nextNumber, repoId] = params
      const st = stacks.get(String(repoId))!
      st.nextNumber = Number(nextNumber)
      st.version += 1
      txSeq += 1
      return [{ version: String(st.version), txid: String(txSeq) }]
    }
    if (q.includes("UPDATE stacks SET version = version + 1")) {
      const repoId = String(params[0])
      const st = stacks.get(repoId)
      if (st) st.version += 1
      txSeq += 1
      return [{ version: String(st?.version ?? 1), txid: String(txSeq) }]
    }
    if (q.includes("INSERT INTO stack_ops")) {
      const [id, , , , , hash, , resJson] = params
      ops.set(String(id), { payloadHash: String(hash), result: JSON.parse(String(resJson)) })
      return []
    }
    if (q.includes("SELECT number, state, issue_number AS \"issueNumber\", pr_number AS \"prNumber\", merge_sha AS \"mergeSha\" FROM todos")) {
      const repoId = String(params[0])
      const touched = [...todos.values()].filter((t) => t.repoId === repoId && t.issueNumber !== null && t.touched)
      for (const t of touched) t.touched = false
      return touched.map((t) => ({
        number: t.number,
        state: t.state,
        issueNumber: t.issueNumber,
        prNumber: t.prNumber,
        mergeSha: t.mergeSha
      }))
    }
    if (q.includes("INSERT INTO work_links")) return [{ id: "wl-1" }]
    if (q.includes("SELECT finished_report AS \"finishedReport\", published_report AS \"publishedReport\"")) {
      const [eventJson, attemptId, todoId, repoId, ordinal] = params
      const a = attempts.get(String(attemptId))
      if (!a || a.todoId !== String(todoId) || a.repoId !== String(repoId) || a.ordinal !== Number(ordinal)) return []
      const matches = a.finishedReport !== null && JSON.stringify(a.finishedReport.event) === String(eventJson)
      return [{ finishedReport: a.finishedReport, publishedReport: a.publishedReport, matches }]
    }
    if (q.includes("SELECT EXISTS(SELECT 1 FROM ancestry")) {
      return [{ closed: opts.baseClosed === true }]
    }
    if (q.includes("UPDATE todos SET step =")) {
      const t = todos.get(String(params[params.length - 1]))
      if (t) {
        t.step = String(params[0])
        if (q.includes("head_sha =")) {
          t.headSha = String(params[0])
          t.prNumber = Number(params[1])
          t.touched = true
        }
      }
      return []
    }
    if (q.includes("UPDATE todos SET waiting =")) {
      const t = todos.get(String(params[1]))
      if (t) t.waiting = params[0] === null ? null : String(params[0])
      return []
    }
    if (q.includes("UPDATE todos SET branch =")) {
      const [branch, baseSha, baseRef, todoId] = params
      const t = todos.get(String(todoId))
      if (t) {
        t.branch = String(branch)
        t.baseSha = String(baseSha)
        t.baseRef = String(baseRef)
      }
      return []
    }
    if (q.includes("UPDATE todo_attempts SET base_sha =")) {
      const [baseSha, branch, baseRef, attId] = params
      const a = attempts.get(String(attId))
      if (a) {
        a.baseSha = String(baseSha)
        a.branch = String(branch)
        a.baseRef = String(baseRef)
      }
      return []
    }
    if (q.includes("UPDATE todo_attempts") && q.includes("published_report =")) {
      const [prNumber, reportJson, attId] = params
      const a = attempts.get(String(attId))
      if (a) {
        a.status = "published"
        a.prNumber = Number(prNumber)
        a.publishedReport = JSON.parse(String(reportJson))
      }
      return []
    }
    if (q.includes("UPDATE todos SET failure =")) {
      const [failure, note, mergeSha, todoId] = params
      const t = todos.get(String(todoId))
      if (t) {
        t.failure = failure === null ? null : String(failure)
        t.note = note === null ? null : String(note)
        t.mergeSha = mergeSha === null ? null : String(mergeSha)
        t.touched = true
      }
      return []
    }
    if (q.includes("UPDATE todo_attempts SET status =") && q.includes("finished_report =")) {
      const [status, reportJson, attId] = params
      const a = attempts.get(String(attId))
      if (a) {
        a.status = String(status)
        a.finishedReport = JSON.parse(String(reportJson))
      }
      return []
    }
    if (q.includes("UPDATE todos SET issue_number =")) {
      const [issueNum, todoId] = params
      const t = todos.get(String(todoId))
      if (t) {
        t.issueNumber = Number(issueNum)
        t.touched = true
      }
      return []
    }
    if (q.includes("SELECT t.number, t.title, r.prompt")) {
      const [attId, todoId] = params
      const a = attempts.get(String(attId))
      const t = todos.get(String(todoId))
      const r = requests.get(String(todoId))
      if (!a || !t || !r) return []
      return [{
        number: t.number,
        title: t.title,
        prompt: r.prompt,
        acceptance: r.acceptance,
        issueNumber: t.issueNumber,
        createdBy: t.createdBy,
        createdLogin: t.createdLogin,
        state: t.state,
        attempt: t.attempt,
        branch: t.branch,
        baseSha: t.baseSha,
        baseRef: t.baseRef,
        headSha: t.headSha,
        prNumber: t.prNumber
      }]
    }
    if (q.includes("published_report IS NOT NULL")) {
      const a = attempts.get(String(params[0]))
      return a?.publishedReport ? [{ starts: a.publishedReport.starts }] : []
    }
    if (q.includes("WITH RECURSIVE below AS")) {
      const todoId = String(params[0])
      const t = todos.get(todoId)
      if (!t || t.issueNumber === null) return []
      return [...todos.values()]
        .filter((o) => o.repoId === t.repoId && o.issueNumber === t.issueNumber && o.id !== t.id && o.position !== null)
        .map((o) => ({ number: o.number }))
    }
    if (q.includes("SELECT b.number, b.branch, b.head_sha AS \"headSha\", b.pr_number AS \"prNumber\"")) {
      const t = todos.get(String(params[0]))
      if (!t || t.after === null) return []
      const b = todos.get(t.after)
      if (!b || b.state !== "in_review" || !b.branch || !b.headSha || b.prNumber === null) return []
      return [{ number: b.number, branch: b.branch, headSha: b.headSha, prNumber: b.prNumber }]
    }
    if (q.includes("WITH bases AS")) {
      const [repoId, branch] = params
      const found = [...todos.values()].find((t) => t.repoId === String(repoId) && t.branch === String(branch))
      return found ? [{ number: found.number, prNumber: found.prNumber, state: found.state, mergeSha: found.mergeSha }] : []
    }
    if (q.includes("SELECT a.id AS \"attemptId\" FROM todos t JOIN todo_attempts a")) {
      const [repoId, num] = params
      const t = [...todos.values()].find((x) => x.repoId === String(repoId) && x.number === Number(num))
      if (!t || (t.state !== "working" && t.state !== "in_review")) return []
      const a = [...attempts.values()].find((x) => x.todoId === t.id && x.ordinal === t.attempt)
      return a ? [{ attemptId: a.id }] : []
    }
    if (q.includes("SELECT a.repo_id AS \"repoId\", coalesce(a.branch, t.branch) AS branch")) {
      const [attId, todoId] = params
      const a = attempts.get(String(attId))
      const t = todos.get(String(todoId))
      if (!a || !t) return []
      return [{ repoId: a.repoId, branch: a.branch ?? t.branch }]
    }
    if (q.includes("UPDATE todos SET state =") && q.includes("base_closed")) {
      const [repoId, todoId] = params
      const held = [...todos.values()].filter((t) => t.repoId === String(repoId) && t.state === "queued" && t.after === String(todoId))
      for (const h of held) {
        h.state = "failed"
        h.failure = "base_closed"
        h.touched = true
      }
      return held.map((h) => ({ id: h.id }))
    }
    if (q.includes("WITH RECURSIVE branches AS") && q.includes("children AS")) {
      const repoId = String(params[0])
      const branch = String(params[params.length - 1])
      return [...todos.values()]
        .filter((t) => t.repoId === repoId && t.baseRef === branch && (t.state === "working" || t.state === "in_review"))
        .map((t) => {
          const a = [...attempts.values()].find((x) => x.todoId === t.id && x.ordinal === t.attempt)
          return a ? { attemptId: a.id, todoId: t.id, repoId: t.repoId, number: t.number, ordinal: a.ordinal, revision: a.revision, prNumber: t.prNumber } : null
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    }
    if (q.includes("SELECT coalesce(a.pr_number")) {
      const [attId, todoId, repoId, ordinal] = params
      const a = attempts.get(String(attId))
      const t = todos.get(String(todoId))
      if (!a || !t || a.repoId !== String(repoId) || a.ordinal !== Number(ordinal)) return []
      return [{ prNumber: a.prNumber ?? (t.attempt === a.ordinal ? t.prNumber : null) }]
    }
    return []
  })

  return { layer, stacks, todos, attempts, ops }
}

describe("Wave-6 apps/mvp Stack, StackFeed, FleetStore, FleetMcpTools & DeploymentPolicy fuzz", () => {
  it("fuzzes Stack.apply, Stack.report, StackFeed, and all Stack query helpers across full lifecycles", () =>
    property(
      Arbitrary.all({
        title: word,
        lanes: intBetween(1, 3),
        base: Arbitrary.schema(Schema.Literals(["stacked", "independent"])),
        withRuns: bool,
        failRuns: bool,
        withIssue: bool,
        finishState: Arbitrary.schema(Schema.Literals(["merged", "failed"])),
        baseClosed: bool,
        retryAny: bool,
        staleHolds: bool
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const repoId = "github/acme/widgets"
          const actor = { id: "person-1", login: "alice" }
          const otherActor = { id: "person-2", login: "bob" }
          const db = makeStackDb({ baseClosed: s.baseClosed })

          const startedAttempts: Array<Stack.AttemptStart> = []
          const stoppedAttempts: Array<Stack.AttemptStop> = []
          const todoRunsLayer = Layer.succeed(Stack.TodoRuns, {
            start: (att) =>
              s.failRuns
                ? Effect.fail(new Stack.RunsUnavailable({ errorCode: "down" }))
                : Effect.sync(() => {
                  startedAttempts.push(att)
                }),
            stop: (att) =>
              s.failRuns
                ? Effect.fail(new Stack.RunsUnavailable({ errorCode: "down" }))
                : Effect.sync(() => {
                  stoppedAttempts.push(att)
                }),
            isStopped: () => Effect.succeed(true)
          })

          const env = Layer.mergeAll(db.layer, todoRunsLayer)

          yield* Effect.gen(function*() {
            // 1. Configure stack
            const cfgOp: Stack.Change = {
              opId: crypto.randomUUID(),
              repoId,
              actor,
              via: "person",
              op: { kind: "configure", lanes: s.lanes, maxOpen: 5, base: s.base }
            }
            const cfgRes = yield* Stack.apply(cfgOp, { runs: s.withRuns })
            expect(cfgRes.kind).toBe("applied")

            // Stale holds refuses without mutating
            if (s.staleHolds) {
              const staleRes = yield* Stack.apply(
                { opId: crypto.randomUUID(), repoId, actor, via: "person", op: { kind: "drop", number: 99 } },
                { runs: false, holds: Effect.succeed(false) }
              )
              expect(staleRes.kind).toBe("stale")
            }

            // 2. Commit TODO #1 (and verify idempotent replay + conflict on same opId!)
            const op1Id = crypto.randomUUID()
            const commit1: Stack.Change = {
              opId: op1Id,
              repoId,
              actor,
              via: "person",
              op: {
                kind: "commit",
                title: s.title,
                prompt: `Do ${s.title}`,
                acceptance: ["passes"],
                ...(s.withIssue ? { issue: 42 } : {})
              }
            }
            const res1Exit = yield* Effect.exit(Stack.apply(commit1, { runs: s.withRuns }))
            // Stack.apply commits the transaction and returns starts; route invokes TodoRuns outside tx.
            expect(Exit.isSuccess(res1Exit)).toBe(true)
            const res1 = Exit.isSuccess(res1Exit) ? res1Exit.value : null!
            expect(res1.kind).toBe("applied")

            // Repeated identical opId returns "repeated"
            const rep1 = yield* Stack.apply(commit1, { runs: s.withRuns })
            expect(rep1.kind).toBe("repeated")

            // Conflicting payload under same opId returns "conflict"
            const conf1 = yield* Stack.apply({
              ...commit1,
              op: { kind: "commit", title: "other", prompt: "other", acceptance: [] }
            }, { runs: s.withRuns })
            expect(conf1.kind).toBe("conflict")

            // Attach issue when TODO #1 had none (or try when it already has one)
            const attachRes = yield* Stack.apply({
              opId: crypto.randomUUID(),
              repoId,
              actor,
              via: "person",
              op: { kind: "attach", number: 1, issue: 77 }
            }, { runs: false })
            expect(attachRes.kind).toBe("applied")

            // Commit TODO #2 stacked after #1
            const op2Id = crypto.randomUUID()
            const commit2: Stack.Change = {
              opId: op2Id,
              repoId,
              actor,
              via: "agent",
              op: {
                kind: "commit",
                title: `${s.title}-2`,
                prompt: "Second",
                acceptance: [],
                after: 1,
                ...(s.withIssue ? { issue: 42 } : {})
              }
            }
            const res2 = yield* Stack.apply(commit2, { runs: s.withRuns })
            expect(res2.kind).toBe("applied")

            // Commit TODO #3 to have queued item
            const op3Id = crypto.randomUUID()
            yield* Stack.apply({
              opId: op3Id,
              repoId,
              actor,
              via: "person",
              op: { kind: "commit", title: `${s.title}-3`, prompt: "Third", acceptance: [] }
            }, { runs: s.withRuns })

            // RetryForbidden when non-owner retries without retryAny
            const forbiddenExit = yield* Effect.exit(
              Stack.apply({
                opId: crypto.randomUUID(),
                repoId,
                actor: otherActor,
                via: "person",
                op: { kind: "retry", number: 1 },
                retryAny: s.retryAny
              }, { runs: false })
            )
            expect(Exit.isFailure(forbiddenExit)).toBe(!s.retryAny)

            // If TODO #1 started an attempt, drive ALL Stack.report events & query helpers!
            if (res1.kind === "applied" && res1.receipt.starts.length > 0) {
              const start1 = res1.receipt.starts[0]!
              const runAttempt: Stack.RunAttempt = {
                attemptId: start1.attemptId,
                todoId: start1.todoId,
                repoId,
                ordinal: start1.ordinal
              }

              // Query helpers
              const attTodo = yield* Stack.attemptTodo(runAttempt)
              expect(Option.isSome(attTodo)).toBe(true)
              expect(yield* Stack.retryCandidate(repoId, 1)).toBe(start1.attemptId)
              expect(typeof (yield* Stack.openAboveFromIssue(runAttempt))).toBe("number")

              // Report: step, waiting, branch, published (x2 for replay!), finished (x2 + conflicting)
              const rStep = yield* Stack.report(runAttempt, { kind: "step", step: "implement" }, { runs: s.withRuns })
              expect(["applied", "base_closed"]).toContain(rStep.outcome)
              const rWait = yield* Stack.report(runAttempt, { kind: "waiting", waiting: "runner" }, { runs: s.withRuns })
              expect(["applied", "base_closed"]).toContain(rWait.outcome)
              const rBranch = yield* Stack.report(
                runAttempt,
                { kind: "branch", branch: "smithers/todo-1", baseSha: "abc123", baseRef: "main" },
                { runs: s.withRuns }
              )
              expect(["applied", "base_closed"]).toContain(rBranch.outcome)

              if (!s.baseClosed) {
                const rPub1 = yield* Stack.report(
                  runAttempt,
                  { kind: "published", headSha: "def456", prNumber: 101, draft: false },
                  { runs: s.withRuns }
                )
                expect(rPub1.outcome).toBe("applied")
                const rPub2 = yield* Stack.report(
                  runAttempt,
                  { kind: "published", headSha: "def789", prNumber: 101, draft: false },
                  { runs: s.withRuns }
                )
                expect(rPub2.outcome).toBe("repeated")
                // waiting after publish (in_review) is stale
                const rWaitStale = yield* Stack.report(runAttempt, { kind: "waiting", waiting: null }, { runs: s.withRuns })
                expect(rWaitStale.outcome).toBe("stale")

                expect(yield* Stack.attemptPull(runAttempt)).toBe(101)
                expect(Option.isSome(yield* Stack.baseTodoOf(repoId, "smithers/todo-1"))).toBe(true)
                expect(Option.isSome(yield* Stack.belowOf({ attemptId: "x", todoId: op2Id, repoId, ordinal: 1 }))).toBe(true)
                expect(Array.isArray(yield* Stack.publishedStarts(runAttempt))).toBe(true)

                // Finish event + idempotent repeat + conflicting finish stale
                const finEvent: Stack.RunEvent = s.finishState === "merged"
                  ? { kind: "finished", state: "merged" }
                  : { kind: "finished", state: "failed", failure: "base_closed" }
                const rFin1 = yield* Stack.report(runAttempt, finEvent, { runs: s.withRuns })
                expect(rFin1.outcome).toBe("applied")
                const rFin2 = yield* Stack.report(runAttempt, finEvent, { runs: s.withRuns })
                expect(rFin2.outcome).toBe("repeated")
                const rFinBad = yield* Stack.report(
                  runAttempt,
                  { kind: "finished", state: "failed", failure: "implement" },
                  { runs: s.withRuns }
                )
                expect(rFinBad.outcome).toBe("stale")

                // descendants on closed branch
                const desc = yield* Stack.descendants({ attemptId: start1.attemptId, todoId: start1.todoId, baseClosed: true })
                expect(Array.isArray(desc)).toBe(true)
              }
            }

            // Drop TODO #3 + drop nonexistent #999 (refusal!)
            const drop3 = yield* Stack.apply({
              opId: crypto.randomUUID(),
              repoId,
              actor,
              via: "person",
              op: { kind: "drop", number: 3 }
            }, { runs: s.withRuns })
            expect(drop3.kind).toBe("applied")

            const dropMiss = yield* Stack.apply({
              opId: crypto.randomUUID(),
              repoId,
              actor,
              via: "person",
              op: { kind: "drop", number: 999 }
            }, { runs: false })
            expect(dropMiss.kind).toBe("applied")
            if (dropMiss.kind === "applied") {
              expect(Stack.isRefusal(dropMiss.receipt.outcome)).toBe(true)
            }

            // StackFeed duplicate foldCommit returns 0
            expect(yield* foldCommit({ opId: op1Id, repoId, actorId: actor.id, number: 1 })).toBe(0)
          }).pipe(Effect.provide(env))
        })
    ))

  it("fuzzes DeploymentPolicy, FleetStore, and FleetMcpTools across all tools, redaction, and auth boundaries", () =>
    property(
      Arbitrary.all({
        login: Arbitrary.schema(Schema.Literals(["roninjin10", "alice", "BOB", "  ", ""])),
        owner: Arbitrary.schema(Schema.Literals(["alice", "bob", "acme"])),
        rawRole: Arbitrary.schema(Schema.Literals(["admin", "maintainer", "member", "guest", "none"])),
        replaceActive: bool,
        includeEnded: bool,
        hasSandbox: bool,
        dbDown: bool,
        toolName: Arbitrary.schema(Schema.Literals(["fleet_heartbeat", "fleet_sessions_report", "fleet_accounts_report", "fleet_overview"])),
        validArgs: bool,
        hasScope: bool
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          // 1. DeploymentPolicy pure & Config functions
          const parsedEmpty = DeploymentPolicy.parseAdminLogins(" , ")
          expect(parsedEmpty.size).toBe(DeploymentPolicy.DEFAULT_ADMINS.size)
          const parsedCustom = DeploymentPolicy.parseAdminLogins("RoninJin10, OpsAdmin")
          expect(parsedCustom.has("opsadmin")).toBe(true)
          expect(parsedCustom.has("roninjin10")).toBe(true)

          const cfgAdmins = yield* DeploymentPolicy.configuredAdmins().pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { DEPLOYMENT_ADMIN_LOGINS: "roninjin10,admin2" } })))
          )
          expect(cfgAdmins.has("admin2")).toBe(true)

          const actor = {
            id: "u1",
            login: s.login || undefined,
            kind: "person"
          } as never
          const isPolicyAdmin = DeploymentPolicy.isDeploymentAdmin(s.login || undefined, parsedCustom)
          expect(DeploymentPolicy.holdsDeploymentAuthority(actor, parsedCustom)).toBe(isPolicyAdmin)

          const reqAdminExit = yield* Effect.exit(
            DeploymentPolicy.requireDeploymentAdmin(actor, parsedCustom)
          )
          expect(Exit.isSuccess(reqAdminExit)).toBe(isPolicyAdmin)

          // 2. FleetStore.scrubText secret redaction
          expect(FleetStore.scrubText(null, 50)).toBeNull()
          expect(FleetStore.scrubText("   \n\t ", 50)).toBeNull()
          const scrubbed = FleetStore.scrubText("hi ghp_1234567890abcdef Bearer abcdef1234567890 TOKEN=xyz end", 200)
          expect(scrubbed).not.toContain("ghp_")
          expect(scrubbed).not.toContain("abcdef1234567890")
          expect(scrubbed).not.toContain("TOKEN=xyz")

          // 3. FleetStore + FleetMcpTools over stateful in-memory SQL layer
          expect(FleetMcpTools.isFleetTool(s.toolName)).toBe(true)
          expect(FleetMcpTools.isFleetTool("other_tool")).toBe(false)
          expect(FleetMcpTools.FLEET_TOOL_DESCRIPTORS.length).toBe(4)

          const nodes = new Map<string, Record<string, unknown>>()
          const sessions = new Map<string, Record<string, unknown>>()
          const accounts = new Map<string, Record<string, unknown>>()

          const fleetDb = makeSqlLayer((raw, params) => {
            if (s.dbDown) return new Error("pg unavailable")
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("INSERT INTO host_nodes")) {
              nodes.set(String(params[0]), { nodeId: String(params[0]), name: String(params[1]), kind: String(params[2]), online: true })
              return []
            }
            if (q.includes("INSERT INTO observed_sessions")) {
              sessions.set(String(params[0]), { sessionKey: String(params[0]), nodeId: String(params[1]), status: "working" })
              return []
            }
            if (q.includes("UPDATE observed_sessions SET status =")) return []
            if (q.includes("INSERT INTO provider_accounts")) {
              accounts.set(String(params[0]), { accountKey: String(params[0]), provider: String(params[1]), label: String(params[2]) })
              return []
            }
            if (q.includes("FROM host_nodes")) return [...nodes.values()]
            if (q.includes("FROM observed_sessions")) return [...sessions.values()]
            if (q.includes("FROM provider_accounts")) return [...accounts.values()]
            if (q.includes("FROM sandbox_generations")) {
              return s.hasSandbox
                ? [{ id: "sb-1", branchId: "github/acme/app#main", generation: 3, kind: "branch", instance: "i1", startedAt: "2026-01-01T00:00:00Z", seenAt: "2026-01-01T00:01:00Z", endedAt: null }]
                : []
            }
            return []
          })

          // Direct FleetStore operations when DB is up
          if (!s.dbDown) {
            yield* Effect.gen(function*() {
              const up = yield* FleetStore.upsertHostNode({
                nodeId: "mac-1",
                name: "MacBook Pro",
                kind: "macbook",
                labels: ["local", "gpu"],
                online: true,
                held: null,
                load1: 1.5,
                cpuCores: 12,
                memUsedGb: 24,
                memTotalGb: 64,
                diskFreeGb: 500,
                diskTotalGb: 1000,
                activeSessions: 2,
                runnerCapacity: 4,
                version: "1.0.0"
              })
              expect(up.nodeId).toBe("mac-1")

              const repSess = yield* FleetStore.reportSessions({
                nodeId: "mac-1",
                replaceActive: s.replaceActive,
                sessions: [{
                  sessionKey: "mac-1:claude:1",
                  managed: true,
                  harness: "claude",
                  model: "opus",
                  accountLabel: "main",
                  repo: "smithers",
                  lane: "fuzz-100",
                  title: "Fuzzing ghp_secret1234567890",
                  status: "working",
                  pid: 1234,
                  cpuSeconds: 12.5,
                  tokensUsed: 5000
                }]
              })
              expect(repSess.reported).toBe(1)

              const repAcc = yield* FleetStore.reportAccounts({
                sourceNode: "mac-1",
                accounts: [{
                  accountKey: "claude:main",
                  provider: "claude",
                  label: "main",
                  plan: "max",
                  status: "ready",
                  fiveHourPct: 12,
                  weeklyPct: 34,
                  scopedPct: 5,
                  creditsBalance: 100,
                  activeSessions: 1,
                  pools: ["default"],
                  coolReason: null
                }]
              })
              expect(repAcc.reported).toBe(1)

              const ov = yield* FleetStore.readOverview(s.includeEnded)
              expect(ov.nodes.length).toBe(s.hasSandbox ? 2 : 1)
              expect(ov.sessions.length).toBe(s.hasSandbox ? 2 : 1)
              expect(ov.accounts.length).toBe(1)
            }).pipe(Effect.provide(fleetDb))
          }

          // FleetMcpTools.callFleetTool across all 4 tools & auth/validation boundaries
          const principal: McpPrincipal | undefined = s.login.trim() === ""
            ? undefined
            : {
              tokenId: "tok-1",
              personId: "p-1",
              login: s.login,
              scopes: s.hasScope ? ["mcp:read", "mcp:write"] : []
            } as unknown as McpPrincipal
          const ctx: McpToolContext = {
            principal: Option.fromNullishOr(principal)
          } as unknown as McpToolContext

          const rawArgs = !s.validArgs
            ? { invalid: true }
            : s.toolName === "fleet_heartbeat"
            ? { nodeId: "n1", name: "Node 1", kind: "macbook" }
            : s.toolName === "fleet_sessions_report"
            ? { nodeId: "n1", sessions: [], replaceActive: s.replaceActive }
            : s.toolName === "fleet_accounts_report"
            ? { sourceNode: "n1", accounts: [] }
            : { includeEnded: s.includeEnded }

          const callExit = yield* Effect.exit(FleetMcpTools.callFleetTool(s.toolName, rawArgs, ctx, fleetDb))
          const isAdmin = principal !== undefined && DeploymentPolicy.isDeploymentAdmin(principal.login)
          const shouldPass = isAdmin && s.hasScope && (s.validArgs || s.toolName === "fleet_overview") && !s.dbDown
          expect(Exit.isSuccess(callExit)).toBe(shouldPass)
        })
    ))
})
