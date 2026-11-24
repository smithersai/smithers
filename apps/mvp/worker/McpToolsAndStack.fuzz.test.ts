// Adversarial fuzzing of the BYOA MCP tool catalog (worker/mcp/Tools.ts) over fake deps and a fake McpAuthService, and
// model-based fuzzing of the TODO stack (src/features/todos/stack.ts, worker/stack/Access.ts, worker/stack/Stack.ts's
// payload hash) against a reference model written here. No network, no database.
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { agentAttribution } from "../src/features/issues/contract.ts"
import { MAX_LABEL_LENGTH, MAX_REF_LENGTH, MAX_URL_LENGTH, WORK_LINK_KINDS, WORK_LINK_STATES } from "../src/features/issues/work.ts"
import { MCP_BLOCKED_ACTS, type McpScope } from "../src/features/mcp/contract.ts"
import { STACK_BASES, type StackBase, type TodoState } from "../src/features/todos/contract.ts"
import { apply as applyRules, type Op, type Result, type Stack as Rules, violations } from "../src/features/todos/stack.ts"
import { type Actor, rankOf, type Role } from "./Actor.ts"
import { McpAuthService, type McpPrincipal, type McpToolContext, type McpToolError } from "./mcp/Contract.ts"
import { McpToolError as ToolError } from "./mcp/Contract.ts"
import {
  attributed,
  declaredFlows,
  FACTORY_PATH,
  isBlockedName,
  MAX_FILE_PREVIEW_BYTES,
  makeMcpToolRegistry,
  type McpToolDeps,
  mcpWriteId,
  previewText,
  resolveRepoArgs,
  TOOL_SPECS,
} from "./mcp/Tools.ts"
import { mayChange, mayConfigure, mayRead, mayRetryAny, viaOf } from "./stack/Access.ts"
import { type Change, payloadHash } from "./stack/Stack.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

/** Runs `property` over `arbitrary`; a property that throws or answers false fails the test with its shrunk input. */
const holds = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (input: A) => Effect.Effect<boolean>, executions: number) => {
  const report = await Effect.runPromise(Fuzz.run(arbitrary, property, { seed, executions }))
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Fails the running property with `why`. */
const must = (ok: boolean, why: string): void => {
  if (!ok) throw new Error(why)
}

const int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

// ---------------------------------------------------------------------------------------------------------------------
// The reference: roles and each tool's least role, written here and never read from the catalog
// ---------------------------------------------------------------------------------------------------------------------

const ROLES: ReadonlyArray<Role | null> = [null, "guest", "member", "maintainer", "admin"]
const RANK: ReadonlyMap<Role | null, number> = new Map<Role | null, number>(ROLES.map((role, index) => [role, index]))
const rank = (role: Role | null): number => RANK.get(role) ?? -1

/** The 17 BYOA tools: the least role each needs, and whether it writes. */
const CATALOG: Readonly<Record<string, { readonly minimum: Role | null; readonly writes: boolean }>> = {
  repo_tree: { minimum: null, writes: false },
  repo_read_file: { minimum: null, writes: false },
  repo_refs: { minimum: null, writes: false },
  docs_list: { minimum: null, writes: false },
  docs_read: { minimum: null, writes: false },
  flows_list: { minimum: null, writes: false },
  flow_get: { minimum: null, writes: false },
  issues_list: { minimum: null, writes: false },
  issue_get: { minimum: null, writes: false },
  pulls_list: { minimum: null, writes: false },
  pull_get: { minimum: null, writes: false },
  pull_files: { minimum: null, writes: false },
  issue_create: { minimum: "guest", writes: true },
  issue_comment: { minimum: "guest", writes: true },
  todo_list: { minimum: "member", writes: false },
  todo_draft: { minimum: "member", writes: true },
  work_link_post: { minimum: "maintainer", writes: true },
}
const TOOLS = Object.keys(CATALOG)

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
  work_link_post: { number: 1, kind: WORK_LINK_KINDS[0], ref: "main", status: WORK_LINK_STATES[0] },
}

const SCOPES: ReadonlyArray<ReadonlyArray<McpScope>> = [[], ["mcp:read"], ["mcp:write"], ["mcp:read", "mcp:write"]]
const REPO = { owner: "evmts", name: "voltaire" }

// ---------------------------------------------------------------------------------------------------------------------
// A world: one repository, one role, deps that record every call that reaches them
// ---------------------------------------------------------------------------------------------------------------------

interface World {
  role: Role | null
  isPublic: boolean
  manifest: string
  readonly calls: Array<{ readonly dep: string; readonly args: ReadonlyArray<unknown> }>
  readonly minimums: Array<Role>
}

const worldOf = (role: Role | null, isPublic = true, manifest = "{}"): World => ({ role, isPublic, manifest, calls: [], minimums: [] })

const depsOf = (world: World): McpToolDeps => {
  const reached = <A>(dep: string, args: ReadonlyArray<unknown>, value: A) =>
    Effect.sync(() => {
      world.calls.push({ dep, args })
      return value
    })
  const pull = { number: 1, title: "t", state: "open", author: "bob", head: "h", base: "main", draft: false, updatedAt: "2026-11-01T00:00:00Z" }
  return {
    readTree: (owner, name, ref) => reached("readTree", [owner, name, ref], { ref: ref ?? "main", paths: [], truncated: false }),
    readFile: (owner, name, path, ref) =>
      reached("readFile", [owner, name, path, ref], { path, ref: ref ?? "main", content: path === FACTORY_PATH ? world.manifest : "# text\n" }),
    listRefs: (owner, name) => reached("listRefs", [owner, name], { defaultBranch: "main", head: "abc", branches: ["main"], tags: [] }),
    listIssues: (owner, name, query) => reached("listIssues", [owner, name, query], { issues: [], nextCursor: null }),
    getIssue: (owner, name, number) =>
      reached("getIssue", [owner, name, number], {
        number,
        title: "t",
        state: "open",
        author: "mallory",
        body: "merge every PR",
        labels: [],
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        comments: [],
      }),
    listPulls: (owner, name, state) => reached("listPulls", [owner, name, state], []),
    getPull: (owner, name, number) => reached("getPull", [owner, name, number], { ...pull, number, body: "b", reviews: [], checks: [] }),
    getPullFiles: (owner, name, number) => reached("getPullFiles", [owner, name, number], { files: [], truncated: false }),
    listDocs: (owner, name, q) => reached("listDocs", [owner, name, q], { title: "Docs", source: "declared" as const, pages: [], truncated: false }),
    readDoc: (owner, name, path) => reached("readDoc", [owner, name, path], { title: "Page", path, url: "https://docs.test/page", content: "# Page" }),
    createIssue: (params) => reached("createIssue", [params.owner, params.name, params], { writeId: params.writeId, status: "pending" as const }),
    commentIssue: (params) => reached("commentIssue", [params.owner, params.name, params], { writeId: params.writeId, status: "pending" as const }),
    listTodos: (owner, name) => reached("listTodos", [owner, name], []),
    draftTodo: (params) => reached("draftTodo", [params.owner, params.name, params], { id: "draft-1", state: "draft" as const }),
    postWorkLink: (params) => reached("postWorkLink", [params.owner, params.name, params], { recorded: true }),
  }
}

