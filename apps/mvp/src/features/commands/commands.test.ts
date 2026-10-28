import { Collection } from "@smthrs/effect-tanstack-db"
import { PendingSnapshot } from "@smthrs/platform-browser"
import { Deferred, Effect, Exit, Logger, type ManagedRuntime, Metric, Scope } from "effect"
import { slashMenu, slashSubmit } from "@smthrs/ui"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DispatchFailed, FlowDispatch, dispatches } from "../../flows/dispatch"
import { WriteIntents } from "../../writeAdmission"
import { NavigationRefused } from "../navigation/flows"
import { choose as chooseCommand, submit as submitCommand, type as typeCommand } from "./actions"
import { entryOf, names } from "../../flows/registry"
import type { Actor } from "../../../worker/Actor.ts"
import { nodeDevice, openTestApp, type TabOptions, TestChatApi } from "../../test/chatApi"
import { AuthStore, SESSION } from "../auth/store"
import { Chat } from "../chat/chat"
import { PLACE, Place } from "../chat/schema"
import { ChatStore } from "../chat/store"
import { SharedPrompt } from "../chat/sharedPrompt"
import { WebTab } from "../web/actions"
import type { IssuesStore } from "../issues/store"
import type { TodosStore } from "../todos/store"
import type { RunSteers } from "../runs/steers"
import type { SteerWrites } from "../runs/writes"
import { ThemeStore } from "../theme/store"
import { CANT_OPEN } from "../web/contract"
import { Load } from "@smthrs/plugin"
import { BUILTIN } from "../../plugins/builtin"
import { Plugins } from "../../plugins/plugins"
import { hostFacts } from "../../plugins/facts"
import { type Command, COMMANDS, commandsFor, commandsOf, pluginCommands, rankOf, summary, type Viewer, viewerOf } from "./catalog"
import { BranchStore } from "../branch/store"
import { CURRENT } from "../branch/schema"
import { RepoStore } from "../repo/store"
import { repoId } from "../repo/contract"
import { Commands } from "./commands"
import { choices, submits } from "./metrics"
import { CommandsStore } from "./store"

// Slash commands (docs/features/slash-commands.md): the catalog and role filter as pure functions, then the menu and
// the submit driven as the composer drives them, through the commands layer's plain actions, on the browser's own
// layer (`appLayer`) over a Node device against ChatApi's real handler and the compose Postgres and Electric. A command
// that runs reaches the flow through `FlowDispatch` on a real engine leader, and the theme changes on the device.

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 6_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** How long a command's flow may take on the device's engine, its first start included, on a loaded machine. */
const engineWithin = 40_000

const person = (role: Actor["role"]): Actor => ({ subject: { kind: "person", id: `person-${role ?? "none"}` }, role })

/**
 * The app over a fresh ChatApi as `actor` (a Member unless set), with the commands layer and its menu started. The test
 * ChatApi serves no sign-in routes, so the tab's session row is set as sign-in's `load` sets it from ChatApi's answer.
 */
/** A device whose tab keeps its input receipts, as a browser's session storage does. */
const keepingInputs = () => {
  const data = new Map<string, string>()
  return {
    ...nodeDevice(),
    writeSnapshot: PendingSnapshot.make({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }, "pending"),
  }
}

const open = async (options: TabOptions = {}, actor: Actor | null = person("member")) => {
  const runtime: ManagedRuntime.ManagedRuntime<
    Commands | Chat | ChatStore | CommandsStore | ThemeStore | AuthStore | TestChatApi | Plugins | FlowDispatch | IssuesStore | TodosStore | RunSteers | SteerWrites | BranchStore | RepoStore | WriteIntents,
    unknown
  > = openTestApp(options, { actor })
  runtimes.push(runtime)
  const { queries, actions } = await runtime.runPromise(Effect.service(Commands))
  const chat = await runtime.runPromise(Effect.service(Chat))
  const store = await runtime.runPromise(Effect.service(CommandsStore))
  const chatStore = await runtime.runPromise(Effect.service(ChatStore))
  // What React's live queries start on first render.
  for (const query of [store.menuState, chatStore.composerState, chatStore.shown]) query.tanstack.startSyncImmediate()
  const theme = await runtime.runPromise(Effect.service(ThemeStore))
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  // Once sign-in's own `load` has had ChatApi's answer, which would overwrite it.
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(
    session.update(
      SESSION,
      (row) =>
        void Object.assign(
          row,
          actor === null
            ? { status: "signed_out", login: null, role: null }
            : { status: "signed_in", login: actor.subject.id, role: actor.role },
        ),
    ),
  )
  return {
    runtime,
    actions,
    chat,
    /** The menu as the composer reads it, if it is the menu for the composer's draft. */
    menu: () => queries.menu.toArray[0],
    labels: () => (queries.menu.toArray[0]?.items ?? []).map(({ label }) => label),
    draft: () => chatStore.composerState.tanstack.toArray[0]?.draft,
    shown: () => chat.queries.conversation.toArray.map(({ role, text }) => `${role} ${text}`),
    theme: () => runtime.runPromise(theme.current),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>) => runtime.runSync(Metric.value(metric)).count,
    /** Shows conversation `conversationId` in this tab, as a branch's page does. */
    showConversation: (conversationId: string) =>
      runtime.runPromise(chatStore.place.update(PLACE, (row) => void (row.conversationId = conversationId))),
    /** The outcome of every request ChatApi's route `route` (a span name, such as `sandbox.call`) answered. */
    answered: async (route: string) =>
      (await runtime.runPromise(Effect.service(TestChatApi))).spans
        .filter((span) => span.name === route)
        .map((span) => span.attributes.get("outcome")),
  }
}

