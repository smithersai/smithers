// Publish and Update branch (worker/branch/Publish.ts, docs/features/branch-publish.md) on the Node host against the
// scripted GitHub and a test `Machines` over an in-memory working copy, both injected Effect services: a write admitted
// as the writes route admits it, then `branch/Publish` takes the branch's working copy to GitHub as the person who
// pressed, and `branch/Update` brings the published branch up to date with its base, or settles why not.
import * as Pg from "@effect/sql-pg"
import { GitHub } from "@smthrs/integrations"
import { Cause, Context, Effect, Exit, Layer, Metric, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Expire from "../flows/Expire.ts"
import { publishExecutionId, updateExecutionId } from "../../src/features/branch/contract.ts"
import { TokenUnavailable } from "../github/Tokens.ts"
import * as Metrics from "../github/Metrics.ts"
import * as Write from "../github/Write.ts"
import { admit, database, REPOSITORY, reset, services, signedIn, sql, writeRow } from "../github/test/fixtures.ts"
import { BOT_LOGIN, type ScriptedGitHub, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import { machines } from "../test/todoMachines.ts"
import * as Conversations from "./Conversations.ts"
import { Forge } from "./Forge.ts"
import { Machines } from "./Machines.ts"
import * as Publish from "./Publish.ts"

const runtime = testFile("branch_publish")
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE branch_publications, pulls, pull_commits, reviews, branches CASCADE")
})

type Built = Awaited<ReturnType<typeof services>>["services"]
type Machine = ReturnType<typeof machines>

/** Maya, signed in, owns the Smithers-only branch `try-1`, made at main's head (or `baseSha`) in the ephemeral namespace. */
const tracked = async (
  github: ScriptedGitHub,
  options: { readonly baseSha?: string; readonly namespace?: "default" | "ephemeral"; readonly forge?: "deployment" | "github" } = {},
) => {
  const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
  const baseSha = options.baseSha ?? github.refs.get("main")!
  const made = await runtime.runPromise(
    Conversations.track(REPOSITORY.id, "try-1", "open", baseSha, maya.personId, undefined, options.namespace ?? "ephemeral", options.forge ?? "deployment"),
  )
  return { maya, branchId: made.branch.branchId, baseSha }
}

/** The branch's working copy, checked out at its base (main's head when first used): `files` written, as Save writes them. */
const edit = async (machine: Machine, branchId: string, ownerId: string, files: Readonly<Record<string, string>>, github?: ScriptedGitHub) => {
  if (github !== undefined && !machine.copies.has(branchId)) {
    machine.copies.set(branchId, { initial: new Map(github.tree("main")), files: new Map(github.tree("main")) })
  }
  const tools = Context.get(await Effect.runPromise(Layer.build(machine.layer).pipe(Effect.scoped)), Machines)
  for (const [path, content] of Object.entries(files)) {
    await Effect.runPromise(tools.tool(
      { branchId, owner: REPOSITORY.owner, name: REPOSITORY.name, branch: "try-1", namespace: "ephemeral" },
      ownerId,
      crypto.randomUUID(),
      { tool: "write", path, content },
    ))
  }
}

/** A Publish of `branchId` admitted for `who`, with the title and body the dialog sent. */
const publishing = (
  who: { readonly personId: string; readonly sessionId: string | null },
  branchId: string,
  via: "person" | "agent" = "person",
) =>
  admit(runtime, {
    actorId: who.personId,
    sessionId: via === "person" ? who.sessionId : null,
    via,
    payload: { op: "branch/publish", branchId, title: "Add a line", body: "Why it helps" },
  })

const updating = (who: { readonly personId: string; readonly sessionId: string }, branchId: string, method: "merge" | "rebase" = "merge") =>
  admit(runtime, { actorId: who.personId, sessionId: who.sessionId, via: "person", payload: { op: "branch/update", branchId, method } })

const send = (built: Built, machine: Machine, writeId: string) =>
  runtime.runPromise(Publish.steps(built).publish({ writeId }).pipe(Effect.provide(machine.layer)))

const update = (built: Built, writeId: string) => runtime.runPromise(Publish.steps(built).update({ writeId }))

/** The GitHub branch a Publish of `writeId` makes for `try-1`. */
const refOf = (writeId: string) => GitHub.Once.branchName(Publish.prefixOf("try-1"), "", Publish.keyOf(writeId, "branch"))

const publication = async (branchId: string) =>
  ((await sql(runtime, `SELECT github_ref AS ref, base_ref AS "baseRef", base_sha AS "baseSha", head_sha AS "headSha",
    pr_number AS "prNumber", write_id AS "writeId", update_state AS state FROM branch_publications WHERE branch_id = '${branchId}'`)) as unknown as Array<{
      ref: string
      baseRef: string
      baseSha: string
      headSha: string
      prNumber: number
      writeId: string
      state: string | null
    }>)[0]

