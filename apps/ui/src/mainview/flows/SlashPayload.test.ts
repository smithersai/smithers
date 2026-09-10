import { describe, expect, test } from "bun:test"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows } from "./Flows"
import { nameOf } from "./registry"
import { hasGrammar, payloadFor } from "./SlashPayload"

/*
 * The composer boundary refuses what it cannot parse exactly. `files.list`
 * and `files.read` already reject extra tokens; `flow.run` and `admin.grant`
 * silently dropped every token after the second, so `/admin.grant 25 octocat
 * 1000` granted 25 with the typo invisible. Extra tokens are now refused.
 */

describe("slash payload argument counts", () => {
  test("chat.clear is local by default and summarization requires its exact flag", () => {
    expect(payloadFor("chat.clear", "")).toEqual({ payload: {} })
    expect(payloadFor("chat.clear", "--summarize")).toEqual({ payload: { summarize: true } })
    for (const input of ["true", "--sumarize", "--summarize extra", "--summarize --summarize"]) {
      expect(payloadFor("chat.clear", input)).toHaveProperty("error")
    }
  })

  test("flow.run refuses extra text that is not a JSON input object", () => {
    const parsed = payloadFor("flow.run", "create-workflow will/flows extra")
    expect(parsed).toEqual({ error: "Flow input is not valid JSON. Fix the JSON object before running it." })
  })

  test("flow.run still takes its name and optional repo", () => {
    expect(payloadFor("flow.run", "create-workflow")).toEqual({ payload: { name: "create-workflow" } })
    expect(payloadFor("flow.run", "create-workflow will/flows")).toEqual({
      payload: { name: "create-workflow", repo: "will/flows" }
    })
    expect(payloadFor("flow.run", "")).toEqual({
      error: "flow.run needs a flow name"
    })
  })

  test("admin.grant refuses a third token instead of dropping it", () => {
    const parsed = payloadFor("admin.grant", "25 octocat 1000")
    expect(parsed).toEqual({ error: "admin.grant takes an amount in dollars and a login" })
  })

  test("admin.grant still takes its amount and login", () => {
    expect(payloadFor("admin.grant", "25 octocat")).toEqual({ payload: { amountUsd: 25, login: "octocat" } })
    expect(payloadFor("admin.grant", "octocat")).toEqual({
      error: "admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat"
    })
  })

  test("the files.* boundary the others now match", () => {
    expect(payloadFor("files.list", "src will/flows extra")).toEqual({
      error: "files.list takes a path and optionally an owner/repo"
    })
  })
})

/*
 * The target reference (docs/LOCAL-APP.md "Cards"): `target.run` takes
 * `<repoId> [workspace] <label>`. A label is `//pkg:name` and never holds
 * whitespace, so the LAST token is the label and everything between it and
 * the repo id is the workspace path — a detected workspace whose directory
 * name has a space still runs where it was declared.
 */
describe("the target reference", () => {
  test("two tokens are the repo id and the label; the workspace stays absent", () => {
    expect(payloadFor("target.run", "r1 //src:lint")).toEqual({ payload: { repoId: "r1", label: "//src:lint" } })
    expect(payloadFor("target.open", "r1 //src:lint")).toEqual({ payload: { repoId: "r1", label: "//src:lint" } })
  })

  test("three tokens carry the workspace between the repo id and the label", () => {
    expect(payloadFor("target.run", "r1 aomi-sdk //:clippyFix")).toEqual({
      payload: { repoId: "r1", workspace: "aomi-sdk", label: "//:clippyFix" }
    })
  })

  test("a workspace path with a space keeps the last token as the label", () => {
    expect(payloadFor("target.run", "r1 my tools //:polish")).toEqual({
      payload: { repoId: "r1", workspace: "my tools", label: "//:polish" }
    })
  })

  test("a lone repo id is refused", () => {
    expect(payloadFor("target.run", "r1")).toEqual({ error: "target.run needs a repository id and a target label" })
  })
})

/*
 * Lane runs — the run inbox and its acts. The filters take any order, the
 * signal's JSON keeps its spacing, and every id-scoped act refuses a blank.
 */
