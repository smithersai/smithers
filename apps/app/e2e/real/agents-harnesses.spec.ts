import type { APIRequestContext, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, realApi, registerOwnedPty, test } from "./support/test"
import { enterCanonicalRepositoryApp } from "./navigation-frames/cards"
import { captureTurnTraffic, parseTurnFrames, toolExecution } from "./chat-tools/ui"

interface HarnessRow {
  readonly id: string
  readonly displayName: string
  readonly binary: string | null
  readonly version: string | null
  readonly status: "signed-in" | "api-key" | "binary-only" | "unavailable"
  readonly account: { readonly email?: string; readonly label?: string } | null
  readonly launch: { readonly argv: ReadonlyArray<string> }
  readonly models?: { readonly suggestions: ReadonlyArray<string>; readonly listable: boolean }
}

interface AgentRow {
  readonly id: string
  readonly label: string
  readonly purpose: string
  readonly harness: string
  readonly model: { readonly provider: string; readonly id: string; readonly label: string }
  readonly delegates: boolean
  readonly builtin: boolean
}

interface HarnessModels {
  readonly harnessId: string
  readonly models: ReadonlyArray<string>
  readonly source: "list" | "suggestions"
  readonly reason?: string
}

const boot = async (page: Page): Promise<void> => {
  await enterCanonicalRepositoryApp(page)
  await expect(page.getByTestId("transcript")).toBeVisible()
}

const harnesses = async (page: Page, request: APIRequestContext): Promise<ReadonlyArray<HarnessRow>> => {
  const response = await realApi(page, request, "GET", "/api/harnesses")
  expect(response.status(), "real harness discovery preflight responds successfully").toBe(200)
  const body = await response.json() as { readonly harnesses?: ReadonlyArray<HarnessRow> }
  expect(body.harnesses, "real harness discovery returns the contract table").toBeDefined()
  return body.harnesses ?? []
}

const agents = async (page: Page, request: APIRequestContext): Promise<ReadonlyArray<AgentRow>> => {
  const response = await realApi(page, request, "GET", "/api/agents")
  expect(response.status()).toBe(200)
  return (await response.json() as { readonly agents: ReadonlyArray<AgentRow> }).agents
}

const authenticatedModelHarness = async (page: Page, request: APIRequestContext): Promise<HarnessRow> => {
  const rows = await harnesses(page, request)
  const usable = (row: HarnessRow): boolean =>
    row.binary !== null &&
    (row.status === "signed-in" || row.status === "api-key") &&
    (row.models?.suggestions.length ?? 0) > 0
  const row = ["opencode-kimi", "opencode-cerebras", "codex", "claude"]
    .map((id) => rows.find((candidate) => candidate.id === id))
    .find((candidate): candidate is HarnessRow => candidate !== undefined && usable(candidate))
  if (row === undefined) {
    throw new Error("Real agents E2E requires an installed, authenticated harness with a verified model; discovery found none.")
  }
  return row
}

const completedPromptHarness = async (page: Page, request: APIRequestContext): Promise<HarnessRow> => {
  const rows = await harnesses(page, request)
  const row = ["opencode-kimi", "opencode-cerebras"]
    .map((id) => rows.find((candidate) => candidate.id === id))
    .find((candidate): candidate is HarnessRow =>
      candidate !== undefined &&
      candidate.binary !== null &&
      (candidate.status === "signed-in" || candidate.status === "api-key") &&
      (candidate.models?.suggestions.length ?? 0) > 0)
  if (row === undefined) {
    throw new Error("Real delegation E2E requires authenticated OpenCode so its one-shot provider command can complete; discovery found none.")
  }
  return row
}

const harnessModels = async (page: Page, request: APIRequestContext, id: string): Promise<HarnessModels> => {
  const response = await realApi(page, request, "GET", `/api/harnesses/${encodeURIComponent(id)}/models`)
  expect(response.status()).toBe(200)
  return await response.json() as HarnessModels
}

const providerOf = (harness: HarnessRow, model: string): string => {
  if (model.includes("/")) return model.slice(0, model.indexOf("/"))
  if (harness.id === "codex") return "openai"
  if (harness.id === "claude") return "anthropic"
  return harness.id
}

const putAgent = async (
  page: Page,
  request: APIRequestContext,
  id: string,
  harness: HarnessRow,
  model: string,
  purpose: string,
  label = id
): Promise<void> => {
  const response = await realApi(page, request, "PUT", `/api/agents/${encodeURIComponent(id)}`, {
    label,
    purpose,
    harness: harness.id,
    model: { provider: providerOf(harness, model), id: model, label: model }
  })
  expect([200, 201]).toContain(response.status())
}

