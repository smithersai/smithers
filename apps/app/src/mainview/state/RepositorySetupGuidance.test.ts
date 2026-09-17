import { expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import { TURN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import { agentVisibleCatalog } from "../flows/agentTools"
import { disclosedEntries } from "../chain/FlowCatalog"
import { createAgentSeat } from "../chain/ChainRuntime"
import { createWebAgent } from "../native/WebAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { CHAT_INSTRUCTIONS_CAP_BYTES, INSTRUCTIONS_HEADROOM_BYTES, instructionStageOf } from "./Instructions"
import { memoryStorage, recordingAgent, unavailableRepositories, waitFor } from "./TestFixtures"

const id = "setup:maintainer:example%2Frepo:issues"
const setupNames = ["setup.guide", "setup.configure", "setup.view", "setup.work", "setup.run", "setup.retry"]

async function fixture(agent?: (requests: StartAgentTurnRequest[]) => AgentPort) {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const payload = { ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1234 }
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(), payload
  } }).isPersisted.promise
  const requests: StartAgentTurnRequest[] = [], fetches: { url: string; method: string }[] = []
  const controller = createAppController(store, unavailableRepositories, agent?.(requests) ?? recordingAgent(requests), {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const url = String(input), method = init?.method ?? "GET"
      fetches.push({ url, method })
      if (url.includes("/repository-setup/state?")) return Response.json({
        owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" }
      })
      return Response.json({}, { status: 404 })
    }
  })
  await waitFor(() => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" && card.payload.recovery?.state === "completed" })
  const call = (input: unknown) => controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify(input) })
  const close = async () => { await controller.dispose(); await store.dispose?.() }
  return { store, payload, controller, requests, fetches, call, close }
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
    expect(t.controller.commands.callable().some(command => command.declaredName === "target.list")).toBe(false)
    const read = JSON.parse(await t.call({ action: "execute", name: "setup.guide", args: id }))
    expect(read).toMatchObject({ cardId: id, repo: "example/repo", job: "issues", revision: 1, inspectedAt: 1234, draft: t.payload.draft })
    expect(t.requests).toHaveLength(0)
    expect(t.fetches.some(({ url, method }) => url.includes("/repository-setup") && method !== "GET")).toBe(false)
  } finally { await t.close() }
})