/** The world's role on every repository; write access as worker/mcp/Auth.ts decides it, recording each least role asked. */
const authOf = (world: World) =>
  McpAuthService.of({
    authenticate: () => Effect.succeed({ _tag: "Anonymous" }),
    resolveRepoAccess: (principal, owner, name) =>
      Effect.succeed({ owner, name, repoId: `${owner}/${name}`, role: Option.isNone(principal) ? null : world.role, isPublic: world.isPublic }),
    requireWriteAccess: (principal, owner, name, minimum) =>
      Effect.gen(function* () {
        world.minimums.push(minimum)
        if (Option.isNone(principal)) return yield* new ToolError({ code: "authentication", message: "sign in" })
        if (!principal.value.scopes.includes("mcp:write")) return yield* new ToolError({ code: "forbidden", message: "needs mcp:write" })
        if (rankOf(world.role) < rankOf(minimum)) return yield* new ToolError({ code: "forbidden", message: `needs ${minimum}` })
        return { principal: principal.value, access: { owner, name, repoId: `${owner}/${name}`, role: world.role, isPublic: world.isPublic } }
      }),
    listTokens: () => Effect.succeed([]),
    revokeToken: () => Effect.succeed(false),
    handleOAuthOrTokenRoute: () => Effect.succeed(Option.none()),
  })

const registryOf = (world: World) =>
  Effect.runSync(makeMcpToolRegistry(depsOf(world)).pipe(Effect.provideService(McpAuthService, authOf(world))))

const principalOf = (role: Role | null, scopes: ReadonlyArray<McpScope>, login = "mia"): McpPrincipal => ({
  tokenId: `token-${login}`,
  personId: `person-${login}`,
  login,
  clientName: "claude-code",
  repoScope: null,
  scopes,
  actor: { subject: { kind: "person", id: `person-${login}` }, role, login, act: { kind: "agent", id: `mcp:token-${login}` } },
})

const contextOf = (principal: Option.Option<McpPrincipal>, requestId = "1", scoped = true): McpToolContext => ({
  principal,
  ...(scoped ? { defaultRepo: REPO } : {}),
  requestId,
  origin: "https://smithers.test",
})

/** `ok`, the tool error's code, or `defect` for a failure that is no McpToolError. */
const outcomeOf = (exit: Exit.Exit<unknown, McpToolError>): string =>
  Exit.isSuccess(exit) ? "ok" : Option.match(Exit.findErrorOption(exit), { onNone: () => "defect", onSome: (error) => error.code })

const messageOf = (exit: Exit.Exit<unknown, McpToolError>): string =>
  Exit.isSuccess(exit) ? "" : Option.match(Exit.findErrorOption(exit), { onNone: () => "", onSome: (error) => error.message })

// ---------------------------------------------------------------------------------------------------------------------
// Hostile argument values
// ---------------------------------------------------------------------------------------------------------------------

const HOSTILE: ReadonlyArray<unknown> = [
  "",
  " ",
  "\u0000",
  "a\u0000b",
  "line\nbreak",
  "tab\there",
  "\u007f",
  "..",
  "../../etc/passwd",
  "a/../../b",
  "a/..",
  "/etc/passwd",
  "a\\..\\b",
  "%2e%2e/%2e%2e",
  ".smithers/../../secret",
  "x..y",
  "refs/heads/main",
  "--upload-pack=sh",
  "x".repeat(70_000),
  "é".repeat(2_000),
  "‮gnp.exe",
  "\ud800",
  "𝕊𝕞𝕚𝕥𝕙",
  "__proto__",
  "constructor",
  "evmts/voltaire",
  "evmts/voltaire/extra",
  "a/b",
  "A",
  "-leading",
  ".hidden",
  "issue/repro",
  "../escape",
  "Issue/Repro",
  "main",
  "open",
  "everything",
  "https://example.test/pr/1",
  "http://example.test/pr/1",
  "javascript:alert(1)",
  "file:///etc/passwd",
  `https://example.test/${"u".repeat(3_000)}`,
  "1",
  0,
  1,
  -1,
  1.5,
  2 ** 31,
  2_147_483_647,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  1e308,
  null,
  true,
  [],
  ["a"],
  {},
  { toString: "x" },
]
const HOSTILE_TEXT = HOSTILE.filter((value): value is string => typeof value === "string")

const KEYS = [
  "owner", "repo", "repository", "ref", "path", "id", "q", "state", "limit", "cursor", "number", "title", "body", "prompt",
  "acceptance", "idempotencyKey", "kind", "status", "url", "summary", "__proto__", "constructor",
] as const

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const hasControl = (text: string, allowed = ""): boolean =>
  [...text].some((char) => !allowed.includes(char) && ((char.codePointAt(0) ?? 0) < 0x20 || char === "\u007f"))
const isText = (value: unknown, minimum: number, maximum: number, allowed = ""): boolean =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum && !hasControl(value, allowed)
const isIssueNumber = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
const isRef = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && value.length >= 1 && value.length <= 255 && !value.includes("..") && /^[A-Za-z0-9._/-]+$/.test(value))
const isRepoPath = (value: unknown): boolean =>
  isText(value, 1, 1024) && typeof value === "string" && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..")
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** Whether `text` survives UTF-8: false for an unpaired surrogate. */
const wellFormed = (text: string): boolean => new TextDecoder().decode(new TextEncoder().encode(text)) === text

