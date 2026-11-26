// Generated properties for the sandbox ledger (worker/branch/Budget.ts) and a branch's permission list
// (worker/branch/Access.ts) on this file's schema of the compose Postgres, and for the pure rules beside them: the
// token permissions a step asks GitHub for, the parent an issue names, and the navigation and file-tab steps. Each
// property computes what should happen from the scenario alone and compares the exact outcome and the stored rows.
import { Fuzz } from "@smthrs/fuzz"
import { FlowRuntime } from "@smthrs/flow"
import { Arbitrary, Effect, Exit, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as FilesFlows from "../src/features/files/flows.ts"
import type { FilesCall } from "../src/features/files/schema.ts"
import * as NavFlows from "../src/features/navigation/flows.ts"
import { DEFAULT_SANDBOX_LIMITS } from "../src/features/spend/contract.ts"
import * as StatusFlows from "../src/features/status/flows.ts"
import type { Actor, Role } from "./Actor.ts"
import * as Access from "./branch/Access.vibe"
import * as Budget from "./branch/Budget.vibe"
import * as Conversations from "./branch/Conversations.vibe"
import * as GitHubStore from "./github/Store.vibe"
import * as GitHubTokens from "./github/Tokens.vibe"
import { testFile } from "./test/harness.ts"

const runtime = testFile("generated_budget_access")

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? 20261151)
const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 100)
/** A property that asks Postgres many times per scenario runs fewer of them. */
const stored = Math.max(10, Math.ceil(executions / 4))

const int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const PEOPLE = ["maya", "ben"] as const
const ROLES = ["admin", "maintainer", "member", "guest"] as const
const Grant = Schema.Literals(["none", "view", "edit"])

const Op = Schema.Struct({
  kind: Schema.Literals(["admit", "started", "seen", "ended", "release", "expire"]),
  branch: int(0, 3),
  person: Schema.Literals(["maya", "ben", "nobody"]),
  slot: Schema.Literals(["branch", "todo"]),
  generation: int(1, 2),
})

/** One ledger row as the test expects Postgres to hold it. */
interface Expected {
  readonly branchId: string
  readonly personId: string | null
  readonly kind: string
  generation: number | null
  instance: string | null
  open: boolean
  /** Renewed within the lease. Meaningful only while `open`. */
  live: boolean
}

test("the sandbox ledger admits, waits, renews and closes exactly as its rules say for each generated history", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    awake: int(1, 3),
    perPerson: int(1, 2),
    alert: int(0, 500),
    length: int(1, 8),
    ops: Schema.Tuple([Op, Op, Op, Op, Op, Op, Op, Op]),
  }))
  const report = await runtime.runPromise(Fuzz.run(scenarios, scenario => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`TRUNCATE sandbox_generations, sandbox_limits`
    expect(yield* Budget.limits).toEqual(DEFAULT_SANDBOX_LIMITS)
    const limit = { awake: scenario.awake, perPerson: scenario.perPerson, monthlyAlertUsd: scenario.alert }
    expect(Number.isSafeInteger(yield* Budget.setLimits(limit, "person-admin"))).toBe(true)
    expect(yield* Budget.limits).toEqual(limit)
    expect(yield* sql`SELECT updated_by AS "updatedBy" FROM sandbox_limits`).toEqual([{ updatedBy: "person-admin" }])

    const rows: Array<Expected> = []
    const openOf = (branchId: string) => rows.find(row => row.branchId === branchId && row.open)
    const awakeCount = () => rows.filter(row => row.open && row.live).length
    for (const op of scenario.ops.slice(0, scenario.length)) {
      const branchId = `branch-${op.branch}`
      const personId = op.person === "nobody" ? null : op.person
      const instance = op.generation === 1 ? "lite" : "standard-1"
      const open = openOf(branchId)
      if (op.kind === "admit") {
        const admission = yield* Budget.admit({ branchId, personId, kind: op.slot })
        if (open?.live === true) {
          expect(admission).toEqual({ _tag: "Admitted", awake: awakeCount() })
        } else {
          if (open !== undefined) open.open = false
          const awake = awakeCount()
          const mine = rows.filter(row => row.open && row.live && row.kind === "branch" && row.personId === personId).length
          if (awake >= limit.awake) {
            expect(admission).toEqual({ _tag: "Waiting", scope: "deployment", awake, limit: limit.awake })
          } else if (op.slot === "branch" && personId !== null && mine >= limit.perPerson) {
            expect(admission).toEqual({ _tag: "Waiting", scope: "person", awake, limit: limit.perPerson })
          } else {
            expect(admission).toEqual({ _tag: "Admitted", awake: awake + 1 })
            rows.push({ branchId, personId, kind: op.slot, generation: null, instance: null, open: true, live: true })
          }
        }
      } else if (op.kind === "started") {
        yield* Budget.started({ branchId, personId, kind: op.slot, generation: op.generation, instance })
        if (open !== undefined && open.generation === op.generation) {
          open.live = true
        } else if (open !== undefined && open.generation === null) {
          Object.assign(open, { generation: op.generation, instance, live: true })
        } else {
          if (open !== undefined) open.open = false
          rows.push({ branchId, personId, kind: op.slot, generation: op.generation, instance, open: true, live: true })
        }
      } else if (op.kind === "seen") {
        yield* Budget.seen(branchId, op.generation)
        if (open?.generation === op.generation) open.live = true
      } else if (op.kind === "ended") {
        yield* Budget.ended(branchId, op.generation)
        if (open?.generation === op.generation) open.open = false
      } else if (op.kind === "release") {
        yield* Budget.release(branchId)
        if (open !== undefined && open.generation === null) open.open = false
      } else {
        // The lease runs out: nobody renewed the branch's open slot for longer than `LEASE_SECONDS`.
        yield* sql`
          UPDATE sandbox_generations SET started_at = started_at - make_interval(secs => ${Budget.LEASE_SECONDS + 1}),
            seen_at = seen_at - make_interval(secs => ${Budget.LEASE_SECONDS + 1})
          WHERE branch_id = ${branchId} AND ended_at IS NULL`
        if (open !== undefined) open.live = false
      }
      const held = yield* sql<Expected>`
        SELECT branch_id AS "branchId", person_id AS "personId", kind, generation, instance, ended_at IS NULL AS open,
          ended_at IS NULL AND seen_at > now() - make_interval(secs => ${Budget.LEASE_SECONDS}) AS live
        FROM sandbox_generations ORDER BY id`
      expect(held, `after ${op.kind} on ${branchId}`).toEqual(rows.map(row => ({ ...row, live: row.open && row.live })))
      expect(yield* Budget.awake).toBe(awakeCount())
    }
    return true
  }), { seed, executions: stored }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

