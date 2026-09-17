import { expect, test } from "bun:test"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import { agentVisibleCatalog } from "../flows/agentTools"
import { disclosedEntries } from "../chain/FlowCatalog"
import type { StorageApi } from "@tanstack/db"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"
import type { AgentPort } from "../runtime/AgentPort"
import { setupQuestionCardId } from "./controller/repositorySetup"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { CHAT_INSTRUCTIONS_CAP_BYTES, INSTRUCTIONS_HEADROOM_BYTES, instructionStageOf } from "./Instructions"
import { memoryStorage, recordingAgent, unavailableRepositories, waitFor } from "./TestFixtures"

const id = "setup:maintainer:example%2Frepo:issues"
const setupNames = ["setup.guide", "setup.configure", "setup.view", "setup.work", "setup.run", "setup.retry"]
const QUESTION = "Keep issue research, duplicate lookup and bug reproduction automatic?"
const CHOICES = ["Keep them automatic", "Ask me before each one runs", "Turn them off"]

const pendingHttpAgent = (requests: StartAgentTurnRequest[]): AgentPort => ({
  available: true, startTurn: async request => { requests.push(request); return { status: "started" } },
  cancelTurn: async () => {}, subscribe: () => () => {},
  journal: { subscribe: () => () => {}, disconnect: () => {}, retire: async () => {}, read: async () => ({ status: "error", code: "storage_failed" }) }
})

async function fixture(agent?: (requests: StartAgentTurnRequest[]) => AgentPort, beforeRecovery?: Promise<void>, settleRecovery = true, storage: StorageApi = memoryStorage()) {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const payload = { ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1234 }
  if (!store.collections.cards.has(id)) await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(), payload
  } }).isPersisted.promise
  const requests: StartAgentTurnRequest[] = [], fetches: { url: string; method: string }[] = []
  const controller = createAppController(store, unavailableRepositories, agent?.(requests) ?? recordingAgent(requests), {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const url = String(input), method = init?.method ?? "GET"
      fetches.push({ url, method })
      if (url.includes("/repository-setup/state?")) {
        if (beforeRecovery) await beforeRecovery
        return Response.json({ owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" } })
      }
      return Response.json({}, { status: 404 })
    }
  })
  if (settleRecovery) await waitFor(() => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" && card.payload.recovery?.state === "completed" })
  const call = (input: unknown) => controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify(input) })
  const close = async () => { await controller.dispose(); await store.dispose?.() }
  const guidance = () => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" ? card.payload.guidance : undefined }
  const setup = () => { const card = store.collections.cards.get(id)!; return card.kind === "repository-setup" ? card.payload : undefined! }
  const question = () => { const card = store.collections.cards.get(setupQuestionCardId(id)); return card?.kind === "flow-form" ? card : undefined }
  const untouched = () => !fetches.some(({ url, method }) => url.includes("/repository-setup") && method !== "GET")
  return { store, storage, payload, controller, requests, fetches, call, close, guidance, setup, question, untouched }
}

const askAndWait = async (t: Awaited<ReturnType<typeof fixture>>) => {
  await t.controller.commands.run("setup.guide", id)
  await waitFor(() => t.question() !== undefined && t.guidance()?.state === "admitted")
  return t.question()!
}

