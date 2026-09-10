import { Author, Authorize, Catalog, Chain, Journal, ScriptRunner } from "@smthrs/chain"
import type { Event } from "@smthrs/chain"
import { CardSchema } from "@smthrs/rpc/Cards"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { commandEntries } from "../chain/FlowCatalog"
import { createChainPolicy } from "../chain/Policy"
import { createFormsController } from "../state/controller/forms"
import type { ControllerContext } from "../state/controller/context"
import type { Card } from "../state/AppState"
import { createCommandRegistry } from "./Commands"
import type { CommandActions } from "./Flows"

const fixture = () => {
  const cards = new Map<string, Card>()
  const effects: string[] = []
  const requests: Authorize.Request[] = []
  const store = {
    session: () => ({ activeRepoKey: null }),
    collections: { cards, repositories: new Map(), workingCopies: new Map() },
    dispatch: (event: { type: string; card?: Card; id?: string; patch?: Partial<Card> }) => {
      if (event.type === "card.upsert") cards.set(event.card!.id, event.card!)
      if (event.type === "card.updated") Object.assign(cards.get(event.id!)!, event.patch)
    }
  }
  let forms: ReturnType<typeof createFormsController>
  const actions = {
    repositoryFlows: () => undefined,
    knownRepositories: () => new Set<string>(),
    noteCommandRun: () => {},
    traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false }),
    decideApproval: () => { effects.push("approval") },
    runWorkflow: async () => { effects.push("workflow") },
    openBrowser: async () => { effects.push("browser") },
    renderFlowForm: (request) => forms.renderFlowForm(request),
    submitForm: (id, invocation) => forms.submitForm(id, invocation)
  } satisfies Partial<CommandActions>
  const commands = createCommandRegistry(actions as unknown as CommandActions)
  const context = { store, commands, commandActor: "smithers" } as unknown as ControllerContext
  forms = createFormsController(context, { nextOrdinal: () => 1 })
  const policy = createChainPolicy()
  const layerFor = (lineage: string) => Layer.effect(Authorize.Authorize)(Effect.gen(function*() {
    const service = yield* Authorize.Authorize
    return Authorize.make({ authorize: (request) => {
      requests.push(request)
      return service.authorize(request)
    } })
  }).pipe(Effect.provide(policy.layerFor(lineage))))
  const form = (target: string, via: "user" | "agent" = "agent", value?: string) => {
    const field = target === "flow.run" ? "name" : target === "browser.open" ? "url" : "cardId"
    const card = CardSchema.parse({
      id: `form-${cards.size}`, kind: "flow-form", title: target, status: "active", createdAt: 1, ordinal: 1,
      payload: { flow: target, via, fields: [{ name: field, label: field, kind: "text", required: true }],
        draft: { [field]: value ?? (target === "browser.open" ? "https://example.invalid/private" : "deployment") }, given: {} }
    })
    cards.set(card.id, card)
    return card.id
  }
  const invoke = (name: string, args: string, lineage = "one", slot: Catalog.CallSlot = { chain: "child", link: 4, ordinal: 2 }) => {
    const entry = commandEntries(commands).find((candidate) => candidate.name === name)!
    return Effect.runPromise(Effect.gen(function*() {
      const service = yield* Authorize.Authorize
      yield* service.authorize({ name, capabilities: entry.capabilities ?? ["*"], slot })
      return yield* entry.handler({ args }, slot)
    }).pipe(Effect.result, Effect.provide(layerFor(lineage))))
  }
  const runChain = (id: string, initial: ReadonlyArray<Event.Event> = []) => Effect.runPromise(
    Effect.gen(function*() {
      const outcome = yield* Chain.run({ goal: "submit the form" })
      const journal = yield* Journal.Journal
      return { outcome, events: yield* journal.read }
    }).pipe(Effect.provide(Layer.mergeAll(
      layerFor("chain"), Catalog.layer(commandEntries(commands)), Journal.layerMemory(initial),
      Author.layerMock([`\`\`\`flow\nawait ctx.call("form.submit", { args: "${id}" })\nreturn done({ submitted: true })\n\`\`\``]),
      ScriptRunner.layerInProcess
    )))
  )
  return { cards, effects, requests, commands, forms, context, policy, form, invoke, runChain }
}