describe("the runs grammar", () => {
  test("runs.list takes its filters in any order, positionals last", () => {
    expect(payloadFor("runs.list", "")).toEqual({ payload: {} })
    expect(payloadFor("runs.list", "parked review-pr")).toEqual({
      payload: { status: "parked", flow: "review-pr" }
    })
    expect(payloadFor("runs.list", "lineage=lin-1 parked will/flows")).toEqual({
      payload: { lineage: "lin-1", status: "parked", repo: "will/flows" }
    })
    expect(payloadFor("runs.list", "sourceCard=list-a parked will/flows")).toEqual({ payload: { sourceCard: "list-a", status: "parked", repo: "will/flows" } })
    expect(payloadFor("runs.list", "by=octocat")).toEqual({ payload: { by: "octocat" } })
    expect(payloadFor("runs.list", "a b c")).toEqual({
      error: "runs.list takes [status] [flow] [by=…] [lineage=…] [sourceCard=…] [owner/repo]"
    })
  })

  test("runs.open takes a run id and an optional repo", () => {
    expect(payloadFor("runs.open", "run-1")).toEqual({ payload: { runId: "run-1" } })
    expect(payloadFor("runs.open", "run-1 will/flows")).toEqual({ payload: { runId: "run-1", repo: "will/flows" } })
    expect(payloadFor("runs.open", "")).toEqual({
      error: "runs.open needs a run id: /runs.open <runId> [owner/repo]"
    })
  })

  test("runs.signal keeps the JSON payload verbatim", () => {
    expect(payloadFor("runs.signal", "run-1 deploy-done")).toEqual({
      payload: { runId: "run-1", name: "deploy-done" }
    })
    expect(payloadFor("runs.signal", `run-1 deploy-done {"ok": true}`)).toEqual({
      payload: { runId: "run-1", name: "deploy-done", payload: `{"ok": true}` }
    })
    expect(payloadFor("runs.signal", "run-1")).toEqual({
      error: "runs.signal needs the signal's name: /runs.signal <runId> <name> [json]"
    })
  })

  test("runs.steer keeps the whole message after the run id", () => {
    expect(payloadFor("runs.steer", "run-1 use the smaller diff")).toEqual({
      payload: { runId: "run-1", body: "use the smaller diff" }
    })
    expect(payloadFor("runs.steer", "run-1")).toEqual({ error: "runs.steer needs the message to deliver" })
  })

  test("runs.logs takes --follow anywhere and nothing else", () => {
    expect(payloadFor("runs.logs", "run-1")).toEqual({ payload: { runId: "run-1" } })
    expect(payloadFor("runs.logs", "run-1 --follow")).toEqual({ payload: { runId: "run-1", follow: true } })
    expect(payloadFor("runs.logs", "--follow run-1")).toEqual({ payload: { runId: "run-1", follow: true } })
    expect(payloadFor("runs.logs", "run-1 extra")).toEqual({
      error: "runs.logs takes a run id and optionally --follow"
    })
  })

  test("flow.run.stop takes an optional reason after the card id", () => {
    expect(payloadFor("flow.run.stop", "card-1")).toEqual({ payload: { cardId: "card-1" } })
    expect(payloadFor("flow.run.stop", "card-1 it hung")).toEqual({
      payload: { cardId: "card-1", reason: "it hung" }
    })
    expect(payloadFor("flow.run.stop", "")).toEqual({ error: "flow.run.stop needs the card id" })
  })

  test("the id-scoped acts refuse a blank run id", () => {
    for (const name of ["runs.resume", "runs.rerun", "runs.events", "runs.steps", "approvals.open"]) {
      expect(payloadFor(name, "")).toEqual({ error: `${name} needs a run id` })
    }
  })

  test("the trace's reader gestures take a filter word, or a node with an optional journal seq", () => {
    expect(payloadFor("runs.trace.filter", "run-1 failed")).toEqual({ payload: { runId: "run-1", filter: "failed" } })
    expect(payloadFor("runs.trace.filter", "")).toEqual({ error: "runs.trace.filter needs a run id" })
    expect(payloadFor("runs.trace.filter", "run-1")).toEqual({
      error: "runs.trace.filter needs one of all, running, failed, model, flow, forks, messages"
    })
    expect(payloadFor("runs.trace.filter", "run-1 calls")).toEqual({
      error: "runs.trace.filter needs one of all, running, failed, model, flow, forks, messages"
    })
    expect(payloadFor("runs.trace.filter", "run-1 failed extra")).toEqual({
      error: "runs.trace.filter takes a run id and one filter"
    })
    expect(payloadFor("runs.trace.select", "run-1 call-2")).toEqual({ payload: { runId: "run-1", nodeId: "call-2" } })
    expect(payloadFor("runs.trace.select", "run-1 call-2 7")).toEqual({ payload: { runId: "run-1", nodeId: "call-2", seq: 7 } })
    expect(payloadFor("runs.trace.select", "run-1")).toEqual({ error: "runs.trace.select needs the trace node to select" })
    expect(payloadFor("runs.trace.select", "run-1 call-2 soon")).toEqual({
      error: "runs.trace.select's seq is a journal sequence number"
    })
    expect(payloadFor("runs.trace.select", "")).toEqual({ error: "runs.trace.select needs a run id" })
  })

  test("approvals.list takes just an owner/repo", () => {
    expect(payloadFor("approvals.list", "")).toEqual({ payload: {} })
    expect(payloadFor("approvals.list", "will/flows")).toEqual({ payload: { repo: "will/flows" } })
    expect(payloadFor("approvals.list", "will/flows extra")).toEqual({
      error: "approvals.list takes just an owner/repo name"
    })
  })
})


