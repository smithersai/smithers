/*
 * THE FORM LAW at the door (apps/ui/AGENTS.md; docs/workbench-lanes/flow-forms.md):
 * a flow invoked without its required input — by the agent or by a typed
 * slash — renders its form card, prefilled with what the line gave, and
 * answers "rendered a form for <fields>"; never a usage sentence. A button
 * always carries its args and never meets the form. Submit re-enters the run
 * path as whoever asked, so an agent's ask on a consequential flow still
 * confirms, and the other doors (W0 unavailable, user-only) stay intact.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, spyOn, test } from "bun:test"
import { AGENT_ROLES, AgentRoleSchema } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { Harness } from "@smthrs/rpc/LocalApp"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import type { Card } from "../state/AppState"
import { Option, Schema } from "effect"
import { createCommandRegistry } from "./Commands"
import type { CommandActions } from "./Flows"
import { assembleArgs, draftFrom, formFieldsFor, missingFields, submissionPayload } from "./FlowForms"
import type { FormField } from "./FlowForms"
import { nameOf } from "./registry"
import { payloadFor } from "./SlashPayload"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const repositories: NativeRepositories = { available: true, pickLocalRepository: async () => ({ status: "cancelled" }) }

const EVERYTHING: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const harness = (overrides: Partial<Harness> & Pick<Harness, "id" | "status">): Harness => ({
  displayName: overrides.id,
  binary: overrides.status === "unavailable" ? null : `/usr/local/bin/${overrides.id}`,
  version: "1.0.0",
  account: null,
  launch: { argv: [overrides.id] },
  ...overrides
})

const HARNESSES: ReadonlyArray<Harness> = [
  harness({ id: "claude", displayName: "Claude Code", status: "signed-in", account: { email: "will@example.com" }, models: { suggestions: ["claude-fable-5"], listable: false } }),
  harness({ id: "codex", displayName: "Codex", status: "api-key", account: { label: "OPENAI_API_KEY" }, models: { suggestions: ["gpt-5.6-sol", "gpt-5.6-terra"], listable: false } }),
  harness({ id: "opencode-kimi", displayName: "OpenCode · Kimi", status: "binary-only", models: { suggestions: ["kimi-for-coding/k3"], listable: true } }),
  harness({ id: "crush", displayName: "Crush", status: "api-key", account: { label: "OPENAI_API_KEY" } }),
  harness({ id: "pi", displayName: "Pi", status: "unavailable" })
]

const settle = async (ticks = 8): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const agents: Array<AgentRole> = [...AGENT_ROLES]
  const puts: Array<{ id: string; body: Record<string, unknown> }> = []
  const controller = createAppController(store, repositories, unavailableAgent, {
    bootstrap: EVERYTHING,
    socketUrl: () => undefined,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      const method = init?.method ?? "GET"
      if (path === "/api/harnesses") return json(200, { harnesses: HARNESSES })
      if (path === "/api/agents" && method === "GET") return json(200, { agents })
      const put = /^\/api\/agents\/([^/]+)$/.exec(path)
      if (put !== null && method === "PUT") {
        const id = put[1]!
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        puts.push({ id, body })
        const row = AgentRoleSchema.parse({ id, ...body, delegates: false, builtin: false, createdAt: 100, updatedAt: 101 })
        agents.push(row)
        return json(201, { agent: row })
      }
      const models = /^\/api\/harnesses\/([^/]+)\/models$/.exec(path)
      if (models !== null) {
        if (models[1] === "codex") return json(200, { harnessId: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], source: "list" })
        return json(200, { harnessId: models[1], models: [], source: "suggestions", reason: "no list command" })
      }
      return json(404, { error: { code: "absent", message: `no stub for ${method} ${path}` } })
    }
  })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: true, scopesPlain: null })
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [...HARNESSES] })
  store.dispatch({ type: "card.upsert", actor: "system", card: { id: "card-1", kind: "status", title: "Status", status: "active", createdAt: 1, ordinal: 0, payload: { progress: 0.5 } } })
  await controller.loadAgents()
  await settle()
  return { store, controller, puts }
}

/** The production agent door (turns.ts continueToolLeg): one tool call, run as actor smithers. */
const execute = (controller: Awaited<ReturnType<typeof boot>>["controller"], name: string, args?: string) =>
  controller.commands.executeForAgent({
    name: "commands",
    arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) })
  })

const formOf = (store: AppStore, flow: string): Extract<Card, { kind: "flow-form" }> | undefined => {
  const card = store.collections.cards.get(`form-${flow}`)
  return card?.kind === "flow-form" ? card : undefined
}

