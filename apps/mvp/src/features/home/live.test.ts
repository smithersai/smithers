import { Effect, type ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import type { CuratedFile } from "../../../worker/home/Curated.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { openTestApp, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { repoId } from "../repo/contract"
import { Repo } from "../repo/repo"
import type { Todo } from "../todos/schema"
import { Todos } from "../todos/todos"
import { Home } from "./home"
import { homePageOf, issuesOf, stackOf } from "./view"

// A repository's curated home in the whole browser app (`appLayer`), against ChatApi's real routes, the compose
// Postgres and Electric: who sees which section, and the live blocks' rows from the stores that sync them. The curated
// home is the test's own (`homes`), for the repository the test ChatApi syncs, so its issues and stack are real.

const [OWNER, NAME] = TEST_REPOSITORY.split("/") as [string, string]
const REPO_ID = repoId(OWNER, NAME)

const homes: ReadonlyArray<CuratedFile> = [{
  repository: TEST_REPOSITORY,
  defaultBranch: "main",
  home: {
    sections: [
      {
        title: "Today",
        audience: "maintainer",
        blocks: [{ type: "action", flow: "branch.new", title: "New branch", key: "b" }, { type: "issues" }, { type: "runs" }],
      },
      { title: "Your work", audience: "contributor", blocks: [{ type: "stack" }] },
      { blocks: [{ type: "hero", title: "A repository" }] },
    ],
  },
}]

const person = (role: Actor["role"]): Actor => ({ subject: { kind: "person", id: `person-${role}` }, role, login: `${role}` })

const until = (assertion: () => void | Promise<void>, timeout = 90_000) => vi.waitFor(assertion, { timeout, interval: 20 })

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
}, 120_000)

/**
 * The app on a fresh ChatApi with the test's curated home, as `actor`, its home's queries started as React starts
 * them; `forge` the branches' forge (GitHub unless set).
 */
const open = async (actor: Actor | null, forge: "github" | "code-storage" = "github") => {
  const runtime: ManagedRuntime.ManagedRuntime<Home | Repo | Todos | TestChatApi, unknown> = openTestApp({}, { actor, homes, forge })
  runtimes.push(runtime)
  const home = await runtime.runPromise(Effect.service(Home))
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  // A repository route's loader asks the person's role there before opening the page (router.tsx `enterRepo`); the
  // stack's shapes wait for that answer (decision 0110).
  const repo = await runtime.runPromise(Effect.service(Repo))
  repo.actions.role(OWNER, NAME)
  const { queries } = home
  for (const query of [queries.home, queries.files, queries.runs, queries.stackAccess]) {
    query.startSyncImmediate()
  }
  const state = () => queries.home.toArray[0]!
  const page = () => homePageOf(state().current, state().home, state().curated)
  const shown = () => {
    const shownPage = page()
    return shownPage.kind === "home" ? shownPage.sections.map((section) => section.title ?? section.audience) : shownPage.kind
  }
  const todos = () => {
    const stack = queries.stack(REPO_ID)
    stack.startSyncImmediate()
    return stack.toArray as ReadonlyArray<Todo>
  }
  return { runtime, home, api, state, page, shown, todos }
}