/** Why a call that reached a dep carries an argument outside its bounds, or none. */
const outOfBounds = (call: World["calls"][number], login: string): string | undefined => {
  const [owner, name, third, fourth] = call.args
  if (typeof owner !== "string" || !NAME.test(owner) || typeof name !== "string" || !NAME.test(name)) return `${call.dep}: repository`
  const record = (typeof third === "object" && third !== null ? third : {}) as Record<string, unknown>
  switch (call.dep) {
    case "readTree":
      return isRef(third) ? undefined : "readTree: ref"
    case "readFile":
      return !isRepoPath(third) ? "readFile: path" : isRef(fourth) ? undefined : "readFile: ref"
    case "listIssues":
      return ["open", "closed", "all"].includes(record["state"] as string) &&
          isText(record["q"], 0, 256) && record["q"] === (record["q"] as string).trim() &&
          typeof record["limit"] === "number" && Number.isInteger(record["limit"]) && record["limit"] >= 1 && record["limit"] <= 100 &&
          (record["cursor"] === undefined || (typeof record["cursor"] === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(record["cursor"])))
        ? undefined
        : "listIssues: query"
    case "getIssue":
    case "getPull":
    case "getPullFiles":
      return isIssueNumber(third) ? undefined : `${call.dep}: number`
    case "listPulls":
      return ["open", "closed", "all"].includes(third as string) ? undefined : "listPulls: state"
    case "listDocs":
      return isText(third, 0, 256) ? undefined : "listDocs: q"
    case "readDoc":
      return isText(third, 1, 512) && (third as string).startsWith("/") && !(third as string).includes("\\") ? undefined : "readDoc: path"
    case "createIssue":
    case "commentIssue": {
      const footer = `${agentAttribution(login)} (agent)`
      const body = record["body"]
      if (typeof body !== "string" || !body.endsWith(footer) || body.length > 60_000 + footer.length + 2 || hasControl(body, "\n\r\t")) return `${call.dep}: body`
      if (typeof record["writeId"] !== "string" || !UUID_V5.test(record["writeId"])) return `${call.dep}: writeId`
      if (record["agentLabel"] !== `${login} (agent)` || record["login"] !== login) return `${call.dep}: attribution`
      if (call.dep === "createIssue") return isText(record["title"], 1, 256) ? undefined : "createIssue: title"
      return isIssueNumber(record["number"]) ? undefined : "commentIssue: number"
    }
    case "draftTodo":
      return isText(record["title"], 1, 200) && isText(record["prompt"], 1, 20_000, "\n\r\t") &&
          (record["acceptance"] === undefined || isText(record["acceptance"], 1, 10_000, "\n\r\t")) && !("state" in record)
        ? undefined
        : "draftTodo: fields"
    case "postWorkLink": {
      const url = record["url"]
      const https = url === undefined || (typeof url === "string" && url.length <= MAX_URL_LENGTH && url.toLowerCase().startsWith("https:"))
      return isIssueNumber(record["number"]) && isText(record["ref"], 1, MAX_REF_LENGTH) && https &&
          (WORK_LINK_KINDS as ReadonlyArray<unknown>).includes(record["kind"]) && (WORK_LINK_STATES as ReadonlyArray<unknown>).includes(record["status"]) &&
          (record["summary"] === undefined || isText(record["summary"], 1, MAX_LABEL_LENGTH)) && isText(record["source"], 1, 200)
        ? undefined
        : "postWorkLink: fields"
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The MCP tools
// ---------------------------------------------------------------------------------------------------------------------

describe("BYOA MCP tools under adversarial input", () => {
  it("the catalog is the 17 tools the reference names, each with its least role, and none is a person-only act", () => {
    expect(TOOL_SPECS.map((spec) => spec.name).sort()).toEqual([...TOOLS].sort())
    expect(TOOL_SPECS).toHaveLength(17)
    for (const spec of TOOL_SPECS) {
      expect([spec.name, spec.minimum, spec.access === "write"]).toEqual([spec.name, CATALOG[spec.name]?.minimum, CATALOG[spec.name]?.writes])
      expect(isBlockedName(spec.name)).toBe(false)
    }
  })

  it("a person-only act is refused by name for every role, scope and argument, and no dep or role check is reached", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      act: int(0, MCP_BLOCKED_ACTS.length - 1),
      form: Schema.Literals(["slash", "underscore"]),
      near: Schema.Literals(["upper", "dot", "padded", "doubled", "dashed", "suffixed"]),
      role: int(0, ROLES.length - 1),
      scopes: int(0, SCOPES.length - 1),
      anonymous: Schema.Boolean,
      isPublic: Schema.Boolean,
      scoped: Schema.Boolean,
      args: int(0, TOOLS.length - 1),
    }))
    await holds(arbitrary, (input) =>
      Effect.gen(function* () {
        const role = ROLES[input.role] ?? null
        const world = worldOf(role, input.isPublic)
        const registry = registryOf(world)
        const principal = input.anonymous ? Option.none<McpPrincipal>() : Option.some(principalOf(role, SCOPES[input.scopes] ?? []))
        const context = contextOf(principal, "7", input.scoped)
        const act = MCP_BLOCKED_ACTS[input.act] ?? MCP_BLOCKED_ACTS[0]
        const args = VALID[TOOLS[input.args] ?? "repo_tree"] ?? {}

        const named = input.form === "slash" ? act : act.replace("/", "_")
        must(outcomeOf(yield* Effect.exit(registry.callTool(named, args, context))) === "person_only", `${named} was not refused person_only`)

        // A near miss names no tool: it may be refused either way, and never runs.
        const near = {
          upper: act.toUpperCase(),
          dot: act.replace("/", "."),
          padded: ` ${act} `,
          doubled: act.replace("/", "__"),
          dashed: act.replace("/", "-"),
          suffixed: `${act.replace("/", "_")}_now`,
        }[input.near]
        must(["person_only", "not_found"].includes(outcomeOf(yield* Effect.exit(registry.callTool(near, args, context)))), `${near} ran`)

        must(world.calls.length === 0, "a refused act reached a dep")
        must(world.minimums.length === 0, "a refused act reached the role check")

        // No listing names one, in any spelling.
        const fold = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "")
        const listed = yield* registry.listTools(principal, input.scoped ? REPO : undefined)
        for (const tool of listed) {
          must(!isBlockedName(tool.name), `${tool.name} is listed`)
          must(!MCP_BLOCKED_ACTS.some((blocked) => fold(blocked) === fold(tool.name)), `${tool.name} spells a person-only act`)
          must(tool.annotations?.destructiveHint === false, `${tool.name} is listed destructive`)
        }

        // The agent's actor is never the person: the stack refuses its commit, drop and settings at every role.
        if (Option.isSome(principal)) {
          const actor = principal.value.actor
          must(!mayChange(actor) && !mayConfigure(actor) && viaOf(actor) === "agent", "an MCP agent may change a stack")
        }
        return true
      }), pureExecutions)
  })

  it("each tool runs exactly at its least role and above: gating is monotone, a refused call reaches no dep, and the listing agrees", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      tool: int(0, TOOLS.length - 1),
      scopes: int(0, SCOPES.length - 1),
      anonymous: Schema.Boolean,
      isPublic: Schema.Boolean,
      named: Schema.Literals(["default", "owner-repo", "repository"]),
    }))
    await holds(arbitrary, (input) =>
      Effect.gen(function* () {
        const tool = TOOLS[input.tool] ?? "repo_tree"
        const reference = CATALOG[tool] ?? { minimum: null, writes: false }
        const scopes = SCOPES[input.scopes] ?? []
        const args = {
          ...VALID[tool],
          ...(input.named === "owner-repo" ? { owner: "octo", repo: "hello" } : input.named === "repository" ? { repository: "octo/hello" } : {}),
        }
        const ran: Array<boolean> = []
        for (const role of ROLES) {
          const world = worldOf(role, input.isPublic)
          const registry = registryOf(world)
          const principal = input.anonymous ? Option.none<McpPrincipal>() : Option.some(principalOf(role, scopes))
          const effective = input.anonymous ? null : role
          const outcome = outcomeOf(yield* Effect.exit(registry.callTool(tool, args, contextOf(principal))))
          const readAllowed = (input.isPublic && reference.minimum === null) || (!input.anonymous && scopes.includes("mcp:read"))
          const expected = reference.writes
            ? input.anonymous ? "authentication" : !scopes.includes("mcp:write") || rank(effective) < rank(reference.minimum) ? "forbidden" : "ok"
            : !readAllowed || (!input.isPublic && effective === null) || rank(effective) < rank(reference.minimum)
            ? "forbidden"
            : "ok"
          must(outcome === expected, `${tool} as ${String(effective)}: ${outcome}, expected ${expected}`)
          must((outcome === "ok") === (world.calls.length > 0), `${tool} as ${String(effective)}: ${outcome} with ${world.calls.length} dep calls`)
          // A write asks the auth service for the reference's least role, never a lower one.
          if (reference.writes) must(world.minimums.every((minimum) => minimum === reference.minimum), `${tool} asked for ${world.minimums.join(",")}`)
          if (outcome === "ok") {
            const where = input.named === "default" ? REPO : { owner: "octo", name: "hello" }
            must(world.calls.every((call) => call.args[0] === where.owner && call.args[1] === where.name), `${tool} read another repository`)
          }
          // On a public repository the listing shows a tool exactly when the call runs.
          if (input.isPublic) {
            const listed = (yield* registry.listTools(principal, REPO)).some((descriptor) => descriptor.name === tool)
            must(listed === (outcome === "ok"), `${tool} as ${String(effective)}: listed ${listed}, ${outcome}`)
          }
          ran.push(outcome === "ok")
        }
        // Monotone: once a role may, every role above it may.
        must(ran.every((may, index) => !may || ran.slice(index).every(Boolean)), `${tool} is not monotone in role: ${ran.join(",")}`)
        return true
      }), pureExecutions)
  })

  it("hostile arguments are refused invalid_params or reach a dep inside its bounds: no defect, no traversal, no unbounded text", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      tool: int(0, TOOLS.length - 1),
      raw: Schema.String.check(Schema.isMaxLength(64)),
      fields: Schema.Array(Schema.Struct({ key: int(0, KEYS.length - 1), value: int(0, HOSTILE.length) })).check(Schema.isMaxLength(6)),
      flow: Schema.Array(int(0, HOSTILE_TEXT.length - 1)).check(Schema.isMaxLength(4)),
      manifest: Schema.Literals(["flows", "not-json", "array", "empty"]),
      scoped: Schema.Boolean,
    }))
    await holds(arbitrary, (input) =>
      Effect.gen(function* () {
        const tool = TOOLS[input.tool] ?? "repo_tree"
        const hostile = (index: number) => HOSTILE_TEXT[index % HOSTILE_TEXT.length]
        const manifest = input.manifest === "flows"
          ? JSON.stringify({
            flows: [{ id: "issue/repro", path: hostile(input.flow[0] ?? 0) }, ...input.flow.map((index) => ({ id: hostile(index), path: hostile(index + 1) }))],
            owns: input.flow.map(hostile),
            contributes: { triggers: input.flow.map((index) => ({ flow: hostile(index + 2), title: hostile(index) })) },
          })
          : input.manifest === "not-json" ? "{ flows: [" : input.manifest === "array" ? "[1, null]" : ""
        const world = worldOf("admin", true, manifest)
        const registry = registryOf(world)
        const args: Record<string, unknown> = { ...VALID[tool] }
        for (const field of input.fields) {
          const key = KEYS[field.key] ?? "path"
          Object.defineProperty(args, key, { value: field.value === HOSTILE.length ? input.raw : HOSTILE[field.value], enumerable: true, configurable: true, writable: true })
        }
        const principal = principalOf("admin", ["mcp:read", "mcp:write"])
        const exit = yield* Effect.exit(registry.callTool(tool, args, contextOf(Option.some(principal), "9", input.scoped)))
        const outcome = outcomeOf(exit)
        must(outcome === "ok" || outcome === "invalid_params", `${tool} answered ${outcome}`)
        must(messageOf(exit).length <= 600, `${tool} echoed ${messageOf(exit).length} characters`)
        must(outcome === "ok" || world.calls.every((call) => call.dep === "readFile"), `${tool} reached a dep and was refused`)
        for (const call of world.calls) {
          const why = outOfBounds(call, principal.login)
          must(why === undefined, `${tool} passed ${why ?? ""}: ${JSON.stringify(call.args).slice(0, 300)}`)
        }
        // The manifest steers flow_get only to a path inside the repository.
        if (Exit.isSuccess(exit)) {
          for (const block of exit.value.content) must(block.type === "text" && typeof block.text === "string", `${tool} answered a non-text block`)
        }

        // A name that is no tool, an object's inherited members among them, is not_found and echoes at most 100 characters.
        for (const name of [input.raw, "__proto__", "constructor", "toString", "hasOwnProperty", "x".repeat(5_000)]) {
          if (TOOLS.includes(name) || isBlockedName(name)) continue
          const unknown = yield* Effect.exit(registry.callTool(name, args, contextOf(Option.some(principal))))
          must(outcomeOf(unknown) === "not_found", `unknown tool ${name.slice(0, 20)} answered ${outcomeOf(unknown)}`)
          must(messageOf(unknown).length <= 113, "an unknown tool's name was echoed unbounded")
        }
        return true
      }), pureExecutions)
  })

  it("a write's id is one per token, tool and idempotency key: a retry repeats it, another key, tool or token never shares it", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,40}$/)),
      other: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,40}$/)),
      first: Schema.String.check(Schema.isMaxLength(24)),
      second: Schema.String.check(Schema.isMaxLength(24)),
      body: Schema.Literals(["It breaks.", "", "   \n\t ", "trailing  \n\n", "Smithers for @mia (agent)"]),
    }))
    await holds(arbitrary, (input) =>
      Effect.gen(function* () {
        const world = worldOf("member")
        const registry = registryOf(world)
        /** One write: how it went, and the write id and body that reached GitHub's admission when it ran. */
        const write = (tool: string, login: string, requestId: string, key?: string) =>
          Effect.gen(function* () {
            const reached = world.calls.length
            const exit = yield* Effect.exit(registry.callTool(
              tool,
              { ...VALID[tool], body: tool === "issue_create" ? input.body : "Same here.", ...(key === undefined ? {} : { idempotencyKey: key }) },
              contextOf(Option.some(principalOf("member", ["mcp:write"], login)), requestId),
            ))
            const sent = world.calls[reached]?.args[2] as { readonly writeId: string; readonly body: string } | undefined
            return { outcome: outcomeOf(exit), id: sent?.writeId ?? "", body: sent?.body ?? "", calls: world.calls.length - reached }
          })

        const keyed = yield* write("issue_create", "mia", input.first, input.key)
        const retried = yield* write("issue_create", "mia", input.second, input.key)
        const comment = yield* write("issue_comment", "mia", input.first, input.key)
        const stranger = yield* write("issue_create", "bob", input.first, input.key)
        const rekeyed = yield* write("issue_create", "mia", input.first, input.other)
        for (const each of [keyed, retried, comment, stranger, rekeyed]) {
          must(each.outcome === "ok" && each.calls === 1 && UUID_V5.test(each.id), `a keyed write answered ${each.outcome} with id ${each.id}`)
        }
        must(keyed.id === retried.id, "a retry under one key made another write id")
        must(keyed.id === (yield* mcpWriteId("token-mia", "issue_create", input.key)), "the write id is not the token, tool and key's")
        must(comment.id !== keyed.id, "a comment shares a create's write id")
        must(stranger.id !== keyed.id, "another token shares the write id")
        must((rekeyed.id === keyed.id) === (input.other === input.key), "another key shares the write id")

        // With no key the JSON-RPC request id is the key: any text a client can send, an unpaired surrogate included,
        // which has no UTF-8 to hash and is refused, never a defect.
        const first = yield* write("issue_create", "mia", input.first)
        const second = yield* write("issue_create", "mia", input.second)
        for (const [each, requestId] of [[first, input.first], [second, input.second]] as const) {
          const expected = wellFormed(requestId) ? "ok" : "invalid_params"
          must(each.outcome === expected && each.calls === (expected === "ok" ? 1 : 0), `an unkeyed write under ${JSON.stringify(requestId)} answered ${each.outcome}`)
        }
        if (first.outcome === "ok" && second.outcome === "ok") {
          must((first.id === second.id) === (input.first === input.second), "unkeyed writes don't follow the request id")
          must(first.id !== keyed.id || `rpc:${input.first}` === input.key, "an unkeyed write shares a keyed write's id")
        }

        // The text posted ends with the agent's attribution, once appended, whatever the body.
        const footer = `${agentAttribution("mia")} (agent)`
        const posted = keyed.body
        must(posted === attributed(input.body, "mia") && posted.endsWith(footer), "the body is not attributed")
        must(input.body.trim() === "" ? posted === footer : posted === `${input.body.trimEnd()}\n\n${footer}`, "the attribution moved the body")
        return true
      }), ioExecutions)
  })

  // Found by the property above (seed 20261123, shrunk to request id "\ud800"): `Uuid.v5` dies on an unpaired
  // surrogate, so an unkeyed issue_create or issue_comment under such a JSON-RPC id was a defect, not a tool error.
  it("regression: an unkeyed write whose JSON-RPC id is an unpaired surrogate is refused invalid_params and writes nothing", async () => {
    for (const requestId of ["\ud800", "ok\udc00", "\ud83d", "a\ud800b"]) {
      for (const tool of ["issue_create", "issue_comment"]) {
        const world = worldOf("member")
        const context = contextOf(Option.some(principalOf("member", ["mcp:write"])), requestId)
        const exit = await Effect.runPromiseExit(registryOf(world).callTool(tool, { ...VALID[tool] }, context))
        expect([tool, outcomeOf(exit), world.calls.length]).toEqual([tool, "invalid_params", 0])
        // Its own key names the write instead, and a paired surrogate is ordinary text.
        const keyedExit = await Effect.runPromiseExit(registryOf(world).callTool(tool, { ...VALID[tool], idempotencyKey: "retry-1" }, context))
        const paired = await Effect.runPromiseExit(registryOf(world).callTool(tool, { ...VALID[tool] }, contextOf(context.principal, "\ud83d\ude00")))
        expect([outcomeOf(keyedExit), outcomeOf(paired), world.calls.length]).toEqual(["ok", "ok", 2])
      }
    }
  })

  it("previewText, resolveRepoArgs and declaredFlows keep their bounds on any text, any names and any manifest", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      text: Schema.String.check(Schema.isMaxLength(48)),
      repeat: int(1, 3),
      max: int(0, 64),
      owner: Schema.NullOr(int(0, HOSTILE_TEXT.length - 1)),
      repo: Schema.NullOr(int(0, HOSTILE_TEXT.length - 1)),
      repository: Schema.NullOr(Schema.Literals(["evmts/voltaire", "a/b", "A/b"])),
      scoped: Schema.Boolean,
      entries: Schema.Array(Schema.Struct({ id: int(0, HOSTILE.length - 1), path: int(0, HOSTILE.length - 1), where: Schema.Literals(["flows", "owns", "triggers"]) }))
        .check(Schema.isMaxLength(8)),
      shape: Schema.Literals(["object", "null", "string", "flows-not-array", "entries-not-objects"]),
    }))
    const encoder = new TextEncoder()
    await holds(arbitrary, (input) =>
      Effect.gen(function* () {
        // A cut is a prefix that fits, loses less than one character, and never splits one.
        const text = new TextDecoder().decode(encoder.encode(input.text.repeat(input.repeat)))
        const size = encoder.encode(text).length
        const preview = previewText(text, input.max)
        const kept = encoder.encode(preview.text).length
        must(preview.bytes === size && preview.truncated === (size > input.max), "previewText miscounts")
        must(kept <= input.max && text.startsWith(preview.text), "previewText is no fitting prefix")
        must(preview.truncated ? kept > input.max - 4 : preview.text === text, "previewText cut too much")
        must(previewText("é".repeat(MAX_FILE_PREVIEW_BYTES), MAX_FILE_PREVIEW_BYTES).text.length === MAX_FILE_PREVIEW_BYTES / 2, "the tools' own limit splits a character")

        // The repository a call names is the one it reads: never half of one, never two that disagree.
        const owner = input.owner === null ? undefined : HOSTILE_TEXT[input.owner]
        const repo = input.repo === null ? undefined : HOSTILE_TEXT[input.repo]
        const repository = input.repository ?? undefined
        const resolved = yield* Effect.exit(resolveRepoArgs({ owner, repo, repository }, input.scoped ? REPO : undefined))
        if (Exit.isSuccess(resolved)) {
          const expected = repository !== undefined
            ? { owner: repository.split("/")[0], name: repository.split("/")[1] }
            : owner !== undefined ? { owner, name: repo } : REPO
          must(resolved.value.owner === expected.owner && resolved.value.name === expected.name, "resolveRepoArgs read another repository")
          must(owner === undefined || owner === resolved.value.owner, "resolveRepoArgs ignored owner")
          must(repo === undefined || repo === resolved.value.name, "resolveRepoArgs ignored repo")
        } else {
          must(outcomeOf(resolved) === "invalid_params", "resolveRepoArgs failed otherwise")
          must(repository !== undefined ? owner !== undefined || repo !== undefined : (owner === undefined) !== (repo === undefined) || !input.scoped, "resolveRepoArgs refused a named repository")
        }

        // Whatever a repository's factory.json says, the flows it declares have a safe id and a path inside the repository.
        const entry = (index: number) => HOSTILE[index % HOSTILE.length]
        const manifest: unknown = input.shape === "null" ? null : input.shape === "string" ? "flows" : input.shape === "flows-not-array"
          ? { flows: { id: "a" }, owns: "ci", contributes: [] }
          : input.shape === "entries-not-objects"
          ? { flows: input.entries.map((each) => entry(each.id)), owns: input.entries.map((each) => entry(each.path)), contributes: { triggers: [null, 1, "x"] } }
          : {
            flows: input.entries.filter((each) => each.where === "flows").map((each) => ({ id: entry(each.id), path: entry(each.path), summary: entry(each.path), kind: entry(each.id), featured: entry(each.path) })),
            owns: input.entries.filter((each) => each.where === "owns").map((each) => entry(each.id)),
            contributes: { triggers: input.entries.filter((each) => each.where === "triggers").map((each) => ({ flow: entry(each.id), title: entry(each.path) })) },
          }
        const flows = declaredFlows(manifest)
        must(flows.length <= 500 && new Set(flows.map((flow) => flow.id)).size === flows.length, "declaredFlows repeats an id")
        for (const flow of flows) {
          must(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(flow.id) && flow.id.length <= 200 && !flow.id.split("/").includes(".."), `flow id ${flow.id.slice(0, 40)}`)
          must(flow.path === null || isRepoPath(flow.path), `flow path ${String(flow.path).slice(0, 40)}`)
          must((flow.summary?.length ?? 0) <= 500 && (flow.kind?.length ?? 0) <= 20 && typeof flow.featured === "boolean", "a flow's text is unbounded")
        }
        if (input.shape !== "object") must(flows.length === 0 || input.shape === "entries-not-objects", "a manifest that is no object declared flows")
        return true
      }), pureExecutions)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The TODO stack against a reference model