const deleteAgent = async (page: Page, request: APIRequestContext, id: string): Promise<void> => {
  const response = await realApi(page, request, "DELETE", `/api/agents/${encodeURIComponent(id)}`)
  expect([200, 404]).toContain(response.status())
}

test("installed authenticated harness discovery agrees with the Agents card", scenario("agents.harnesses.discovery", {
  capabilities: ["local.harnesses"],
  coverage: [
    "action:agent.list",
    "host:local",
    "path:success",
    "door:slash",
    "dimension:installed-authenticated-harnesses",
    "evidence:harness-api-and-agents-card"
  ],
  description: "The real local host probes installed CLIs and credential state; the slash-rendered Agents card must project those same available harness-backed roles."
}), async ({ page, request }) => {
  await boot(page)
  const rows = await harnesses(page, request)
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(row.launch.argv[0]).toBeTruthy()
    if (row.status === "unavailable") expect(row.binary).toBeNull()
    else {
      expect(row.binary).toMatch(/^\//)
      expect(row.version === null || row.version.trim() !== "").toBe(true)
    }
  }

  const authenticated = rows.filter((row) => row.binary !== null && (row.status === "signed-in" || row.status === "api-key"))
  expect(authenticated.length, "at least one installed harness must have a real credential").toBeGreaterThan(0)

  const agentsResponse = (await realApi(page, request, "GET", "/api/agents"))
  expect(agentsResponse.status()).toBe(200)
  const agentRows = (await agentsResponse.json() as {
    readonly agents: ReadonlyArray<{ readonly id: string; readonly harness: string }>
  }).agents

  await command(page, "/agent.list")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="agents"]')
  await expect(card).toBeVisible()
  const projected = agentRows.filter((agent) => authenticated.some((row) => row.id === agent.harness))
  expect(projected.length, "at least one authenticated harness backs an agent role").toBeGreaterThan(0)
  for (const agent of projected) {
    const discovered = authenticated.find((row) => row.id === agent.harness)!
    const role = card.locator(`[data-agent="${agent.id}"]`)
    await expect(role).toHaveAttribute("data-available", "true")
    const account = discovered.account?.email ?? discovered.account?.label
    if (account) await expect(role).toContainText(account)
  }
})

test("a real harness model list is projected into the Models card", scenario("agents.harnesses.models", {
  capabilities: ["local.harnesses"],
  coverage: [
    "action:agent.models",
    "host:local",
    "path:success",
    "door:slash",
    "dimension:provider-model-selection",
    "evidence:model-route-and-card"
  ],
  description: "The selected installed harness runs its real model-list probe when supported, and the slash-rendered card agrees with the authenticated API result."
}), async ({ page, request }) => {
  await boot(page)
  const harness = await authenticatedModelHarness(page, request)
  const answer = await harnessModels(page, request, harness.id)
  expect(answer.harnessId).toBe(harness.id)
  expect(answer.models.length, answer.reason ?? `${harness.displayName} returned no models`).toBeGreaterThan(0)

  await command(page, `/agent.models ${harness.id}`)
  await closeComposer(page)
  const card = page.getByTestId(`card-agent-models-${harness.id}`)
  await expect(card).toBeVisible()
  await expect(card.getByTestId("agent-models-list")).toBeVisible()
  await expect(card).toContainText(answer.models[0]!)
})

test("the New agent form creates a custom role with a real selectable harness model", scenario("agents.custom.create-form", {
  capabilities: ["local.harnesses"],
  coverage: [
    "action:agent.new",
    "action:agent.create",
    "action:form.set",
    "action:form.submit",
    "host:local",
    "path:success",
    "door:slash",
    "door:button",
    "dimension:custom-role-create",
    "dimension:provider-model-selection",
    "evidence:agents-api-readback"
  ],
  description: "A partial slash invocation renders the derived form, whose real harness and model seams create a persisted custom role verified through the host API."
}), async ({ page, request }) => {
  await boot(page)
  const id = "s09-create"
  await deleteAgent(page, request, id)
  const harness = await authenticatedModelHarness(page, request)
  const model = harness.models?.suggestions[0]
  if (model === undefined) throw new Error(`${harness.displayName} provided no selectable real model.`)

  await command(page, `/agent.new ${id} ${harness.id}`)
  const form = page.getByTestId("card-form-agent.create")
  await expect(form).toBeVisible()
  await closeComposer(page)
  await expect(form.getByTestId("flow-form-id")).toHaveValue(id)
  await expect(form.getByTestId("flow-form-harness")).toHaveValue(harness.id)
  await form.getByTestId("flow-form-model").fill(model)
  await form.getByTestId("flow-form-purpose").fill("Answers harmless E2E probes")
  await form.getByTestId("flow-form-submit").click()
  await expect(form).toHaveAttribute("data-status", "acted")

  await expect.poll(async () => (await agents(page, request)).find((agent) => agent.id === id)).toMatchObject({
    id,
    purpose: "Answers harmless E2E probes",
    harness: harness.id,
    model: { id: model },
    builtin: false
  })
  await deleteAgent(page, request, id)
})