/** What a slash lists for `viewer`: every command at or below their role, in the registry's order. */
/** The built-in plugins' commands (src/plugins/builtin.ts), loaded as the app loads them: the menu offers them too. */
const PLUGIN_COMMANDS = pluginCommands(
  Effect.runSync(Load.load(hostFacts(), BUILTIN.map(({ manifest }) => ({ tier: "built-in" as const, manifest })))).contributions
    .commands,
)
const listed = (viewer: Viewer) => commandsFor(viewer, [...COMMANDS, ...PLUGIN_COMMANDS]).map(({ name }) => `/${name}`)

const MEMBER: Viewer = { signedIn: true, role: "member" }

/**
 * Waits until a slash lists what `viewer` may run: the app's stores are open and sign-in has said who is at the
 * composer. Returns the theme row's index.
 */
const ready = async (tab: Awaited<ReturnType<typeof open>>, viewer: Viewer = MEMBER) => {
  await until(() => {
    tab.actions.type("/")
    expect(tab.labels()).toEqual(listed(viewer))
  })
  return tab.labels().indexOf("/theme")
}

/** The theme's command, as the catalog derives it from `app/theme/set`. */
const THEME: Command = {
  name: "theme",
  flow: "app/theme/set",
  minimum: "anyone",
  description: "Light or dark theme",
  fields: [{
    name: "mode",
    label: "Mode",
    kind: "select",
    required: true,
    options: [{ value: "light", label: "light" }, { value: "dark", label: "dark" }],
  }],
}

describe("the catalog", () => {
  test("every registered flow with a slash door, its row the first sentence of its description, its arguments its payload", () => {
    expect(COMMANDS.find(({ flow }) => flow === "app/theme/set")).toEqual(THEME)
    expect(commandsOf((["app/theme/set", "chat/Answer", "repo/tree"] as const).map((name) => [name, entryOf(name)])))
      .toEqual([THEME])
    // A reference carries no description: its row has none.
    const { _tag, payloadSchema, successSchema, errorSchema } = entryOf("app/theme/set").flow
    const reference = { _tag, payloadSchema, successSchema, errorSchema }
    expect(commandsOf([["app/theme/set", { ...entryOf("app/theme/set"), flow: reference, slash: { ...entryOf("app/theme/set").slash!, description: undefined } }]])).toEqual([
      { ...THEME, description: "" },
    ])
  })

  test("a plugin's commands with a slash join the menu, with their fixed payload; the rest don't", () => {
    expect(pluginCommands([
      { flow: "app/navigate", title: "Queue", minimum: "member", args: { to: "/app/queue" }, slash: { name: "queue" } },
      { flow: "app/navigate", title: "Home", minimum: "anyone", slash: { name: "home" } },
      { flow: "app/navigate", title: "Palette only", minimum: "anyone" },
    ])).toEqual([
      { name: "queue", flow: "app/navigate", minimum: "member", description: "Queue", fields: [], args: { to: "/app/queue" } },
      { name: "home", flow: "app/navigate", minimum: "anyone", description: "Home", fields: [] },
    ])
    // The built-ins' (src/plugins/builtin.ts): the bug plugin's form and inbox, and the queue.
    expect(PLUGIN_COMMANDS.map(({ name }) => name)).toEqual(["bug", "bugs", "queue"])
  })

  test("names are command syntax, one per flow, and each slash door's flow carries a description", () => {
    const slashed = names.filter((name) => entryOf(name).slash !== undefined)
    expect(new Set(COMMANDS.map(({ name }) => name)).size).toBe(COMMANDS.length)
    for (const name of slashed) {
      expect(entryOf(name).slash!.command).toMatch(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/)
      expect(entryOf(name).flow.description?.trim()).toBeTruthy()
    }
    expect(COMMANDS.map(({ flow }) => flow)).toEqual(slashed)
  })

  test("a summary is the description's first sentence, or all of it", () => {
    expect(summary("  One thing. And more.  ")).toBe("One thing.")
    expect(summary("Is it? Yes.")).toBe("Is it?")
    expect(summary("Version 1.2 ships. Then 1.3.")).toBe("Version 1.2 ships.")
    expect(summary("No full stop")).toBe("No full stop")
    expect(summary("")).toBe("")
  })

  test("a slash door's fields are the ones its line fills: /issue's title takes the rest of the line, /comment's body", () => {
    const issue = COMMANDS.find(({ flow }) => flow === "issue/create")!
    expect(issue.fields.map(({ name }) => name)).toEqual(["repo", "title"])
    expect(slashSubmit("/issue octo/hello Fix the crash on start", COMMANDS)).toEqual({
      kind: "run",
      command: issue,
      payload: { repo: "octo/hello", title: "Fix the crash on start" },
    })
    const comment = COMMANDS.find(({ flow }) => flow === "issue/comment")!
    expect(comment.fields.map(({ name }) => name)).toEqual(["repo", "number", "body"])
    expect(slashSubmit("/comment octo/hello 12 Looks good to me", COMMANDS)).toEqual({
      kind: "run",
      command: comment,
      payload: { repo: "octo/hello", number: 12, body: "Looks good to me" },
    })
    expect(slashSubmit("/issue octo/hello", COMMANDS)).toMatchObject({ kind: "missing", fields: ["title"] })
  })

  test("a person sees the commands at or below their role; signed out is anyone, signed in with no role a Guest", () => {
    const at = (minimum: Command["minimum"]): Command => ({ ...THEME, name: minimum, minimum })
    const every = [at("anyone"), at("guest"), at("member"), at("maintainer"), at("admin")]
    const seen = (signedIn: boolean, role: Parameters<typeof rankOf>[0]["role"]) =>
      commandsFor({ signedIn, role }, every).map(({ name }) => name)
    expect(seen(false, null)).toEqual(["anyone"])
    expect(seen(false, "admin")).toEqual(["anyone"])
    expect(seen(true, null)).toEqual(["anyone", "guest"])
    expect(seen(true, "guest")).toEqual(["anyone", "guest"])
    expect(seen(true, "member")).toEqual(["anyone", "guest", "member"])
    expect(seen(true, "maintainer")).toEqual(["anyone", "guest", "member", "maintainer"])
    expect(seen(true, "admin")).toEqual(["anyone", "guest", "member", "maintainer", "admin"])
    expect(commandsFor({ signedIn: false, role: null })).toEqual(COMMANDS.filter(({ minimum }) => minimum === "anyone"))
  })

  test("who is at the composer: what ChatApi said, else the session the device last confirmed, else nobody", () => {
    const member = { role: "member" as const }
    expect(viewerOf({ status: "signed_in", role: "guest" }, member)).toEqual({ signedIn: true, role: "guest" })
    expect(viewerOf({ status: "signed_out", role: null }, member)).toEqual({ signedIn: false, role: null })
    expect(viewerOf({ status: "loading", role: null }, member)).toEqual({ signedIn: true, role: "member" })
    expect(viewerOf({ status: "unreachable", role: null }, { role: null })).toEqual({ signedIn: true, role: null })
    expect(viewerOf({ status: "loading", role: null }, undefined)).toEqual({ signedIn: false, role: null })
  })
})