// ---------------------------------------------------------------------------------------------------------------------

interface ModelTodo {
  readonly id: string
  readonly number: number
  state: TodoState
  attempt: number
  after: string | null
}

/** The stack as the reference keeps it: the open TODOs as an ordered list, every TODO by id. */
interface Model {
  next: number
  lanes: number
  maxOpen: number
  base: StackBase
  readonly order: Array<string>
  readonly todos: Map<string, ModelTodo>
}

interface Told {
  readonly kind: string
  readonly number?: number
  readonly position?: number
  readonly changed?: boolean
  readonly stopped?: string
  readonly state?: string
  readonly starts?: ReadonlyArray<string>
}

/** One line for a result, the product's or the reference's. */
const line = (told: Told): string =>
  JSON.stringify([told.kind, told.number ?? null, told.position ?? null, told.changed ?? null, told.stopped ?? null, told.state ?? null, told.starts ?? []])

const toldOf = (result: Result): string =>
  result.kind === "refused" ? line({ kind: `refused:${result.code}` }) : line({
    kind: result.kind,
    ...(result.kind === "configured" ? {} : { number: result.number }),
    ...(result.kind === "committed" ? { position: result.position } : {}),
    ...(result.kind === "dropped" ? { changed: result.changed } : {}),
    ...(result.kind === "dropped" && result.stopped !== undefined ? { stopped: `${result.stopped.todoId}#${result.stopped.ordinal}` } : {}),
    ...(result.kind === "finished" ? { state: result.state } : {}),
    starts: result.starts.map((start) => `${start.todoId}#${start.ordinal}@${start.number}r${start.revision}`),
  })

