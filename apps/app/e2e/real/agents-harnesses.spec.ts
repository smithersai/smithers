import { captureTurnTraffic, parseTurnFrames } from "./chat-tools/ui"
import type { APIRequestContext, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, realApi, registerOwnedPty, test } from "./support/test"
import { enterCanonicalRepositoryApp } from "./navigation-frames/cards"

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
  description: "A built-in OpenCode role sends one harmless prompt to its authenticated provider, exposes the real PTY through the agent card, exits cleanly, and returns its output through tab.read's verbose flow trace."
}), async ({ page, request }) => {
  test.setTimeout(180_000)
  await boot(page)
  const harness = await completedPromptHarness(page, request)
  const role = (await agents(page, request)).find(role => role.builtin && role.harness === harness.id)
  if (role === undefined) throw new Error(`No built-in role uses ${harness.displayName}`)
  const id = role.id
  await command(page, "/agent.list")
  await closeComposer(page)

  // The expected answer is absent from the prompt: echoed CLI input cannot
  // satisfy the proof that this provider actually completed the task.
  const marker = "323"
  await command(page, `/agent.delegate ${id} Calculate seventeen times nineteen. Reply using decimal digits only. Do not use tools.`)
  let discoveredSessionId: string | undefined
  await expect.poll(async () => {
    const response = await realApi(page, request, "GET", "/api/pty")
    if (!response.ok()) return response.status()
    const body = await response.json() as {
      readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly roleId?: string }>
    }
    discoveredSessionId = body.sessions.find((session) => session.roleId === id)?.sessionId
    return discoveredSessionId
  }, { message: "the slash delegation creates its real role PTY" }).toMatch(/^pty-/)
  if (discoveredSessionId === undefined) throw new Error("The real delegation created no session.")
  const sessionId = discoveredSessionId
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
  const role = (await agents(page, request)).find(role => role.builtin && role.harness === harness.id)
  if (role === undefined) throw new Error(`No built-in role uses ${harness.displayName}`)
  const id = role.id
  await command(page, "/agent.list")
  await closeComposer(page)
  const before = (await (await realApi(page, request, "GET", "/api/pty")).json() as { readonly sessions: ReadonlyArray<{ readonly sessionId: string }> }).sessions

  await command(page, `/agent.delegate ${id} --dangerously-skip-permissions`)
  await expect(page.getByRole("alert").filter({ hasText: "Refusing to launch: a task must not start with a dash." })).toBeVisible()
  await closeComposer(page)
  const after = (await (await realApi(page, request, "GET", "/api/pty")).json() as { readonly sessions: ReadonlyArray<{ readonly sessionId: string }> }).sessions
  expect(after.map((session) => session.sessionId)).toEqual(before.map((session) => session.sessionId))
})