/** What a person may do on a branch, restated from decision 0013 rather than from `accessOf`'s arithmetic. */
const allowed = (
  person: string,
  role: Role | null,
  branch: { readonly createdBy: string | null; readonly own: "none" | "view" | "edit"; readonly link: "none" | "view" | "edit" },
): "owner" | "edit" | "view" | "none" => {
  if (role === null) return "none"
  // A Guest opens a branch only when it is shared with them by name, and only to view.
  if (role === "guest") return branch.own === "none" ? "none" : "view"
  if (branch.createdBy === person) return "owner"
  if (branch.own === "edit" || branch.link === "edit") return "edit"
  return branch.own === "view" || branch.link === "view" ? "view" : "none"
}

let branches = 0

test("a stored branch's permission list gives every person and role exactly the access its shares allow", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    owner: Schema.Literals(["maya", "ben", "team"]),
    mode: Schema.Literals(["open", "locked", "restricted"]),
    maya: Grant,
    ben: Grant,
    link: Grant,
  }))
  const report = await runtime.runPromise(Fuzz.run(scenarios, scenario => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { branch } = yield* Conversations.track(
      "octo/hello", `generated-${branches++}`, scenario.mode, "a".repeat(40), scenario.owner === "team" ? undefined : scenario.owner,
    )
    // A locked branch and the team's have no creator, and start shared for editing with the repository's link.
    const createdBy = scenario.mode === "locked" || scenario.owner === "team" ? null : scenario.owner
    const grants: Record<string, "view" | "edit"> = createdBy === null ? { repository: "edit" } : {}
    for (const [grantee, access] of [["maya", scenario.maya], ["ben", scenario.ben], ["repository", scenario.link]] as const) {
      if (access === "none") continue
      grants[grantee] = access
      yield* sql`
        INSERT INTO branch_shares (branch_id, grantee, login, access)
        VALUES (${branch.branchId}, ${grantee}, ${grantee === "repository" ? null : grantee}, ${access})
        ON CONFLICT (branch_id, grantee) DO UPDATE SET access = EXCLUDED.access`
    }
    const policy = yield* Access.policyOf(branch.branchId)
    expect(policy).toEqual({ createdBy, grants })
    for (const person of [...PEOPLE, "stranger"]) {
      for (const role of [...ROLES, null]) {
        const expected = allowed(person, role, { createdBy, own: grants[person] ?? "none", link: grants["repository"] ?? "none" })
        const access = Access.underPolicy(policy, person, role)
        expect(access, `${person} as ${role}`).toBe(expected)
        expect(Access.canView(access)).toBe(expected !== "none")
        expect(Access.canEdit(access)).toBe(expected === "owner" || expected === "edit")
        const actor: Actor = { subject: { kind: "person", id: person }, role }
        expect(Access.accessOf(Option.some(actor), { createdBy, person: grants[person] ?? null, repository: grants["repository"] ?? null })).toBe(expected)
        expect(Access.isMember(Option.some(actor))).toBe(role !== null && role !== "guest")
      }
    }
    // Signed out, nobody gets in, whatever the branch shares.
    expect(Access.accessOf(Option.none(), { createdBy, person: "edit", repository: "edit" })).toBe("none")
    expect(Access.isMember(Option.none())).toBe(false)
    // A branch nobody recorded shares nothing.
    expect(yield* Access.policyOf(crypto.randomUUID())).toEqual({ createdBy: null, grants: {} })
    return true
  }), { seed, executions: stored }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const WRITES: Readonly<Record<GitHubTokens.Access, ReadonlyArray<string>>> = {
  read: [], write: ["issues"], contents: [], pulls: [], publish: ["pull_requests", "contents"], review: ["pull_requests"],
  status: ["statuses"], metadata: [],
}

