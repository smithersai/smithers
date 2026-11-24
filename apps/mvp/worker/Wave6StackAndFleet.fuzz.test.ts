// Generated stack changes, fleet tool calls and deployment-admin checks. The stack and the fleet run on this file's
// schema of the compose Postgres (`pnpm db:up`). Each outcome and every row a call leaves is checked against a model
// the test keeps of its own: what the scenario says must happen, never what the code under test computed.
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Exit, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { beforeAll, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import scrubFleetTranscripts from "../db/migrations/0131_scrub_fleet_transcripts.ts"
import type { Actor } from "./Actor.ts"
import * as DeploymentPolicy from "./DeploymentPolicy.vibe"
import * as FleetMcpTools from "./fleet/FleetMcpTools.vibe"
import * as FleetStore from "./fleet/FleetStore.vibe"
import type { McpPrincipal } from "./mcp/Contract.ts"
import * as Stack from "./stack/Stack.ts"
import { testFile, uuid } from "./test/harness.ts"

const runtime = testFile("wave6_stack_fleet")

// Migration 0131 creates the fleet's snapshot staging table. It can run again on a schema that already has it.
beforeAll(() => runtime.runPromise(scrubFleetTranscripts))

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? 20261128)
const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 100)

const maya = { id: "person-maya", login: "maya" }
const ada = { id: "person-ada", login: "ada" }

const StackScenario = Schema.Struct({
  maxOpen: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  steps: Schema.Array(Schema.Struct({
    kind: Schema.Literals(["commit", "drop", "retry", "replay", "conflict"]),
    number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
    byAda: Schema.Boolean,
    retryAny: Schema.Boolean,
  })).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
})

/** A TODO as the test's model holds it: on a host that runs no TODOs it is Queued until someone drops it. */
interface ModelTodo {
  readonly id: string
  readonly number: number
  readonly createdBy: string
  state: "queued" | "dropped"
  settledBy: string | null
}