describe("the menu", () => {
  test("a slash lists the commands with their descriptions; typing filters; no match lists nothing", async () => {
    const tab = await open()
    const theme = await ready(tab)
    expect(tab.draft()).toBe("/")
    expect(tab.labels()).toEqual(listed(MEMBER))
    expect(tab.menu()).toMatchObject({ kind: "commands", label: "Commands", highlighted: 0, refusal: null })
    expect(tab.menu()?.items[theme]).toEqual({
      id: "command:theme",
      label: "/theme",
      detail: "Light or dark theme",
      draft: "/theme ",
      runs: false,
    })
    tab.actions.type("/them")
    expect(tab.labels()).toEqual(["/theme"])
    tab.actions.type("/dark")
    // The description matches too.
    expect(tab.labels()).toEqual(["/theme"])
    tab.actions.type("/zz")
    expect(tab.menu()).toMatchObject({ kind: "none", items: [] })
    tab.actions.type("hello")
    expect(tab.labels()).toEqual([])
  })

  test("oversize input stays intact with its limit and never dispatches", async () => {
    const tab = await open()
    await ready(tab)
    const text = "x".repeat(8001)
    tab.actions.type(text)
    expect(tab.menu()?.refusal).toBe("8,000 characters max")
    tab.actions.submit(text)
    expect(tab.menu()?.refusal).toBe("8,000 characters max")
    expect(tab.draft()).toBe(text)
    expect(tab.shown()).toEqual([])
    tab.actions.type("x".repeat(8000))
    expect(tab.menu()?.refusal).toBeNull()
  })

  test("exact repository commands show their format on the first Enter", async () => {
    const tab = await open()
    await ready(tab)
    for (const [name, hint] of [["repo", "/repo owner/name"], ["issues", "/issues owner/name"], ["docs", "/docs owner/name query"]]) {
      tab.actions.type(`/${name}`)
      tab.actions.choose(0, "accept")
      expect(tab.draft()).toBe(`/${name}`)
      expect(tab.menu()?.refusal).toBe(hint)
    }
    expect(tab.shown()).toEqual([])
  })

  test("Tab completes a command to its argument values, labelled by the field; the arrows move; Tab completes a value", async () => {
    const tab = await open()
    tab.actions.choose(await ready(tab), "complete")
    expect(tab.draft()).toBe("/theme ")
    expect(tab.menu()).toMatchObject({ kind: "values", label: "Mode", highlighted: 0 })
    expect(tab.labels()).toEqual(["light", "dark"])
    tab.actions.highlight(1)
    expect(tab.menu()?.highlighted).toBe(1)
    tab.actions.choose(1, "complete")
    expect(tab.draft()).toBe("/theme dark")
    expect(tab.labels()).toEqual(["dark"])
    tab.actions.type("/theme d")
    expect(tab.labels()).toEqual(["dark"])
    expect(tab.count(Metric.withAttributes(choices, { kind: "commands", how: "complete" }))).toBe(1)
    expect(tab.count(Metric.withAttributes(choices, { kind: "values", how: "complete" }))).toBe(1)
  })

  test("Enter on a command that needs arguments completes it, as Tab does", async () => {
    const tab = await open()
    tab.actions.choose(await ready(tab), "accept")
    expect(tab.draft()).toBe("/theme ")
    expect(tab.labels()).toEqual(["light", "dark"])
    expect(tab.count(Metric.withAttributes(choices, { kind: "commands", how: "accept" }))).toBe(1)
  })

  test("Escape closes the menu and keeps the draft; typing lists again", async () => {
    const tab = await open()
    await ready(tab)
    tab.actions.dismiss()
    expect(tab.draft()).toBe("/")
    expect(tab.menu()).toMatchObject({ items: [] })
    tab.actions.type("/them")
    expect(tab.labels()).toEqual(["/theme"])
  })

  test("a menu for an older draft never shows, and choosing from it, or past its rows, does nothing", async () => {
    const tab = await open()
    await ready(tab)
    tab.actions.choose(COMMANDS.length, "complete")
    expect(tab.draft()).toBe("/")
    // Edit on an unsent question, or asking, changes the draft without the menu.
    tab.chat.actions.setDraft("/the")
    expect(tab.menu()).toBeUndefined()
    tab.actions.choose(0, "complete")
    expect(tab.draft()).toBe("/the")
    expect(tab.count(choices)).toBe(0)
  })
})