test("a step's GitHub token writes only what it names, a month holds its instant, and an issue URL names one parent", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    access: Schema.Literals(["read", "write", "contents", "pulls", "publish", "review", "status", "metadata"]),
    at: int(Date.UTC(2020, 0, 1), Date.UTC(2040, 0, 1)),
    owner: Schema.Literals(["octo", "acme-co", "a.b"]),
    name: Schema.Literals(["hello", "wid_gets", "x"]),
    number: int(0, 100_000),
    suffix: Schema.Literals(["", "?per_page=1", "#top", "/comments", "x"]),
    instance: Schema.Literals(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4", "unknown"]),
    owned: Schema.Literals(["maya", "", "absent"]),
  }))
  const report = await Effect.runPromise(Fuzz.run(scenarios, scenario => Effect.sync(() => {
    const permissions = GitHubTokens.permissionsOf(scenario.access)
    expect(Object.entries(permissions).filter(([, level]) => level === "write").map(([name]) => name).sort())
      .toEqual([...WRITES[scenario.access]].sort())
    expect(Object.keys(permissions).length).toBeGreaterThan(0)

    const month = Budget.monthOf(scenario.at)
    expect(month.label).toBe(new Date(scenario.at).toISOString().slice(0, 7))
    expect(month.from <= scenario.at && scenario.at < month.until).toBe(true)
    expect(new Date(month.from).toISOString().slice(7)).toBe("-01T00:00:00.000Z")
    expect(Budget.monthOf(month.until).from).toBe(month.until)
    expect(Budget.monthOf(month.until - 1).label).toBe(month.label)

    const sizes = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"]
    const at = sizes.indexOf(scenario.instance)
    const price = Budget.pricePerSecond(scenario.instance)
    // An instance type the table doesn't know is priced as the largest, so spend is never understated.
    if (at === -1) expect(price).toBe(Budget.pricePerSecond("standard-4"))
    else if (at > 0) expect(price).toBeGreaterThan(Budget.pricePerSecond(sizes[at - 1]!))
    else expect(price).toBeCloseTo(0.000002015, 12)

    expect(Budget.personOf(scenario.owned === "absent" ? undefined : scenario.owned)).toBe(scenario.owned === "maya" ? "maya" : null)

    const url = `https://api.github.com/repos/${scenario.owner}/${scenario.name}/issues/${scenario.number}${scenario.suffix}`
    // GitHub has no owner with a dot, so a URL under one names no issue this app could read.
    const named = scenario.owner !== "a.b" && scenario.number >= 1 && ["", "?per_page=1", "#top"].includes(scenario.suffix)
    expect(GitHubStore.parentNamed(url)).toEqual(named
      ? {
        repoId: `github/${scenario.owner}/${scenario.name}`,
        number: scenario.number,
        owner: scenario.owner,
        name: scenario.name,
        id: `github/${scenario.owner}/${scenario.name}#${scenario.number}`,
      }
      : undefined)
    return true
  }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const instanceOf = (executionId: string) => ({ executionId }) as FlowRuntime.FlowInstance["Service"]

/** The error a failed exit carries, or undefined for a success. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined

test("navigation and file steps ask only the tab that started the run, for app paths only, and report what it did", async () => {
  const origin = "https://smithers.test"
  const scenarios = Arbitrary.schema(Schema.Struct({
    to: Schema.Literals(["path", "bare", "own-url", "other-origin", "script", "broken"]),
    word: Schema.Literals(["alpha", "beta", "gamma"]),
    agent: Schema.Boolean,
    tab: Schema.Literals(["gone", "did", "did-not", "no-repository"]),
    leading: int(0, 2),
    trailing: int(0, 2),
    lines: Schema.Literals(["none", "12", "10-20"]),
    status: int(100, 599),
  }))
  const report = await Effect.runPromise(Fuzz.run(scenarios, scenario => Effect.gen(function* () {
    const executionId = scenario.agent ? `answer-1/chat/Respond@v1/call/0.1` : "dispatch-1"
    const requester = scenario.agent ? "answer-1" : "dispatch-1"

    const to = {
      path: `/octo/${scenario.word}?L=3#top`,
      bare: `octo/${scenario.word}`,
      "own-url": `${origin}//octo/${scenario.word}`,
      "other-origin": `https://evil.example/octo/${scenario.word}`,
      script: "javascript:alert(1)",
      broken: "http://[::1",
    }[scenario.to]
    const path = { path: `/octo/${scenario.word}?L=3#top`, bare: `/octo/${scenario.word}`, "own-url": `/octo/${scenario.word}` }[
      scenario.to as "path" | "bare" | "own-url"
    ] as string | undefined
    const reason = { "other-origin": "origin", script: "scheme", broken: "invalid" }[
      scenario.to as "other-origin" | "script" | "broken"
    ] as string | undefined
    const asked: Array<unknown> = []
    const moved = scenario.tab === "did"
    const navigated = yield* Effect.exit(NavFlows.goTo({ to }).pipe(
      Effect.provideService(NavFlows.Tabs, NavFlows.Tabs.of({
        origin,
        ask: (call) => Effect.sync(() => {
          asked.push(call)
          return scenario.tab === "gone" ? Option.none() : Option.some({ door: "composer" as const, moved })
        }),
      })),
      Effect.provideService(FlowRuntime.FlowInstance, instanceOf(executionId)),
    ))
    // The tab is told to stay (no path) for a refused target, and never hears the target itself.
    expect(asked).toStrictEqual([path === undefined ? { requester } : { requester, path }])
    if (path === undefined) {
      expect(failureOf(navigated)).toMatchObject({ _tag: "@smthrs/mvp/navigation/NavigationRefused", reason })
    } else {
      expect(navigated).toStrictEqual(Exit.succeed({ path, moved }))
    }

    const raw = `${"/".repeat(scenario.leading)}src/${scenario.word}.ts${"/".repeat(scenario.trailing)}`
    const file = `src/${scenario.word}.ts`
    expect(FilesFlows.normalPath(raw)).toBe(file)
    const lines = scenario.lines === "none" ? undefined : scenario.lines
    const calls: Array<{ readonly requester: string; readonly call: FilesCall }> = []
    const reply = scenario.tab === "no-repository"
      ? { repository: null, ref: null, done: false }
      : { repository: "octo/hello", ref: "main", done: scenario.tab === "did" }
    const tabs = FilesFlows.FileTabsTabs.of({
      ask: (from, call) => Effect.sync(() => {
        calls.push({ requester: from, call })
        return scenario.tab === "gone" ? Option.none() : Option.some({ door: "button" as const, reply })
      }),
    })
    const provided = <A, E>(step: Effect.Effect<A, E, FilesFlows.FileTabsTabs | FlowRuntime.FlowInstance>) =>
      Effect.exit(step.pipe(
        Effect.provideService(FilesFlows.FileTabsTabs, tabs),
        Effect.provideService(FlowRuntime.FlowInstance, instanceOf(executionId)),
      ))
    const opened = yield* provided(FilesFlows.openFile({ path: raw, lines }))
    const closed = yield* provided(FilesFlows.closeFile({ path: raw }))
    expect(calls).toStrictEqual([
      { requester, call: { op: "open", path: file, ...(lines === undefined ? {} : { lines }) } },
      { requester, call: { op: "close", path: file } },
    ])
    if (scenario.tab === "no-repository") {
      expect(failureOf(opened)).toMatchObject({ _tag: "@smthrs/mvp/files/NotInRepository" })
      expect(failureOf(closed)).toMatchObject({ _tag: "@smthrs/mvp/files/NotInRepository" })
    } else {
      const there = scenario.tab !== "gone"
      expect(opened).toStrictEqual(Exit.succeed({
        repository: there ? "octo/hello" : "", ref: there ? "main" : "", path: file, lines: lines ?? null, opened: scenario.tab === "did",
      }))
      expect(closed).toStrictEqual(Exit.succeed({ closed: scenario.tab === "did" }))
    }

    // A 4xx is final but for a timeout and a rate limit, which say to try again.
    const final = String(scenario.status).startsWith("4") && scenario.status !== 408 && scenario.status !== 429
    expect(StatusFlows.isRefusal(scenario.status)).toBe(final)
    expect(StatusFlows.isRefusal(undefined)).toBe(false)
    return true
  }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})