test("cloud setup controls are discoverable to the model and stay out of the human menu", async () => {
  const t = await fixture()
  try {
    const listed = JSON.parse(await t.call({ action: "list", namespace: "setup" }))
    const controls = listed.commands.filter((command: { name: string }) => command.name.startsWith("setup."))
    const names = controls.map((command: { name: string }) => command.name)
    expect(names).toEqual(setupNames)
    expect(controls.every((command: { args?: string }) => typeof command.args === "string")).toBe(true)
    expect(agentVisibleCatalog(t.controller.commands.callable()).filter(command => command.name.startsWith("setup.")).map(command => command.name)).toEqual(setupNames)
    expect(t.controller.commands.disclosed().filter(command => command.name.startsWith("setup.")).map(command => command.name)).toEqual(setupNames)
    expect(disclosedEntries(t.controller.commands).filter(command => command.name.startsWith("setup.")).map(command => command.name)).toEqual(setupNames)
    expect(t.controller.commands.slashItems("setup.").some(item => setupNames.includes(item.flow.name))).toBe(false)
    // The question flow is the app's own act: invocable so the controller can
    // render the form, never offered to the model or to the slash menu.
    expect(t.controller.commands.callable().some(command => command.binding.descriptor.name === "setup.ask")).toBe(true)
    expect(t.controller.commands.slashItems("setup.ask")).toHaveLength(0)
    expect(JSON.stringify(listed)).not.toContain("setup.ask")
    const read = JSON.parse(await t.call({ action: "execute", name: "setup.guide", args: id }))
    expect(read).toMatchObject({ cardId: id, repo: "example/repo", job: "issues", revision: 1, inspectedAt: 1234, draft: t.payload.draft })
    expect(read.controls).toContainEqual(expect.objectContaining({ kind: "issue-filter", scopeField: "scope", labelField: "label", labelMeaning: "match-existing-label" }))
    expect(read.instruction).toContain("The app asks this setup's first question itself")
    // A model reading the guide never mints an unsolicited first-question intent.
    expect(t.guidance()).toBeUndefined()
    expect(t.question()).toBeUndefined()
    expect(t.requests).toHaveLength(0)
    expect(t.untouched()).toBe(true)
  } finally { await t.close() }
})

test.each(["ready", "recovering", "immediate"])("the app itself asks the first question while %s, with no provider turn", async phase => {
  let release!: () => void
  const beforeRecovery = new Promise<void>(resolve => { release = resolve })
  const t = await fixture(pendingHttpAgent, phase === "recovering" ? beforeRecovery : undefined, phase === "ready")
  try {
    if (phase === "recovering") await waitFor(() => t.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
    const outcome = await t.controller.commands.run("setup.guide", id)
    expect(outcome.status).not.toBe("failed")
    if (phase === "recovering") {
      expect(t.question()).toBeUndefined()
      const requested = t.guidance()
      await t.controller.commands.run("setup.guide", id)
      expect(t.guidance()).toEqual(requested)
    }
    release()
    await waitFor(() => t.question() !== undefined && t.guidance()?.state === "admitted")
    const card = t.question()!
    expect(card.title).toBe(QUESTION)
    expect(card.payload.flow).toBe("setup.ask")
    expect(card.payload.via).toBe("agent")
    expect(card.payload.fields.map(field => field.name)).toEqual(["choice"])
    expect(card.payload.fields[0]?.kind).toBe("select")
    expect(card.payload.fields[0]?.options?.map(option => option.label)).toEqual(CHOICES)
    // The answer is bound to the exact candidate it was asked about.
    expect(card.payload.given).toMatchObject({ cardId: id, questionId: "issues.steps.automatic", revision: 1, digest: setupCandidate(t.setup()) })
    expect(t.requests).toHaveLength(0)
    expect(t.store.collections.messages.size).toBe(0)
    expect([...t.store.collections.httpTurns.values()]).toHaveLength(0)
    expect(t.setup().draft).toEqual(t.payload.draft)
    expect(t.untouched()).toBe(true)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { release(); await t.close() }
})

test("answering through the real form controller edits the draft only", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    expect(await t.controller.commands.run("form.set", `${card.id} choice approved`)).toMatchObject({ status: "executed" })
    expect(t.question()?.payload.draft).toEqual({ choice: "approved" })
    expect(await t.controller.commands.run("form.submit", card.id)).toMatchObject({ status: "executed" })
    await waitFor(() => t.question()?.status === "acted")
    const draft = t.setup().draft
    expect(draft.steps.map(step => step.mode)).toEqual(["approved", "approved", "approved", "manual", "manual", "manual"])
    expect(draft.label).toBe("")
    expect(draft.scope).toBe("future")
    expect(t.setup().request).toBeUndefined()
    expect(t.setup().evaluation).toBeUndefined()
    expect(t.setup().trial).toBeUndefined()
    expect(t.setup().active).toBeUndefined()
    expect(t.requests).toHaveLength(0)
    expect(t.untouched()).toBe(true)
    // A submitted question is closed: no second answer, and no re-ask.
    expect(await t.controller.commands.run("form.submit", card.id)).toMatchObject({ status: "failed", error: expect.stringContaining("already submitted") })
    expect(await t.controller.commands.run("form.set", `${card.id} choice off`)).toMatchObject({ status: "failed" })
    expect(t.question()?.status).toBe("acted")
    expect(t.setup().draft).toEqual(draft)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

test("a stale candidate refuses visibly in the card and edits nothing", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    await t.call({ action: "execute", name: "setup.configure", args: JSON.stringify({ cardId: id, field: "budgetMinutes", value: 45 }) })
    const before = structuredClone(t.setup().draft)
    await t.controller.commands.run("form.set", `${card.id} choice off`)
    await t.controller.commands.run("form.submit", card.id)
    await waitFor(() => t.question()?.payload.error !== undefined)
    expect(t.question()?.payload.error).toContain("changed after the question was asked")
    expect(t.question()?.status).toBe("error")
    expect(t.setup().draft).toEqual(before)
  } finally { await t.close() }
})

test("a second Configure in Chat points at the open question instead of resetting it", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    const intent = t.guidance()!
    await t.controller.commands.run("form.set", `${card.id} choice off`)
    await t.controller.commands.run("setup.guide", id)
    await t.store.settled?.()
    expect(t.guidance()).toEqual(intent)
    expect(t.question()?.payload.draft).toEqual({ choice: "off" })
    expect([...t.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
    expect(t.requests).toHaveLength(0)
  } finally { await t.close() }
})

test("a reload during admission re-admits the same question without re-rendering it", async () => {
  const storage = memoryStorage()
  const first = await fixture(pendingHttpAgent, undefined, true, storage)
  const card = await askAndWait(first)
  await first.controller.commands.run("form.set", `${card.id} choice off`)
  const intent = first.guidance()!
  // Reopen from the same disk with guidance still unacknowledged.
  const stored = first.store.collections.cards.get(id)!
  if (stored.kind !== "repository-setup") throw Error("setup card missing")
  await first.store.dispatch({ type: "card.upsert", actor: "system",
    card: { ...stored, payload: { ...stored.payload, guidance: { id: intent.id, state: "requested" } } } }).isPersisted.promise
  await first.close()
  const resumed = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    await waitFor(() => resumed.guidance()?.state === "admitted")
    expect(resumed.guidance()?.id).toBe(intent.id)
    expect(resumed.question()?.payload.draft).toEqual({ choice: "off" })
    expect(resumed.question()?.title).toBe(QUESTION)
    expect(resumed.requests).toHaveLength(0)
    expect((await resumed.store.verifyState()).valid).toBe(true)
  } finally { await resumed.close() }
})