test("a stack on a host that runs no TODOs answers and stores each generated change as the model says", async () => {
  const report = await runtime.runPromise(Fuzz.run(Arbitrary.schema(StackScenario), (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const repoId = `github/fuzz/${uuid()}`
      const todos: Array<ModelTodo> = []
      const recorded: Array<{ readonly change: Stack.Change; readonly receipt: Stack.Receipt }> = []
      let nextNumber = 1
      let version = 0

      /** What Postgres holds must be what the model holds: the TODOs, the stack's counters and every receipt. */
      const stored = Effect.gen(function* () {
        const open = todos.filter((todo) => todo.state === "queued")
        expect(yield* sql`
          SELECT id::text AS id, number, state, position, created_by AS "createdBy", settled_by AS "settledBy"
          FROM todos WHERE repo_id = ${repoId} ORDER BY number`).toEqual(todos.map((todo) => ({
            ...todo,
            position: todo.state === "queued" ? open.indexOf(todo) + 1 : null,
          })))
        expect(yield* sql`
          SELECT next_number AS "nextNumber", version::int AS version, max_open AS "maxOpen", lanes
          FROM stacks WHERE repo_id = ${repoId}`).toEqual([{ nextNumber, version, maxOpen: scenario.maxOpen, lanes: 2 }])
        expect(yield* sql`
          SELECT id::text AS id, actor_id AS "actorId", op, outcome, result
          FROM stack_ops WHERE repo_id = ${repoId}`).toEqual(
            expect.arrayContaining(recorded.map(({ change, receipt }) => ({
              id: change.opId,
              actorId: change.actor.id,
              op: change.op.kind,
              outcome: receipt.outcome,
              result: receipt,
            }))),
          )
        expect(yield* sql`SELECT count(*)::int AS count FROM stack_ops WHERE repo_id = ${repoId}`).toEqual([
          { count: recorded.length },
        ])
      })

      /** Applies `change` and checks its answer: a recorded receipt at the next version, or what `refused` names. */
      const applies = (
        change: Stack.Change,
        expected: Stack.Receipt | { readonly kind: "repeated"; readonly receipt: Stack.Receipt } | "conflict" | "forbidden",
      ) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(Stack.apply(change, { runs: false }))
          if (expected === "forbidden") {
            expect(Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : exit.value)
              .toBeInstanceOf(Stack.RetryForbidden)
          } else {
            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
            const answer = exit.value
            if (expected === "conflict") {
              expect(answer).toEqual({ kind: "conflict" })
            } else if ("kind" in expected) {
              expect(answer).toEqual(expected)
            } else {
              version += 1
              recorded.push({ change, receipt: expected })
              expect(answer.kind === "applied" ? { kind: answer.kind, version: answer.version, receipt: answer.receipt } : answer)
                .toEqual({ kind: "applied", version, receipt: expected })
            }
          }
          yield* stored
        })

      yield* applies(
        { opId: uuid(), repoId, actor: ada, via: "person", op: { kind: "configure", lanes: 2, maxOpen: scenario.maxOpen, base: "independent" } },
        { outcome: "configured", starts: [] },
      )
      for (const step of scenario.steps) {
        const actor = step.byAda ? ada : maya
        const named = todos.find((todo) => todo.number === step.number)
        if (step.kind === "commit") {
          const opId = uuid()
          const full = todos.filter((todo) => todo.state === "queued").length >= scenario.maxOpen
          const receipt: Stack.Receipt = full ? { outcome: "stack_full", starts: [] } : { outcome: "committed", number: nextNumber, starts: [] }
          if (!full) {
            todos.push({ id: opId, number: nextNumber, createdBy: actor.id, state: "queued", settledBy: null })
            nextNumber += 1
          }
          yield* applies(
            { opId, repoId, actor, via: "person", op: { kind: "commit", title: `TODO ${step.number}`, prompt: "Do it.", acceptance: [] } },
            receipt,
          )
        } else if (step.kind === "drop") {
          if (named?.state === "queued") {
            named.state = "dropped"
            named.settledBy = actor.id
          }
          yield* applies(
            { opId: uuid(), repoId, actor, via: "person", op: { kind: "drop", number: step.number } },
            named === undefined ? { outcome: "not_found", starts: [] } : { outcome: "dropped", number: step.number, starts: [] },
          )
        } else if (step.kind === "retry") {
          // Only its own person retries a TODO, unless the route says any may; none here ever failed, so none retries.
          yield* applies(
            { opId: uuid(), repoId, actor, via: "person", op: { kind: "retry", number: step.number }, retryAny: step.retryAny },
            named === undefined
              ? { outcome: "not_found", starts: [] }
              : named.createdBy !== actor.id && !step.retryAny
              ? "forbidden"
              : { outcome: "not_retryable", starts: [] },
          )
        } else {
          const prior = recorded[step.number % recorded.length]!
          yield* step.kind === "replay"
            ? applies(prior.change, { kind: "repeated", receipt: prior.receipt })
            : applies({ ...prior.change, op: { kind: "drop", number: 1_000 + step.number } }, "conflict")
        }
      }
      return true
    }), { seed, executions: Math.min(executions, 60) }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const LinkScenario = Schema.Struct({
  ending: Schema.Literals(["merged", "failed", "dropped", "open"]),
  issue: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9_000 })),
  pull: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9_000 })),
})

