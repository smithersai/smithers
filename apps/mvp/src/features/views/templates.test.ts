// A repository's view and its issues view in the conversation (docs/features/views.md#a-repository-and-its-issues,
// decision 0004 §3, ruling FE-9): the browser's own layer (`appLayer`) over a Node device against ChatApi's real handler
// and the compose Postgres and Electric (src/test/chatApi.ts). A person's `/repo` and `/issues` add them as the agent's
// `ui/repo` and `ui/issues` do; the tab loads what a repository's view shows as it arrives (src/features/views/embeds.ts);
// and Back to chat on a repository's page returns to the page its view was opened from, or leaves the repository in the
// home conversation (src/features/views/minimize.ts).
import { Effect, type ManagedRuntime, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { failingWorker, member, nodeDevice, openTestApp, type TabOptions } from "../../test/chatApi"
import { AuthStore, SESSION } from "../auth/store"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { Commands } from "../commands/commands"
import { Repo } from "../repo/repo"
import { CHAT_PATH, minimized, sameTarget } from "./minimize"
import { issuesOf, repoOf } from "./rows"
import { Views } from "./views"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

const WITHIN = 90_000

type App = ManagedRuntime.ManagedRuntime<Commands | Chat | ChatStore | Views | Repo | AuthStore, unknown>

/** The app as `actor` (a Member unless `null`), signed in as sign-in's `load` sets it, its queries started as React does. */
const open = async (actor: Actor | null = member, options: TabOptions = {}) => {
  const runtime: App = openTestApp(options, { actor })
  runtimes.push(runtime)
  const chat = await runtime.runPromise(Effect.service(Chat))
  const views = await runtime.runPromise(Effect.service(Views))
  const commands = await runtime.runPromise(Effect.service(Commands))
  const repo = await runtime.runPromise(Effect.service(Repo))
  for (const query of [chat.queries.conversation, views.queries.rowsIn(undefined), commands.queries.menu, repo.queries.embeds]) {
    query.startSyncImmediate()
  }
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(session.update(SESSION, (row) =>
    void Object.assign(
      row,
      actor === null
        ? { status: "signed_out", login: null, role: null }
        : { status: "signed_in", login: actor.subject.id, role: actor.role },
    )))
  const rows = () => views.queries.rowsIn(undefined).toArray
  return {
    runtime,
    views,
    repo,
    /** Types `text` in the composer and sends it, as Enter does: a slash command runs. */
    send: (text: string) => {
      commands.actions.type(text)
      commands.actions.submit(text)
    },
    /** The home conversation's app views in the conversation's order: each one's template and its props. */
    shown: () =>
      [...rows()].sort((a, b) => a.position - b.position).flatMap((row) => {
        const props = repoOf(row) ?? issuesOf(row)
        return props === undefined ? [] : [{ template: row.template, props }]
      }),
    rows,
    count: (attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(minimized, attributes))).count,
  }
}

describe("/repo and /issues", () => {
  test("add a repository's view and its issues view to the conversation, and the tab loads what the view shows", async () => {
    const tab = await open()
    tab.send("/repo octocat/Spoon-Knife")
    await until(() => expect(tab.shown()).toEqual([{ template: "repo", props: { repo: "octocat/Spoon-Knife" } }]))
    // The follower loads it as it arrives: its row is on the tab (what it settles to is embed.test.ts's).
    const viewId = tab.rows()[0]!.id
    await until(() => expect(tab.repo.queries.embeds.toArray.map((row) => row.embed.key)).toEqual([viewId]))
    tab.send("/issues octocat/Spoon-Knife")
    await until(() =>
      expect(tab.shown()).toEqual([
        { template: "repo", props: { repo: "octocat/Spoon-Knife" } },
        { template: "issues", props: { repo: "octocat/Spoon-Knife" } },
      ])
    )
    // An issues view needs no load of its own: the embeds hold only the repository's view.
    expect(tab.repo.queries.embeds.toArray.map((row) => row.embed.key)).toEqual([viewId])
  }, WITHIN)
})