/** A published branch: Maya's README change on GitHub as `try-1-<key>` with its pull request. */
const published = async (github: ScriptedGitHub) => {
  const branch = await tracked(github)
  const machine = machines(github)
  await edit(machine, branch.branchId, branch.maya.personId, { "README.md": "# Widgets\n\nA line\n" }, github)
  const writeId = await publishing(branch.maya, branch.branchId)
  const { services: built } = await services(runtime, github)
  const settled = await send(built, machine, writeId)
  return { ...branch, built, machine, writeId, ref: refOf(writeId), number: settled.prNumber! }
}

describe("branch/Publish", { timeout: 60_000 }, () => {
  test("a person's Publish makes the GitHub branch at the base, one commit of the working copy, and the pull request, as them", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, baseSha } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "# Widgets\n\nA line\n", "docs/new.md": "new\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    const ran = await runFlow(Publish.Publish, { writeId }, Publish.registration(built, machine.layer, Forge.gitHub), {
      executionId: publishExecutionId(writeId),
      maxConnections: 2,
    })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", prNumber: 1 }))
    const ref = refOf(writeId)
    const head = github.refs.get(ref)!
    const commit = github.commits.get(head)!
    expect(commit.parents).toEqual([baseSha])
    expect(commit.message).toBe(`Add a line\n\nSmithers-Write: ${Publish.keyOf(writeId, "commit")}`)
    expect([commit.login, github.tree(ref).get("README.md"), github.tree(ref).get("docs/new.md")]).toEqual(["maya", "# Widgets\n\nA line\n", "new\n"])
    const pull = github.pulls.get(1)!
    const issue = github.issues.get(1)!
    expect([pull.head, pull.base, issue.title, issue.login]).toEqual([ref, "main", "Add a line", "maya"])
    expect(GitHub.Issues.writeIdOf(issue.body)).toBe(Publish.keyOf(writeId, "pull"))
    expect(github.seen("POST", /\/git\/refs$/).map((call) => call.token)).toEqual(["user"])
    expect(github.seen("POST", /\/pulls$/).map((call) => call.token)).toEqual(["user"])
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: 1, attempts: 1 })
    expect(await publication(branchId)).toEqual({ ref, baseRef: "main", baseSha, headSha: head, prNumber: 1, writeId, state: null })
    // Read back, so every device sees the pull request before any webhook rings.
    expect(await sql(runtime, `SELECT head_ref AS head FROM pulls`)).toEqual([{ head: ref }])
    expect(github.refs.get("main")).toBe(baseSha)
  })

  test("the agent's Publish goes as the App, saying whom it acted for", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.roles.set("maya", "write")
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "agent\n" })
    const writeId = await publishing(maya, branchId, "agent")
    const { services: built } = await services(runtime, github)
    expect(await send(built, machine, writeId)).toEqual({ status: "done", prNumber: 1 })
    const issue = github.issues.get(1)!
    expect(issue.login).toBe(BOT_LOGIN)
    expect(issue.body).toContain("Why it helps\n\nSmithers for @maya")
    expect(github.commits.get(github.refs.get(refOf(writeId))!)!.message).toContain("Smithers for @maya")
  })

  test("the agent's Publish for someone who no longer writes to the repository is not_allowed, and nothing is made", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.roles.set("maya", "read")
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "agent\n" })
    const writeId = await publishing(maya, branchId, "agent")
    const { services: built } = await services(runtime, github)
    expect(await send(built, machine, writeId)).toEqual({ status: "refused", prNumber: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(github.seen("POST", /\/git\/refs$/)).toEqual([])
    // An agent's write for nobody sign-in knows (no login) is refused the same way.
    const stranger = await admit(runtime, {
      actorId: crypto.randomUUID(),
      sessionId: null,
      via: "agent",
      payload: { op: "branch/publish", branchId, title: "t", body: "" },
    })
    await send(built, machine, stranger)
    expect(await writeRow(runtime, stranger)).toMatchObject({ status: "refused", failure: "not_allowed" })
  })

  test("published without the App's read-back settles done, and its pull request waits for a read", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "x\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    const noApp = { ...built, tokens: { ...built.tokens, forInstallation: () => Effect.fail(new TokenUnavailable({ reason: "app_not_installed" })) } }
    expect(await send(noApp, machine, writeId)).toEqual({ status: "done", prNumber: 1 })
    expect(await sql(runtime, `SELECT number FROM pulls`)).toEqual([])
  })

  test("a working copy with no change is refused empty_change, and nothing reaches GitHub", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    const refs = [...github.refs.keys()]
    expect(await send(built, machines(github), writeId)).toEqual({ status: "refused", prNumber: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "empty_change" })
    expect([...github.refs.keys()]).toEqual(refs)
    expect(github.calls.filter((call) => call.method !== "GET" && !call.path.includes("access_tokens"))).toEqual([])
    expect(await publication(branchId)).toBeUndefined()
  })

  test("more files than one Publish commits is refused too_large", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`f${index}.md`, "x"])))
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    await send(built, machine, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "too_large" })
  })

  test("a base GitHub doesn't have is refused base_missing, before any branch", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github, { baseSha: "f".repeat(40) })
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "x\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    await send(built, machine, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "base_missing" })
    expect(github.seen("POST", /\/git\/refs$/)).toEqual([])
  })

  test.each(["/git/refs", "/graphql", "/pulls"])("a lost answer to %s is found by its key: one branch, one commit, one pull request", async (path) => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "lost\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    github.faults.push({ match: (method, url) => method === "POST" && url.endsWith(path), lost: true })
    expect(await send(built, machine, writeId)).toEqual({ status: "done", prNumber: 1 })
    expect([...github.refs.keys()].filter((name) => name.startsWith("try-1-"))).toEqual([refOf(writeId)])
    expect(github.seen("POST", /\/git\/refs$/)).toHaveLength(1)
    expect(github.seen("POST", /\/graphql$/)).toHaveLength(1)
    expect(github.seen("POST", /\/pulls$/)).toHaveLength(1)
    expect(github.pulls.size).toBe(1)
  })

  test("a run again after it settled, or of a write that isn't one, answers what stands", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, writeId, number } = await published(github)
    expect(await send(built, machine, writeId)).toEqual({ status: "done", prNumber: number })
    expect(await send(built, machine, crypto.randomUUID())).toEqual({ status: "missing", prNumber: null })
    expect(github.seen("POST", /\/pulls$/)).toHaveLength(1)
  })

  test("a run that published but stopped before settling settles from its publication", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, writeId, number } = await published(github)
    await sql(runtime, `UPDATE github_writes SET status = 'pending', item_number = NULL, settled_at = NULL WHERE id = '${writeId}'`)
    expect(await send(built, machine, writeId)).toEqual({ status: "done", prNumber: number })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: number })
  })

  test("publishing again pushes only what changed since the last push, as one more commit on the same pull request", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, maya, branchId, ref, number } = await published(github)
    const before = github.refs.get(ref)!
    await edit(machine, branchId, maya.personId, { "README.md": "# Widgets\n\nA better line\n", "docs/new.md": "new\n" })
    const again = await publishing(maya, branchId)
    expect(await send(built, machine, again)).toEqual({ status: "done", prNumber: number })
    const head = github.refs.get(ref)!
    expect(github.commits.get(head)!.parents).toEqual([before])
    expect(github.commits.get(head)!.message).toBe(`Add a line\n\nSmithers-Write: ${Publish.keyOf(again, "commit")}`)
    expect([github.tree(ref).get("README.md"), github.tree(ref).get("docs/new.md")]).toEqual(["# Widgets\n\nA better line\n", "new\n"])
    expect(github.pulls.size).toBe(1)
    expect(await publication(branchId)).toMatchObject({ headSha: head, prNumber: number })
    expect(await writeRow(runtime, again)).toMatchObject({ status: "done", itemNumber: number })
    // Nothing new since: no commit.
    const nothing = await publishing(maya, branchId)
    await send(built, machine, nothing)
    expect(await writeRow(runtime, nothing)).toMatchObject({ status: "refused", failure: "empty_change" })
    expect(github.refs.get(ref)).toBe(head)
  })

  test("publishing again puts back what the working copy no longer changes: a reverted file and an added one removed", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, maya, branchId, ref } = await published(github)
    await edit(machine, branchId, maya.personId, { "docs/new.md": "new\n" })
    await send(built, machine, await publishing(maya, branchId))
    const copy = machine.copies.get(branchId)!
    copy.files.set("README.md", copy.initial.get("README.md")!)
    copy.files.delete("docs/new.md")
    const back = await publishing(maya, branchId)
    expect((await send(built, machine, back)).status).toBe("done")
    expect([github.tree(ref).get("README.md"), github.tree(ref).has("docs/new.md")]).toEqual([github.tree("main").get("README.md"), false])
    const deleted = await publishing(maya, branchId)
    copy.files.delete("README.md")
    expect((await send(built, machine, deleted)).status).toBe("done")
    expect(github.tree(ref).has("README.md")).toBe(false)
    const again = await publishing(maya, branchId)
    await send(built, machine, again)
    expect(await writeRow(runtime, again)).toMatchObject({ status: "refused", failure: "empty_change" })
  })

  test("a file GitHub changed since the last push that this push also changes is refused conflict; another file lands on top", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, maya, branchId, ref } = await published(github)
    const theirs = github.push(ref, { "README.md": "# Widgets\n\nTheir line\n" }, "ben")
    await edit(machine, branchId, maya.personId, { "README.md": "# Widgets\n\nMy line\n" })
    const conflicted = await publishing(maya, branchId)
    await send(built, machine, conflicted)
    expect(await writeRow(runtime, conflicted)).toMatchObject({ status: "refused", failure: "conflict" })
    expect(github.refs.get(ref)).toBe(theirs)
    const copy = machine.copies.get(branchId)!
    copy.files.set("README.md", "# Widgets\n\nA line\n")
    await edit(machine, branchId, maya.personId, { "OTHER.md": "mine\n" })
    const other = await publishing(maya, branchId)
    expect((await send(built, machine, other)).status).toBe("done")
    expect(github.commits.get(github.refs.get(ref)!)!.parents).toEqual([theirs])
    expect([github.tree(ref).get("README.md"), github.tree(ref).get("OTHER.md")]).toEqual(["# Widgets\n\nTheir line\n", "mine\n"])
  })

  test("publishing again: a lost answer is found by its key, and a step that runs again commits onto the head it recorded", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, maya, branchId, ref } = await published(github)
    await edit(machine, branchId, maya.personId, { "A.md": "a\n" })
    const lost = await publishing(maya, branchId)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/graphql"), lost: true })
    expect((await send(built, machine, lost)).status).toBe("done")
    expect(github.seen("POST", /\/graphql$/)).toHaveLength(2)
    const recorded = github.refs.get(ref)!
    await edit(machine, branchId, maya.personId, { "B.md": "b\n" })
    const retried = await publishing(maya, branchId)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/graphql"), status: 502 })
    const exit = await runtime.runPromise(Effect.exit(Publish.steps(built).publish({ writeId: retried }).pipe(Effect.provide(machine.layer))))
    expect(exit._tag === "Failure" && Cause.squash(exit.cause)).toBeInstanceOf(Publish.PublishUnavailable)
    expect(await publication(branchId)).toMatchObject({ headSha: recorded })
    expect((await send(built, machine, retried)).status).toBe("done")
    expect(github.commits.get(github.refs.get(ref)!)!.parents).toEqual([recorded])
    expect(await sql(runtime, `SELECT pushing_write FROM branch_publications`)).toEqual([{ pushing_write: null }])
  })

  test("publishing again when GitHub's comparison since the last push is too long to check is refused conflict", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, maya, branchId, ref } = await published(github)
    github.push(ref, Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`gen/${index}.md`, "x\n"])), "ben")
    await edit(machine, branchId, maya.personId, { "OTHER.md": "mine\n" })
    const write = await publishing(maya, branchId)
    await send(built, machine, write)
    expect(await writeRow(runtime, write)).toMatchObject({ status: "refused", failure: "conflict" })
  })

  test("a Publish whose write give-up settled while it ran leaves the write as give-up left it, and counts nothing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "x\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    github.faults.push({
      match: (method, path) => method === "POST" && path.endsWith("/pulls"),
      hold: () => sql(runtime, `UPDATE github_writes SET status = 'failed', failure = 'unavailable', settled_at = now() WHERE id = '${writeId}'`).then(() => undefined),
    })
    const registry: Metric.MetricRegistry = new Map()
    await runtime.runPromise(Publish.steps(built).publish({ writeId }).pipe(Effect.provide(machine.layer), Effect.provideService(Metric.MetricRegistry, registry)))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "failed", failure: "unavailable" })
    expect(await publication(branchId)).toBeUndefined()
    const counted = await runtime.runPromise(Metric.value(Metric.withAttributes(Publish.publishes, { outcome: "done" })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    ))
    expect(counted.count).toBe(0)
  })

  test("publishing again to a merged or closed pull request, or a GitHub branch someone deleted, is refused", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, maya, branchId, ref, number } = await published(github)
    await edit(machine, branchId, maya.personId, { "A.md": "a\n" })
    github.refs.delete(ref)
    const gone = await publishing(maya, branchId)
    await send(built, machine, gone)
    expect(await writeRow(runtime, gone)).toMatchObject({ status: "refused", failure: "not_found" })
    github.close(number)
    const closed = await publishing(maya, branchId)
    await send(built, machine, closed)
    expect(await writeRow(runtime, closed)).toMatchObject({ status: "refused", failure: "closed" })
    github.issues.get(number)!.state = "open"
    github.pulls.get(number)!.merged = true
    const merged = await publishing(maya, branchId)
    await send(built, machine, merged)
    expect(await writeRow(runtime, merged)).toMatchObject({ status: "refused", failure: "merged" })
  })

  test("publishing again: a reverted file the tools read only in part is too_large; a refused read invalid; a machine down tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { built, machine, maya, branchId } = await published(github)
    const copy = machine.copies.get(branchId)!
    copy.files.set("README.md", copy.initial.get("README.md")!)
    const real = Context.get(await Effect.runPromise(Layer.build(machine.layer).pipe(Effect.scoped)), Machines)
    const reading = (answer: (call: Parameters<Machines["Service"]["tool"]>[3]) => ReturnType<Machines["Service"]["tool"]> | undefined) =>
      Layer.succeed(Machines, Machines.of({ ...real, tool: (branch, owner, callId, call) => answer(call) ?? real.tool(branch, owner, callId, call) }))
    const restoreRead = (outcome: ReturnType<Machines["Service"]["tool"]>) =>
      reading((call) => (call.tool === "read" && call.path === "README.md" ? outcome : undefined))
    const run_ = (layer: Layer.Layer<Machines>, writeId: string) =>
      runtime.runPromise(Effect.exit(Publish.steps(built).publish({ writeId }).pipe(Effect.provide(layer))))
    const cut = await publishing(maya, branchId)
    await run_(restoreRead(Effect.succeed({ result: { tool: "read", path: "README.md", content: "x", bytes: 1, truncated: true }, generation: 1 }) as never), cut)
    expect(await writeRow(runtime, cut)).toMatchObject({ status: "refused", failure: "too_large" })
    const refused = await publishing(maya, branchId)
    await run_(restoreRead(Effect.fail({ _tag: "@smthrs/sandbox/SandboxTools/ToolRefused", reason: "path" }) as never), refused)
    expect(await writeRow(runtime, refused)).toMatchObject({ status: "refused", failure: "invalid" })
    const down = await publishing(maya, branchId)
    const exit = await run_(restoreRead(Effect.fail({ _tag: "@smthrs/mvp/branch/SandboxUnavailable", reason: "exec" }) as never), down)
    expect(exit._tag === "Failure" && Cause.squash(exit.cause)).toBeInstanceOf(Publish.PublishUnavailable)
  })

  test("the paths GitHub changed: each file's, and a renamed file's old one", () => {
    expect([...Publish.changedPaths([{ filename: "a.md" }, { filename: "new.md", previous_filename: "old.md" }])]).toEqual(["a.md", "new.md", "old.md"])
  })

  test("what a push leaves GitHub holding, by path", () => {
    const pushed = Publish.pushedOf({ "a.md": "1", "b.md": null }, { additions: [{ path: "c.md", contents: "Yw==" }], deletions: ["d.md"] }, ["a.md"])
    expect(Object.keys(pushed).sort()).toEqual(["b.md", "c.md", "d.md"])
    expect([pushed["b.md"], pushed["d.md"], pushed["c.md"]!.length]).toEqual([null, null, 64])
  })

  test.each([
    ["a branch GitHub already has (default namespace)", { namespace: "default" as const }],
    ["a branch made on GitHub", { forge: "github" as const }],
  ])("%s is refused invalid", async (_, options) => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github, options)
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    await send(built, machines(github), writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "invalid" })
  })

  test("a branch that's gone is refused not_found", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const writeId = await publishing(maya, branchId)
    await sql(runtime, `UPDATE branches SET deleted_at = now() WHERE id = '${branchId}'`)
    const { services: built } = await services(runtime, github)
    await send(built, machines(github), writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_found" })
  })

  test("an ended session is sign_in_required; one being refreshed, or GitHub down, is tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "x\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    const failing = (failure: TokenUnavailable) => ({ ...built, tokens: { ...built.tokens, forSession: () => Effect.fail(failure) } })
    const retried = async (with_: Built) => {
      const exit = await runtime.runPromise(Effect.exit(Publish.steps(with_).publish({ writeId }).pipe(Effect.provide(machine.layer))))
      const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(Publish.PublishUnavailable)
      return (error as Publish.PublishUnavailable).retryAfterMillis
    }
    expect(await retried(failing(new TokenUnavailable({ reason: "refreshing", retryAfterMillis: 5_000 })))).toBe(5_000)
    expect(await retried(failing(new TokenUnavailable({ reason: "unavailable" })))).toBeUndefined()
    expect(await retried(failing(new TokenUnavailable({ reason: "refreshing" })))).toBeUndefined()
    github.faults.push({ match: (method, path) => method === "GET" && path.includes("/compare/"), status: 502 })
    expect(await retried(built)).toBeUndefined()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/git/refs"), status: 502 })
    expect(await retried(built)).toBeUndefined()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/pulls"), status: 429, headers: { "retry-after": "3" } })
    expect(await retried(built)).toBe(3_000)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "pending" })
    await send(failing(new TokenUnavailable({ reason: "sign_in_required" })), machine, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "sign_in_required" })
  })

  test("the agent's Publish where the App isn't installed is app_not_installed", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "x\n" })
    const writeId = await publishing(maya, branchId, "agent")
    const { services: built } = await services(runtime, github)
    const noApp = { ...built, tokens: { ...built.tokens, forInstallation: () => Effect.fail(new TokenUnavailable({ reason: "app_not_installed" })) } }
    await send(noApp, machine, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "app_not_installed" })
    const failing = (failure: TokenUnavailable) => ({ ...built, tokens: { ...built.tokens, forInstallation: () => Effect.fail(failure) } })
    for (const reason of ["not_allowed", "sign_in_required"] as const) {
      const write = await publishing(maya, branchId, "agent")
      await send(failing(new TokenUnavailable({ reason })), machine, write)
      expect(await writeRow(runtime, write)).toMatchObject({ status: "refused", failure: reason })
    }
    const again = await publishing(maya, branchId, "agent")
    const waits = async (failure: TokenUnavailable) => {
      const exit = await runtime.runPromise(Effect.exit(Publish.steps(failing(failure)).publish({ writeId: again }).pipe(Effect.provide(machine.layer))))
      return exit._tag === "Failure" ? (Cause.squash(exit.cause) as Publish.PublishUnavailable).retryAfterMillis : "settled"
    }
    expect(await waits(new TokenUnavailable({ reason: "unavailable", retryAfterMillis: 2_000 }))).toBe(2_000)
    expect(await waits(new TokenUnavailable({ reason: "unavailable" }))).toBeUndefined()
  })

  test("GitHub refusing the pull request settles its refusal; the projection failing never undoes a Publish", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "x\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/pulls"), status: 403 })
    await send(built, machine, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(await publication(branchId)).toBeUndefined()

    const again = await publishing(maya, branchId)
    const registry: Metric.MetricRegistry = new Map()
    await sql(runtime, "ALTER TABLE pulls ADD CONSTRAINT reject_projection CHECK (number < 0)")
    try {
      const settled = await runtime.runPromise(
        Publish.steps(built).publish({ writeId: again }).pipe(Effect.provide(machine.layer), Effect.provideService(Metric.MetricRegistry, registry)),
      )
      expect(settled.status).toBe("done")
      expect(await publication(branchId)).toMatchObject({ writeId: again })
      const failures = await runtime.runPromise(Metric.value(Metric.withAttributes(Metrics.projectionFailures, { op: "branch/publish" })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ))
      expect(failures.count).toBe(1)
    } finally {
      await sql(runtime, "ALTER TABLE pulls DROP CONSTRAINT reject_projection")
    }
  })

  test("a machine that refuses is invalid; one that can't answer is tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    const failing = (tag: string) =>
      Layer.succeed(Machines, Machines.of({
        tool: () => Effect.fail({ _tag: tag } as never),
        commands: () => Effect.die("unused") as never,
        sleepIfIdle: () => Effect.die("unused"),
      }))
    const down = await runtime.runPromise(Effect.exit(Publish.steps(built).publish({ writeId }).pipe(Effect.provide(failing("@smthrs/mvp/branch/SandboxUnavailable")))))
    expect(down._tag === "Failure" && Cause.squash(down.cause)).toBeInstanceOf(Publish.PublishUnavailable)
    await runtime.runPromise(Publish.steps(built).publish({ writeId }).pipe(Effect.provide(failing("@smthrs/mvp/branch/CheckoutFailed"))))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "invalid" })
  })

  test("Postgres down fails send and give-up alike, as unavailable; give-up settles a pending write failed", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    const down = { ...built, database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))) }
    const failedSend = await runtime.runPromise(Effect.exit(Publish.steps(down).publish({ writeId }).pipe(Effect.provide(machines(github).layer))))
    expect(failedSend._tag === "Failure" && Cause.squash(failedSend.cause)).toBeInstanceOf(Publish.PublishUnavailable)
    const failedGiveUp = await runtime.runPromise(Effect.exit(Publish.steps(down).giveUp({ writeId })))
    expect(failedGiveUp._tag === "Failure" && Cause.squash(failedGiveUp.cause)).toBeInstanceOf(Publish.PublishUnavailable)
    expect(await runtime.runPromise(Publish.steps(built).giveUp({ writeId }))).toEqual({ status: "failed", prNumber: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "failed", failure: "unavailable" })
    expect(await runtime.runPromise(Publish.steps(built).giveUp({ writeId }))).toEqual({ status: "failed", prNumber: null })
    expect(await runtime.runPromise(Publish.steps(built).giveUp({ writeId: crypto.randomUUID() }))).toEqual({ status: "missing", prNumber: null })
  })

  test("github/Write never runs a Publish, an Update or a Resync: each settles refused there", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const { services: built } = await services(runtime, github)
    const resyncing = admit(runtime, { actorId: maya.personId, sessionId: maya.sessionId, via: "person", payload: { op: "branch/resync", branchId } })
    for (const writeId of [await publishing(maya, branchId), await updating(maya, branchId), await resyncing]) {
      const ran = await runFlow(Write.Write, { writeId }, Write.registration(built), { maxConnections: 2 })
      expect(ran.exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
      expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "invalid" })
    }
  })

  test("GitHub's statuses as a Publish's or an Update's refusal", () => {
    expect([401, 404, 409, 422, 403].map(Publish.refusalOf)).toEqual(["sign_in_required", "not_found", "head_moved", "invalid", "not_allowed"])
    expect(Publish.prefixOf("x".repeat(300))).toHaveLength(Publish.PREFIX_LENGTH + 1)
  })
})