describe("shared draft admission", () => {
  test("typing lists immediately and older admissions never replace newer menus or dismissals", async () => {
    const tab = await open()
    await ready(tab)
    const store = await tab.runtime.runPromise(Effect.service(ChatStore))
    const isolatedPlace = await tab.runtime.runPromise(Collection.local<Place, string>({
      id: "command-admission-place", schema: Place, getKey: row => row.id,
      initialData: [{ id: PLACE, conversationId: crypto.randomUUID(), shared: true }],
    }).pipe(Effect.provideService(Scope.Scope, store.scope)))
    const sharedStore = { ...store, place: isolatedPlace }
    const entered = [Effect.runSync(Deferred.make<void>()), Effect.runSync(Deferred.make<void>())]
    const admitted = [Effect.runSync(Deferred.make<void>()), Effect.runSync(Deferred.make<void>())]
    const pending: Promise<void>[] = []
    const shared = { set: (draft: string) => {
      const index = draft === "/the" ? 0 : 1
      return Effect.andThen(Deferred.succeed(entered[index]!, undefined), Deferred.await(admitted[index]!))
    } }
    try {
      pending.push(tab.runtime.runPromise(typeCommand("/the").pipe(Effect.provideService(ChatStore, sharedStore), Effect.provideService(SharedPrompt, shared))))
      await Effect.runPromise(Deferred.await(entered[0]!))
      await until(() => expect(tab.labels()).toContain("/theme"))
      pending.push(tab.runtime.runPromise(typeCommand("/bug").pipe(Effect.provideService(ChatStore, sharedStore), Effect.provideService(SharedPrompt, shared))))
      await Effect.runPromise(Deferred.await(entered[1]!))
      await until(() => expect(tab.labels()).toContain("/bug"))
      Effect.runSync(Deferred.succeed(admitted[1]!, undefined))
      await pending[1]
      tab.actions.dismiss()
      Effect.runSync(Deferred.succeed(admitted[0]!, undefined))
      await pending[0]
      expect(tab.draft()).toBe("/bug")
      await until(() => expect(tab.menu()).toMatchObject({ items: [] }))
    } finally {
      for (const gate of admitted) Effect.runSync(Deferred.succeed(gate, undefined))
      await Promise.all(pending)
    }
  })
})