test("the Agents card edits an independently provisioned custom role", scenario("agents.custom.edit-button", {
  capabilities: ["local.harnesses"],
  coverage: [
    "action:agent.list",
    "action:agent.new",
    "action:agent.edit",
    "action:form.set",
    "action:form.submit",
    "host:local",
    "path:success",
    "door:slash",
    "door:button",
    "dimension:custom-role-edit",
    "evidence:agents-api-readback"
  ],
  description: "A real role fixture is edited through the Agents card and derived form, then read back independently from the persistent agents API."
}), async ({ page, request }) => {
  await boot(page)
  const id = "s09-edit"
  await deleteAgent(page, request, id)
  const harness = await authenticatedModelHarness(page, request)
  const model = harness.models!.suggestions[0]!
  await putAgent(page, request, id, harness, model, "Before edit", "Before edit")

  await command(page, "/agent.list")
  await closeComposer(page)
  const list = page.locator('.smithers-card[data-kind="agents"]')
  await list.getByTestId(`agents-edit-${id}`).click()
  const form = page.getByTestId("card-form-agent.edit")
  await expect(form).toBeVisible()
  await form.getByTestId("flow-form-purpose").fill("Edited through the real UI")
  await form.getByTestId("flow-form-label").fill("S09 editor")
  await form.getByTestId("flow-form-submit").click()
  await expect(form).toHaveAttribute("data-status", "acted")
  await expect.poll(async () => (await agents(page, request)).find((agent) => agent.id === id)).toMatchObject({
    label: "S09 editor",
    purpose: "Edited through the real UI",
    harness: harness.id,
    model: { id: model }
  })
  await deleteAgent(page, request, id)
})

test("the Agents card removes only the selected custom role", scenario("agents.custom.remove-button", {
  capabilities: ["local.harnesses"],
  coverage: [
    "action:agent.list",
    "action:agent.remove",
    "host:local",
    "path:success",
    "door:slash",
    "door:button",
    "dimension:custom-role-delete",
    "dimension:stable-target",
    "evidence:agents-api-readback"
  ],
  description: "The Remove button carries one concrete custom id; the real API proves that row disappeared while a second owned role remained."
}), async ({ page, request }) => {
  await boot(page)
  const target = "s09-remove"
  const control = "s09-keep"
  await deleteAgent(page, request, target)
  await deleteAgent(page, request, control)
  const harness = await authenticatedModelHarness(page, request)
  const model = harness.models!.suggestions[0]!
  await putAgent(page, request, target, harness, model, "Remove me")
  await putAgent(page, request, control, harness, model, "Keep me")

  await command(page, "/agent.list")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="agents"]')
  await card.getByTestId(`agents-remove-${target}`).click()
  await expect.poll(async () => (await agents(page, request)).some((agent) => agent.id === target)).toBe(false)
  expect((await agents(page, request)).some((agent) => agent.id === control)).toBe(true)
  await expect(card.locator(`[data-agent="${target}"]`)).toHaveCount(0)
  await expect(card.locator(`[data-agent="${control}"]`)).toBeVisible()
  await deleteAgent(page, request, control)
})