describe("branch/Update", { timeout: 60_000 }, () => {
  test("merge: main moved, so its head merges into the published branch as the person, carrying the write's key", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, ref, number, built } = await published(github)
    github.push("main", { "CHANGELOG.md": "1.1\n" })
    const writeId = await updating(maya, branchId)
    const ran = await runFlow(Publish.Update, { writeId }, Publish.registration(built, machines(github).layer, Forge.gitHub), {
      executionId: updateExecutionId(writeId),
      maxConnections: 2,
    })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", prNumber: number }))
    const head = github.refs.get(ref)!
    const merge = github.commits.get(head)!
    expect(merge.parents).toHaveLength(2)
    expect(merge.login).toBe("maya")
    expect(merge.message).toBe(`Merge main into ${ref}\n\nSmithers-Write: ${Publish.keyOf(writeId, "update")}`)
    expect(github.tree(ref).get("CHANGELOG.md")).toBe("1.1\n")
    expect(await publication(branchId)).toMatchObject({ headSha: head, state: "updated" })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: number })
  })

  test("a branch already holding its base is up to date: nothing merges", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, ref, built } = await published(github)
    const before = github.refs.get(ref)
    const writeId = await updating(maya, branchId)
    expect((await update(built, writeId)).status).toBe("done")
    expect(github.refs.get(ref)).toBe(before)
    expect(await publication(branchId)).toMatchObject({ headSha: before, state: "up_to_date" })
  })

  test("a conflict is refused conflict for everyone on the branch, and nothing merges", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, ref, built } = await published(github)
    github.push("main", { "README.md": "# Widgets\n\nAnother line\n" })
    const before = github.refs.get(ref)
    const writeId = await updating(maya, branchId)
    expect(await update(built, writeId)).toEqual({ status: "refused", prNumber: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "conflict" })
    expect(await publication(branchId)).toMatchObject({ state: "conflict", headSha: before })
    expect(github.refs.get(ref)).toBe(before)
  })

  test("a lost merge answer is found by its key: one merge", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, built } = await published(github)
    github.push("main", { "CHANGELOG.md": "1.1\n" })
    const writeId = await updating(maya, branchId)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/merges"), lost: true })
    expect((await update(built, writeId)).status).toBe("done")
    expect(github.seen("POST", /\/merges$/)).toHaveLength(1)
    expect(await publication(branchId)).toMatchObject({ state: "updated" })
  })

  test("rebase: the branch is rewritten onto main's head, fenced by the head it read", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, ref, built } = await published(github)
    const main = github.push("main", { "CHANGELOG.md": "1.1\n" })
    const writeId = await updating(maya, branchId, "rebase")
    expect((await update(built, writeId)).status).toBe("done")
    const head = github.refs.get(ref)!
    expect(github.commits.get(head)!.parents).toEqual([main])
    expect([github.tree(ref).get("CHANGELOG.md"), github.tree(ref).get("README.md")]).toEqual(["1.1\n", "# Widgets\n\nA line\n"])
    expect(await publication(branchId)).toMatchObject({ headSha: head, state: "updated" })
    const upToDate = await updating(maya, branchId, "rebase")
    expect((await update(built, upToDate)).status).toBe("done")
    expect(await publication(branchId)).toMatchObject({ headSha: head, state: "up_to_date" })
    expect(github.seen("POST", /\/graphql$/).length).toBe(2)
  })

  test("rebase: a lost answer finds the rewritten head; a conflict, a moved head and a refusal settle why", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, ref, built } = await published(github)
    github.push("main", { "CHANGELOG.md": "1.1\n" })
    const lost = await updating(maya, branchId, "rebase")
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/graphql"), lost: true })
    expect((await update(built, lost)).status).toBe("done")

    github.push("main", { "README.md": "# Widgets\n\nTheirs\n" })
    const conflicted = await updating(maya, branchId, "rebase")
    await update(built, conflicted)
    expect(await writeRow(runtime, conflicted)).toMatchObject({ status: "refused", failure: "conflict" })

    github.push("main", { "README.md": "# Widgets\n\nA line\n" })
    const moved = await updating(maya, branchId, "rebase")
    github.faults.push({
      match: (method, path) => method === "POST" && path.endsWith("/graphql"),
      hold: async () => void github.push(ref, { "late.md": "late\n" }),
    })
    await update(built, moved)
    expect(await writeRow(runtime, moved)).toMatchObject({ status: "refused", failure: "head_moved" })

    github.push("main", { "OTHER.md": "o\n" })
    const refused = await updating(maya, branchId, "rebase")
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/graphql"), status: 422 })
    await update(built, refused)
    expect(await writeRow(runtime, refused)).toMatchObject({ status: "refused", failure: "not_mergeable" })
  })

  test("a branch not yet published is refused not_published; a merged or closed pull request, merged or closed", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const fresh = await tracked(github)
    const { services: built } = await services(runtime, github)
    const early = await updating(fresh.maya, fresh.branchId)
    await update(built, early)
    expect(await writeRow(runtime, early)).toMatchObject({ status: "refused", failure: "not_published" })
    await sql(runtime, "TRUNCATE branch_publications, branches CASCADE")

    const { maya, branchId, number } = await published(github)
    github.close(number)
    const closed = await updating(maya, branchId)
    await update(built, closed)
    expect(await writeRow(runtime, closed)).toMatchObject({ status: "refused", failure: "closed" })
    github.issues.get(number)!.state = "open"
    github.merge(number)
    const merged = await updating(maya, branchId)
    await update(built, merged)
    expect(await writeRow(runtime, merged)).toMatchObject({ status: "refused", failure: "merged" })
    expect(await update(built, merged)).toEqual({ status: "refused", prNumber: null })
    expect(await update(built, crypto.randomUUID())).toEqual({ status: "missing", prNumber: null })
  })

  test("an agent's Update for someone who no longer writes is not_allowed; Postgres down is tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, built } = await published(github)
    github.push("main", { "CHANGELOG.md": "1.1\n" })
    const writeId = await admit(runtime, { actorId: maya.personId, sessionId: null, via: "agent", payload: { op: "branch/update", branchId, method: "merge" } })
    await update(built, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(github.seen("POST", /\/merges$/)).toEqual([])
    const down = { ...built, database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))) }
    const exit = await runtime.runPromise(Effect.exit(Publish.steps(down).update({ writeId: crypto.randomUUID() })))
    expect(exit._tag === "Failure" && Cause.squash(exit.cause)).toBeInstanceOf(Publish.PublishUnavailable)
  })

  test("GitHub down is tried again; the base branch gone is not_found; give-up settles failed", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId, number, built } = await published(github)
    const writeId = await updating(maya, branchId)
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith(`/pulls/${number}`), status: 502 })
    const exit = await runtime.runPromise(Effect.exit(Publish.steps(built).update({ writeId })))
    expect(exit._tag === "Failure" && Cause.squash(exit.cause)).toBeInstanceOf(Publish.PublishUnavailable)
    expect(await runtime.runPromise(Publish.steps(built).giveUp({ writeId }))).toEqual({ status: "failed", prNumber: null })

    github.push("main", { "N.md": "n\n" })
    github.pulls.get(number)!.base = "gone"
    const rebase = await updating(maya, branchId, "rebase")
    await update(built, rebase)
    expect(await writeRow(runtime, rebase)).toMatchObject({ status: "refused", failure: "not_found" })
  })
})