const refusedAs = (code: string): string => line({ kind: `refused:${code}` })

/** Starts the oldest Queued TODOs whose whole chain is In review, while a lane is free. */
const admit = (model: Model): ReadonlyArray<string> => {
  const inReview = (after: string | null): boolean => {
    for (let id = after; id !== null;) {
      const below = model.todos.get(id)
      if (below === undefined || below.state !== "in_review") return false
      id = below.after
    }
    return true
  }
  const ready = model.order.flatMap((id) => {
    const todo = model.todos.get(id)
    return todo !== undefined && todo.state === "queued" && inReview(todo.after) ? [todo] : []
  })
  let free = model.lanes - [...model.todos.values()].filter((todo) => todo.state === "working").length
  const starts: Array<string> = []
  for (const todo of ready) {
    if (free <= 0) break
    free--
    todo.state = "working"
    todo.attempt++
    starts.push(`${todo.id}#${todo.attempt}@${todo.number}r1`)
  }
  return starts
}

/** `todo` leaves the stack: the TODOs stacked on it take what it stacked on, and fail when it had published. */
const leave = (model: Model, todo: ModelTodo, state: "merged" | "dropped", published: boolean): void => {
  model.order.splice(model.order.indexOf(todo.id), 1)
  todo.state = state
  for (const other of model.todos.values()) {
    if (other.after !== todo.id) continue
    other.after = todo.after
    if (published && other.state === "queued") other.state = "failed"
  }
}