describe("submitting", () => {
  test("opening a browser tab cannot clear source text changed by the host's opening callback", async () => {
    const tab = await open()
    const source = "/web https://example.com/ tab"
    tab.actions.type(source)
    await tab.runtime.runPromise(submitCommand(source).pipe(Effect.provideService(WebTab, {
      policy: { localHttp: false, appOrigin: "https://app.example.test" },
      openTab: () => { tab.actions.type("Later typing"); return true },
    })))
    expect(tab.draft()).toBe("Later typing")
  })

  test("a web tab opens inside the gesture before a shared prompt waits for admission", async () => {
    const tab = await open()
    const store = await tab.runtime.runPromise(Effect.service(ChatStore))
    await tab.runtime.runPromise(store.place.update(PLACE, (row) => { row.conversationId = crypto.randomUUID(); row.shared = true }))
    const entered = Effect.runSync(Deferred.make<void>())
    const admitted = Effect.runSync(Deferred.make<void>())
    const opened: string[] = []
    const submitting = tab.runtime.runPromise(submitCommand("/web https://example.com/ tab").pipe(
      Effect.provideService(SharedPrompt, { set: () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(admitted)) }),
      Effect.provideService(WebTab, { policy: { localHttp: false, appOrigin: "https://app.example.test" }, openTab: (href) => { opened.push(href); return true } }),
    ))
    try {
      await Effect.runPromise(Deferred.await(entered))
      expect(opened).toEqual(["https://example.com/"])
    } finally { Effect.runSync(Deferred.succeed(admitted, undefined)); await submitting }
  })

  test("/theme dark runs app/theme/set through dispatch, door slash, and the device's theme changes", async () => {
    const tab = await open({ answers: true })
    await ready(tab)
    tab.actions.type("/theme dark")
    tab.actions.submit("/theme dark")
    expect(tab.draft()).toBe("")
    expect(tab.menu()).toMatchObject({ kind: "none", items: [], refusal: null })
    await until(async () => expect(await tab.theme()).toBe("dark"), engineWithin)
    expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: "theme" }))).toBe(1)
    await until(() =>
      expect(
        tab.count(Metric.withAttributes(dispatches, { flow: "app/theme/set", door: "slash", outcome: "done" })),
      ).toBe(1)
    )
    // Nothing went to the agent.
    expect(tab.shown()).toEqual([])
  }, 60_000)

  test("navigation dispatch failures keep the command and a short reason", async () => {
    const tab = await open()
    await ready(tab)
    for (const result of [
      Effect.fail(new DispatchFailed({ flow: "app/navigate", reason: "unavailable" })),
      Effect.succeed({ _tag: "Failed" as const, error: new NavigationRefused({ reason: "invalid" }) }),
    ]) {
      tab.actions.type("/navigate /nope-page")
      tab.runtime.runSync(submitCommand("/navigate /nope-page").pipe(
        Effect.provideService(FlowDispatch, FlowDispatch.of({ dispatch: () => result as never })),
      ))
      await until(() => expect(tab.menu()?.refusal).toBe("Couldn’t open page"))
      expect(tab.draft()).toBe("/navigate /nope-page")
    }
  })

  test("late refusals preserve new typing and the newly opened conversation", async () => {
    const tab = await open()
    await ready(tab)
    for (const changed of ["menu", "draft", "conversation"] as const) {
      tab.actions.type("/navigate /nope-page")
      const gate = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      tab.runtime.runSync(submitCommand("/navigate /nope-page").pipe(
        Effect.provideService(FlowDispatch, FlowDispatch.of({ dispatch: () => Effect.gen(function* () {
          yield* Effect.promise(() => gate.promise)
          return { _tag: "Done", value: { moved: false } }
        }).pipe(Effect.ensuring(Effect.sync(() => finished.resolve()))) as never })),
      ))
      if (changed === "menu") tab.actions.type("new typing")
      if (changed === "draft") tab.chat.actions.setDraft("edited draft")
      if (changed === "conversation") await tab.showConversation(crypto.randomUUID())
      gate.resolve()
      await finished.promise
      await tab.runtime.runPromise(Effect.yieldNow)
      expect(tab.draft()).toBe(changed === "menu" ? "new typing" : changed === "draft" ? "edited draft" : "")
      expect(tab.menu()?.refusal ?? null).toBeNull()
    }
  })

  test("typing while the engine admits /new keeps the new text: no refusal or cleared line replaces it", async () => {
    const tab = await open()
    await ready(tab)
    for (const outcome of ["admitted", "refused"] as const) {
      const draft = `/new roninjin10/smithers-github-tests typed-meanwhile-${outcome}`
      tab.actions.type(draft)
      const gate = Effect.runSync(Deferred.make<void>())
      const submitted = tab.runtime.runPromise(submitCommand(draft).pipe(
        Effect.provideService(FlowDispatch, FlowDispatch.of({ dispatch: ((_name, _payload, options) => Effect.gen(function* () {
          yield* Deferred.await(gate)
          const started = outcome === "admitted" ? Exit.void : Exit.fail(new DispatchFailed({ flow: "conversation/new", reason: "refused" }))
          if (options.admitted !== undefined) yield* Deferred.done(options.admitted, started)
          if (Exit.isFailure(started)) return yield* Effect.failCause(started.cause)
          return yield* Effect.never
        })) as FlowDispatch["Service"]["dispatch"] })),
      ))
      await tab.actions.type(`newer ${outcome}`)
      Effect.runSync(Deferred.succeed(gate, undefined))
      await submitted
      await tab.runtime.runPromise(Effect.yieldNow)
      expect(tab.draft()).toBe(`newer ${outcome}`)
      expect(tab.menu()?.refusal ?? null).toBeNull()
      tab.actions.type("")
    }
  })

  test("a /new pressed again after its run failed is a new execution, never the failed one joined", async () => {
    const tab = await open({ host: keepingInputs() })
    await ready(tab)
    const executions: Array<string> = []
    const failing = FlowDispatch.of({ dispatch: ((_name, _payload, options) => Effect.gen(function* () {
      executions.push(options.executionId!)
      if (options.admitted !== undefined) yield* Deferred.succeed(options.admitted, undefined)
      return { _tag: "Failed", error: {} }
    })) as FlowDispatch["Service"]["dispatch"] })
    const line = "/new roninjin10/smithers-github-tests again"
    tab.actions.type(line)
    const intents = await tab.runtime.runPromise(Effect.service(WriteIntents))
    await tab.runtime.runPromise(submitCommand(line).pipe(Effect.provideService(FlowDispatch, failing)))
    // The failed run's own answer retires its input; the line stays.
    await vi.waitFor(() => expect(intents.answered.size).toBe(1))
    await vi.waitFor(() => expect(intents.pending()).toEqual([]))
    expect(tab.draft()).toBe(line)
    await tab.runtime.runPromise(submitCommand(line).pipe(Effect.provideService(FlowDispatch, failing)))
    expect(executions).toHaveLength(2)
    expect(new Set(executions).size).toBe(2)
  })

  test("after its start was admitted, the run dying settles it; a refused or lost read of its end keeps its input", async () => {
    const tab = await open({ host: keepingInputs() })
    await ready(tab)
    const intents = await tab.runtime.runPromise(Effect.service(WriteIntents))
    for (const [reason, kept] of [["defect", false], ["refused", true], ["unavailable", true]] as const) {
      const line = `/new roninjin10/smithers-github-tests ended-${reason}`
      tab.actions.type(line)
      await tab.runtime.runPromise(submitCommand(line).pipe(Effect.provideService(FlowDispatch, FlowDispatch.of({
        dispatch: ((_name, _payload, options) => Effect.gen(function* () {
          if (options.admitted !== undefined) yield* Deferred.succeed(options.admitted, undefined)
          return yield* new DispatchFailed({ flow: "conversation/new", reason })
        })) as FlowDispatch["Service"]["dispatch"],
      }))))
      await vi.waitFor(() => expect(intents.pending().some((intent) => intent.payload.branch === `ended-${reason}`)).toBe(kept))
      expect(tab.draft()).toBe(line)
      // Only the run dying says so under the line.
      await vi.waitFor(() => expect(tab.menu()?.refusal ?? null).toBe(reason === "defect" ? "Couldn't make a branch" : null))
      tab.actions.type("")
    }
  })

  test("new conversation outcomes: the engine's refusal is Not sent, a run that fails says so under its line, no reply keeps it", async () => {
    // `/new` is admitted once the engine records its run (decision 0124): the line clears then, and comes back with why
    // if the run fails; the engine refusing to record it keeps the line, Not sent; a start that got no reply proves
    // nothing, so the line stays as it was, staged for the next page open.
    const tab = await open()
    await ready(tab)
    const outcomes = [
      { start: Effect.fail(new DispatchFailed({ flow: "conversation/new", reason: "refused" })), draft: "kept", refusal: "Not sent" },
      { start: Effect.fail(new DispatchFailed({ flow: "conversation/new", reason: "unavailable" })), draft: "kept", refusal: null },
      { start: Effect.void, result: Effect.succeed({ _tag: "Failed" }), draft: "kept", refusal: "Couldn't make a branch" },
      // Admitted, the line stays until the run's own answer says Done (decision 0124).
      { start: Effect.void, result: Effect.succeed({ _tag: "Done", value: {} }), draft: "", refusal: null },
    ] as const
    for (const [index, outcome] of outcomes.entries()) {
      const draft = `/new roninjin10/smithers-github-tests bugbash3-bb2-chat-${index}`
      tab.actions.type(draft)
      await tab.runtime.runPromise(submitCommand(draft).pipe(
        Effect.provideService(FlowDispatch, FlowDispatch.of({ dispatch: ((_name, _payload, options) => Effect.gen(function* () {
          const started = yield* Effect.exit(outcome.start)
          if (options.admitted !== undefined) yield* Deferred.done(options.admitted, started)
          if (Exit.isFailure(started)) return yield* Effect.failCause(started.cause)
          return yield* ("result" in outcome ? outcome.result : Effect.never)
        })) as FlowDispatch["Service"]["dispatch"] })),
      ))
      await tab.runtime.runPromise(Effect.yieldNow)
      await vi.waitFor(() => expect(tab.draft()).toBe(outcome.draft === "kept" ? draft : ""))
      await vi.waitFor(() => expect(tab.menu()?.refusal ?? null).toBe(outcome.refusal))
      tab.actions.type("")
    }
  })

  test("a navigation the router refuses stays in chat with a reason", async () => {
    const server = openTestApp({ answers: false })
    runtimes.push(server)
    const api = await server.runPromise(Effect.service(TestChatApi))
    const host = nodeDevice({ agent: api })
    const tab = await open({ host: { ...host, navigate: () => { throw new Error("Page not found") } } })
    await ready(tab)
    tab.actions.type("/navigate /nope-page")
    tab.actions.submit("/navigate /nope-page")
    await until(() => expect(tab.menu()?.refusal).toBe("Couldn’t open page"), engineWithin)
    expect(tab.draft()).toBe("/navigate /nope-page")
    expect(host.navigated).toEqual([])
    expect(tab.shown()).toEqual([])
  }, engineWithin)

  test("/queue, a plugin's command, runs app/navigate with the payload its manifest fixes, door slash", async () => {
    const tab = await open({ answers: true })
    await ready(tab)
    tab.actions.submit("/queue")
    expect(tab.draft()).toBe("")
    expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: "queue" }))).toBe(1)
    await until(() =>
      expect(tab.count(Metric.withAttributes(dispatches, { flow: "app/navigate", door: "slash", outcome: "done" }))).toBe(1)
    )
    expect(tab.shown()).toEqual([])
  }, 60_000)

  test.each(["/issue nonrepo title", "/clone nope", "/new invalid", "/comment invalid 1 words"])(
    "%s retains its malformed repository with a visible refusal", async (line) => {
      const tab = await open()
      tab.actions.type(line)
      tab.actions.submit(line)
      expect(tab.draft()).toBe(line)
      expect(tab.menu()?.refusal).toContain("owner/name")
      expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: line.split(" ")[0]!.slice(1) }))).toBe(0)
    }, engineWithin,
  )

  test("/web keeps a refused URL in the composer without dispatching", async () => {
    const tab = await open()
    tab.actions.type("/web javascript:alert(1)")
    tab.actions.submit("/web javascript:alert(1)")
    expect(tab.draft()).toBe("/web javascript:alert(1)")
    expect(tab.menu()?.refusal).toBe(CANT_OPEN.scheme)
    expect(await tab.answered("web.preview")).toEqual([])
  })

  test("/web runs app/web/open through its own door, the person's gesture, door slash", async () => {
    const tab = await open()
    await ready(tab)
    tab.actions.type("/web https://example.com")
    tab.actions.submit("/web https://example.com")
    expect(tab.draft()).toBe("")
    expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: "web" }))).toBe(1)
    await until(() =>
      expect(
        ["done", "failed", "error"].reduce(
          (sum, outcome) =>
            sum + tab.count(Metric.withAttributes(dispatches, { flow: "app/web/open", door: "slash", outcome })),
          0,
        ),
      ).toBe(1), engineWithin)
    // No question: the line went to the flow, never to the agent.
    expect(tab.shown().filter((row) => row.startsWith("user"))).toEqual([])
  }, 60_000)

  test("/ls runs sandbox/list through dispatch, door slash, on the conversation this tab shows", async () => {
    const tab = await open()
    await ready(tab)
    // A branch's conversation ChatApi doesn't know: the call reaches ChatApi there, and is refused not_found.
    await tab.showConversation(crypto.randomUUID())
    tab.actions.submit("/ls")
    expect(tab.draft()).toBe("")
    expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: "ls" }))).toBe(1)
    await until(() => expect(tab.count(Metric.withAttributes(dispatches, { flow: "sandbox/list", door: "slash", outcome: "failed" }))).toBe(1), engineWithin)
    expect(await tab.answered("sandbox.call")).toEqual(["not_found"])
    expect(tab.shown().filter((row) => row.startsWith("user"))).toEqual([])
  }, 60_000)

  test("/publish and /branch.update run their flows through dispatch, door slash, on the branch this tab shows", async () => {
    const tab = await open()
    await ready(tab)
    // Home shows no branch: nothing is pinned, so each dispatch is refused for its missing branch, never sent to the agent.
    tab.actions.submit("/publish Add a line")
    tab.actions.submit("/branch.update")
    expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: "publish" }))).toBe(1)
    expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: "branch.update" }))).toBe(1)
    await until(() => {
      for (const flow of ["branch/publish", "branch/update"]) {
        expect(["done", "failed", "error"].reduce((sum, outcome) =>
          sum + tab.count(Metric.withAttributes(dispatches, { flow, door: "slash", outcome })), 0)).toBe(1)
      }
    }, engineWithin)
    expect(tab.shown().filter((row) => row.startsWith("user"))).toEqual([])
  }, 60_000)

  test("Enter on a value that completes the command runs it", async () => {
    const tab = await open({ answers: true })
    await ready(tab)
    tab.actions.type("/theme ")
    tab.actions.choose(1, "accept")
    expect(tab.draft()).toBe("")
    await until(async () => expect(await tab.theme()).toBe("dark"), engineWithin)
    expect(tab.count(Metric.withAttributes(choices, { kind: "values", how: "accept" }))).toBe(1)
  }, 60_000)

  test("a line naming no command stays in the composer, says so, and never reaches the agent", async () => {
    const tab = await open()
    await ready(tab)
    tab.actions.type("/nope now")
    tab.actions.submit("/nope now")
    expect(tab.draft()).toBe("/nope now")
    expect(tab.menu()).toMatchObject({ items: [], refusal: "/nope isn't a command" })
    expect(tab.count(Metric.withAttributes(submits, { outcome: "unknown" }))).toBe(1)
    expect(tab.shown()).toEqual([])
    // Typing clears the line.
    tab.actions.type("/nope no")
    expect(tab.menu()?.refusal).toBeNull()
  })

  test("a missing argument says which, and lists the command again; a value that isn't an option names the options", async () => {
    const tab = await open()
    await ready(tab)
    tab.actions.type("/theme")
    tab.actions.submit("/theme")
    expect(tab.draft()).toBe("/theme")
    expect(tab.menu()).toMatchObject({ refusal: "/theme needs mode", items: [{ label: "/theme" }] })
    tab.actions.type("/theme blue ")
    tab.actions.submit("/theme blue")
    expect(tab.draft()).toBe("/theme blue ")
    expect(tab.menu()).toMatchObject({ refusal: "/theme takes light or dark", items: [] })
    expect(tab.count(Metric.withAttributes(submits, { outcome: "missing", command: "theme" }))).toBe(1)
    expect(tab.count(Metric.withAttributes(submits, { outcome: "invalid", command: "theme" }))).toBe(1)
  })

  test("anything else asks Smithers, and a blank line does nothing", async () => {
    const tab = await open()
    await ready(tab)
    tab.actions.submit("")
    expect(tab.draft()).toBe("/")
    tab.actions.type("What is /etc/hosts?")
    await tab.actions.submit("What is /etc/hosts?")
    expect(tab.draft()).toBe("")
    expect(tab.shown()).toEqual(["user What is /etc/hosts?"])
    expect(tab.count(submits)).toBe(0)
  })

  test("roles: signed out lists only what anyone may run, and a command above the role is unknown", async () => {
    const tab = await open({}, null)
    await ready(tab, { signedIn: false, role: null })
    const above = COMMANDS.filter(({ minimum }) => minimum !== "anyone")
    for (const { name } of above) {
      expect(tab.labels()).not.toContain(`/${name}`)
      tab.actions.type(`/${name} x`)
      tab.actions.submit(`/${name} x`)
      expect(tab.menu()?.refusal).toBe(`/${name} isn't a command`)
    }
    tab.actions.type("/theme light")
    tab.actions.submit("/theme light")
    expect(tab.draft()).toBe("")
  })

  test("roles: a Guest lists only what anyone may run, and a member-only command typed in full is unknown", async () => {
    const tab = await open({}, person("guest"))
    await ready(tab, { signedIn: true, role: "guest" })
    const membersOnly = COMMANDS.filter(({ minimum }) => minimum === "member")
    expect(membersOnly.length).toBeGreaterThan(0)
    for (const { name } of membersOnly) {
      expect(tab.labels()).not.toContain(`/${name}`)
      tab.actions.type(`/${name}`)
      expect(tab.labels()).not.toContain(`/${name}`)
      tab.actions.submit(`/${name} https://example.com`)
      expect(tab.menu()?.refusal).toBe(`/${name} isn't a command`)
    }
    expect(tab.count(Metric.withAttributes(submits, { outcome: "unknown" }))).toBe(membersOnly.length)
  })

  test("roles: an Admin lists every command", async () => {
    const tab = await open({}, person("admin"))
    await ready(tab, { signedIn: true, role: "admin" })
    expect(tab.labels()).toEqual([...COMMANDS, ...PLUGIN_COMMANDS].map(({ name }) => `/${name}`))
  })
})