const messages = (store: AppStore) => [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal)
const toasts = (store: AppStore) => [...store.collections.toasts.values()]

describe("THE FORM LAW — the agent door", () => {
  test("a call without the required input renders the flow's form and says so; no usage sentence, nothing ran", async () => {
    const { store, controller, puts } = await boot()
    const result = await execute(controller, "agent.create")
    expect(result).toBe("rendered a form for id, harness, model: ask the user to fill it in")
    expect(result).not.toContain("needs")
    expect(result).not.toContain("/agent.create ")
    const form = formOf(store, "agent.create")
    expect(form?.payload).toMatchObject({ flow: "agent.create", via: "agent", draft: {}, given: {} })
    expect(form?.title).toBe("/agent.create")
    expect(form?.payload.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["id", "text", true],
      ["harness", "select", true],
      ["model", "text", true],
      ["purpose", "text", false]
    ])
    // The harness select is the harness seam: installed with credential state; an unpickable one carries its reason.
    expect(form?.payload.fields[1]?.options).toEqual([
      { value: "claude", label: "Claude Code · will@example.com" },
      { value: "codex", label: "Codex · OPENAI_API_KEY" },
      { value: "opencode-kimi", label: "OpenCode · Kimi", disabled: true, reason: "no credential" },
      { value: "crush", label: "Crush · OPENAI_API_KEY", disabled: true, reason: "no verified model flag" },
      { value: "pi", label: "Pi", disabled: true, reason: "not installed" }
    ])
    // No harness picked yet: the model field has no options to offer.
    expect(form?.payload.fields[2]?.options).toEqual([])
    expect(puts).toEqual([])
    expect(messages(store).find((message) => message.action?.flow === "agent.create")).toBeUndefined()
  })

  test("partial args prefill the draft and the form asks only for the rest; the harness's model list feeds the model field", async () => {
    const { store, controller } = await boot()
    expect(await execute(controller, "agent.create", "reviewer codex")).toBe("rendered a form for model: ask the user to fill it in")
    await settle()
    const form = formOf(store, "agent.create")
    expect(form?.payload.draft).toEqual({ id: "reviewer", harness: "codex" })
    expect(form?.payload.given).toEqual({ id: "reviewer", harness: "codex" })
    // The verified suggestions at render, replaced by the harness's own list once it answers.
    expect(form?.payload.fields[2]?.options?.map((option) => option.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
  })

  test("a complete call on a confirm flow still confirms — the form door never swallows the confirm path", async () => {
    const { store, controller, puts } = await boot()
    const result = await execute(controller, "agent.create", "reviewer codex gpt-5.6-terra Reviews diffs")
    expect(result).toContain("asked the user to confirm")
    expect(formOf(store, "agent.create")).toBeUndefined()
    expect(messages(store).find((message) => message.action?.flow === "agent.create")?.action?.args).toBe("reviewer codex gpt-5.6-terra Reviews diffs")
    expect(puts).toEqual([])
  })

  test("the user-only refusal and the W0 door are untouched: a user-only flow without args is refused by name, never formed", async () => {
    const { store, controller } = await boot()
    const result = await execute(controller, "tab.select")
    expect(result).toStartWith("failed: /tab.select is user-only")
    expect(formOf(store, "tab.select")).toBeUndefined()
  })
})

describe("THE FORM LAW — the slash door and the button door", () => {
  test("a typed slash without its input renders the same form as the human's, and the composer line points at it", async () => {
    const { store, controller } = await boot()
    controller.send("/agent.create reviewer")
    await settle()
    const form = formOf(store, "agent.create")
    expect(form?.payload).toMatchObject({ via: "user", draft: { id: "reviewer" } })
    expect(store.session().draft).toBe("")
    const shown = toasts(store)
    expect(shown.map((toast) => [toast.title, toast.status])).toEqual([["Fill in the form above", "ok"]])
    expect(shown[0]?.detail ?? "").not.toContain("needs")
  })

  test("a button carries its args and runs the flow as before; nothing renders a form", async () => {
    const { store, controller, puts } = await boot()
    const outcome = await controller.commands.run("agent.create", "reviewer codex gpt-5.6-terra Reviews diffs")
    expect(outcome.status).toBe("executed")
    expect(puts.map((put) => put.id)).toEqual(["reviewer"])
    expect(formOf(store, "agent.create")).toBeUndefined()
  })
})

describe("THE FORM LAW — filling and submitting", () => {
  test("form.set commits one field into the payload, coerces by kind, and refuses what the seam did not offer", async () => {
    const { store, controller } = await boot()
    await execute(controller, "agent.create")
    const id = "form-agent.create"
    expect((await controller.commands.run("form.set", `${id} harness codex`)).status).toBe("executed")
    expect((await controller.commands.run("form.set", `${id} id reviewer`)).status).toBe("executed")
    expect(formOf(store, "agent.create")?.payload.draft).toEqual({ harness: "codex", id: "reviewer" })
    // Picking the harness re-read the model field's options for it.
    expect(formOf(store, "agent.create")?.payload.fields[2]?.options?.map((option) => option.value)).toContain("gpt-5.6-terra")
    expect(await controller.commands.run("form.set", `${id} harness pi`)).toEqual({ status: "failed", error: "Pi cannot be picked: not installed." })
    expect(await controller.commands.run("form.set", `${id} harness moon`)).toEqual({
      status: "failed",
      error: "Harness offers claude, codex, opencode-kimi, crush, pi; moon is not one of them."
    })
    expect(await controller.commands.run("form.set", `${id} colour red`)).toEqual({
      status: "failed",
      error: "The form has no field colour; its fields are id, harness, model, purpose."
    })
    // A blank commit clears.
    expect((await controller.commands.run("form.set", `${id} id`)).status).toBe("executed")
    expect(formOf(store, "agent.create")?.payload.draft).toEqual({ harness: "codex" })
    expect(await controller.commands.run("form.set", "form-nope id x")).toEqual({ status: "failed", error: "There is no form card form-nope." })
  })

  test("a slash-rendered form's Submit runs the flow as the human, and the card keeps the record as acted", async () => {
    const { store, controller, puts } = await boot()
    controller.send("/agent.create")
    await settle()
    const id = "form-agent.create"
    for (const line of ["id reviewer", "harness codex", "model gpt-5.6-terra", "purpose Reviews diffs for correctness"]) {
      await controller.commands.run("form.set", `${id} ${line}`)
    }
    const outcome = await controller.commands.run("form.submit", id)
    expect(outcome).toEqual({ status: "executed", value: "created agent reviewer: Reviewer on codex with gpt-5.6-terra" })
    expect(puts).toEqual([{
      id: "reviewer",
      body: { label: "Reviewer", purpose: "Reviews diffs for correctness", harness: "codex", model: { provider: "openai", id: "gpt-5.6-terra", label: "gpt-5.6-terra" } }
    }])
    const form = formOf(store, "agent.create")
    expect(form?.status).toBe("acted")
    expect(form?.payload.error).toBeUndefined()
    // No confirm card: the human's own Submit was the act.
    expect(messages(store).find((message) => message.action?.flow === "agent.create")).toBeUndefined()
    expect(await controller.commands.run("form.submit", id)).toEqual({ status: "failed", error: `The form ${id} was already submitted.` })
  })

  test("an agent-rendered form's Submit runs the flow as the agent: a confirm flow posts its confirm card and the human's click runs it", async () => {
    const { store, controller, puts } = await boot()
    await execute(controller, "agent.create", "reviewer")
    const id = "form-agent.create"
    await controller.commands.run("form.set", `${id} harness codex`)
    await controller.commands.run("form.set", `${id} model gpt-5.6-terra`)
    // The human clicks Submit on the agent's form.
    const outcome = await controller.commands.run("form.submit", id)
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : "").toContain("asked the user to confirm")
    expect(puts).toEqual([])
    const confirmation = messages(store).find((message) => message.action?.flow === "agent.create")
    expect(confirmation?.action).toEqual({ flow: "agent.create", args: "reviewer codex gpt-5.6-terra", label: "Confirm: create the agent reviewer on codex with gpt-5.6-terra" })
    expect(formOf(store, "agent.create")?.status).toBe("acted")
    // The confirm button runs the flow as the user.
    expect((await controller.commands.run("agent.create", "reviewer codex gpt-5.6-terra")).status).toBe("executed")
    expect(puts.map((put) => put.id)).toEqual(["reviewer"])
  })

  test("the agent may submit its own form, and a refusal lands on the card and in its result", async () => {
    const { store, controller } = await boot()
    await execute(controller, "tab.harness")
    const id = "form-tab.harness"
    expect(await execute(controller, "form.submit", id)).toBe("failed: The form still needs: Harness id.")
    expect(formOf(store, "tab.harness")?.payload.error).toBe("The form still needs: Harness id.")
    expect(formOf(store, "tab.harness")?.status).toBe("error")
    await execute(controller, "form.set", `${id} harnessId claude`)
    // A field commit clears the refusal.
    expect(formOf(store, "tab.harness")?.payload.error).toBeUndefined()
    expect(formOf(store, "tab.harness")?.status).toBe("active")
    const submitted = await execute(controller, "form.submit", id)
    expect(submitted).toContain("asked the user to confirm")
    expect(messages(store).find((message) => message.action?.flow === "tab.harness")?.action?.args).toBe("claude")
  })

  test("a refused flow puts its reason on the form for the human, with no toast", async () => {
    const { store, controller } = await boot()
    controller.send("/agent.create")
    await settle()
    const id = "form-agent.create"
    for (const line of ["id ui", "harness codex", "model gpt-5.6-terra"]) await controller.commands.run("form.set", `${id} ${line}`)
    expect(await controller.commands.run("form.submit", id)).toEqual({ status: "executed" })
    const form = formOf(store, "agent.create")
    expect(form?.status).toBe("error")
    expect(form?.payload.error).toBe("An agent named ui already exists — agent.edit ui changes it.")
    expect(toasts(store).filter((toast) => toast.status === "failed")).toEqual([])
  })

  test("Cancel is card.dismiss: it drops a form card and refuses any other kind", async () => {
    const { store, controller } = await boot()
    await execute(controller, "agent.create")
    expect((await controller.commands.run("card.dismiss", "form-agent.create")).status).toBe("executed")
    expect(formOf(store, "agent.create")).toBeUndefined()
    expect(await controller.commands.run("card.dismiss", "card-1")).toEqual({ status: "failed", error: "/card.dismiss dismisses form cards; card-1 is a status card." })
    expect(store.collections.cards.get("card-1")).toBeDefined()
    expect(await controller.commands.run("card.dismiss", "nope")).toEqual({ status: "failed", error: "There is no card nope." })
  })

  test("agent.new renders agent.create's form; an existing id renders agent.edit's, prefilled from the row", async () => {
    const { store, controller } = await boot()
    expect(await execute(controller, "agent.new")).toBe("rendered a form for id, harness, model: ask the user to fill it in")
    expect(formOf(store, "agent.create")?.payload.via).toBe("agent")
    expect((await controller.commands.run("agent.new", "explainer")).status).toBe("executed")
    const edit = formOf(store, "agent.edit")
    const explainer = AGENT_ROLES.find((role) => role.id === "explainer")
    expect(edit?.payload).toMatchObject({
      flow: "agent.edit",
      via: "user",
      draft: { id: "explainer", model: "kimi-for-coding/k3", purpose: explainer?.purpose ?? "", label: "Explainer" }
    })
    // The id select is the agents seam; the model field's options are the row's harness's.
    expect(edit?.payload.fields[0]?.optionsFrom).toBe("agents")
    expect(edit?.payload.fields[0]?.options?.map((option) => option.value)).toContain("explainer")
    expect(edit?.payload.fields[1]?.options?.map((option) => option.value)).toEqual(["kimi-for-coding/k3"])
  })
})