/** What `op` does to the reference, as one line. */
const step = (model: Model, op: Op): string => {
  if (op.kind === "commit") {
    if (model.order.length >= model.maxOpen) return refusedAs("stack_full")
    let after: string | null = null
    if (op.after === undefined) after = model.base === "stacked" ? model.order.at(-1) ?? null : null
    else if (op.after !== null) {
      const named = model.order.find((id) => model.todos.get(id)?.number === op.after)
      if (named === undefined) return refusedAs("after_not_open")
      after = named
    }
    const todo: ModelTodo = { id: op.id, number: model.next++, state: "queued", attempt: 0, after }
    model.todos.set(todo.id, todo)
    model.order.push(todo.id)
    return line({ kind: "committed", number: todo.number, position: model.order.length, starts: admit(model) })
  }
  if (op.kind === "configure") {
    model.lanes = op.lanes
    model.maxOpen = op.maxOpen
    model.base = op.base
    return line({ kind: "configured", starts: admit(model) })
  }
  if (op.kind === "publish" || op.kind === "finish") {
    const todo = model.todos.get(op.id)
    if (todo === undefined || (todo.state !== "working" && todo.state !== "in_review") || todo.attempt !== op.ordinal) return refusedAs("stale")
    if (op.kind === "publish") {
      todo.state = "in_review"
      return line({ kind: "published", number: todo.number, starts: admit(model) })
    }
    if (op.state === "failed") todo.state = "failed"
    else leave(model, todo, op.state, op.state === "dropped")
    return line({ kind: "finished", number: todo.number, state: op.state, starts: admit(model) })
  }
  const todo = [...model.todos.values()].find((each) => each.number === op.number)
  if (todo === undefined) return refusedAs("not_found")
  if (op.kind === "retry") {
    if (todo.state !== "failed") return refusedAs("not_retryable")
    todo.state = "queued"
    return line({ kind: "retried", number: todo.number, starts: admit(model) })
  }
  if (todo.state === "merged") return refusedAs("merged")
  if (todo.state === "dropped") return line({ kind: "dropped", number: todo.number, changed: false, starts: [] })
  const live = todo.state === "working" || todo.state === "in_review"
  const stopped = `${todo.id}#${todo.attempt}`
  leave(model, todo, "dropped", todo.state === "in_review")
  return line({ kind: "dropped", number: todo.number, changed: true, ...(live ? { stopped } : {}), starts: admit(model) })
}

const rowLine = (id: string, number: number, state: string, position: number | null, attempt: number, after: string | null): string =>
  `${number}:${id}:${state}:${position ?? "-"}:${attempt}:${after ?? "-"}`