/*
 * The line anchor (docs/code-intel/PLAN.md §1, the grammar C7 reserved for
 * `code.goto`): `files.read <path>[:<line>[:<col>]] [owner/repo]`. Only a
 * TRAILING numeric suffix comes off the path token, so a repository path
 * with a colon of its own keeps working; the parser stays first-token-is-path.
 */
describe("the files.read line anchor", () => {
  test("a trailing :line or :line:col comes off the path token into the payload", () => {
    expect(payloadFor("files.read", "src/x.ts:12")).toEqual({ payload: { path: "src/x.ts", line: 12 } })
    expect(payloadFor("files.read", "src/x.ts:12:5 will/flows")).toEqual({
      payload: { path: "src/x.ts", line: 12, column: 5, repo: "will/flows" }
    })
    expect(payloadFor("files.read", "/smithersai/smithers/src/x.ts:317")).toEqual({
      payload: { path: "/smithersai/smithers/src/x.ts", line: 317 }
    })
  })

  test("a colon inside the path is the path's own", () => {
    expect(payloadFor("files.read", "notes/a:b.md")).toEqual({ payload: { path: "notes/a:b.md" } })
    expect(payloadFor("files.read", "notes/a:b.md:4")).toEqual({ payload: { path: "notes/a:b.md", line: 4 } })
    expect(payloadFor("files.read", "v1:2:3.txt")).toEqual({ payload: { path: "v1:2:3.txt" } })
  })

  test("zero is refused by name: lines and columns are 1-based", () => {
    const error = "files.read lines and columns count from 1: /files.read <path>[:<line>[:<col>]]"
    expect(payloadFor("files.read", "src/x.ts:0")).toEqual({ error })
    expect(payloadFor("files.read", "src/x.ts:3:0")).toEqual({ error })
    expect(payloadFor("files.read", ":12")).toEqual({ error: "files.read needs a file path" })
  })

  test("files.list keeps a path exactly as typed", () => {
    expect(payloadFor("files.list", "src:1")).toEqual({ payload: { path: "src:1" } })
  })
})

/*
 * The code-intel positions (docs/code-intel/PLAN.md §4): `code.hover` and
 * `code.definition` take `<path>:<line>:<col> [owner/repo]` with BOTH numbers
 * required and 1-based; `code.diagnostics` takes the path alone. The path
 * keeps a colon of its own exactly as files.read's anchor does.
 */
