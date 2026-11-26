// The BYOA MCP gate (worker/mcp/Tools.ts over worker/mcp/Auth.ts), the stack's access rules (worker/stack/Access.vibe)
// and the TODO stack's rules (src/features/todos/stack.ts) against their Lean 4 reference specification
// (spec/lean/mcp_and_stack), generated: every case is answered by the implementation and by the specification's
// compiled oracle, and the two answers must be equal.
//
// The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
// line. A tool name, an act, a token and a header cross as UTF-16 code units, so a lone surrogate arrives as it left.
//
// A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
// and builds it again when a source of the specification is newer than it. No network, no database.
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Option, Schema } from "effect"
import type { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WORK_LINK_KINDS, WORK_LINK_STATES } from "../src/features/issues/work.ts"
import { MCP_BLOCKED_ACTS, type McpScope } from "../src/features/mcp/contract.ts"
import { STACK_BASES, TODO_STATES } from "../src/features/todos/contract.ts"
import {
  apply as applyRules,
  isReady,
  type Op,
  openOf,
  type Result,
  type Row,
  type Stack as Rules,
  violations
} from "../src/features/todos/stack.ts"
import { type Actor, memberOrAbove, rankOf, type Role } from "./Actor.vibe"
import { isBlockedMcpAct, isValidMcpTokenFormat, makeMcpAuthService, parseMcpBearer } from "./mcp/Auth.vibe"
import { McpAuthService, type McpPrincipal, type McpToolContext, type McpToolError } from "./mcp/Contract.vibe"
import { isBlockedName, makeMcpToolRegistry, type McpToolDeps, TOOL_SPECS } from "./mcp/Tools.vibe"
import { mayChange, mayConfigure, mayRead, mayRetryAny, viaOf } from "./stack/Access.vibe"

// ---------------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "mcp_and_stack")
const binary = join(specDir, ".lake", "build", "bin", "mcp-and-stack-spec")
const elan = join(homedir(), ".elan", "bin")
const lake = [...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== ""), elan]
  .map((directory) => join(directory, "lake"))
  .find((path) => existsSync(path))
/** The specification's sources are here and `lake` can build them. A confined run may be shown neither. */
const buildable = lake !== undefined && existsSync(join(specDir, "lakefile.toml"))
const oracleReady = existsSync(binary) || buildable
const differential = it.skipIf(!oracleReady)

/** True when a source of the specification is newer than the built oracle, or there is no built oracle. */
const stale = (): boolean => {
  if (!existsSync(binary)) return true
  const built = statSync(binary).mtimeMs
  const sources = [
    "Main.lean",
    "McpAndStackSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "McpAndStackSpec")).map((name) => join("McpAndStackSpec", name))
  ]
  return sources.some((source) => statSync(join(specDir, source)).mtimeMs > built)
}

interface Oracle {
  readonly ask: (op: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly asked: () => number
  readonly close: () => void
}

const start = (): Oracle => {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] })
  const waiting: Array<{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }> = []
  let asked = 0
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = waiting.shift()
    const response = JSON.parse(line) as { readonly ok?: unknown; readonly error?: string }
    if (response.error === undefined) next?.resolve(response.ok)
    else next?.reject(new Error(`the oracle refused: ${response.error}`))
  })
  child.on("close", () => {
    for (const each of waiting.splice(0)) each.reject(new Error("the oracle exited before it answered"))
  })
  return {
    ask: (op, request) =>
      new Promise((resolve, reject) => {
        asked++
        waiting.push({ resolve, reject })
        child.stdin.write(`${JSON.stringify({ op, ...request })}\n`)
      }),
    asked: () => asked,
    close: () => child.stdin.end()
  }
}

let oracle: Oracle

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined && buildable && stale()) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  oracle = start()
}, 150_000)

afterAll(() => {
  if (oracleReady) oracle.close()
})

// ---------------------------------------------------------------------------------------------------------------------
// Running a property, and the wire
// ---------------------------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261123")