test("a reload after the answer never re-asks and keeps the edit", async () => {
  const storage = memoryStorage()
  const first = await fixture(pendingHttpAgent, undefined, true, storage)
  const card = await askAndWait(first)
  await first.controller.commands.run("form.set", `${card.id} choice approved`)
  await first.controller.commands.run("form.submit", card.id)
  await waitFor(() => first.question()?.status === "acted")
  await first.close()
  const resumed = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    await resumed.store.settled?.()
    await resumed.store.dispatch({ type: "composer.changed", actor: "user", draft: "still usable" }).isPersisted.promise
    expect(resumed.guidance()?.state).toBe("admitted")
    expect(resumed.question()?.status).toBe("acted")
    expect(resumed.setup().draft.steps.slice(0, 3).map(step => step.mode)).toEqual(["approved", "approved", "approved"])
    expect(resumed.requests).toHaveLength(0)
    expect(resumed.store.session().draft).toBe("still usable")
  } finally { await resumed.close() }
})

test("a saved guide request survives a held recovery and full store/controller reopen", async () => {
  const storage = memoryStorage()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = await fixture(pendingHttpAgent, held, false, storage)
  await waitFor(() => first.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
  await first.controller.commands.run("setup.guide", id)
  const requested = first.guidance()!
  expect(requested.state).toBe("requested")
  expect(first.question()).toBeUndefined()
  await first.close(); release()
  const resumed = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    await waitFor(() => resumed.guidance()?.state === "admitted")
    expect(resumed.guidance()?.id).toBe(requested.id)
    expect(resumed.question()?.title).toBe(QUESTION)
    expect(resumed.requests).toHaveLength(0)
    expect((await resumed.store.verifyState()).valid).toBe(true)
  } finally { await resumed.close() }
})