describe("the code.* positions", () => {
  test("code.hover and code.definition take a path, a line, a column, and the optional repo", () => {
    expect(payloadFor("code.hover", "src/x.ts:12:5")).toEqual({ payload: { path: "src/x.ts", line: 12, column: 5 } })
    expect(payloadFor("code.definition", "src/x.ts:12:5 will/flows")).toEqual({
      payload: { path: "src/x.ts", line: 12, column: 5, repo: "will/flows" }
    })
    expect(payloadFor("code.hover", "/smithersai/smithers/src/x.ts:317:9")).toEqual({
      payload: { path: "/smithersai/smithers/src/x.ts", line: 317, column: 9 }
    })
    expect(payloadFor("code.hover", "notes/a:b.ts:4:2")).toEqual({ payload: { path: "notes/a:b.ts", line: 4, column: 2 } })
  })

  test("a position without both numbers, a zero, or an extra token is refused by name", () => {
    const usage = "/code.hover <path>:<line>:<col> [owner/repo]"
    expect(payloadFor("code.hover", "")).toEqual({ error: `code.hover needs a position: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts")).toEqual({ error: `code.hover needs <path>:<line>:<col>: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:12")).toEqual({ error: `code.hover needs <path>:<line>:<col>: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:0:1")).toEqual({ error: `code.hover lines and columns count from 1: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:1:0")).toEqual({ error: `code.hover lines and columns count from 1: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:1:1 will/flows extra")).toEqual({
      error: "code.hover takes a position and optionally an owner/repo"
    })
    expect(payloadFor("code.definition", ":1:1")).toEqual({
      error: "code.definition needs <path>:<line>:<col>: /code.definition <path>:<line>:<col> [owner/repo]"
    })
  })

  test("code.diagnostics takes the path and the optional repo, and refuses a third token", () => {
    expect(payloadFor("code.diagnostics", "src/x.ts")).toEqual({ payload: { path: "src/x.ts" } })
    expect(payloadFor("code.diagnostics", "src/x.ts will/flows")).toEqual({ payload: { path: "src/x.ts", repo: "will/flows" } })
    expect(payloadFor("code.diagnostics", "")).toEqual({
      error: "code.diagnostics needs a file path: /code.diagnostics <path> [owner/repo]"
    })
    expect(payloadFor("code.diagnostics", "src/x.ts will/flows extra")).toEqual({
      error: "code.diagnostics takes a path and optionally an owner/repo"
    })
  })
})


describe("structured flow input", () => {
  test("an optional JSON object preserves nested values and string whitespace with or without a repo", () => {
    const input = { plan: { prompt: "Keep  two spaces.\nNext line.", changes: [{ title: "One" }] }, count: 3, enabled: true }
    expect(payloadFor("flow.run", `coding will/repo ${JSON.stringify(input)}`)).toEqual({ payload: { name: "coding", repo: "will/repo", input } })
    expect(payloadFor("flow.run", `coding ${JSON.stringify(input)}`)).toEqual({ payload: { name: "coding", input } })
    for (const body of ["[]", "null", '"text"', "3", "true", "{} trailing", "{bad"]) {
      expect(payloadFor("flow.run", `coding will/repo ${body}`)).toHaveProperty("error")
    }
  })
})

test("run source parsing preserves repository context for slash-shaped run IDs", () => {
  const known = new Set(["will/flows"])
  expect(payloadFor("runs.open", "sourceCard=list-a jobs/run-1", undefined, known)).toEqual({
    payload: { runId: "jobs/run-1", sourceCard: "list-a" }
  })
  expect(payloadFor("runs.open", "sourceCard=list-a jobs/run-1 will/flows", undefined, known)).toEqual({
    payload: { runId: "jobs/run-1", repo: "will/flows", sourceCard: "list-a" }
  })
})


/*
 * The declaration/grammar gate. Argument grammar lives in one table, keyed by
 * name, beside declarations that carry their own `args` hint and input schema;
 * a declaration the table forgets decodes to the EMPTY payload, so what the
 * human typed is discarded in silence. `triggers.register` shipped exactly
 * that: it declares `[owner/repo]`, forwards `repo` to registerTrigger, and
 * had no decoder, so a named repository never reached it.
 */
describe("every declaration that takes arguments names a decoder", () => {
  /** Registration never invokes a handler, so every controller call answers with nothing. */
  const inertActions = new Proxy({}, { get: () => () => undefined }) as CommandActions

  test("a flow declaring an args hint carries a decoder, in the table or on the declaration", () => {
    const undecoded = [...baseFlows(inertActions), ...adminFlows(inertActions)]
      .filter((entry) => entry.metadata.args !== undefined)
      .map(nameOf)
      .filter((name) => !hasGrammar(name))
    expect(undecoded).toEqual([])
  })

  test("triggers.register preserves the repository it was given, as triggers.list does", () => {
    expect(payloadFor("triggers.register", "other/repo")).toEqual({ payload: { repo: "other/repo" } })
    expect(payloadFor("triggers.list", "other/repo")).toEqual({ payload: { repo: "other/repo" } })
    expect(payloadFor("triggers.register", "")).toEqual({ payload: {} })
    expect(payloadFor("triggers.register", "other/repo extra")).toEqual({
      error: "triggers.register takes just an owner/repo name"
    })
  })
})