test("a TODO made from an issue leaves the issue its session, pull request and merge in the state its ending gives them", async () => {
  const report = await runtime.runPromise(Fuzz.run(Arbitrary.schema(LinkScenario), (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const repoId = `github/fuzz/${uuid()}`
      const [, owner, name] = repoId.split("/")
      const links = sql`
        SELECT kind, ref, state, url, source FROM work_links WHERE repo_id = ${repoId} AND number = ${scenario.issue}
        ORDER BY kind`
      const committed = yield* Stack.apply(
        { opId: uuid(), repoId, actor: maya, via: "person", op: { kind: "commit", title: "T", prompt: "P", acceptance: [], issue: scenario.issue } },
        { runs: true },
      )
      const start = committed.kind === "applied" ? committed.receipt.starts[0] : undefined
      if (start === undefined) return yield* Effect.die("the commit started no attempt")
      const attempt = { attemptId: start.attemptId, todoId: start.todoId, repoId, ordinal: start.ordinal }
      const session = (state: string | null) => ({ kind: "session", ref: "TODO #1", state, url: null, source: "todo:1" })
      const pull = (state: string) => ({
        kind: "pr", ref: `#${scenario.pull}`, state, url: `https://github.com/${owner}/${name}/pull/${scenario.pull}`, source: "todo:1",
      })
      expect(yield* links).toEqual([session("working")])

      const published = yield* Stack.report(attempt, { kind: "published", headSha: "b".repeat(40), prNumber: scenario.pull, draft: false }, { runs: true })
      expect(published).toEqual({ outcome: "applied", starts: [] })
      const merge = "c".repeat(40)
      if (scenario.ending === "merged") {
        expect(yield* Stack.report(attempt, { kind: "finished", state: "merged", note: "merged_on_github", mergeSha: merge }, { runs: true }))
          .toEqual({ outcome: "applied", starts: [] })
      } else if (scenario.ending === "failed") {
        expect(yield* Stack.report(attempt, { kind: "finished", state: "failed", failure: "crashed" }, { runs: true }))
          .toEqual({ outcome: "applied", starts: [] })
      } else if (scenario.ending === "dropped") {
        const dropped = yield* Stack.apply({ opId: uuid(), repoId, actor: maya, via: "person", op: { kind: "drop", number: 1 } }, { runs: true })
        expect(dropped.kind === "applied" ? dropped.receipt : dropped).toEqual({
          outcome: "dropped", number: 1, starts: [], stopped: { attemptId: start.attemptId, todoId: start.todoId },
        })
      }
      expect(yield* links).toEqual({
        merged: [
          { kind: "merge", ref: merge.slice(0, 12), state: "merged", url: `https://github.com/${owner}/${name}/commit/${merge}`, source: "todo:1" },
          pull("merged"),
          session("done"),
        ],
        failed: [pull("closed"), session("failed")],
        dropped: [pull("closed"), session("closed")],
        open: [pull("open"), session(null)],
      }[scenario.ending])
      expect(yield* sql`SELECT state, pr_number AS "prNumber", merge_sha AS "mergeSha" FROM todos WHERE repo_id = ${repoId}`).toEqual([{
        state: scenario.ending === "open" ? "in_review" : scenario.ending,
        prNumber: scenario.pull,
        mergeSha: scenario.ending === "merged" ? merge : null,
      }])
      return true
    }), { seed, executions: Math.min(executions, 40) }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

/** The deployment's admins as its configuration names them: any case, padded, with an empty entry. */
const ADMINS = DeploymentPolicy.parseAdminLogins(" Maya , ops,, ")

/** A credential of each family the fleet's scrubber knows, never issued. */
const CREDENTIALS = {
  github: `ghp_${"a1B2c3D4".repeat(4)}`,
  anthropic: `sk-ant-${"x9Y8z7W6".repeat(3)}`,
  machine: `smm_${"Ab3-_xY9".repeat(6).slice(0, 43)}`,
} as const

/**
 * `text` with its credential gone and a redaction marker in its place. The journal's rules mark a provider key
 * `[REDACTED_API_KEY]` and the fleet's own rule marks the rest `[redacted]`, so the marker's family is not pinned here.
 */
const scrubbed = (before: string, after: string): string =>
  expect.stringMatching(new RegExp(`^${before}\\[redacted(?:_[a-z_]+)?\\]${after}$`, "i")) as string

const FleetScenario = Schema.Struct({
  who: Schema.Literals(["none", "admin", "paddedAdmin", "other"]),
  pinned: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  tool: Schema.Literals(FleetMcpTools.FLEET_TOOL_NAMES),
  valid: Schema.Boolean,
  credential: Schema.Literals(["github", "anthropic", "machine"]),
})

test("a fleet tool runs and stores scrubbed rows only for an unpinned admin token with the tool's scope and valid arguments", async () => {
  const { database } = await runtime.runPromise(Effect.gen(function* () {
    return yield* TestDatabase.Scratch
  }))
  const report = await runtime.runPromise(Fuzz.run(Arbitrary.schema(FleetScenario), (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const known = `known-${uuid()}`
      const fresh = `fresh-${uuid()}`
      const secret = CREDENTIALS[scenario.credential]
      yield* FleetStore.upsertHostNode({ nodeId: known, name: "Known host", kind: "mac-mini" })

      const login = scenario.who === "admin" ? "maya" : scenario.who === "paddedAdmin" ? " MAYA " : "alice"
      const principal: Option.Option<McpPrincipal> = scenario.who === "none" ? Option.none() : Option.some({
        tokenId: "tok-1",
        personId: "p-1",
        login,
        clientName: "fuzz",
        repoScope: scenario.pinned ? "github/octo/hello" : null,
        scopes: [...(scenario.read ? ["mcp:read" as const] : []), ...(scenario.write ? ["mcp:write" as const] : [])],
        actor: { subject: { kind: "person", id: "p-1" }, role: null, login, act: { kind: "agent", id: "mcp:tok-1" } },
      })
      const args: Record<FleetMcpTools.FleetToolName, readonly [valid: unknown, invalid: unknown]> = {
        fleet_heartbeat: [
          { nodeId: fresh, name: `Host ${secret}`, kind: "macbook", held: `held by ${secret}` },
          { nodeId: fresh, name: "Host", kind: "toaster" },
        ],
        fleet_sessions_report: [
          { nodeId: known, sessions: [{ sessionKey: `${fresh}:s1`, harness: "claude", status: "working", title: `Fix ${secret} now` }] },
          { nodeId: known, sessions: [{ sessionKey: `${fresh}:s1`, harness: "claude", status: "napping" }] },
        ],
        fleet_accounts_report: [
          { sourceNode: fresh, accounts: [{ accountKey: fresh, provider: "claude", label: "main", status: "cooling", coolReason: `limit ${secret}` }] },
          { sourceNode: fresh, accounts: [{ accountKey: fresh, provider: "claude", label: "main", status: "asleep" }] },
        ],
        fleet_overview: [{ includeEnded: false }, { includeEnded: "yes" }],
      }
      const scoped = scenario.tool === "fleet_overview" ? scenario.read : scenario.write
      const refusal = scenario.who === "none"
        ? "authentication"
        : scenario.pinned || scenario.who === "other" || !scoped
        ? "forbidden"
        : scenario.valid
        ? undefined
        : "invalid_params"

      const exit = yield* Effect.exit(FleetMcpTools.callFleetTool(
        scenario.tool,
        args[scenario.tool][scenario.valid ? 0 : 1],
        { principal, requestId: "req-1", origin: "https://smithers.test" },
        database,
        ADMINS,
      ))
      expect(Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit))?.code : "ok").toBe(refusal ?? "ok")
      expect(FleetMcpTools.visibleDescriptors(principal, ADMINS).some((tool) => tool.name === scenario.tool)).toBe(
        refusal === undefined || refusal === "invalid_params",
      )

      // Only the admitted call wrote, and what it wrote carries no credential.
      const ran = (tool: FleetMcpTools.FleetToolName) => refusal === undefined && scenario.tool === tool
      expect(yield* sql`SELECT name, held, kind FROM host_nodes WHERE node_id = ${fresh}`).toEqual(
        ran("fleet_heartbeat") ? [{ name: scrubbed("Host ", ""), held: scrubbed("held by ", ""), kind: "macbook" }] : [],
      )
      expect(yield* sql`SELECT node_id AS "nodeId", title, status FROM observed_sessions WHERE session_key = ${`${fresh}:s1`}`).toEqual(
        ran("fleet_sessions_report") ? [{ nodeId: known, title: scrubbed("Fix ", " now"), status: "working" }] : [],
      )
      expect(yield* sql`SELECT source_node AS "sourceNode", status, cool_reason AS "coolReason" FROM provider_accounts WHERE account_key = ${fresh}`)
        .toEqual(ran("fleet_accounts_report") ? [{ sourceNode: fresh, status: "cooling", coolReason: scrubbed("limit ", "") }] : [])
      expect(yield* sql`SELECT active_sessions AS "activeSessions" FROM host_nodes WHERE node_id = ${known}`).toEqual([
        { activeSessions: ran("fleet_sessions_report") ? 1 : 0 },
      ])
      if (Exit.isSuccess(exit) && scenario.tool === "fleet_overview") {
        const [block] = exit.value.content
        const overview = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ nodeId: Schema.String, name: Schema.String })),
        })))(block?.type === "text" ? block.text : "")
        expect(overview.nodes.filter((node) => node.nodeId === known)).toEqual([{ nodeId: known, name: "Known host" }])
        expect(overview.nodes.some((node) => node.nodeId === fresh)).toBe(false)
      }
      return true
    }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const PolicyScenario = Schema.Struct({
  name: Schema.Literals(["maya", "ops", "alice"]),
  shouted: Schema.Boolean,
  padded: Schema.Boolean,
  signedIn: Schema.Boolean,
  delegated: Schema.Boolean,
  listed: Schema.Struct({ maya: Schema.Boolean, ops: Schema.Boolean, alice: Schema.Boolean }),
  spaced: Schema.Boolean,
})