describe("the remote host", { timeout: 60_000 }, () => {
  test("the Durable Object's handlers run branch/Publish to the end through withBranchPublish", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { maya, branchId } = await tracked(github)
    const machine = machines(github)
    await edit(machine, branchId, maya.personId, { "README.md": "remote\n" })
    const writeId = await publishing(maya, branchId)
    const { services: built } = await services(runtime, github)
    const flows = ExecutionHost.withBranchPublish(
      ExecutionHost.remote({ database: await database(runtime), expiry: Expire.DEFAULT_EXPIRY }),
      Effect.succeed(built),
      machine.layer,
      Forge.gitHub,
    )
    expect(flows.flows.slice(-3)).toEqual([Publish.Publish, Publish.Update, Publish.Resync])
    const values = new Map<string, unknown>()
    const storage: ExecutionHost.Storage = {
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => values.delete(key)),
      setAlarm: () => Effect.void,
      deleteAlarm: () => Effect.void,
    }
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const url = (yield* TestDatabase.serverUrl).toString()
        const admin = yield* Layer.build(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
        const client = Context.get(admin, SqlClient.SqlClient)
        const name = `flows_${crypto.randomUUID().replaceAll("-", "")}`
        yield* Effect.addFinalizer(() => Effect.orDie(client`DROP SCHEMA IF EXISTS ${client(name)} CASCADE`))
        const executionId = publishExecutionId(writeId)
        const host = ExecutionHost.make(storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows,
          router: { start: () => Effect.void, wake: () => Effect.void },
        })
        yield* host.start(yield* ExecutionHost.intent(Publish.Publish, { executionId, payload: { writeId } }))
        let driven = yield* host.alarm()
        for (let drives = 1; driven._tag !== "Settled" && drives < 20; drives++) driven = yield* host.alarm()
        expect(driven).toMatchObject({ _tag: "Settled" })
      })),
    )
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: 1 })
    expect(github.issues.get(1)!.login).toBe("maya")
  })
})