test("the production HTTP seat reads the exact guide through a committed tool leg before a scripted first question", async () => {
  const t = await fixture(requests => createAgentSeat(createWebAgent({ fetchImpl: async (url, init) => {
    expect(String(url)).toBe(TURN_PATH)
    const request = JSON.parse(String(init?.body)) as StartAgentTurnRequest
    requests.push(request)
    const journal = request.journal!
    const cursor = { version: 1 as const, runId: request.runId, legId: journal.legId, batch: 0, position: 0, hash: "0".repeat(64) }
    const output = request.messages.find(item => "type" in item && item.type === "function_call_output")
    const frames: AgentTurnFrame[] = output === undefined ? [
      { type: "tool_call", runId: request.runId, name: "commands", call_id: "read-current-setup", arguments: JSON.stringify({ action: "execute", name: "setup.guide", args: id }) },
      { type: "done", runId: request.runId, reason: "tool_call" }
    ] : [
      { type: "delta", runId: request.runId, kind: "text", text: "Should research run automatically on new issues?" },
      { type: "done", runId: request.runId, reason: "stop" }
    ]
    if (output && "output" in output) expect(JSON.parse(output.output)).toMatchObject({ cardId: id, repo: "example/repo", revision: 1, inspectedAt: 1234 })
    expect(request.instructions).toContain("Current repository setup cards:")
    const body = { version: 1 as const, runId: request.runId, legId: journal.legId, batch: 1, from: 1, previousHash: cursor.hash, frames }
    const batch = { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
    return new Response([JSON.stringify({ type: "accepted", cursor }), JSON.stringify({ type: "batch", batch,
      cursor: { ...cursor, batch: 1, position: frames.length, hash: batch.hash } })].join("\n"), {
      headers: { "x-smithers-turn-journal": "1", "content-type": "application/x-ndjson" }
    })
  } })))
  try {
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => t.requests.length === 2 && t.store.session().phase === "idle")
    expect([...t.store.collections.toolCalls.values()].map(call => JSON.parse(call.arguments).name)).toEqual(["setup.guide"])
    expect([...t.store.collections.httpTurns.values()][0]?.status).toBe("complete")
    expect(t.store.collections.cards.get(id)).toMatchObject({ kind: "repository-setup", payload: t.payload })
    expect(t.fetches.some(({ url, method }) => url.includes("/repository-setup") && method !== "GET")).toBe(false)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

test("the normal guide kickoff carries fresh owned setup identity and a callable read under the instruction cap", async () => {
  const t = await fixture()
  try {
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => t.requests.length > 0)
    const request = t.requests[0]!
    expect(JSON.stringify(request.messages)).toContain(`Read setup.guide for card ${id}`)
    expect(request.instructions).toContain("Current repository setup cards:")
    expect(request.instructions).toContain(JSON.stringify({ cardId: id, repo: "example/repo", job: "issues", revision: 1, digest: setupCandidate(t.payload), inspectedAt: 1234, state: "draft" }))
    expect(request.instructions).toContain('"name":"setup.guide","args":"<cardId>"')
    for (const control of setupNames) {
      const command = agentVisibleCatalog(t.controller.commands.callable()).find(command => command.name === control)!
      expect(request.instructions).toContain(`- /${control} ${command.args} — ${command.summary}`)
    }
    expect(request.instructions).toContain("one short question at a time")
    expect(new TextEncoder().encode(composeAgentInstructions(request.instructions, request.context)).length).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    console.info(`setup guide instructions: stage ${instructionStageOf(request.instructions)}, ${new TextEncoder().encode(composeAgentInstructions(request.instructions, request.context)).length} composed bytes`)
    expect(t.store.collections.cards.get(id)).toMatchObject({ kind: "repository-setup", payload: t.payload })
    expect(t.fetches.some(({ url, method }) => url.includes("/repository-setup") && method !== "GET")).toBe(false)
  } finally { await t.close() }
})

test("an explicitly guided older card survives recent-card compaction without injecting full prompts or eval answers", async () => {
  const t = await fixture()
  try {
    const marker = "DO-NOT-INJECT-FULL-DRAFT-OR-HELDOUT-ANSWER"
    await t.controller.configureRepositorySetup(id, "step.research.prompt", marker.repeat(100))
    for (let index = 0; index < 15; index++) {
      await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: `recent-file-${index}`, kind: "file", title: `File ${index}`, status: "active", createdAt: 2, ordinal: t.store.nextOrdinal(),
        payload: { repo: "example/repo", path: `file-${index}.md`, content: "Source", truncated: false }
      } }).isPersisted.promise
    }
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => t.requests.length > 0)
    const request = t.requests[0]!
    expect(request.context?.recentCards?.some(card => card.id === id)).toBe(false)
    expect(request.instructions).toContain(`"cardId":"${id}"`)
    expect(request.instructions).toContain('"revision":2')
    expect(request.instructions).not.toContain(marker)
    expect(new TextEncoder().encode(composeAgentInstructions(request.instructions, request.context)).length).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
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
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => t.requests.length > 0)
    const line = t.requests[0]!.instructions.split("\n").find(line => line.startsWith("Current repository setup cards:"))!
    const cards = JSON.parse(line.slice("Current repository setup cards: ".length))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ cardId: id, revision: 2, digest: setupCandidate(t.store.collections.cards.get(id)!.payload as typeof t.payload) })
    expect(line).not.toContain("other/private")
    expect(await t.call({ action: "execute", name: "setup.guide", args: "foreign-setup" })).toContain("different account")
  } finally { await t.close() }
})