describe("THE FORM LAW — every flow's form round-trips through its own grammar", () => {
  test("a filled form assembles to a line the flow's grammar parses, for every flow that takes arguments", async () => {
    const { controller } = await boot()
    const failures: Array<string> = []
    for (const entry of controller.commands.entries()) {
      if (entry.metadata.args === undefined) continue
      const name = nameOf(entry)
      const fields = formFieldsFor(entry.input, entry.metadata.form)
      const sample: Record<string, unknown> = {}
      for (const field of fields) {
        if (field.kind === "number") sample[field.name] = 1
        else if (field.kind === "boolean") sample[field.name] = true
        else if (field.kind === "select") sample[field.name] = field.options?.[0]?.value ?? "x1"
        // A repository target is only ever read in its owner/repo shape (RepoContext.splitTrailingRepo).
        else if (field.name === "repo") sample[field.name] = "o/r"
        else if (name === "flow.run" && field.name === "input") sample[field.name] = { message: "Keep  spaces" }
        else sample[field.name] = "x1"
      }
      const draft = draftFrom(fields, sample)
      if (missingFields(fields, draft).length > 0) failures.push(`${name}: the sample left ${missingFields(fields, draft).join(", ")} missing`)
      const args = assembleArgs(fields, entry.metadata.form, { ...draft })
      const parsed = payloadFor(name, args === "" ? undefined : args)
      if ("error" in parsed) failures.push(`${name}: "${args}" → ${parsed.error}`)
    }
    expect(failures).toEqual([])
  })
})


