// Your conversations on the device (decision 0013 decision 2, docs/features/conversations.md), driven as React drives
// them: through the branch layer's plain actions, reading its live queries, with no React. Two devices of one person
// run the browser's own layer (`appLayer`) on Node devices whose engines lead, against ChatApi's real handler over the
// compose Postgres and Electric (src/test/chatApi.ts). The forge is Code Storage scripted over the test git host
// (worker/test/branch.ts), which can make a branch; the deployment's own repository is `octo/hello`. Unhappy paths use
// ChatApi's real refusals.
import { Effect, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { CreateRefused, Forge } from "../../../worker/branch/Forge.ts"
import { DEFAULT_REPOSITORY } from "../../../worker/SignIn.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { dispatches } from "../../flows/dispatch"
import { failingWorker, nodeDevice, type NodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { read } from "../../test/otlp"
import { AuthStore, SESSION } from "../auth/store"
import { Branch } from "../branch/branch"
import { Chat } from "../chat/chat"
import { COMPOSER, PLACE } from "../chat/schema"
import { ChatStore } from "../chat/store"
import { Commands } from "../commands/commands"
import { ACTION_FAILED } from "../home/contract"
import { NEW_BRANCH_PREFIX } from "./contract"
import { CREATION } from "../../plugins/builtinFlows"
import { dropped } from "./metrics"
import { ConversationsStore } from "./store"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long a flow may take on the device's engine, its first start included, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: flows on fresh devices' engines, each with its first start, on a loaded machine. */
const WITHIN = 120_000

/**
 * ChatApi on Code Storage, from a first tab whose engine never leads; `octo/hello` has `main` and `feature/one`, and the
 * deployment's own repository (`GITHUB_REPOSITORY`, unset here) has `main` and `taken`.
 */
const openApi = async (forge?: Forge["Service"]) => {
  const runtime = openTestApp({ answers: false }, { forge: forge ?? "code-storage" })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), "feature/one": shaOf("feature/one") },
  })
  const [owner, name] = DEFAULT_REPOSITORY.split("/") as [string, string]
  api.branches.github.publish(owner, name, { defaultBranch: "main", branches: { main: shaOf("main"), taken: shaOf("taken") } })
  api.branches.forge.ephemeral.publish(owner, name, { defaultBranch: "main", branches: { taken: shaOf("taken") } })
  return api
}

/** One of the person's devices, its engine leading, signed in as a Member, with the live queries React starts. */
const openDevice = async (api: TestChatApi["Service"], host: NodeDevice = nodeDevice({ agent: api }), listOpen = true) => {
  const runtime = openTab(api, { host })
  runtimes.push(runtime)
  const branch = await runtime.runPromise(Effect.service(Branch))
  const chat = await runtime.runPromise(Effect.service(Chat))
  const commands = await runtime.runPromise(Effect.service(Commands))
  const store = await runtime.runPromise(Effect.service(ConversationsStore))
  const { conversations } = branch
  for (const query of [...(listOpen ? [conversations.queries.list, conversations.queries.search] : []), branch.queries.current, chat.queries.place]) {
    query.startSyncImmediate()
  }
  // Signed in as sign-in's `load` sets it, so the composer offers the slash commands.
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(
    session.update(SESSION, (row) => void Object.assign(row, { status: "signed_in", login: "member", role: "member" })),
  )
  return {
    host,
    runtime,
    branch,
    commands,
    actions: conversations.actions,
    /** The list as it shows: each row's branch, and whether it is archived. */
    list: () => conversations.queries.list.toArray.map((row) => `${row.branch}${row.archived ? " (archived)" : ""}`),
    loaded: () => conversations.queries.search.toArray[0]?.loaded,
    /** The acts this device holds until the rows show them. */
    pending: () => store.pending.tanstack.toArray.map((act) => act.archived),
    count: (metric: typeof dropped, attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(metric, attributes))).count,
  }
}