// Production bug bash: omitted context must never pick a repository silently.
test("/new asks for its repository before dispatch and exposes it in the command", () => {
  expect(slashSubmit("/new", COMMANDS)).toMatchObject({ kind: "missing", fields: ["repo"] })
  expect(slashSubmit("/new roninjin10/smithers-github-tests topic", COMMANDS)).toMatchObject({
    kind: "run", payload: { repo: "roninjin10/smithers-github-tests", branch: "topic" },
  })
  expect(slashMenu("/new", COMMANDS).items[0]?.runs).toBe(false)
})


test("slash descriptions fit a menu row and /n offers /new first", () => {
  for (const command of COMMANDS) expect(command.description.length).toBeLessThanOrEqual(40)
  expect(slashMenu("/n", COMMANDS).items.slice(0, 2).map(item => item.label)).toEqual(["/new", "/navigate"])
})


for (const keyboard of [false, true]) test(`an exact command wins on Enter; pointer choice stays explicit (${keyboard})`, async () => {
  const tab = await open({ answers: true })
  await ready(tab)
  tab.actions.type("/bug")
  expect(tab.labels()).toEqual(["/bug", "/bugs"])
  // A displaced highlight used to turn /bug into another command despite the exact typed name.
  tab.actions.highlight(1)
  tab.actions.choose(1, "accept", keyboard)
  expect(tab.count(Metric.withAttributes(submits, { outcome: "run", command: keyboard ? "bug" : "bugs" }))).toBe(1)
  expect(tab.draft()).toBe("")
  await until(() => expect(tab.count(Metric.withAttributes(dispatches, { flow: "app/navigate", door: "slash", outcome: "done" }))).toBe(1))
})