/*
 * THE FORM LAW at the submission (ui-flows-chain/api-design/1): a form runs
 * its flow with the NAMED payload it collected. The gate below fills every
 * field of every flow with a DISTINCT value and compares the payload the
 * declaration's own schema decodes with the payload the form intended — a
 * value that landed on the neighbouring field is a failure, which the old
 * "the line parsed" acceptance could not see.
 */

/** A flow's declaration schema as a decoder: the registry types `input` as `Schema.Top`, which carries no service bound. */
const decodeInput = (input: Schema.Top) => Schema.decodeUnknownOption(input as unknown as Schema.Codec<unknown>)

/** Each input property past `Schema.optional`: the shape a sample must take, and whether the schema lets it go. */
const propertyShapes = (input: Schema.Top): ReadonlyMap<string, { readonly tag: string; readonly optional: boolean }> => {
  const ast = input.ast as { _tag: string; propertySignatures?: ReadonlyArray<{ name: PropertyKey; type: any }> }
  const shapes = new Map<string, { readonly tag: string; readonly optional: boolean }>()
  for (const signature of ast.propertySignatures ?? []) {
    const type = signature.type
    const inner = type._tag === "Union" ? type.types.find((member: any) => member._tag !== "Undefined") ?? type : type
    shapes.set(String(signature.name), { tag: String(inner._tag), optional: type._tag === "Union" && type !== inner })
  }
  return shapes
}