describe("a curated home in the app", () => {
  test("a visitor sees everyone's section, and the stack's shape is never asked", { timeout: 240_000 }, async () => {
    const tab = await open(null)
    expect(tab.home.queries.stack("unopened").toArray).toEqual([])
    tab.home.actions.open(OWNER, NAME)
    await until(() => expect(tab.shown()).toEqual(["everyone"]))
    expect(tab.state().current).toMatchObject({ audience: "everyone", answering: false, stack: null })
  })

  test("a Member's stack block opens the repository's stack: a TODO committed shows in it", { timeout: 240_000 }, async () => {
    const tab = await open(person("member"))
    tab.home.actions.open(OWNER, NAME)
    await until(() => expect(tab.shown()).toEqual(["Your work", "everyone"]))
    await until(() => expect(tab.state().current.stack).toBe(REPO_ID))
    const todos = await tab.runtime.runPromise(Effect.service(Todos))
    const draft = todos.actions.newDraft(OWNER, NAME)
    todos.actions.setTitle(draft, "A TODO from home")
    todos.actions.setPrompt(draft, "Add a line, please.")
    ;(await todos.actions.commit(draft))
    await until(() => expect(tab.todos().map((todo) => todo.title)).toContain("A TODO from home"))
    const stack = stackOf(tab.todos(), OWNER, NAME, "allowed")
    expect("entries" in stack && stack.entries.map((entry) => [entry.label, entry.title, entry.status?.label])).toEqual([
      ["T1", "A TODO from home", "Queued"],
    ])
  })

  test("a Maintainer sees the day first; its issues block reads the synced issues", { timeout: 240_000 }, async () => {
    const tab = await open(person("maintainer"))
    tab.home.actions.open(OWNER, NAME)
    await until(() => expect(tab.shown()).toEqual(["Today", "Your work", "everyone"]))
    // An issue and a finished walk, as `github/Reconcile` writes them.
    await Effect.runPromise(tab.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.andThen(
        sql`INSERT INTO items (id, repo_id, number, kind, github_id, title, state, created_at, updated_at,
              source_updated_at, fetched_at)
            VALUES (${`${REPO_ID}#7`}, ${REPO_ID}, 7, 'issue', 7, 'Proposed from the home test', 'open', now(), now(),
              now(), now())`,
        sql`INSERT INTO github_sync (repo_id, stream, synced_at, complete) VALUES (${REPO_ID}, 'issues', now(), true)
            ON CONFLICT (repo_id, stream) DO UPDATE SET complete = true, synced_at = now()`,
      ))))
    // The home opens the repository's issues for its `issues` block, as the page reads them.
    await until(() => expect(tab.state().current.issues).toBe(REPO_ID))
    const itemsQuery = tab.home.queries.items(REPO_ID)
    const syncsQuery = tab.home.queries.syncs(REPO_ID)
    itemsQuery.startSyncImmediate()
    syncsQuery.startSyncImmediate()
    await until(() => {
      const items = itemsQuery.toArray
      const synced = syncsQuery.toArray.some((row) => row.repoId === REPO_ID && row.complete)
      expect(issuesOf(items, OWNER, NAME, REPO_ID, synced)).toMatchObject({
        proposed: 1,
        triage: { total: 1, entries: [{ label: "#7", title: "Proposed from the home test" }] },
      })
    })
  })

  test("a Maintainer's New branch makes a branch at the default branch's head and answers its workspace", { timeout: 240_000 }, async () => {
    const tab = await open(person("maintainer"), "code-storage")
    tab.api.branches.github.publish(OWNER, NAME, { defaultBranch: "main", branches: { main: shaOf("main") } })
    tab.home.actions.open(OWNER, NAME)
    await until(() => expect(tab.shown()).toEqual(["Today", "Your work", "everyone"]))
    const pending = tab.home.actions.run("branch.new", "maya")
    // Pressed again while it runs: nothing more.
    await until(() => expect(tab.state().current.running).toEqual(["branch.new"]))
    expect(await tab.home.actions.run("branch.new", "maya")).toBeUndefined()
    const href = await pending
    expect(href).toMatch(new RegExp(`^/${OWNER}/${NAME}/tree/maya/[0-9a-z]{6}$`))
    expect(tab.state().current).toMatchObject({ running: [], failure: null })
    const branch = href!.slice(`/${OWNER}/${NAME}/tree/`.length)
    expect(tab.api.branches.forge.ephemeral.repository(OWNER, NAME)!.branches[branch]).toBe(shaOf("main"))
    expect(tab.api.branches.github.repository(OWNER, NAME)!.branches).toEqual({ main: shaOf("main") })
  })

  test("a completed branch action keeps the repository opened while it ran", { timeout: 240_000 }, async () => {
    const tab = await open(person("maintainer"), "code-storage")
    tab.api.branches.github.publish(OWNER, NAME, { defaultBranch: "main", branches: { main: shaOf("main") } })
    tab.home.actions.open(OWNER, NAME)
    await until(() => expect(tab.shown()).toEqual(["Today", "Your work", "everyone"]))
    const pending = tab.home.actions.run("branch.new", "maya")
    await until(() => expect(tab.state().current.running).toEqual(["branch.new"]))
    tab.home.actions.open("octocat", "Spoon-Knife")
    expect(await pending).toBeUndefined()
    expect(tab.state().current).toMatchObject({
      owner: "octocat", name: "Spoon-Knife", running: [], failure: null,
    })
    expect(Object.keys(tab.api.branches.forge.ephemeral.repository(OWNER, NAME)!.branches))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^maya\/[0-9a-z]{6}$/)]))
    expect(tab.api.branches.github.repository(OWNER, NAME)!.branches).toEqual({ main: shaOf("main") })
  })

  test("New branch where the forge can't make one says why, and a flow the home doesn't run does nothing", { timeout: 240_000 }, async () => {
    const tab = await open(person("maintainer"))
    tab.api.branches.github.publish(OWNER, NAME, { defaultBranch: "main", branches: { main: shaOf("main") } })
    tab.home.actions.open(OWNER, NAME)
    await until(() => expect(tab.shown()).toEqual(["Today", "Your work", "everyone"]))
    expect(await tab.home.actions.run("branch.new", null)).toBeUndefined()
    expect(tab.state().current).toMatchObject({ running: [], failure: "not_configured" })
    expect(await tab.home.actions.run("issue", null)).toBeUndefined()
    // A name that can't be a repository has no actions.
    tab.home.actions.open("app", "x y")
    expect(await tab.home.actions.run("branch.new", null)).toBeUndefined()
  })
})