test("deployment authority belongs to a configured login acting in person, whatever its case or padding", async () => {
  const report = await Effect.runPromise(Fuzz.run(Arbitrary.schema(PolicyScenario), (scenario) =>
    Effect.gen(function* () {
      const names = (["maya", "ops", "alice"] as const).filter((name) => scenario.listed[name])
      const raw = names.map((name, index) => index % 2 === 0 ? name.toUpperCase() : name).join(scenario.spaced ? " , ,  " : ",")
      const admins = yield* DeploymentPolicy.configuredAdmins().pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(names.length === 0 && scenario.spaced ? {} : { DEPLOYMENT_ADMIN_LOGINS: raw })),
      )
      expect([...admins].sort()).toEqual([...names].sort())
      expect([...DeploymentPolicy.parseAdminLogins(raw)].sort()).toEqual([...names].sort())

      const cased = scenario.shouted ? scenario.name.toUpperCase() : scenario.name
      const login = scenario.padded ? `  ${cased}\t` : cased
      const actor: Actor = {
        subject: { kind: "person", id: "p-1" },
        role: "admin",
        ...(scenario.signedIn ? { login } : {}),
        ...(scenario.delegated ? { act: { kind: "agent", id: "mcp:tok-1" } } : {}),
      }
      const named = scenario.signedIn && scenario.listed[scenario.name]
      expect(DeploymentPolicy.isDeploymentAdmin(actor.login, admins)).toBe(named)
      expect(DeploymentPolicy.holdsDeploymentAuthority(actor, admins)).toBe(named && !scenario.delegated)
      // A deployment that names nobody grants nobody, a GitHub admin of the repository included.
      expect(DeploymentPolicy.holdsDeploymentAuthority(actor)).toBe(false)
      const required = yield* Effect.exit(DeploymentPolicy.requireDeploymentAdmin(actor, admins))
      expect(Exit.isSuccess(required) ? required.value : Option.getOrUndefined(Exit.findErrorOption(required))?.code)
        .toBe(named && !scenario.delegated ? login : "forbidden")
      return true
    }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})