describe("Back to chat", () => {
  test("returns to the page a view was opened from; else leaves the repository in the chat once", async () => {
    const tab = await open()
    tab.send("/repo octocat/Spoon-Knife")
    await until(() => expect(tab.shown()).toHaveLength(1))

    // The home conversation shows it already: back to the chat, adding nothing.
    expect(tab.views.actions.minimize({ template: "repo", props: { repo: "OCTOCAT/spoon-knife" } })).toBe(CHAT_PATH)
    await until(() => expect(tab.count({ returned: "chat", outcome: "kept" })).toBe(1))
    // A location it doesn't show yet is added, by the same flow `/repo` runs.
    const deeper = { repo: "octocat/Spoon-Knife", ref: "dev", kind: "blob", path: "README.md" } as const
    expect(tab.views.actions.minimize({ template: "repo", props: deeper })).toBe(CHAT_PATH)
    await until(() =>
      expect(tab.count({ returned: "chat", outcome: "added" }) + tab.count({ returned: "chat", outcome: "failed" })).toBe(1)
    )
    expect(tab.count({ returned: "chat", outcome: "added" })).toBe(1)
    await until(() => expect(tab.shown()).toContainEqual({ template: "repo", props: deeper }))
    expect(tab.views.actions.minimize({ template: "issues", props: { repo: "octocat/Spoon-Knife" } })).toBe(CHAT_PATH)
    await until(() => expect(tab.shown()).toContainEqual({ template: "issues", props: { repo: "octocat/Spoon-Knife" } }))

    // Opened from a view on a branch's page: back there, for any page of that repository, and nothing is added.
    const viewId = tab.rows()[0]!.id
    tab.views.actions.opened(viewId, "repo", "Octocat/Spoon-Knife", "/acme/widgets/tree/feature")
    expect(tab.views.actions.minimize({ template: "repo", props: { repo: "octocat/spoon-knife", path: "docs" } }))
      .toBe("/acme/widgets/tree/feature")
    expect(tab.count({ returned: "origin", outcome: "returned" })).toBe(1)
    // Another repository, or its issues page, isn't the view that was opened.
    expect(tab.views.actions.minimize({ template: "issues", props: { repo: "octocat/Spoon-Knife" } })).toBe(CHAT_PATH)
    expect(tab.views.actions.minimize({ template: "repo", props: { repo: "octocat/Hello-World" } })).toBe(CHAT_PATH)
    await until(() => expect(tab.shown()).toContainEqual({ template: "repo", props: { repo: "octocat/Hello-World" } }))
    expect(tab.shown().filter((shown) => shown.template === "issues")).toHaveLength(1)
  }, WITHIN)

  test("signed out, the chat still opens; the view isn't added, and that is counted", async () => {
    const tab = await open(null)
    expect(tab.views.actions.minimize({ template: "repo", props: { repo: "octocat/Spoon-Knife" } })).toBe(CHAT_PATH)
    await until(() => expect(tab.count({ returned: "chat", outcome: "failed" })).toBe(1))
    expect(tab.shown()).toEqual([])
  }, WITHIN)

  test("a tab with no engine still opens the chat; the view isn't added, and that is counted", async () => {
    const tab = await open(member, { host: nodeDevice({ engineWorker: failingWorker }) })
    expect(tab.views.actions.minimize({ template: "issues", props: { repo: "octocat/Spoon-Knife" } })).toBe(CHAT_PATH)
    await until(() => expect(tab.count({ returned: "chat", outcome: "failed" })).toBe(1))
    expect(tab.shown()).toEqual([])
  }, WITHIN)
})

describe("sameTarget", () => {
  test("the same repository whatever its case; a repository's view the same ref and path, a kind only when both name one", () => {
    expect(sameTarget("issues", { repo: "A/B" }, { repo: "a/b" })).toBe(true)
    expect(sameTarget("issues", { repo: "a/b" }, { repo: "a/c" })).toBe(false)
    expect(sameTarget("repo", { repo: "a/b" }, { repo: "a/b", path: "" })).toBe(true)
    expect(sameTarget("repo", { repo: "a/b", path: "x.md" }, { repo: "a/b", path: "x.md", kind: "blob" })).toBe(true)
    expect(sameTarget("repo", { repo: "a/b", path: "x", kind: "tree" }, { repo: "a/b", path: "x", kind: "blob" })).toBe(false)
    expect(sameTarget("repo", { repo: "a/b", path: "x", kind: "tree" }, { repo: "a/b", path: "x", kind: "tree" })).toBe(true)
    expect(sameTarget("repo", { repo: "a/b", ref: "dev" }, { repo: "a/b" })).toBe(false)
    expect(sameTarget("repo", { repo: "a/b", path: "x" }, { repo: "a/b", path: "y" })).toBe(false)
    expect(sameTarget("repo", {}, { repo: "a/b" })).toBe(false)
    expect(sameTarget("repo", { repo: "a/b" }, {})).toBe(false)
  })
})