test.each([1, 2])("the question is never asked twice after %s failed card writes", async failures => {
  const disk = memoryStorage()
  let remaining = 0, rejected = 0
  const storage: StorageApi = { ...disk, setItem: (key, value) => {
    if (key === ENVELOPE_STORAGE_KEY && remaining > 0) {
      const rows = JSON.parse(parseStorageEnvelope(value)!.entries["smithers-mvp.app-cards"] ?? "{}")
      if (rows[`s:${setupQuestionCardId(id)}`] !== undefined) { remaining--; rejected++; throw Error("Question card disk failure") }
    }
    disk.setItem(key, value)
  } }
  const t = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    remaining = failures
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => failures === 1
      ? t.question() !== undefined && t.guidance()?.state === "admitted"
      : t.guidance()?.state === "failed")
    await t.store.settled?.()
    expect(rejected).toBe(failures)
    // The chat never wedges on a failed question write.
    await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat remains editable" }).isPersisted.promise
    expect(t.store.session().draft).toBe("Chat remains editable")
    expect([...t.store.collections.cards.values()].filter(card => card.kind === "flow-form")).toHaveLength(failures === 1 ? 1 : 0)
    expect(t.requests).toHaveLength(0)
    if (failures === 2) {
      expect(t.guidance()?.error).toContain("could not be saved")
      await waitFor(() => [...t.store.collections.toasts.values()].some(toast => toast.key === "command.failed.setup.guide"))
      await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "" }).isPersisted.promise
      const retried = await t.controller.commands.run("setup.guide", id)
      expect(retried.status).not.toBe("failed")
      await waitFor(() => t.question() !== undefined)
    }
    expect(t.question()?.title).toBe(QUESTION)
    expect([...t.store.collections.cards.values()].filter(card => card.kind === "flow-form")).toHaveLength(1)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

test("an account change while discovery is held cannot render or recreate the prior account's question", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const t = await fixture(pendingHttpAgent, held, false)
  try {
    await waitFor(() => t.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
    await t.controller.commands.run("setup.guide", id)
    const requested = t.guidance()
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    release(); await t.store.settled?.()
    await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Other account question" }).isPersisted.promise
    expect(requested?.state).toBe("requested")
    expect(t.guidance()).toBeUndefined() // The identity boundary retires private cards.
    expect(t.question()).toBeUndefined()
    expect(t.requests).toHaveLength(0)
    expect(t.store.session().draft).toBe("Other account question")
  } finally { release(); await t.close() }
})

test("a controller disposed before the idle window renders no question", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const t = await fixture(pendingHttpAgent, held, false)
  await waitFor(() => t.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
  await t.controller.commands.run("setup.guide", id)
  expect(t.guidance()?.state).toBe("requested")
  await t.controller.dispose()
  release()
  await t.store.settled?.()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(t.question()).toBeUndefined()
  expect(t.requests).toHaveLength(0)
  await t.store.dispose?.()
})

test("a specific change asked in chat stays usable beside the question, and pruned tool history changes nothing", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    // The model's own door still works while the app's question is open.
    expect(await t.call({ action: "execute", name: "setup.configure", args: JSON.stringify({ cardId: id, field: "landing", value: "checks" }) })).toContain("Draft updated")
    expect(t.setup().draft.landing).toBe("checks")
    expect(t.question()?.status).toBe("active")
    /*
     * Whether the question was asked is the durable card and the guidance
     * receipt, never a tool-call row: pruned or absent tool history (there is
     * none here at all) changes nothing.
     */
    expect(t.store.collections.toolCalls.size).toBe(0)
    await t.store.settled?.()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect([...t.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
    expect(t.question()?.id).toBe(card.id)
    expect(t.requests).toHaveLength(0)
    // The user can close the question without answering it; nothing re-opens it.
    expect(await t.controller.commands.run("card.dismiss", card.id)).toMatchObject({ status: "executed" })
    await t.store.settled?.()
    expect(t.question()).toBeUndefined()
    expect(t.guidance()?.state).toBe("admitted")
  } finally { await t.close() }
})