describe("your conversations", () => {
  test("opening a branch lists its conversation on every device; Archive hides it on both; opening it brings it back", async () => {
    const api = await openApi()
    const [laptop, phone] = [await openDevice(api), await openDevice(api)]
    expect(laptop.list()).toEqual([])
    // An empty list is said only once the device knows it is empty: restored, and the first sync answered.
    await until(() => expect(laptop.loaded()).toBe(true))

    const branchId = await laptop.branch.actions.open("octo", "hello", "feature/one")
    expect(branchId).toBeDefined()
    const conversationId = laptop.branch.queries.current.toArray[0]!.conversationId!
    await until(() => expect(laptop.list()).toEqual(["feature/one"]))
    await until(() => expect(phone.list()).toEqual(["feature/one"]))

    // Archive shows on this device before ChatApi answers, then on the person's other device.
    const archiving = laptop.actions.archive(conversationId, true)
    await until(() => expect(laptop.list()).toEqual([]))
    await archiving
    await until(() => expect(phone.list()).toEqual([]))
    // Once the row shows it, the device forgets its act.
    await until(() => expect(laptop.pending()).toEqual([]))
    await phone.actions.showArchived(true)
    await until(() => expect(phone.list()).toEqual(["feature/one (archived)"]))

    // Opening the branch, on any device, brings it back everywhere.
    await phone.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(laptop.list()).toEqual(["feature/one"]))
    await until(() => expect(phone.list()).toEqual([]))
    await phone.actions.showArchived(false)
    await until(() => expect(phone.list()).toEqual(["feature/one"]))

    // Restore from the archived list does the same without opening it.
    await laptop.actions.archive(conversationId, true)
    await until(() => expect(phone.list()).toEqual([]))
    await phone.actions.archive(conversationId, false)
    await until(() => expect(laptop.list()).toEqual(["feature/one"]))

    // Two presses before the first lands: the later one wins, on this device and everywhere.
    const first = laptop.actions.archive(conversationId, true)
    const second = laptop.actions.archive(conversationId, false)
    await Promise.all([first, second])
    expect(laptop.list()).toEqual(["feature/one"])
    await until(() => expect(laptop.pending()).toEqual([]))
    await until(() => expect(phone.list()).toEqual(["feature/one"]))

    // A blank screen must be diagnosable from the shape's outcome and the list's counts.
    // Dispose the devices to flush their real OTLP exporters before inspecting the server's receipts.
    await phone.runtime.dispose()
    await laptop.runtime.dispose()
    const records = read(api.telemetry)
    expect(records.log("conversations.shape.sync")).toContainEqual(
      expect.objectContaining({ attributes: expect.objectContaining({ phase: "sent", durationMs: expect.any(Number) }) }),
    )
    expect(records.log("conversations.shape.sync")).toContainEqual(
      expect.objectContaining({ attributes: expect.objectContaining({ phase: "ready", durationMs: expect.any(Number) }) }),
    )
    expect(records.point("smithers_conversation_shape_transitions", { phase: "ready" })?.value).toBeGreaterThan(0)
    expect(records.point("smithers_conversation_list_updates", { archived: "false", loaded: "true" })?.value).toBeGreaterThan(0)
    const projected = records.log("conversations.list").map(row => row.attributes)
    expect(projected).toContainEqual(expect.objectContaining({ syncedRows: 0, listedRows: 0, loaded: false }))
    expect(projected).toContainEqual(expect.objectContaining({ syncedRows: 1, pendingRows: 0, listedRows: 1, archived: false }))
    expect(projected).toContainEqual(expect.objectContaining({ syncedRows: 1, listedRows: 0, archived: false }))
    expect(projected).toContainEqual(expect.objectContaining({ syncedRows: 1, listedRows: 1, archived: true }))
    expect(records.span("conversations.list")).toContainEqual(
      expect.objectContaining({ attributes: expect.objectContaining({ syncedRows: 1, listedRows: 1 }) }),
    )
    // No repository, branch name or search is added to these diagnostics.
    expect(JSON.stringify([records.log("conversations.shape.sync"), projected])).not.toContain("feature/one")
  }, WITHIN)

  test("leaving a pending branch page still lists its conversation on both devices after tracking settles", async () => {
    const api = await openApi()
    const laptop = await openDevice(api, nodeDevice({ agent: api }), false)
    const phone = await openDevice(api, nodeDevice({ agent: api }), false)
    const release = api.branches.github.hold()
    const navigation = new AbortController()
    const opening = laptop.branch.actions.open("octo", "hello", "feature/one", navigation.signal)
    try {
      // Pending branch chrome can already name the branch before this real forge request answers.
      await until(() => expect(api.branches.github.seen.length).toBeGreaterThan(0))
      navigation.abort()
      await laptop.branch.actions.leave()
      for (const device of [laptop, phone]) {
        device.branch.conversations.queries.list.startSyncImmediate()
        device.branch.conversations.queries.search.startSyncImmediate()
      }
      expect(laptop.list()).toEqual([])
      expect(phone.list()).toEqual([])
    } finally {
      release()
    }
    expect(await opening).toBeUndefined()
    await until(() => expect(laptop.list()).toEqual(["feature/one"]))
    await until(() => expect(phone.list()).toEqual(["feature/one"]))
    await until(() => expect(phone.loaded()).toBe(true))
  }, WITHIN)

  test("opening Conversations after branch navigation and reload reads ordinary and ephemeral rows and follows other devices", async () => {
    const api = await openApi()
    const laptop = await openDevice(api, nodeDevice({ agent: api }), false)
    const phoneHost = nodeDevice({ agent: api })
    const phone = await openDevice(api, phoneHost, false)
    await laptop.branch.actions.open("octo", "hello", "feature/one")
    laptop.commands.actions.type("/new octo/hello topic-two")
    laptop.commands.actions.submit("/new octo/hello topic-two")
    await until(() => expect(laptop.host.navigated).toEqual(["/octo/hello/tree/topic-two"]))
    // The route starts these queries only when Conversations mounts, after the writes.
    for (const device of [laptop, phone]) {
      device.branch.conversations.queries.list.startSyncImmediate()
      device.branch.conversations.queries.search.startSyncImmediate()
      await until(() => expect(device.list()).toEqual(["topic-two", "feature/one"]))
    }
    const store = await laptop.runtime.runPromise(Effect.service(ConversationsStore))
    const conversationId = store.mine.tanstack.toArray.find(row => row.branch === "topic-two")!.conversationId
    await laptop.actions.archive(conversationId, true)
    await until(() => expect(phone.list()).toEqual(["feature/one"]))
    await phone.runtime.dispose()
    const reloaded = await openDevice(api, phoneHost, false)
    reloaded.branch.conversations.queries.list.startSyncImmediate()
    reloaded.branch.conversations.queries.search.startSyncImmediate()
    await until(() => expect(reloaded.loaded()).toBe(true))
    expect(reloaded.list()).toEqual(["feature/one"])
    await reloaded.actions.showArchived(true)
    await until(() => expect(reloaded.list()).toEqual(["topic-two (archived)"]))
    await reloaded.branch.actions.open("octo", "hello", "topic-two")
    await until(() => expect(laptop.list()).toEqual(["topic-two", "feature/one"]))
  }, WITHIN)

  test("a device clock behind its pending archive still restores with a later act", async () => {
    const api = await openApi()
    const laptop = await openDevice(api)
    await laptop.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(laptop.list()).toEqual(["feature/one"]))
    const store = await laptop.runtime.runPromise(Effect.service(ConversationsStore))
    const conversationId = laptop.branch.queries.current.toArray[0]!.conversationId!
    const future = Date.now() + 60_000
    // A persisted act from a device whose clock was ahead has not reached the server yet.
    await laptop.runtime.runPromise(store.pending.insert({ conversationId, archived: true, at: future }))
    await laptop.actions.archive(conversationId, false)
    await until(() => expect(store.mine.tanstack.get(conversationId)?.changedAt).toBeDefined())
    await until(() => expect(laptop.pending()).toEqual([]))
    expect(new Date(store.mine.tanstack.get(conversationId)!.changedAt).getTime()).toBeGreaterThan(future)
    expect(laptop.list()).toEqual(["feature/one"])

    const later = future + 60_000
    await laptop.runtime.runPromise(store.pending.insert({ conversationId, archived: true, at: later }))
    await laptop.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(laptop.pending()).toEqual([]))
    expect(new Date(store.mine.tanstack.get(conversationId)!.changedAt).getTime()).toBeGreaterThan(later)
    expect(laptop.list()).toEqual(["feature/one"])
  }, WITHIN)

  test("search matches the repository and the branch, every word", async () => {
    const api = await openApi()
    const laptop = await openDevice(api)
    await laptop.branch.actions.open("octo", "hello", "feature/one")
    await laptop.branch.actions.open("octo", "hello", "main")
    await until(() => expect(laptop.list()).toEqual(["main", "feature/one"]))

    await laptop.actions.search("FEATURE")
    await until(() => expect(laptop.list()).toEqual(["feature/one"]))
    await laptop.actions.search("octo/hello main")
    await until(() => expect(laptop.list()).toEqual(["main"]))
    await laptop.actions.search("nothing")
    await until(() => expect(laptop.list()).toEqual([]))
    await laptop.actions.search("")
    await until(() => expect(laptop.list()).toEqual(["main", "feature/one"]))

    // Opening one again moves it first.
    await laptop.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(laptop.list()).toEqual(["feature/one", "main"]))
  }, WITHIN)

  test("an archive ChatApi refuses leaves the device: the row shows as it is, counted and logged", async () => {
    const api = await openApi()
    const laptop = await openDevice(api)
    // A conversation no branch has: ChatApi answers 404, which is final.
    const unknown = "00000000-0000-4000-8000-000000000000"
    await laptop.actions.archive(unknown, true)
    await until(() => expect(laptop.count(dropped, { reason: "@smthrs/mvp/conversations/ArchiveRefused" })).toBe(1))
    expect(laptop.pending()).toEqual([])

    // A press replaced before its refusal lands: only the latest act is taken back, once.
    await Promise.all([laptop.actions.archive(unknown, true), laptop.actions.archive(unknown, false)])
    await until(() => expect(laptop.pending()).toEqual([]))
    await until(() => expect(laptop.count(dropped, { reason: "@smthrs/mvp/conversations/ArchiveRefused" })).toBe(2))
  }, WITHIN)
})