/** A distinct value per field, so a value that shifts onto another field is visible in the comparison. */
const sampleFor = (tag: string | undefined, field: FormField, index: number): unknown => {
  if (field.kind === "number") return index + 1
  if (field.kind === "boolean") return true
  if (field.kind === "select") return field.options?.[0]?.value ?? `${field.name}-${index}`
  // A list control is one line of space-separated items, so its items carry no space.
  if (tag === "Arrays") return [`src/oné-${index}.ts`, `docs/two-${index}.md`]
  if (tag === "Objects") return { message: `Keep  spaces ${index}` }
  // A repository target is only ever read in its owner/repo shape (RepoContext.splitTrailingRepo).
  if (field.name === "repo") return `owner${index}/repo${index}`
  // Unicode and a path with spaces: a positional line cannot carry either honestly.
  return `${field.name}/a path ${index} ✓`
}

/** The payload a filled form submits: the draft the card holds, named. */
const submissionOf = (
  entry: ReturnType<ReturnType<typeof createCommandRegistry>["entries"]>[number],
  given: Readonly<Record<string, unknown>>
): Record<string, unknown> | string => {
  const fields = formFieldsFor(entry.input, entry.metadata.form)
  const submission = submissionPayload(entry.input, fields, given, draftFrom(fields, given))
  return "error" in submission ? submission.error : submission.payload
}