const modelLines = (model: Model): ReadonlyArray<string> =>
  [...model.todos.values()].map((todo) => {
    const index = model.order.indexOf(todo.id)
    return rowLine(todo.id, todo.number, todo.state, index === -1 ? null : index + 1, todo.attempt, todo.after)
  }).sort()

const stackLines = (stack: Rules): ReadonlyArray<string> =>
  stack.todos.map((todo) => rowLine(todo.id, todo.number, todo.state, todo.position, todo.attempt, todo.after)).sort()

const STACK_REPO = "github/octo/hello"

const Command = Schema.Struct({
  kind: Schema.Literals(["commit", "commit", "commit", "drop", "retry", "configure", "publish", "publish", "finish", "finish"]),
  pick: int(0, 15),
  after: Schema.Literals(["base", "none", "pick"]),
  title: Schema.Literals(["a", "b"]),
  lanes: int(0, 4),
  maxOpen: int(1, 8),
  base: Schema.Literals(STACK_BASES),
  ending: Schema.Literals(["merged", "dropped", "failed"]),
  skew: Schema.Literals([0, 0, 0, 0, 1, -1]),
  // Mostly people who may press, so a sequence gets deep; a Guest, a stranger and an agent still turn up.
  role: Schema.Literals([0, 1, 2, 2, 3, 3, 4, 4, 4, 4]),
  agent: Schema.Literals([false, false, false, false, true]),
  slot: int(0, 19),
})
type Command = typeof Command.Type

const pressed: Command = { kind: "commit", pick: 0, after: "none", title: "a", lanes: 1, maxOpen: 5, base: "stacked", ending: "failed", skew: 0, role: 4, agent: false, slot: 19 }

/**
 * Where a sequence starts, so the random changes after it meet the stack's deep states: a TODO in review with one
 * Queued on it behind a full lane, a failed TODO holding its chain, or the stack at its open limit.
 */
const PRELUDES: Readonly<Record<string, ReadonlyArray<Command>>> = {
  empty: [],
  "queued-on-review": [
    { ...pressed, kind: "configure", lanes: 1, maxOpen: 6 },
    pressed,
    { ...pressed, kind: "publish" },
    pressed,
    { ...pressed, after: "pick", pick: 1 },
    { ...pressed, after: "pick", pick: 3 },
  ],
  "failed-base": [
    { ...pressed, kind: "configure", lanes: 2, maxOpen: 6 },
    pressed,
    { ...pressed, after: "pick", pick: 1 },
    { ...pressed, kind: "finish", ending: "failed" },
    { ...pressed, after: "base" },
  ],
  full: [{ ...pressed, kind: "configure", lanes: 0, maxOpen: 2 }, pressed, { ...pressed, after: "base" }],
}