test("keyboard selection ranks command prefixes over description matches without changing argument completion", async () => {
  const tab = await open()
  await ready(tab)
  tab.actions.type("/n")
  const description = tab.menu()!.items.findIndex(item => !item.label.startsWith("/n"))
  expect(description).toBeGreaterThan(0)
  tab.actions.choose(description, "complete", true)
  expect(tab.draft()).toBe("/new ")
  tab.actions.type("/dark")
  tab.actions.choose(0, "complete", true)
  expect(tab.draft()).toBe("/theme ")
  tab.actions.type("/theme ")
  tab.actions.choose(0, "complete", true)
  expect(tab.draft()).toBe("/theme light")
  tab.actions.type("/unknown-no-match")
  tab.actions.choose(0, "accept", true)
  expect(tab.draft()).toBe("/unknown-no-match")
})


test("command-choice records explain keyboard matching without retaining the typed line", async () => {
  const tab = await open({ answers: true })
  await ready(tab)
  tab.actions.type("/bug")
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  await tab.runtime.runPromise(chooseCommand(1, "accept", true).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(entry => void logs.push(Logger.formatStructured.log(entry)))])),
  ))
  expect(logs).toContainEqual(expect.objectContaining({
    message: "slash.choose", level: "INFO",
    annotations: expect.objectContaining({ feature: "commands", kind: "commands", how: "accept", via: "keyboard", match: "exact", index: 1 }),
  }))
  expect(JSON.stringify(logs)).not.toContain("/bug")
  await until(() => expect(tab.count(Metric.withAttributes(dispatches, { flow: "app/navigate", door: "slash", outcome: "done" }))).toBe(1))
})