test("delegation completes a harmless prompt in a real harness and its session can be selected and read", scenario("agents.delegate.completed-session", {
  capabilities: ["local.harnesses", "local.terminal"],
  coverage: [
    "action:agent.delegate",
    "action:tab.select",
    "action:tab.read",
    "host:local",
    "path:success",
    "path:keyboard",
    "door:slash",
    "door:user-only",
    "dimension:real-provider-completion",
    "dimension:keyboard",
    "dimension:session-selection",
    "dimension:session-read",
    "dimension:verbose-readback",
    "evidence:pty-api-output-and-ui"
  ],
  description: "A custom OpenCode role sends one harmless prompt to its authenticated provider, exposes the real PTY through the agent card, exits cleanly, and returns its output through tab.read's verbose flow trace."
}), async ({ page, request }) => {
  test.setTimeout(180_000)
  await boot(page)
  const id = "s09-delegate"
  await deleteAgent(page, request, id)
  const harness = await completedPromptHarness(page, request)
  const model = harness.models!.suggestions[0]
  if (model === undefined) throw new Error(`${harness.displayName} returned no model for a real delegation.`)
  await putAgent(page, request, id, harness, model, "Returns one harmless verification marker")
  await command(page, "/agent.list")
  await closeComposer(page)

  // The expected answer is absent from the prompt: echoed CLI input cannot
  // satisfy the proof that this provider actually completed the task.
  const marker = "323"
  await command(page, `/agent.delegate ${id} Calculate seventeen times nineteen. Reply using decimal digits only. Do not use tools.`)
  let sessionId: string | undefined
  await expect.poll(async () => {
    const response = await realApi(page, request, "GET", "/api/pty")
    if (!response.ok()) return response.status()
    const body = await response.json() as {
      readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly roleId?: string }>
    }
    sessionId = body.sessions.find((session) => session.roleId === id)?.sessionId
    return sessionId
  }, { message: "the slash delegation creates its real role PTY" }).toMatch(/^pty-/)
  if (sessionId === undefined) throw new Error("The real delegation created no session.")
  registerOwnedPty(sessionId)

  const listed = await realApi(page, request, "GET", "/api/pty")
  expect(listed.status()).toBe(200)
  expect((await listed.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> }).sessions)
    .toContainEqual(expect.objectContaining({ sessionId, kind: "harness", harnessId: harness.id, roleId: id, alive: true }))

  // Launching the delegated session selects its real PTY body. Meta+1 is the
  // product's documented keyboard path back to the conversation.
  await expect(page.getByTestId(`tab-body-${sessionId}`)).toBeVisible()
  await expect(page.getByTestId(`terminal-${sessionId}`)).toBeVisible()
  await page.keyboard.press("Meta+1")
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await closeComposer(page)
  const agentCard = page.locator(`.smithers-card[data-kind="agent"] [data-role="${id}"]`).last()
  await expect(agentCard).toBeVisible()

  await expect.poll(async () => {
    const response = await realApi(page, request, "GET", `/api/pty/${encodeURIComponent(sessionId)}/output?tail=16384`)
    if (!response.ok()) return { alive: true, output: "" }
    const body = await response.json() as { readonly alive: boolean; readonly output: string }
    const lines = body.output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).map((line) => line.trim())
    return { alive: body.alive, hasMarker: lines.includes(marker) }
  }, { timeout: 150_000, intervals: [500, 1_000, 2_000] }).toEqual({ alive: false, hasMarker: true })
  await expect(agentCard).toHaveAttribute("data-phase", "exited")

  await command(page, `/tab.select ${sessionId}`)
  await expect(page.getByTestId(`tab-body-${sessionId}`)).toBeVisible()
  await expect(page.getByTestId(`terminal-${sessionId}`).locator(".xterm-rows")).toContainText(marker)
  await page.keyboard.press("Meta+1")
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await closeComposer(page)

  // Command return values are a diagnostic surface. The product's explicit
  // contract projects them into the flow trace while /verbose is enabled.
  await command(page, "/verbose")
  await command(page, `/tab.read ${sessionId}`)
  await page.keyboard.press("Meta+1")
  const readTrace = page.getByTestId("transcript").locator(".tool-act-line")
    .filter({ hasText: `You ran /tab.read ${sessionId}` }).last()
  await expect(readTrace).toContainText(marker)
  const finalRead = await realApi(page, request, "GET", `/api/pty/${encodeURIComponent(sessionId)}/output?tail=16384`)
  expect(finalRead.status()).toBe(200)
  expect(await finalRead.json()).toMatchObject({ alive: false })
  const finalSessions = await realApi(page, request, "GET", "/api/pty")
  expect(finalSessions.status()).toBe(200)
  expect((await finalSessions.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> }).sessions)
    .toContainEqual(expect.objectContaining({ sessionId, alive: false, exitCode: 0 }))
  await deleteAgent(page, request, id)
})