test("an act a closed tab left on the device follows its run when the device opens again, and leaves when it can't land", async () => {
  const api = await openApi()
  const host = nodeDevice({ agent: api })
  const before = openTab(api, { host })
  const store = await before.runPromise(Effect.service(ConversationsStore))
  // The tab wrote the act and closed before its run started: a conversation no branch has, which ChatApi refuses.
  const unknown = "00000000-0000-4000-8000-000000000000"
  await before.runPromise(Effect.flatMap(store.pending.insert({ conversationId: unknown, archived: true, at: 5 }), (tx) => tx.persisted))
  await before.dispose()

  const after = openTab(api, { host })
  runtimes.push(after)
  const reopened = await after.runPromise(Effect.service(ConversationsStore))
  reopened.pending.tanstack.startSyncImmediate()
  await after.runPromise(Effect.service(Branch))
  await until(() => expect(reopened.pending.tanstack.toArray).toEqual([]))
  expect(after.runSync(Metric.value(Metric.withAttributes(dropped, { reason: "@smthrs/mvp/conversations/ArchiveRefused" }))).count)
    .toBe(1)
}, WITHIN)

describe("a new conversation", () => {
  test("a Member's /new from home reports a missing deployment mirror and keeps the command retryable", async () => {
    // Without the deployment mirror, the selector cannot pin repository installation bytes.
    // Its real not_found response is terminal and restores the accepted command.
    const runtime = openTestApp({ answers: false }, { forge: "code-storage" })
    runtimes.push(runtime)
    const api = await runtime.runPromise(Effect.service(TestChatApi))
    const laptop = await openDevice(api)
    laptop.commands.queries.menu.startSyncImmediate()
    laptop.commands.actions.type(`/new ${DEFAULT_REPOSITORY}`)
    laptop.commands.actions.submit(`/new ${DEFAULT_REPOSITORY}`)
    await until(() =>
      expect(laptop.count(dispatches, { flow: "conversation/new", door: "slash", outcome: "failed" })).toBe(1)
    )
    expect(laptop.commands.queries.menu.toArray[0]?.refusal).toBe(ACTION_FAILED)
    expect(laptop.host.navigated).toEqual([])
    expect(api.branches.github.seen.map(row => row.path)).toEqual([
      `/${DEFAULT_REPOSITORY}.git/info/refs?service=git-upload-pack`,
    ])
    // The composer and its menu agree, so the existing error is visible.
    expect((await laptop.runtime.runPromise(Effect.service(ChatStore))).composer.tanstack.get(COMPOSER)?.draft).toBe(`/new ${DEFAULT_REPOSITORY}`)
  }, WITHIN)

  test("an unavailable engine keeps /new in the composer, staged, and claims no failure it can't prove", async () => {
    // No reply from the engine proves nothing either way (decision 0124): the line stays the person's, its input stays
    // staged for the next page open, and the composer says nothing went wrong.
    const api = await openApi()
    const laptop = await openDevice(api, nodeDevice({ engineWorker: failingWorker }))
    laptop.commands.queries.menu.startSyncImmediate()
    laptop.commands.actions.type(`/new ${DEFAULT_REPOSITORY}`)
    laptop.commands.actions.submit(`/new ${DEFAULT_REPOSITORY}`)
    await until(() =>
      expect(laptop.count(dispatches, { flow: "conversation/new", door: "slash", outcome: "error" })).toBe(1)
    )
    expect(laptop.commands.queries.menu.toArray[0]?.refusal ?? null).toBeNull()
    expect((await laptop.runtime.runPromise(Effect.service(ChatStore))).composer.tanstack.get(COMPOSER)?.draft).toBe(`/new ${DEFAULT_REPOSITORY}`)
    expect(laptop.host.navigated).toEqual([])
  }, WITHIN)

  test("choosing /new requests a repository without creating a branch", async () => {
    const api = await openApi()
    const laptop = await openDevice(api)
    laptop.commands.queries.menu.startSyncImmediate()
    laptop.commands.actions.type("/")
    const index = laptop.commands.queries.menu.toArray[0]!.items.findIndex(row => row.label === "/new")
    laptop.commands.actions.choose(index, "accept")
    const store = await laptop.runtime.runPromise(Effect.service(ChatStore))
    expect(store.composer.tanstack.get(COMPOSER)?.draft).toBe("/new ")
    laptop.commands.actions.submit("/new")
    expect(laptop.commands.queries.menu.toArray[0]?.refusal).toBe("/new needs repo")
    expect(laptop.host.navigated).toEqual([])
    expect(api.branches.github.seen).toEqual([])
  }, WITHIN)

  test.each(["typing", "dismissal", "draft", "conversation"] as const)(
    "a delayed refusal leaves newer %s alone",
    async (change) => {
      const api = await openApi()
      const laptop = await openDevice(api)
      laptop.commands.queries.menu.startSyncImmediate()
      const store = await laptop.runtime.runPromise(Effect.service(ChatStore))
      const release = api.branches.github.hold()
      try {
        laptop.commands.actions.type(`/new ${DEFAULT_REPOSITORY} taken`)
        laptop.commands.actions.submit(`/new ${DEFAULT_REPOSITORY} taken`)
        // The real branch request is still waiting for its forge.
        await until(() => expect(api.branches.github.seen.length).toBeGreaterThan(0))
        expect(laptop.commands.queries.menu.toArray[0]?.refusal).toBeNull()
        if (change === "typing") laptop.commands.actions.type("/theme")
        if (change === "dismissal") laptop.commands.actions.dismiss()
        if (change === "draft") {
          await laptop.runtime.runPromise(store.composer.update(COMPOSER, row => { row.draft = "next question" }))
        }
        if (change === "conversation") {
          await laptop.runtime.runPromise(store.place.update(PLACE, row => { row.conversationId = "another-conversation" }))
        }
      } finally {
        release()
      }
      await until(() =>
        expect(laptop.count(dispatches, { flow: "conversation/new", door: "slash", outcome: "failed" })).toBe(1)
      )
      expect(laptop.commands.queries.menu.toArray[0]?.refusal ?? null).toBeNull()
      // The line stays until its run finished (decision 0124): a run that failed leaves it, and says nothing over newer
      // work.
      expect(store.composer.tanstack.get(COMPOSER)?.draft).toBe(
        change === "typing" ? "/theme" : change === "draft" ? "next question" : `/new ${DEFAULT_REPOSITORY} taken`,
      )
      expect(laptop.host.navigated).toEqual([])
    },
    WITHIN,
  )

  test("/new makes a new branch of the explicitly named repository from a branch or home", async () => {
    const api = await openApi()
    const laptop = await openDevice(api)
    await laptop.branch.actions.open("octo", "hello", "feature/one")

    laptop.commands.actions.type("/new octo/hello topic-two")
    laptop.commands.actions.submit("/new octo/hello topic-two")
    await until(() => expect(laptop.host.navigated).toEqual(["/octo/hello/tree/topic-two"]))
    await until(() => expect(laptop.list()).toContain("topic-two"))

    // From the home conversation, with no name: the deployment's own repository, a name drawn from the run.
    await laptop.branch.actions.leave()
    laptop.commands.actions.type(`/new ${DEFAULT_REPOSITORY}`)
    laptop.commands.actions.submit(`/new ${DEFAULT_REPOSITORY}`)
    await until(() => expect(laptop.host.navigated).toHaveLength(2))
    expect(laptop.host.navigated[1]).toMatch(new RegExp(`^/${DEFAULT_REPOSITORY}/tree/${NEW_BRANCH_PREFIX}[0-9a-f]{6}$`))
    await until(() =>
      expect(laptop.count(dispatches, { flow: "conversation/new", door: "slash", outcome: "done" })).toBe(2)
    )
  }, WITHIN)

  test("/new executes the repository-selected source through the device's durable engine", async () => {
    const api = await openApi()
    api.branches.forge.files.set(".smithers/branch.json", JSON.stringify({ plugin: "team-branches", flow: "create" }))
    api.branches.forge.files.set(".smithers/plugins/team-branches/plugin.json", JSON.stringify({ ...CREATION.manifest, id: "team-branches" }))
    api.branches.forge.files.set(".smithers/flows/team-branches/create/flow.ts", CREATION.source
      .replace('"branches/create"', '"team-branches/create"')
      .replace('Create.call({ ref })', 'Create.call({ ref: `team/${ref}` })'))
    const laptop = await openDevice(api)
    await laptop.branch.actions.open("octo", "hello", "feature/one")
    laptop.commands.actions.type("/new octo/hello selected")
    laptop.commands.actions.submit("/new octo/hello selected")
    await until(() => expect(laptop.host.navigated).toEqual(["/octo/hello/tree/team/selected"]))
    await until(() => expect(laptop.list()).toContain("team/selected"))
    expect(api.branches.forge.created).toContainEqual({ repo: "github/octo/hello", from: "main", branch: "team/selected" })
    expect(api.branches.github.repository("octo", "hello")?.branches["team/selected"]).toBeUndefined()
    expect(api.branches.forge.ephemeral.repository("octo", "hello")?.branches["team/selected"]).toBe(shaOf("main"))
  }, WITHIN)

  test.each([401, 403])("/new stops after Code Storage %s: one write attempt, no navigation", async (status) => {
    let attempts = 0
    const api = await openApi(Forge.of({
      move: () => Effect.die("no resync"),
      pull: () => Effect.die("no resync"),
      upstream: () => Effect.succeed({ url: `https://github.com/${DEFAULT_REPOSITORY}.git` }),
      create: () => Effect.suspend(() => {
        attempts++
        return Effect.fail(new CreateRefused({
          code: "forbidden", errorTag: "@smthrs/effect-code-storage/CodeStorageError",
          errorCode: status === 401 ? "unauthorized" : "insufficient_scope", errorStatus: status,
        }))
      }),
    }))
    const laptop = await openDevice(api)
    laptop.commands.queries.menu.startSyncImmediate()
    laptop.commands.actions.type(`/new ${DEFAULT_REPOSITORY}`)
    laptop.commands.actions.submit(`/new ${DEFAULT_REPOSITORY}`)
    // A completed failure is a durable terminal result, with no retry pending.
    await until(() =>
      expect(laptop.count(dispatches, { flow: "conversation/new", door: "slash", outcome: "failed" })).toBe(1)
    )
    expect(attempts).toBe(1)
    expect(laptop.host.navigated).toEqual([])
    expect(laptop.commands.queries.menu.toArray[0]?.refusal).toBe(ACTION_FAILED)
  }, WITHIN)

  test("a name the forge already has is refused exists, never tried again, and the tab stays", async () => {
    const api = await openApi()
    const laptop = await openDevice(api)
    laptop.commands.queries.menu.startSyncImmediate()
    laptop.commands.actions.type(`/new ${DEFAULT_REPOSITORY} taken`)
    laptop.commands.actions.submit(`/new ${DEFAULT_REPOSITORY} taken`)
    // The step's refusal is final: one failed run, no retries for a day.
    await until(() =>
      expect(laptop.count(dispatches, { flow: "conversation/new", door: "slash", outcome: "failed" })).toBe(1)
    )
    expect(laptop.host.navigated).toEqual([])
    expect(laptop.commands.queries.menu.toArray[0]?.refusal).toBe(ACTION_FAILED)
  }, WITHIN)
})