describe("repository slash authority (AUTH-8)", () => {
  test("the conversation's repository Member gets sandbox commands despite no deployment role", async () => {
    const tab = await open({}, person(null))
    const branches = await tab.runtime.runPromise(Effect.service(BranchStore))
    const repos = await tab.runtime.runPromise(Effect.service(RepoStore))
    await tab.runtime.runPromise(repos.roles.insert({ id: repoId("my", "repo"), role: "member", own: false }))
    await tab.runtime.runPromise(branches.current.update(CURRENT, row => void Object.assign(row, {
      owner: "my", repo: "repo", conversationId: "own-repo-conversation", status: "ready", access: "owner",
    })))
    await tab.showConversation("own-repo-conversation")
    await tab.actions.type("/status")
    expect(tab.menu()?.items.map(item => item.label)).toContain("/status")
    await tab.actions.type("/read")
    expect(tab.menu()?.refusal).toBeNull()
    expect(tab.menu()?.kind).not.toBe("unknown")
    // Returning to home restores deployment authority.
    await tab.runtime.runPromise(Effect.service(ChatStore).pipe(Effect.flatMap(store => store.place.update(PLACE, row => { row.conversationId = null }))))
    await tab.actions.type("/status")
    expect(tab.menu()?.items).toEqual([])
  })

  test("a deployment Admin never carries commands onto a Guest, unanswered or failed repository", async () => {
    const tab = await open({}, person("admin"))
    const branches = await tab.runtime.runPromise(Effect.service(BranchStore))
    const repos = await tab.runtime.runPromise(Effect.service(RepoStore))
    await tab.runtime.runPromise(branches.current.update(CURRENT, row => void Object.assign(row, {
      owner: "other", repo: "repo", conversationId: "guest-conversation", status: "ready", access: "view",
    })))
    await tab.showConversation("guest-conversation")
    await tab.actions.type("/status")
    expect(tab.menu()?.items).toEqual([])
    await tab.runtime.runPromise(repos.roles.insert({ id: repoId("other", "repo"), role: "guest", own: false }))
    await tab.actions.submit("/status")
    expect(tab.menu()?.refusal).toBe("/status isn't a command")
    await tab.runtime.runPromise(repos.roles.update(repoId("other", "repo"), row => { row.role = "admin"; row.failure = "unavailable" }))
    await tab.actions.type("/status")
    expect(tab.menu()?.items).toEqual([])
    await tab.runtime.runPromise(repos.roles.update(repoId("other", "repo"), row => { row.role = null; delete row.failure }))
    await tab.actions.type("/status")
    expect(tab.menu()?.items).toEqual([])
    await tab.runtime.runPromise(branches.current.update(CURRENT, row => { row.conversationId = "stale-conversation" }))
    await tab.actions.type("/status")
    expect(tab.menu()?.items).toEqual([])
    await tab.runtime.runPromise(branches.current.update(CURRENT, row => { row.status = "tracking" }))
    await tab.actions.type("/status")
    expect(tab.menu()?.items).toEqual([])
  })

  test("signed out never inherits a repository role left on the device", async () => {
    const tab = await open({}, null)
    const branches = await tab.runtime.runPromise(Effect.service(BranchStore))
    const repos = await tab.runtime.runPromise(Effect.service(RepoStore))
    await tab.runtime.runPromise(repos.roles.insert({ id: repoId("other", "repo"), role: "admin", own: false }))
    await tab.runtime.runPromise(branches.current.update(CURRENT, row => void Object.assign(row, {
      owner: "other", repo: "repo", conversationId: "prior-conversation", status: "ready", access: "owner",
    })))
    await tab.showConversation("prior-conversation")
    await tab.actions.type("/status")
    expect(tab.menu()?.items).toEqual([])
  })
})


test("slash commands use the effective role on an uninstalled repository copy without granting GitHub authority", async () => {
  const tab = await open({}, person("member"))
  const branches = await tab.runtime.runPromise(Effect.service(BranchStore))
  const repos = await tab.runtime.runPromise(Effect.service(RepoStore))
  await tab.runtime.runPromise(repos.roles.insert({ id: repoId("public", "copy"), role: null, workspaceRole: "member", own: false }))
  await tab.runtime.runPromise(branches.current.update(CURRENT, row => void Object.assign(row, {
    owner: "public", repo: "copy", conversationId: "copied-conversation", status: "ready", access: "owner",
  })))
  await tab.showConversation("copied-conversation")
  await tab.actions.type("/status")
  expect(tab.menu()?.items.map(item => item.label)).toContain("/status")
  await tab.runtime.runPromise(repos.roles.update(repoId("public", "copy"), row => { row.workspaceRole = null }))
  await tab.actions.type("/status")
  expect(tab.menu()?.items).toEqual([])
})