describe("form.submit authorization through the real chain catalog (security/1)", () => {
  for (const via of ["user", "agent"] as const) {
    test(`an agent cannot dispatch protected targets through a ${via} form`, async () => {
      const h = fixture()
      for (const target of ["approval.approve", "approval.deny", "flow.run", "browser.open"]) {
        const result = await h.invoke("form.submit", h.form(target, via))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure.message).toContain(target.startsWith("approval.") ? "human" : "approval")
          if (!target.startsWith("approval.")) expect((result.failure as Catalog.CallError).cause).toBe("approval_required")
        }
        expect(h.effects).toEqual([])
      }
      expect(h.requests.filter((request) => ["flow.run", "browser.open"].includes(request.name))).toEqual([
        { name: "flow.run", capabilities: ["outbound:launch"], slot: { chain: "child", link: 4, ordinal: 2 } },
        { name: "browser.open", capabilities: ["session:net-read"], slot: { chain: "child", link: 4, ordinal: 2 } }
      ])
    })
  }

  test("all agent entry points deny approvals; every form continuation fails closed without chain authority", async () => {
    const h = fixture()
    for (const name of ["approval.approve", "approval.deny", "flow.run", "browser.open"]) {
      expect((await h.commands.runForAgent(`/${name}`, "target")).status).toBe("failed")
      if (name.startsWith("approval.")) {
        expect((await h.commands.runAsAgent(name, "target")).status).toBe("failed")
        expect(await h.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name, args: "target" }) })).toContain("failed:")
      }
      expect((await h.commands.runAsAgent("form.submit", h.form(name))).status).toBe("failed")
      expect(await h.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "form.submit", args: h.form(name) }) })).toContain("failed:")
      expect((await h.commands.runForAgent("form.submit", h.form(name))).status).toBe("failed")
    }
    expect(h.effects).toEqual([])
    expect((await h.commands.run("approval.approve", "target")).status).toBe("executed")
    expect(h.effects).toEqual(["approval"])
  })

  test("outbound grants stay in their lineage and are consumed once by the nested target", async () => {
    const h = fixture()
    const id = h.form("flow.run")
    expect((await h.invoke("form.submit", id, "one"))._tag).toBe("Failure")
    expect(h.policy.pendingAsk("one")).toEqual({ name: "flow.run", claim: "outbound:launch" })
    expect(h.policy.resolve("one", "approved")).toBe(true)
    expect((await h.invoke("form.submit", id, "two"))._tag).toBe("Failure")
    expect(h.effects).toEqual([])
    expect((await h.invoke("form.submit", id, "one"))._tag).toBe("Success")
    expect(h.effects).toEqual(["workflow"])
    expect((await h.invoke("form.submit", h.form("flow.run"), "one"))._tag).toBe("Failure")
    expect(h.effects).toEqual(["workflow"])
  })

  test("session grants permit later browser targets, and revocation rechecks them", async () => {
    const h = fixture()
    const id = h.form("browser.open")
    expect((await h.invoke("form.submit", id))._tag).toBe("Failure")
    expect(h.policy.resolve("one", "approved")).toBe(true)
    expect((await h.invoke("form.submit", id))._tag).toBe("Success")
    expect((await h.invoke("form.submit", h.form("browser.open"), "two"))._tag).toBe("Success")
    h.policy.revoke()
    expect((await h.invoke("form.submit", h.form("browser.open")))._tag).toBe("Failure")
    expect(h.effects).toEqual(["browser", "browser"])
  })

  test("a generated form keeps host authority for a later human submission and rechecks grants", async () => {
    const h = fixture()
    expect((await h.invoke("browser.open", ""))._tag).toBe("Failure")
    h.policy.resolve("one", "approved")
    expect((await h.invoke("browser.open", ""))._tag).toBe("Success")
    await h.forms.setFormField("form-browser.open", "url", "https://example.invalid/private")
    const card = h.cards.get("form-browser.open")!
    expect(JSON.stringify(card.payload)).not.toContain("authorize")
    expect(JSON.stringify(card.payload)).not.toContain("slot")
    h.policy.revoke()
    h.context.commandActor = "user"
    await h.forms.submitForm(card.id)
    expect(h.effects).toEqual([])
    expect(h.policy.pendingAsk("one")).toEqual({ name: "browser.open", claim: "session:net-read" })
    h.policy.resolve("one", "approved")
    await h.forms.submitForm(card.id)
    expect(h.effects).toEqual(["browser"])
  })

  test("replacing a generated form payload cannot borrow its lineage's outbound grant", async () => {
    const h = fixture()
    expect((await h.invoke("flow.run", ""))._tag).toBe("Failure")
    h.policy.resolve("one", "approved")
    expect((await h.invoke("flow.run", ""))._tag).toBe("Success")
    await h.forms.setFormField("form-flow.run", "name", "intended")
    h.context.commandActor = "user"
    await h.forms.submitForm("form-flow.run")
    expect(h.policy.pendingAsk("one")?.name).toBe("flow.run")
    h.policy.resolve("one", "approved")
    const card = h.cards.get("form-flow.run")!
    if (card.kind !== "flow-form") throw new Error("missing form")
    // Same valid metadata shape as card.show/card.update, with an attacker-chosen draft.
    h.cards.set(card.id, { ...card, payload: { ...card.payload, draft: { name: "attacker" } } })
    await h.forms.submitForm(card.id)
    expect(h.effects).toEqual([])
    expect(h.cards.get(card.id)?.status).toBe("error")
  })

  test("recursive form continuations retain authorization and the outer slot", async () => {
    const h = fixture()
    const inner = h.form("browser.open", "user")
    const outer = h.form("form.submit", "user", inner)
    const result = await h.invoke("form.submit", outer)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect((result.failure as Catalog.CallError).cause).toBe("approval_required")
    expect(h.requests.map((request) => request.name)).toEqual(["form.submit", "form.submit", "browser.open"])
    expect(h.requests.every((request) => request.slot.chain === "child" && request.slot.link === 4 && request.slot.ordinal === 2)).toBe(true)
    expect(h.effects).toEqual([])
  })

  for (const target of ["flow.run", "browser.open"]) {
    test(`the real chain parks and resumes a form for ${target} without settling the blocked call`, async () => {
      const h = fixture()
      const id = h.form(target)
      const first = await h.runChain(id)
      expect(first.outcome._tag).toBe("ApprovalWait")
      expect(h.effects).toEqual([])
      expect(first.events.some((event) => event._tag === "CallSettled" && event.name === "form.submit")).toBe(false)
      expect(h.policy.resolve("chain", "approved")).toBe(true)
      const resumed = await h.runChain(id, first.events)
      expect(resumed.outcome._tag).toBe("Done")
      expect(h.effects).toEqual([target === "flow.run" ? "workflow" : "browser"])
    })
  }
})