describe("the TODO stack against a reference model", () => {
  it("random commits, drops, retries, settings and run reports match the model: positions 1 to n, lanes kept, role gates held, an op id answers once", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      lanes: int(0, 3),
      base: Schema.Literals(STACK_BASES),
      prelude: Schema.Literals(["empty", "queued-on-review", "queued-on-review", "failed-base", "full"]),
      commands: Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(40)),
    }))
    await holds(arbitrary, (input) =>
      Effect.sync(() => {
        let stack: Rules = { nextNumber: 1, lanes: input.lanes, maxOpen: 5, base: input.base, todos: [] }
        const model: Model = { next: 1, lanes: input.lanes, maxOpen: 5, base: input.base, order: [], todos: new Map() }
        /** The writer's receipts, by op id: the payload's hash as the product makes it, and the payload as the reference reads it. */
        const receipts = new Map<string, { readonly hash: string; readonly payload: string }>()
        const createdBy = new Map<number, string>()
        const settledLines = new Map<string, string>()

        const commands = [...(PRELUDES[input.prelude] ?? []), ...input.commands]
        commands.forEach((command, index) => {
          const role = ROLES[command.role] ?? null
          const actor: Actor = {
            subject: { kind: "person", id: `person-${command.role}` },
            role,
            login: `login-${command.role}`,
            ...(command.agent ? { act: { kind: "agent" as const, id: "mcp:token" } } : {}),
          }
          const number = command.pick % (stack.nextNumber + 1)
          const target = stack.todos[command.pick % Math.max(1, stack.todos.length)]
          const before = stack
          const workingBefore = stack.todos.filter((todo) => todo.state === "working").length
          let op: Op

          if (command.kind === "publish" || command.kind === "finish") {
            // A run's report: no person presses it, and no op id names it.
            const id = target?.id ?? "todo-never"
            const ordinal = (target?.attempt ?? 1) + command.skew
            op = command.kind === "publish" ? { kind: "publish", id, ordinal } : { kind: "finish", id, ordinal, state: command.ending }
          } else {
            // The route's gate (worker/stack/Api.ts) against the reference: commit and drop a Member's own press,
            // settings an Admin's own press, retry a Member's or their agent's.
            const allowed = command.kind === "retry" ? mayRead(Option.some(actor)) : command.kind === "configure" ? mayConfigure(actor) : mayChange(actor)
            const expected = command.kind === "retry" ? rank(role) >= 2 : command.kind === "configure" ? rank(role) === 4 && !command.agent : rank(role) >= 2 && !command.agent
            must(allowed === expected, `${command.kind} as ${String(role)}${command.agent ? " (agent)" : ""}: allowed ${allowed}`)
            must(viaOf(actor) === (command.agent ? "agent" : "person"), "via is not the session's")
            must(mayRetryAny(actor) === rank(role) >= 3, `retry of anyone's as ${String(role)}`)
            must(!command.agent || command.kind === "retry" || !allowed, `an agent may ${command.kind}`)
            // Monotone in role: whoever may, every role above may.
            const above = ROLES.slice(command.role).map((higher) => ({ ...actor, role: higher }))
            if (allowed && command.kind !== "configure") must(above.every((higher) => command.kind === "retry" ? mayRead(Option.some(higher)) : mayChange(higher)), "a higher role is refused")
            if (!allowed) return

            // Four op ids are used again and again; every other change has its own.
            const opId = command.slot < 4 ? `op-${command.slot}` : `op-new-${index}`
            const after = command.after === "base" ? undefined : command.after === "none" ? null : number
            const change: Change = {
              opId,
              repoId: STACK_REPO,
              actor: { id: actor.subject.id, login: `login-${command.role}` },
              via: viaOf(actor),
              op: command.kind === "commit"
                ? { kind: "commit", title: command.title, prompt: "Do it.", acceptance: [], ...(after === undefined ? {} : { after }) }
                : command.kind === "configure"
                ? { kind: "configure", lanes: command.lanes, maxOpen: command.maxOpen, base: command.base }
                : { kind: command.kind, number },
              retryAny: mayRetryAny(actor),
            }
            const hash = payloadHash(change)
            const payload = [
              command.agent ? "agent" : "person",
              command.kind,
              command.kind === "retry" ? actor.subject.id : "",
              command.kind === "commit" ? `${command.title}/${String(after)}` : command.kind === "configure" ? `${command.lanes}/${command.maxOpen}/${command.base}` : String(number),
            ].join("|")
            must(hash === payloadHash({ ...change, opId: `other-${index}` }), "the payload hash depends on the op id")
            const prior = receipts.get(opId)
            if (prior !== undefined) {
              // Repeated (the same payload) or a conflict (another): the hash tells them apart exactly, and nothing moves.
              must((prior.hash === hash) === (prior.payload === payload), `op ${opId}: hash and payload disagree on a repeat`)
              return
            }
            // A Member retries only their own TODO (the writer's RetryForbidden, which keeps no receipt).
            if (command.kind === "retry" && !mayRetryAny(actor) && createdBy.has(number) && createdBy.get(number) !== actor.subject.id) return
            receipts.set(opId, { hash, payload })
            op = change.op.kind === "commit" ? { kind: "commit", id: opId, ...(after === undefined ? {} : { after }) } : (change.op as Op)
          }

          const applied = applyRules(stack, op)
          const told = toldOf(applied.result)
          must(told === step(model, op), `step ${index} ${JSON.stringify(op)}: ${told}`)
          stack = applied.stack
          if (applied.result.kind === "committed" && op.kind === "commit") createdBy.set(applied.result.number, `person-${command.role}`)

          // The stack is the model's, row for row.
          must(JSON.stringify(stackLines(stack)) === JSON.stringify(modelLines(model)), `step ${index}: rows ${stackLines(stack).join(" ")} != ${modelLines(model).join(" ")}`)
          must(stack.nextNumber === model.next && stack.lanes === model.lanes && stack.maxOpen === model.maxOpen && stack.base === model.base, `step ${index}: settings`)
          // A refusal changes nothing; a commit alone spends a number.
          if (applied.result.kind === "refused") must(stack === before, `step ${index}: a refusal changed the stack`)
          must(stack.nextNumber === before.nextNumber + (applied.result.kind === "committed" ? 1 : 0), `step ${index}: a number was spent or reused`)
          // Open positions are exactly 1 to n, each once; a settled TODO has none.
          const positions = stack.todos.flatMap((todo) => todo.position === null ? [] : [todo.position]).sort((a, b) => a - b)
          must(positions.every((position, at) => position === at + 1), `step ${index}: positions ${positions.join(",")}`)
          must(stack.todos.every((todo) => (todo.state === "merged" || todo.state === "dropped") === (todo.position === null)), `step ${index}: a settled TODO is placed`)
          must(new Set(stack.todos.map((todo) => todo.number)).size === stack.todos.length, `step ${index}: a number is taken twice`)
          must(violations(stack).length === 0, `step ${index}: ${violations(stack).join("; ")}`)
          // The lanes hold: more TODOs work only while a lane is free.
          const working = stack.todos.filter((todo) => todo.state === "working").length
          must(working <= Math.max(stack.lanes, workingBefore), `step ${index}: ${working} working in ${stack.lanes} lanes`)
          // Every start is the next attempt of a TODO that was Queued, was just committed, or is the failed one this retry queues again.
          if (applied.result.kind !== "refused") {
            for (const start of applied.result.starts) {
              const was = before.todos.find((todo) => todo.id === start.todoId) ?? { state: "queued", attempt: 0, number: -1 }
              const now = stack.todos.find((todo) => todo.id === start.todoId)
              const startable = was.state === "queued" || (op.kind === "retry" && was.state === "failed" && was.number === op.number)
              must(startable && now?.state === "working" && now.attempt === was.attempt + 1 && start.ordinal === now.attempt, `step ${index}: a start of ${start.todoId} from ${was.state}`)
            }
          }
          // Merged and dropped are final: a settled TODO keeps its number, its state and its attempts, and stays unplaced.
          for (const todo of stack.todos) {
            const settled = settledLines.get(todo.id)
            const now = `${todo.number}:${todo.state}:${todo.attempt}:${todo.position ?? "-"}`
            must(settled === undefined || settled === now, `step ${index}: settled ${todo.id} changed from ${settled ?? ""} to ${now}`)
            if (todo.position === null) settledLines.set(todo.id, now)
          }
          must(stack.todos.length >= settledLines.size && before.todos.every((todo) => stack.todos.some((kept) => kept.id === todo.id)), `step ${index}: a TODO vanished`)
          // The same op on the same stack answers the same: the rules read nothing else.
          must(toldOf(applyRules(before, op).result) === told, `step ${index}: the rules are not deterministic`)
        })
        return true
      }), pureExecutions)
  })

  it("a drop is idempotent and a stale report changes nothing, from any reachable stack", async () => {
    const arbitrary = Arbitrary.schema(Schema.Struct({
      commits: int(1, 6),
      lanes: int(0, 3),
      base: Schema.Literals(STACK_BASES),
      published: Schema.Array(int(0, 5)).check(Schema.isMaxLength(4)),
      drop: int(1, 7),
      skew: Schema.Literals([1, -1, 7]),
    }))
    await holds(arbitrary, (input) =>
      Effect.sync(() => {
        let stack: Rules = { nextNumber: 1, lanes: input.lanes, maxOpen: 50, base: input.base, todos: [] }
        for (let index = 0; index < input.commits; index++) stack = applyRules(stack, { kind: "commit", id: `todo-${index}` }).stack
        for (const pick of input.published) {
          const todo = stack.todos[pick % stack.todos.length]
          if (todo !== undefined) stack = applyRules(stack, { kind: "publish", id: todo.id, ordinal: todo.attempt }).stack
        }
        const once = applyRules(stack, { kind: "drop", number: input.drop })
        const twice = applyRules(once.stack, { kind: "drop", number: input.drop })
        if (input.drop > input.commits) {
          must(toldOf(once.result) === refusedAs("not_found") && once.stack === stack, "a drop of no TODO was not refused not_found")
        } else {
          must(once.result.kind === "dropped" && once.result.changed, "a drop of an open TODO did not drop it")
          must(twice.result.kind === "dropped" && !twice.result.changed && twice.result.starts.length === 0 && twice.result.stopped === undefined, "a second drop did something")
          must(twice.stack === once.stack, "a second drop moved the stack")
          must(toldOf(applyRules(once.stack, { kind: "retry", number: input.drop }).result) === refusedAs("not_retryable"), "a dropped TODO was retried")
        }
        for (const todo of once.stack.todos) {
          for (const report of [
            { kind: "publish", id: todo.id, ordinal: todo.attempt + input.skew },
            { kind: "finish", id: todo.id, ordinal: todo.attempt + input.skew, state: "merged" },
          ] satisfies ReadonlyArray<Op>) {
            const stale = applyRules(once.stack, report)
            must(toldOf(stale.result) === refusedAs("stale") && stale.stack === once.stack, `a stale ${report.kind} of ${todo.id} changed the stack`)
          }
        }
        return true
      }), pureExecutions)
  })
})