test("the real Explainer provider streams an answer into its embedded card", scenario("agents.explain.real-provider", {
  capabilities: ["agent"],
  coverage: [
    "action:agent.explain",
    "host:local",
    "path:success",
    "door:slash",
    "dimension:real-provider-stream",
    "dimension:embedded-answer",
    "evidence:completed-explain-card"
  ],
  description: "The local app's genuine Smithers Cloud agent seam answers an Explainer turn and settles the embedded explain card; transport refusals are failures."
}), async ({ page }) => {
  test.setTimeout(180_000)
  await boot(page)
  const traffic = await captureTurnTraffic(page)
  await command(page, "/agent.explain In one short sentence, explain the product of seventeen and nineteen. Include the computed result in digits.")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="explain"]').last()
  await expect(card).toBeVisible()
  await expect(card.locator(".explain-card")).toHaveAttribute("data-phase", "answered", { timeout: 150_000 })
  await expect(card.locator(".smithers-card-markdown")).toContainText(/\b323\b/)
  const frames = parseTurnFrames(await traffic.read())
  expect(frames.some((frame) => frame.type === "delta" && frame.kind === "text" && typeof frame.text === "string" && frame.text.length > 0)).toBe(true)
  expect(frames.some((frame) => frame.type === "done" && frame.error === undefined)).toBe(true)
})

test("a real model tool request cannot remove a role before the human confirms", scenario("agents.permission.agent-confirm-remove", {
  capabilities: ["agent", "local.harnesses"],
  coverage: [
    "action:agent.list",
    "action:agent.remove",
    "host:local",
    "path:permission",
    "door:agent",
    "door:button",
    "dimension:consequential-confirmation",
    "dimension:no-side-effect-before-confirm",
    "evidence:model-tool-call-and-agents-api"
  ],
  description: "A real model invokes the consequential agent.remove flow, which must preserve the role until the exact human confirmation button executes the bound removal."
}), async ({ page, request }) => {
  test.setTimeout(180_000)
  await boot(page)
  const id = "s09-confirm"
  await deleteAgent(page, request, id)
  const harness = await authenticatedModelHarness(page, request)
  const model = harness.models!.suggestions[0]!
  await putAgent(page, request, id, harness, model, "Confirmation boundary fixture")
  await command(page, "/agent.list")
  await closeComposer(page)

  const traffic = await captureTurnTraffic(page)
  await command(page, `Use the commands tool now with action execute, name agent.remove, and args ${id}. This checks the app's confirmation boundary.`)
  await closeComposer(page)
  // A real provider may request confirmation more than once in the same turn.
  // Every request must remain inert; activate the latest exactly bound action.
  const confirmation = page.locator(`button[data-flow="agent.remove"][data-flow-args="${id}"]`, { hasText: `Confirm: remove the agent ${id}` }).last()
  await expect(confirmation).toBeVisible({ timeout: 150_000 })
  await expect(page.getByTestId("transcript")).toHaveAttribute("aria-busy", "false", { timeout: 150_000 })
  expect(toolExecution(parseTurnFrames(await traffic.read()), "agent.remove"))
    .toMatchObject({ action: "execute", name: "agent.remove", args: id })
  expect((await agents(page, request)).some((agent) => agent.id === id)).toBe(true)

  await confirmation.click()
  await expect.poll(async () => (await agents(page, request)).some((agent) => agent.id === id)).toBe(false)
})

test("a flag-shaped delegated task is refused before any PTY is created", scenario("agents.delegate.permission-argv", {
  capabilities: ["local.harnesses"],
  coverage: [
    "action:agent.delegate",
    "host:local",
    "path:permission",
    "path:error",
    "door:slash",
    "dimension:argv-boundary",
    "dimension:no-session-side-effect",
    "evidence:pty-inventory-and-refusal"
  ],
  description: "The real role launch boundary rejects a task that begins like a CLI flag, and the independently read PTY inventory proves no process was created."
}), async ({ page, request }) => {
  await boot(page)
  const harness = await completedPromptHarness(page, request)
  const id = "s09-permission"
  await deleteAgent(page, request, id)
  await putAgent(page, request, id, harness, harness.models!.suggestions[0]!, "Permission boundary fixture")
  await command(page, "/agent.list")
  await closeComposer(page)
  const before = (await (await realApi(page, request, "GET", "/api/pty")).json() as { readonly sessions: ReadonlyArray<{ readonly sessionId: string }> }).sessions

  await command(page, `/agent.delegate ${id} --dangerously-skip-permissions`)
  await expect(page.getByRole("alert").filter({ hasText: "Refusing to launch: a task must not start with a dash." })).toBeVisible()
  await closeComposer(page)
  const after = (await (await realApi(page, request, "GET", "/api/pty")).json() as { readonly sessions: ReadonlyArray<{ readonly sessionId: string }> }).sessions
  expect(after.map((session) => session.sessionId)).toEqual(before.map((session) => session.sessionId))
  await deleteAgent(page, request, id)
})