describe("THE FORM LAW — every flow's form submits its own named payload", () => {
  test("every filled field arrives under its own name, through the flow's input schema", async () => {
    const { controller } = await boot()
    const failures: Array<string> = []
    for (const entry of controller.commands.entries()) {
      if (entry.metadata.args === undefined) continue
      const name = nameOf(entry)
      const fields = formFieldsFor(entry.input, entry.metadata.form)
      const shapes = propertyShapes(entry.input)
      const given: Record<string, unknown> = {}
      fields.forEach((field, index) => {
        given[field.name] = sampleFor(shapes.get(field.name)?.tag, field, index)
      })
      const payload = submissionOf(entry, given)
      const decoded = typeof payload === "string" ? Option.none() : decodeInput(entry.input)(payload)
      if (Option.isNone(decoded)) {
        failures.push(`${name}: ${JSON.stringify(payload)} is not valid input`)
        continue
      }
      const kept = decoded.value as Record<string, unknown>
      for (const field of fields) {
        if (JSON.stringify(kept[field.name]) !== JSON.stringify(given[field.name])) {
          failures.push(`${name}.${field.name}: submitted ${JSON.stringify(given[field.name])}, ran with ${JSON.stringify(kept[field.name])}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  test("an omitted optional stays omitted instead of shifting the next field's value onto it", async () => {
    const { controller } = await boot()
    const failures: Array<string> = []
    for (const entry of controller.commands.entries()) {
      if (entry.metadata.args === undefined) continue
      const name = nameOf(entry)
      const fields = formFieldsFor(entry.input, entry.metadata.form)
      const optional = fields.filter((field) => !field.required && field.kind !== "boolean")
      // The last optional field alone: everything before it is the gap a positional line closes up.
      const last = optional[optional.length - 1]
      if (last === undefined) continue
      const shapes = propertyShapes(entry.input)
      const given: Record<string, unknown> = {}
      fields.forEach((field, index) => {
        if (field.required || field.name === last.name) given[field.name] = sampleFor(shapes.get(field.name)?.tag, field, index)
      })
      const payload = submissionOf(entry, given)
      const decoded = typeof payload === "string" ? Option.none() : decodeInput(entry.input)(payload)
      if (Option.isNone(decoded)) {
        failures.push(`${name}: ${JSON.stringify(payload)} is not valid input`)
        continue
      }
      const kept = decoded.value as Record<string, unknown>
      for (const field of fields) {
        /* A field the schema requires and a `required: false` hint lets stand blank submits as the blank it shows. */
        const expected = field.name in given
          ? given[field.name]
          : shapes.get(field.name)?.optional === false
          ? ""
          : undefined
        if (JSON.stringify(kept[field.name]) !== JSON.stringify(expected)) {
          failures.push(`${name}.${field.name}: expected ${JSON.stringify(expected)}, ran with ${JSON.stringify(kept[field.name])}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  test("a prefilled free-text field the human cleared submits as the clear, not as the value it held", async () => {
    const { controller } = await boot()
    const entry = controller.commands.find("agent.edit")!
    const fields = formFieldsFor(entry.input, entry.metadata.form)
    const given = { id: "explainer", purpose: "Explains code" }
    // form.set with a blank value drops the key: the human emptied the control.
    const cleared = submissionPayload(entry.input, fields, given, { id: "explainer" })
    expect(cleared).toEqual({ payload: { id: "explainer", purpose: "" } })
    expect(submissionPayload(entry.input, fields, given, draftFrom(fields, given))).toEqual({ payload: given })
  })

  test("a structured control holding text that is not JSON is the form's own refusal, and nothing runs", async () => {
    const { controller } = await boot()
    const entry = controller.commands.find("flow.run")!
    const fields = formFieldsFor(entry.input, entry.metadata.form)
    expect(submissionPayload(entry.input, fields, {}, { name: "coding", input: "{invalid" })).toEqual({
      error: "Input JSON is not valid JSON. Fix it before submitting the form."
    })
    expect(submissionPayload(entry.input, fields, {}, { name: "coding", input: JSON.stringify({ plan: { title: "One" } }) })).toEqual({
      payload: { name: "coding", input: { plan: { title: "One" } } }
    })
  })

  test("change.diff runs with the pins the form filled, never with the line's positions", async () => {
    const calls: Array<{ readonly action: string; readonly args: ReadonlyArray<unknown> }> = []
    const recording = new Proxy({}, {
      get: (_target, property: string) => {
        if (property === "bootstrap") return EVERYTHING
        if (property === "snapshot") return () => ({ surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: false })
        if (property === "repositoryFlows") return () => undefined
        if (property === "knownRepositories") return () => new Set<string>()
        return (...args: ReadonlyArray<unknown>) => {
          calls.push({ action: property, args })
          return undefined
        }
      }
    }) as CommandActions
    const registry = createCommandRegistry(recording)
    await registry.submit({ name: "change.diff", payload: { changeId: "c1", to: "1" }, actor: "user", display: "c1 1" })
    expect(calls.filter((call) => call.action === "diffChange")).toEqual([
      { action: "diffChange", args: ["c1", undefined, "1", undefined] }
    ])
  })

  test("the form door submits the draft by name and keeps the assembled line for display only", async () => {
    const { store, controller } = await boot()
    const submitted = spyOn(controller.commands, "submit")
    expect(await execute(controller, "change.diff")).toContain("rendered a form")
    const card = formOf(store, "change.diff")!
    await controller.commands.run("form.set", `${card.id} changeId c1`)
    await controller.commands.run("form.set", `${card.id} to 1`)
    await controller.commands.run("form.submit", card.id)
    const submission = submitted.mock.calls[0]?.[0]
    expect(submission?.payload).toEqual({ changeId: "c1", to: "1" })
    // The line the card echoes is the lossy one the run path no longer reads.
    expect(submission?.display).toBe("c1 1")
    expect(payloadFor("change.diff", submission?.display)).toEqual({ payload: { changeId: "c1", from: "1" } })
  })
})