test("the chat prompt keeps the setup handoff, states that the app asks, and stays under the cap", async () => {
  const t = await fixture()
  try {
    await t.controller.send("what is set up for this repo?")
    await waitFor(() => t.requests.length > 0)
    const request = t.requests[0]!
    expect(request.instructions).toContain("Current repository setup cards:")
    expect(request.instructions).toContain(JSON.stringify({ cardId: id, repo: "example/repo", job: "issues", revision: 1, digest: setupCandidate(t.payload), inspectedAt: 1234, state: "draft" }))
    expect(request.instructions).toContain('"name":"setup.guide","args":"<cardId>"')
    for (const control of setupNames) {
      const command = agentVisibleCatalog(t.controller.commands.callable()).find(command => command.name === control)!
      expect(request.instructions).toContain(`- /${control} ${command.args} — ${command.summary}`)
    }
    expect(request.instructions).toContain("The app asks this setup's first question itself")
    expect(request.instructions).not.toContain("one short question at a time")
    expect(request.instructions).not.toContain("setup.ask")
    const composed = new TextEncoder().encode(composeAgentInstructions(request.instructions, request.context)).length
    expect(composed).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    console.info(`setup guide instructions: stage ${instructionStageOf(request.instructions)}, ${composed} composed bytes`)
  } finally { await t.close() }
})

/*
 * The kickoff turn that used to name this card id in the user's own message is
 * gone, so a setup compacted out of the recent window is no longer carried into
 * the prompt by a mention. What must still hold is that nothing injects the
 * draft's full prompts or its held-out eval answers, at any window position.
 */
test("a compacted setup card injects no full prompts or eval answers, and a named one still carries its identity", async () => {
  const t = await fixture()
  try {
    const marker = "DO-NOT-INJECT-FULL-DRAFT-OR-HELDOUT-ANSWER"
    await t.controller.configureRepositorySetup(id, "step.research.prompt", marker.repeat(100))
    for (let index = 0; index < 15; index++) {
      await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: `recent-file-${index}`, kind: "file", title: `File ${index}`, status: "active", createdAt: 2, ordinal: t.store.nextOrdinal(),
        payload: { repo: "example/repo", path: `file-${index}.md`, content: "Source", truncated: false }
      } }).isPersisted.promise
    }
    await t.controller.send("summarize the setup")
    await waitFor(() => t.requests.length > 0)
    const compacted = t.requests[0]!
    expect(compacted.context?.recentCards?.some(card => card.id === id)).toBe(false)
    expect(compacted.instructions).not.toContain(marker)
    expect(new TextEncoder().encode(composeAgentInstructions(compacted.instructions, compacted.context)).length).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    await waitFor(() => t.store.session().phase === "idle")
    await t.controller.send(`what is set up in ${id}?`)
    await waitFor(() => t.requests.length > 1)
    const named = t.requests[1]!
    expect(named.instructions).toContain(`"cardId":"${id}"`)
    expect(named.instructions).toContain('"revision":2')
    expect(named.instructions).not.toContain(marker)
  } finally { await t.close() }
})

test("setup authority refreshes after an edit and never includes another account's card", async () => {
  const t = await fixture()
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: "foreign-setup", kind: "repository-setup", title: "Other setup", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
      payload: { ...initialSetup("other/private", "issues", "other"), inspectedAt: 5 }
    } }).isPersisted.promise
    await t.call({ action: "execute", name: "setup.configure", args: JSON.stringify({ cardId: id, field: "step.research.mode", value: "manual" }) })
    const read = JSON.parse(await t.call({ action: "execute", name: "setup.guide", args: id }))
    expect(read.revision).toBe(2)
    expect(read.draft.steps.find((step: { id: string }) => step.id === "research").mode).toBe("manual")
    await t.controller.send("what changed?")
    await waitFor(() => t.requests.length > 0)
    const line = t.requests[0]!.instructions.split("\n").find(line => line.startsWith("Current repository setup cards:"))!
    const cards = JSON.parse(line.slice("Current repository setup cards: ".length))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ cardId: id, revision: 2, digest: setupCandidate(t.setup()) })
    expect(line).not.toContain("other/private")
    expect(await t.call({ action: "execute", name: "setup.guide", args: "foreign-setup" })).toContain("different account")
  } finally { await t.close() }
})