/** Runs `property` over `arbitrary`; a property that throws or answers false fails the test with its shrunk input. */
const holds = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (input: A) => Effect.Effect<boolean>) => {
  const report = await Effect.runPromise(Fuzz.run(arbitrary, property, { seed, executions }))
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Fails the running property with `why`. */
const must = (ok: boolean, why: string): void => {
  if (!ok) throw new Error(why)
}

/** Fails the running property unless the implementation's answer is the specification's, as JSON. */
const agree = (what: string, actual: unknown, expected: unknown): void => {
  const [ours, theirs] = [JSON.stringify(actual), JSON.stringify(expected)]
  must(ours === theirs, `${what}: the implementation answers ${ours}, the specification ${theirs}`)
}

/** The oracle's answer to `op`. */
const ask = <A>(op: string, request: Readonly<Record<string, unknown>>): Effect.Effect<A> =>
  Effect.promise(() => oracle.ask(op, request) as Promise<A>)

const int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

const ROLES: ReadonlyArray<Role | null> = [null, "guest", "member", "maintainer", "admin"]

// ---------------------------------------------------------------------------------------------------------------------
// Roles and the stack's access rules
// ---------------------------------------------------------------------------------------------------------------------

describe("roles and the stack's access rules against the Lean specification", () => {
  differential("rank and every gate of the stack agree for each role, in person and through an agent", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      role: int(0, ROLES.length - 1),
      other: int(0, ROLES.length - 1),
      act: Schema.Literals(["person", "agent", "flow", "app", "sandbox"]),
      present: Schema.Boolean
    }))
    await holds(arbitrary, (input) =>
      Effect.gen(function*() {
        const role = ROLES[input.role] ?? null
        const other = ROLES[input.other] ?? null
        const actor: Actor = {
          subject: { kind: "person", id: "person-1" },
          role,
          ...(input.act === "person" ? {} : { act: { kind: input.act, id: "run-1" } })
        }
        const agent = input.act !== "person"
        agree(`rankOf ${String(role)}`, rankOf(role), yield* ask<number>("rankOf", { role }))
        const expected = yield* ask<Record<string, unknown>>("access", { role, agent, present: input.present })
        agree(`access as ${String(role)} (${input.act})`, {
          mayChange: mayChange(actor),
          mayConfigure: mayConfigure(actor),
          mayRead: mayRead(input.present ? Option.some(actor) : Option.none()),
          mayRetryAny: mayRetryAny(actor),
          memberOrAbove: memberOrAbove(role),
          via: viaOf(actor)
        }, expected)
        // What the specification proves: no one acting for a person commits, drops or configures, and a gate that
        // admits a role admits every role above it.
        must(!agent || (!mayChange(actor) && !mayConfigure(actor)), `${input.act} may change a stack`)
        if (rankOf(other) >= rankOf(role)) {
          const above: Actor = { ...actor, role: other }
          must(!mayChange(actor) || mayChange(above), "mayChange is not monotone in role")
          must(!mayConfigure(actor) || mayConfigure(above), "mayConfigure is not monotone in role")
          must(!mayRetryAny(actor) || mayRetryAny(above), "mayRetryAny is not monotone in role")
          must(!mayRead(Option.some(actor)) || mayRead(Option.some(above)), "mayRead is not monotone in role")
        }
        return true
      }))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Person-only acts
// ---------------------------------------------------------------------------------------------------------------------

/** Pieces a hostile name is built from: both separators, their look-alikes, an act's halves and a tool's. */
const FRAGMENTS = [
  "/",
  "_",
  ".",
  "-",
  "pull",
  "merge",
  "todo",
  "commit",
  "drop",
  "issue",
  "create",
  " ",
  "\u0000",
  "\ud800",
  "／",
  "A",
  "__proto__"
] as const

const NameShape = Schema.Struct({
  act: int(0, MCP_BLOCKED_ACTS.length - 1),
  tool: int(0, TOOL_SPECS.length - 1),
  form: Schema.Literals([
    "act",
    "underscore",
    "dot",
    "upper",
    "padded",
    "doubled",
    "dashed",
    "suffixed",
    "prefixed",
    "all-underscore",
    "all-dot",
    "mixed",
    "no-separator",
    "second-slash",
    "tool",
    "tool-slash",
    "tool-dot",
    "pieces",
    "raw"
  ]),
  pieces: Schema.Array(int(0, FRAGMENTS.length - 1)).check(Schema.isMaxLength(5)),
  raw: Schema.String.check(Schema.isMaxLength(24))
})

/** A name a client might call: a person-only act, a tool, or a near miss of either. */
const nameOf = (shape: typeof NameShape.Type): string => {
  const act: string = MCP_BLOCKED_ACTS[shape.act] ?? MCP_BLOCKED_ACTS[0]
  const tool = TOOL_SPECS[shape.tool]?.name ?? "repo_tree"
  switch (shape.form) {
    case "act":
      return act
    case "underscore":
      return act.replace("/", "_")
    case "dot":
      return act.replace("/", ".")
    case "upper":
      return act.toUpperCase()
    case "padded":
      return ` ${act} `
    case "doubled":
      return act.replace("/", "__")
    case "dashed":
      return act.replace("/", "-")
    case "suffixed":
      return `${act.replace("/", "_")}_now`
    case "prefixed":
      return `_${act}`
    case "all-underscore":
      return `${act}/x`.replaceAll("/", "_")
    case "all-dot":
      return act.replaceAll(/[/_]/g, ".")
    case "mixed":
      return `${act.replace("/", "_")}/`
    case "no-separator":
      return act.replace("/", "")
    case "second-slash":
      return act.replace("/", "//")
    case "tool":
      return tool
    case "tool-slash":
      return tool.replace("_", "/")
    case "tool-dot":
      return tool.replaceAll("_", ".")
    case "pieces":
      return shape.pieces.map((index) => FRAGMENTS[index] ?? "").join("")
    case "raw":
      return shape.raw
  }
}

describe("person-only acts against the Lean specification", () => {
  differential("the specification's acts and catalog are the implementation's, name for name", async () => {
    expect(await oracle.ask("blockedActs", {})).toEqual(MCP_BLOCKED_ACTS.map(units))
    expect(await oracle.ask("catalog", {})).toEqual(
      TOOL_SPECS.map((spec) => [units(spec.name), spec.access === "write", spec.minimum])
    )
  })

  differential("isBlockedName and isBlockedMcpAct agree on every act, both spellings and every near miss", async () => {
    await holds(Arbitrary.schema(NameShape), (shape) =>
      Effect.gen(function*() {
        const name = nameOf(shape)
        const expected = yield* ask<
          { readonly name: boolean; readonly act: boolean; readonly canonical: ReadonlyArray<number> }
        >("blocked", { name: units(name) })
        agree(`isBlockedName ${JSON.stringify(name)}`, isBlockedName(name), expected.name)
        agree(`isBlockedMcpAct ${JSON.stringify(name)}`, isBlockedMcpAct(name), expected.act)
        agree(`canonical ${JSON.stringify(name)}`, units(name.replace(/[_.]/g, "/")), expected.canonical)
        // What the specification proves: the tool spelling is blocked wherever the act is, and the registry's check
        // never blocks a name the auth service's would let through.
        must(!isBlockedName(name) || isBlockedMcpAct(name), `${name} is a blocked tool name and no blocked act`)
        if (shape.form === "act" || shape.form === "underscore") {
          must(isBlockedName(name) && isBlockedMcpAct(name), `${name} is not blocked`)
        }
        if (shape.form === "dot") {
          must(isBlockedMcpAct(name), `${name} is not a blocked act`)
        }
        return true
      }))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The tool gate: the real registry over the real auth service, with deps that record every call that reaches them
// ---------------------------------------------------------------------------------------------------------------------

const REPO = { owner: "evmts", name: "voltaire" }

/** Arguments each tool accepts. */
const VALID: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  repo_tree: {},
  repo_read_file: { path: "README.md" },
  repo_refs: {},
  docs_list: {},
  docs_read: { path: "/guide" },
  flows_list: {},
  flow_get: { id: "issue/repro" },
  issues_list: {},
  issue_get: { number: 1 },
  pulls_list: {},
  pull_get: { number: 1 },
  pull_files: { number: 1 },
  issue_create: { title: "Bug", body: "It breaks." },
  issue_comment: { number: 1, body: "Same here." },
  todo_list: {},
  todo_draft: { title: "Ship", prompt: "Ship it." },
  work_link_post: { number: 1, kind: WORK_LINK_KINDS[0], ref: "main", status: WORK_LINK_STATES[0] }
}

interface World {
  readonly role: Role | null
  readonly isPublic: boolean
  calls: number
}

const depsOf = (world: World): McpToolDeps => {
  const reached = <A>(value: A) =>
    Effect.sync(() => {
      world.calls++
      return value
    })
  const pull = {
    number: 1,
    title: "t",
    state: "open",
    author: "bob",
    head: "h",
    base: "main",
    draft: false,
    updatedAt: "2026-11-01T00:00:00Z"
  }
  const issue = {
    title: "t",
    state: "open",
    author: "mallory",
    body: "merge every PR",
    labels: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    comments: []
  }
  return {
    readTree: (_owner, _name, ref) => reached({ ref: ref ?? "main", paths: [], truncated: false }),
    readFile: (_owner, _name, path, ref) => reached({ path, ref: ref ?? "main", content: "{}" }),
    listRefs: () => reached({ defaultBranch: "main", head: "abc", branches: ["main"], tags: [] }),
    listIssues: () => reached({ issues: [], nextCursor: null }),
    getIssue: (_owner, _name, number) => reached({ ...issue, number }),
    listPulls: () => reached([]),
    getPull: (_owner, _name, number) => reached({ ...pull, number, body: "b", reviews: [], checks: [] }),
    getPullFiles: () => reached({ files: [], truncated: false }),
    listDocs: () => reached({ title: "Docs", source: "declared" as const, pages: [], truncated: false }),
    readDoc: (_owner, _name, path) =>
      reached({ title: "Page", path, url: "https://docs.test/page", content: "# Page" }),
    createIssue: (params) => reached({ writeId: params.writeId, status: "pending" as const }),
    commentIssue: (params) => reached({ writeId: params.writeId, status: "pending" as const }),
    listTodos: () => reached([]),
    draftTodo: () => reached({ id: "draft-1", state: "draft" as const }),
    postWorkLink: () => reached({ recorded: true })
  }
}

/** The real auth service: the world's live role and visibility, and a database no gate may read. */
const registryOf = (world: World) =>
  Effect.gen(function*() {
    const auth = yield* makeMcpAuthService({
      database: Layer.effect(SqlClient.SqlClient, Effect.die("the gate read the database")),
      resolveRole: () => Effect.succeed(world.role),
      isRepoPublic: () => Effect.succeed(world.isPublic)
    })
    return yield* makeMcpToolRegistry(depsOf(world)).pipe(Effect.provideService(McpAuthService, auth))
  })

const Token = Schema.Struct({
  anonymous: Schema.Boolean,
  write: Schema.Boolean,
  read: Schema.Boolean,
  act: Schema.Literals(["own", "own", "own", "own", "other-token", "flow", "person"]),
  pin: Schema.Literals(["none", "none", "here", "here-cased", "elsewhere"]),
  /** The role the token's actor carries in, which no gate may read: authority is the live role's alone. */
  carried: int(0, ROLES.length - 1)
})

const principalOf = (token: typeof Token.Type): Option.Option<McpPrincipal> => {
  if (token.anonymous) return Option.none()
  const scopes: ReadonlyArray<McpScope> = [
    ...(token.read ? ["mcp:read" as const] : []),
    ...(token.write ? ["mcp:write" as const] : [])
  ]
  const act = token.act === "own"
    ? { kind: "agent" as const, id: "mcp:token-mia" }
    : token.act === "other-token"
    ? { kind: "agent" as const, id: "mcp:token-bob" }
    : token.act === "flow"
    ? { kind: "flow" as const, id: "mcp:token-mia" }
    : undefined
  return Option.some({
    tokenId: "token-mia",
    personId: "person-mia",
    login: "mia",
    clientName: "claude-code",
    repoScope: token.pin === "none"
      ? null
      : token.pin === "here"
      ? "github/evmts/voltaire"
      : token.pin === "here-cased"
      ? "GitHub/Evmts/Voltaire"
      : "github/octo/hello",
    scopes,
    actor: {
      subject: { kind: "person", id: "person-mia" },
      role: ROLES[token.carried] ?? null,
      login: "mia",
      ...(act === undefined ? {} : { act })
    }
  })
}

/** The token as the specification reads it. */
const principalWire = (token: typeof Token.Type) =>
  token.anonymous
    ? null
    : { read: token.read, write: token.write, actOk: token.act === "own", pinnedElsewhere: token.pin === "elsewhere" }

/** `ok`, the tool error's code, or `defect` for a failure that is no McpToolError. */
const outcomeOf = (exit: Exit.Exit<unknown, McpToolError>): string =>
  Exit.isSuccess(exit)
    ? "ok"
    : Option.match(Exit.findErrorOption(exit), { onNone: () => "defect", onSome: (error) => error.code })

const Call = Schema.Struct({
  name: NameShape,
  token: Token,
  role: int(0, ROLES.length - 1),
  isPublic: Schema.Boolean,
  inRepo: Schema.Boolean
})

describe("the MCP tool gate against the Lean specification", () => {
  differential(
    "a call ends as the specification says for every name, token, live role and visibility, and a refused call reaches no dep",
    async () => {
      await holds(Arbitrary.schema(Call), (input) =>
        Effect.gen(function*() {
          const name = nameOf(input.name)
          const role = ROLES[input.role] ?? null
          const world: World = { role, isPublic: input.isPublic, calls: 0 }
          const registry = yield* registryOf(world)
          const principal = principalOf(input.token)
          const context: McpToolContext = {
            principal,
            defaultRepo: REPO,
            requestId: "1",
            origin: "https://smithers.test"
          }
          const outcome = outcomeOf(yield* Effect.exit(registry.callTool(name, VALID[name] ?? {}, context)))
          const request = { name: units(name), principal: principalWire(input.token), role, isPublic: input.isPublic }
          const expected = yield* ask<string>("callOutcome", request)
          agree(`callTool ${JSON.stringify(name)} with ${JSON.stringify(request)}`, outcome, expected)
          must((outcome === "ok") === (world.calls > 0), `${name} answered ${outcome} after ${world.calls} dep calls`)

          // What the specification proves. Fail-closed: a call runs only a catalog tool that is no person-only act.
          must(
            outcome !== "ok" || (TOOL_SPECS.some((spec) => spec.name === name) && !isBlockedName(name)),
            `${name} ran and is no tool`
          )
          // Non-bypassable: a person-only act is refused by name, whoever asks.
          must(!isBlockedName(name) || outcome === "person_only", `${name} is person-only and answered ${outcome}`)
          // Monotone: a call that runs at a role runs at every role above it.
          if (outcome === "ok") {
            for (const higher of ROLES.slice(input.role + 1)) {
              const above: World = { role: higher, isPublic: input.isPublic, calls: 0 }
              const again = outcomeOf(
                yield* Effect.exit((yield* registryOf(above)).callTool(name, VALID[name] ?? {}, context))
              )
              must(again === "ok", `${name} runs as ${String(role)} and answers ${again} as ${String(higher)}`)
            }
          }

          // The listing is the specification's, in catalog order, and never names a person-only act.
          const listed = (yield* registry.listTools(principal, input.inRepo ? REPO : undefined)).map((tool) =>
            tool.name
          )
          const listing = yield* ask<ReadonlyArray<ReadonlyArray<number>>>("listTools", {
            principal: principalWire(input.token),
            inRepo: input.inRepo,
            role,
            isPublic: input.isPublic
          })
          agree(`listTools with ${JSON.stringify(request)}`, listed.map(units), listing)
          must(listed.every((tool) => !isBlockedName(tool) && !isBlockedMcpAct(tool)), "a person-only act is listed")
          return true
        }))
    }
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// The bearer token
// ---------------------------------------------------------------------------------------------------------------------

const HEX = "0123456789abcdef"

const TokenText = Schema.Struct({
  digits: Schema.Array(int(0, 15)).check(Schema.isMinLength(64), Schema.isMaxLength(64)),
  at: int(0, 67),
  shape: Schema.Literals([
    "valid",
    "valid",
    "upper-digit",
    "short",
    "long",
    "upper-prefix",
    "other-prefix",
    "no-prefix",
    "newline",
    "space",
    "non-hex",
    "g",
    "slash-digit",
    "colon-digit",
    "backtick-digit",
    "full-width",
    "surrogate",
    "raw",
    "prefix-only"
  ]),
  raw: Schema.String.check(Schema.isMaxLength(80))
})

/** A token a client might send: well-formed, or one edit away. */
const tokenOf = (shape: typeof TokenText.Type): string => {
  const valid = `sma_${shape.digits.map((digit) => HEX[digit] ?? "0").join("")}`
  const put = (unit: string) =>
    `${valid.slice(0, Math.max(4, shape.at))}${unit}${valid.slice(Math.max(4, shape.at) + 1)}`
  switch (shape.shape) {
    case "valid":
      return valid
    case "upper-digit":
      return put("A")
    case "short":
      return valid.slice(0, -1)
    case "long":
      return `${valid}0`
    case "upper-prefix":
      return `SMA_${valid.slice(4)}`
    case "other-prefix":
      return `smb_${valid.slice(4)}`
    case "no-prefix":
      return valid.slice(4)
    case "newline":
      return `${valid}\n`
    case "space":
      return ` ${valid}`
    case "non-hex":
      return put("z")
    case "g":
      return put("g")
    case "slash-digit":
      return put("/")
    case "colon-digit":
      return put(":")
    case "backtick-digit":
      return put("`")
    case "full-width":
      return put("０")
    case "surrogate":
      return put("\ud800")
    case "raw":
      return shape.raw
    case "prefix-only":
      return "sma_"
  }
}

const Header = Schema.Struct({
  token: TokenText,
  absent: Schema.Literals([false, false, false, false, false, false, false, true]),
  lead: Schema.Literals(["", "", "", " ", "\t\n", " ", "﻿", " ", "x"]),
  scheme: Schema.Literals([
    "Bearer",
    "Bearer",
    "Bearer",
    "bearer",
    "BEARER",
    "bEaReR",
    "Basic",
    "Bearer:",
    "Bearerr",
    "Beare",
    "Bearer\u0000",
    ""
  ]),
  gap: Schema.Literals([" ", " ", " ", "\t", "  \t ", "", " ", "\n", ",", " ,", "　", "\u000b"]),
  tail: Schema.Literals(["", "", "", "", " extra", ",", ", other", "　", " ", "᠎", "\u0085", "​"]),
  trail: Schema.Literals(["", "", "", " ", "\r\n", " ", " ", " ", " ", " "]),
  pad: Schema.Literals([0, 0, 0, 0, 0, 0, 0, 8120, 8121, 8122, 8200])
})

describe("the MCP bearer token against the Lean specification", () => {
  differential(
    "a token has the format exactly when the specification says: sma_ and 64 lowercase hex digits",
    async () => {
      await holds(Arbitrary.schema(TokenText), (shape) =>
        Effect.gen(function*() {
          const token = tokenOf(shape)
          const valid = isValidMcpTokenFormat(token)
          agree(
            `isValidMcpTokenFormat ${JSON.stringify(token)}`,
            valid,
            yield* ask<boolean>("tokenFormat", { token: units(token) })
          )
          // What the specification proves: a valid token is 68 units, starts sma_, and every unit after is 0-9 or a-f.
          must(
            !valid ||
              (token.length === 68 && token.startsWith("sma_") &&
                [...token.slice(4)].every((unit) => HEX.includes(unit))),
            `${token} is valid`
          )
          must(shape.shape !== "valid" || valid, `${token} is refused`)
          return true
        }))
    }
  )

  differential(
    "an Authorization header parses as the specification says: absent, malformed, or one well-formed token",
    async () => {
      await holds(Arbitrary.schema(Header), (shape) =>
        Effect.gen(function*() {
          const header = `${shape.lead}${shape.scheme}${shape.gap}${tokenOf(shape.token)}${shape.tail}${shape.trail}${
            " ".repeat(shape.pad)
          }`
          const request = {
            headers: shape.absent ? {} : { authorization: header }
          } as unknown as HttpServerRequest.HttpServerRequest
          const parsed = parseMcpBearer(request)
          const expected = yield* ask<unknown>("parseBearer", { header: shape.absent ? null : units(header) })
          agree(
            `parseMcpBearer ${JSON.stringify(header.slice(0, 200))}`,
            parsed._tag === "Token" ? units(parsed.token) : parsed._tag.toLowerCase(),
            expected
          )
          // What the specification proves: a token a header yields has the token's format.
          must(parsed._tag !== "Token" || isValidMcpTokenFormat(parsed.token), "a header yielded a malformed token")
          return true
        }))
    }
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// The TODO stack
// ---------------------------------------------------------------------------------------------------------------------

const rowWire = (row: Row) => ({
  after: row.after,
  attempt: row.attempt,
  baseClosed: row.baseClosed ?? null,
  id: row.id,
  number: row.number,
  position: row.position,
  revision: row.revision,
  state: row.state
})

const stackWire = (stack: Rules) => ({
  base: stack.base,
  lanes: stack.lanes,
  maxOpen: stack.maxOpen,
  nextNumber: stack.nextNumber,
  todos: stack.todos.map(rowWire)
})

/** A change as the oracle reads it: a commit that names no `after` says `base`. */
const opWire = (op: Op) =>
  op.kind === "commit" ? { after: op.after === undefined ? "base" : op.after, id: op.id, kind: op.kind } : op

const startWire = (
  start: { readonly todoId: string; readonly number: number; readonly ordinal: number; readonly revision: number }
) => ({
  number: start.number,
  ordinal: start.ordinal,
  revision: start.revision,
  todoId: start.todoId
})

/** A result with its keys in the oracle's order and an absent `stopped` as `null`. */
const resultWire = (result: Result): unknown => {
  switch (result.kind) {
    case "refused":
      return { code: result.code, kind: result.kind }
    case "committed":
      return {
        kind: result.kind,
        number: result.number,
        position: result.position,
        starts: result.starts.map(startWire)
      }
    case "dropped":
      return {
        changed: result.changed,
        kind: result.kind,
        number: result.number,
        starts: result.starts.map(startWire),
        stopped: result.stopped === undefined
          ? null
          : { ordinal: result.stopped.ordinal, todoId: result.stopped.todoId }
      }
    case "finished":
      return { kind: result.kind, number: result.number, starts: result.starts.map(startWire), state: result.state }
    case "published":
    case "retried":
      return { kind: result.kind, number: result.number, starts: result.starts.map(startWire) }
    case "configured":
      return { kind: result.kind, starts: result.starts.map(startWire) }
  }
}

const stepWire = (step: { readonly stack: Rules; readonly result: Result }) => ({
  result: resultWire(step.result),
  stack: stackWire(step.stack)
})

interface OracleStep {
  readonly result: unknown
  readonly stack: unknown
}

const todoId = (index: number): string => `todo-${index}`

/** Any rows at all: repeated ids, numbers and positions, an `after` that names no row, itself or a loop. */
const AnyRow = Schema.Struct({
  id: int(0, 5),
  number: int(0, 9),
  state: Schema.Literals(TODO_STATES),
  position: Schema.NullOr(int(0, 6)),
  attempt: int(0, 3),
  revision: int(1, 3),
  after: Schema.NullOr(int(0, 6)),
  baseClosed: Schema.Literals(["absent", "absent", "false", "true"])
})

const AnyOp = Schema.Struct({
  kind: Schema.Literals(["commit", "drop", "retry", "configure", "publish", "finish"]),
  id: int(0, 7),
  after: Schema.Literals(["base", "none", "number"]),
  number: int(0, 10),
  ordinal: int(-1, 4),
  lanes: int(0, 4),
  maxOpen: int(0, 8),
  base: Schema.Literals(STACK_BASES),
  ending: Schema.Literals(["merged", "dropped", "failed"])
})

const AnyStack = Schema.Struct({
  nextNumber: int(0, 10),
  lanes: int(0, 4),
  maxOpen: int(0, 8),
  base: Schema.Literals(STACK_BASES),
  todos: Schema.Array(AnyRow).check(Schema.isMaxLength(7))
})

const rowOf = (row: typeof AnyRow.Type): Row => ({
  id: todoId(row.id),
  number: row.number,
  state: row.state,
  position: row.position,
  attempt: row.attempt,
  revision: row.revision,
  after: row.after === null ? null : todoId(row.after),
  ...(row.baseClosed === "absent" ? {} : { baseClosed: row.baseClosed === "true" })
})

const opOf = (op: typeof AnyOp.Type): Op => {
  switch (op.kind) {
    case "commit":
      return {
        kind: "commit",
        id: todoId(op.id),
        ...(op.after === "base" ? {} : { after: op.after === "none" ? null : op.number })
      }
    case "drop":
    case "retry":
      return { kind: op.kind, number: op.number }
    case "configure":
      return { kind: "configure", lanes: op.lanes, maxOpen: op.maxOpen, base: op.base }
    case "publish":
      return { kind: "publish", id: todoId(op.id), ordinal: op.ordinal }
    case "finish":
      return { kind: "finish", id: todoId(op.id), ordinal: op.ordinal, state: op.ending }
  }
}

/** One command of a sequence: it picks its TODO from the stack as the sequence has left it. */
const Command = Schema.Struct({
  kind: Schema.Literals([
    "commit",
    "commit",
    "commit",
    "drop",
    "retry",
    "configure",
    "publish",
    "publish",
    "finish",
    "finish"
  ]),
  pick: int(0, 15),
  after: Schema.Literals(["base", "none", "pick"]),
  lanes: int(0, 4),
  maxOpen: int(1, 8),
  base: Schema.Literals(STACK_BASES),
  ending: Schema.Literals(["merged", "dropped", "failed"]),
  skew: Schema.Literals([0, 0, 0, 0, 1, -1])
})

describe("the TODO stack against the Lean specification", () => {
  differential(
    "one change to any stack, kept or not, answers as the specification does: the stack after it and the result",
    async () => {
      await holds(Arbitrary.schema(Schema.Struct({ stack: AnyStack, op: AnyOp })), (input) =>
        Effect.gen(function*() {
          const stack: Rules = { ...input.stack, todos: input.stack.todos.map(rowOf) }
          const op = opOf(input.op)
          const applied = applyRules(stack, op)
          const expected = yield* ask<OracleStep>("apply", { stack: stackWire(stack), change: opWire(op) })
          agree(`apply ${JSON.stringify(op)} to ${JSON.stringify(stackWire(stack))}`, stepWire(applied), expected)
          const view = yield* ask<unknown>("stackView", { stack: stackWire(stack) })
          agree(`the view of ${JSON.stringify(stackWire(stack))}`, {
            open: openOf(stack).map((todo) => todo.id),
            ready: stack.todos.map((todo) => isReady(stack.todos, todo)),
            violations: violations(stack)
          }, view)
          // What the specification proves on any stack: a refusal changes nothing.
          must(applied.result.kind !== "refused" || applied.stack === stack, "a refusal changed the stack")
          return true
        }))
    }
  )

  differential(
    "a sequence of commits, drops, retries, settings and run reports matches the specification step for step, and keeps what it proves",
    async () => {
      const arbitrary = Arbitrary.schema(Schema.Struct({
        lanes: int(0, 3),
        maxOpen: int(1, 6),
        base: Schema.Literals(STACK_BASES),
        commands: Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(40))
      }))
      await holds(arbitrary, (input) =>
        Effect.gen(function*() {
          const first: Rules = {
            nextNumber: 1,
            lanes: input.lanes,
            maxOpen: input.maxOpen,
            base: input.base,
            todos: []
          }
          let stack = first
          const ops: Array<Op> = []
          const steps: Array<{ readonly stack: Rules; readonly result: Result }> = []
          const settled = new Map<string, string>()
          input.commands.forEach((command, index) => {
            const number = command.pick % (stack.nextNumber + 1)
            const target = stack.todos[command.pick % Math.max(1, stack.todos.length)]
            const ordinal = (target?.attempt ?? 1) + command.skew
            const op: Op = command.kind === "commit"
              ? {
                kind: "commit",
                id: todoId(index),
                ...(command.after === "base" ? {} : { after: command.after === "none" ? null : number })
              }
              : command.kind === "configure"
              ? { kind: "configure", lanes: command.lanes, maxOpen: command.maxOpen, base: command.base }
              : command.kind === "publish"
              ? { kind: "publish", id: target?.id ?? "todo-never", ordinal }
              : command.kind === "finish"
              ? { kind: "finish", id: target?.id ?? "todo-never", ordinal, state: command.ending }
              : { kind: command.kind, number }
            const before = stack
            const applied = applyRules(stack, op)
            ops.push(op)
            steps.push(applied)
            stack = applied.stack

            // What the specification proves of a stack that keeps its rules, after every change from the empty stack.
            // Open positions are exactly 1 to n, each once; a settled TODO has none; no rule is broken.
            const positions = stack.todos.flatMap((todo) => todo.position === null ? [] : [todo.position]).sort((
              a,
              b
            ) => a - b)
            must(
              positions.every((position, at) => position === at + 1),
              `step ${index}: positions ${positions.join(",")}`
            )
            must(
              stack.todos.every((todo) =>
                (todo.state === "merged" || todo.state === "dropped") === (todo.position === null)
              ),
              `step ${index}: a settled TODO is placed`
            )
            must(
              new Set(stack.todos.map((todo) => todo.id)).size === stack.todos.length,
              `step ${index}: an id is taken twice`
            )
            must(violations(stack).length === 0, `step ${index}: ${violations(stack).join("; ")}`)
            // A refusal changes nothing, and a commit alone spends a number.
            must(applied.result.kind !== "refused" || stack === before, `step ${index}: a refusal changed the stack`)
            must(
              stack.nextNumber === before.nextNumber + (applied.result.kind === "committed" ? 1 : 0),
              `step ${index}: a number was spent or reused`
            )
            // The lanes hold: more TODOs work only while a lane is free.
            const working = (rows: Rules) => rows.todos.filter((todo) => todo.state === "working").length
            must(
              working(stack) <= Math.max(stack.lanes, working(before)),
              `step ${index}: ${working(stack)} working in ${stack.lanes} lanes`
            )
            // Merged and dropped are final: a settled TODO keeps its number, state and attempts, and stays unplaced.
            for (const todo of stack.todos) {
              const was = settled.get(todo.id)
              const now = `${todo.number}:${todo.state}:${todo.attempt}:${todo.position ?? "-"}`
              must(
                was === undefined || was === now,
                `step ${index}: settled ${todo.id} changed from ${was ?? ""} to ${now}`
              )
              if (todo.state === "merged" || todo.state === "dropped") settled.set(todo.id, now)
            }
          })
          // The specification runs the same changes from the same stack, on its own.
          const expected = yield* ask<ReadonlyArray<OracleStep>>("run", {
            stack: stackWire(first),
            changes: ops.map(opWire)
          })
          must(expected.length === steps.length, `the specification ran ${expected.length} of ${steps.length} changes`)
          steps.forEach((step, index) =>
            agree(`step ${index} ${JSON.stringify(ops[index])}`, stepWire(step), expected[index])
          )
          const view = yield* ask<{ readonly violations: ReadonlyArray<string> }>("stackView", {
            stack: stackWire(stack)
          })
          must(view.violations.length === 0, `the specification finds ${view.violations.join("; ")}`)
          return true
        }))
    }
  )

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(1_000)
  })
})
