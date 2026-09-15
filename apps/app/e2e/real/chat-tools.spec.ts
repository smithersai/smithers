import type { TestInfo } from "@playwright/test"
import {
  closeComposer,
  command,
  createOwnedLocalRepo,
  expect,
  openComposer,
  realApi,
  test
} from "./support/test"
import { scenario } from "./coverage/types"
import { launchFaultHarness } from "./chat-tools/fault-process"
import {
  assertOwnedFile,
  assistantMessages,
  bootWorkspace,
  frameLocation,
  captureTurnTraffic,
  captureCancelReply,
  completedAssistantContaining,
  nextTurnResponse,
  openOwnedRepoThroughSlash,
  parseTurnFrames,
  selectOwnedRepo,
  toolExecution,
  transcript
} from "./chat-tools/ui"

test.setTimeout(180_000)
test.use({ actionTimeout: 20_000 })

const attachJson = async (testInfo: TestInfo, name: string, value: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

test("a grounded answer arrives as multiple real stream frames and completes in the transcript", scenario("chat.stream-grounded", {
  capabilities: ["agent"],
  coverage: ["action:chat.send", "host:local", "host:production", "path:success", "door:user-only", "dimension:streaming", "evidence:agent-turn-ndjson"],
  description: "Send a unique grounded prompt through the composer and correlate the rendered answer with multiple backend NDJSON deltas."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const marker = `STREAM_GROUNDED_${Date.now()}`
  const expected = `${marker} ${Array.from({ length: 48 }, (_, index) => `word${index + 1}`).join(" ")}`
  const traffic = await captureTurnTraffic(page)
  const turnResponse = nextTurnResponse(page)

  await command(page, `Reply with exactly the following line and no other text:\n${expected}`)
  expect((await turnResponse).status()).toBe(200)
  const answer = await completedAssistantContaining(page, marker)
  await expect(answer.locator(".message-markdown")).toContainText(expected)

  const bodies = await traffic.read()
  const frames = parseTurnFrames(bodies)
  const deltas = frames.filter((frame) => frame.type === "delta" && frame.kind === "text" && typeof frame.text === "string" && frame.text.length > 0)
  expect(deltas.length).toBeGreaterThan(1)
  expect(deltas.map((frame) => frame.text).join("")).toContain(expected)
  expect(frames.some((frame) => frame.type === "done" && frame.error === undefined)).toBe(true)
  await attachJson(testInfo, "real-stream-frames", frames)
})

test("the model invokes files.read against an owned repository and grounds its answer in disk bytes", scenario("chat.tool-files-read", {
  capabilities: ["agent", "local.repositories"],
  coverage: ["action:chat.send", "action:repo.open", "action:files.read", "host:local", "path:success", "door:slash", "door:agent", "dimension:tool-loop", "dimension:grounding", "evidence:tool-call-and-repo-read"],
  description: "Open a disposable jj repository through the UI, require the agent to read a real file, and verify both tool traffic and filesystem truth."
}), async ({ page }, testInfo) => {
  const fileText = `owned file truth ${Date.now()}\nsecond line\n`
  const marker = `FILE_READ_${Date.now()}`
  const repo = await createOwnedLocalRepo({ name: `chat-file-${Date.now()}`, files: { "context.txt": fileText } })
  await bootWorkspace(page)
  const opened = await openOwnedRepoThroughSlash(page, repo)
  const fileResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/repo/files" && response.status() === 200)
  const traffic = await captureTurnTraffic(page)
  const turnResponse = nextTurnResponse(page)

  await command(page, `Use the commands tool to execute files.read with args context.txt. Read the tool result before answering. Then answer with ${marker} followed by the exact first line of the file.`)
  expect((await turnResponse).status()).toBe(200)
  const answer = await completedAssistantContaining(page, marker)
  await expect(answer).toContainText(fileText.split("\n")[0]!)
  const readResponse = await fileResponse
  expect(readResponse.request().postDataJSON()).toEqual({ repoId: opened.id, path: "context.txt" })
  const readUrl = new URL(readResponse.url())
  expect(readResponse.request().method()).toBe("POST")
  const independentRead = await realApi(page, page.context().request, "POST", readUrl.pathname + readUrl.search, readResponse.request().postDataJSON())
  expect(independentRead.status()).toBe(200)
  const readBody = await independentRead.json() as { readonly content?: unknown; readonly path?: unknown }
  expect(readBody.path).toBe("context.txt")
  expect(readBody.content).toBe(fileText)

  const frames = parseTurnFrames(await traffic.read())
  const execution = toolExecution(frames, "files.read")
  expect(execution?.args).toMatch(/^context\.txt(?:\s|$)/)
  await expect(transcript(page).locator('.smithers-card[data-kind="file"]')).toContainText("context.txt")
  await assertOwnedFile(repo, "context.txt", fileText)
  await attachJson(testInfo, "files-read-evidence", { execution, readBody, frames })
})

test("the model invokes browser.open and cites content returned by the real fetch service", scenario("chat.tool-browser-open", {
  capabilities: ["agent", "browser.read"],
  coverage: ["action:chat.send", "action:browser.open", "host:local", "host:production", "path:success", "door:agent", "dimension:tool-loop", "dimension:network", "evidence:browser-tool-and-fetch"],
  description: "Require a real backend tool call to browser.open, correlate it with browser-fetch traffic, and verify the model reads the public page."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const marker = `BROWSER_TOOL_${Date.now()}`
  const fetchResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tools/browser-fetch")
  const traffic = await captureTurnTraffic(page)
  const turnResponse = nextTurnResponse(page)

  await command(page, `Use the commands tool to execute browser.open with args https://example.com/. Read the returned page before answering. Then answer with ${marker} and the page heading.`)
  expect((await turnResponse).status()).toBe(200)
  const answer = await completedAssistantContaining(page, marker)
  await expect(answer).toContainText("Example Domain")
  const fetched = await fetchResponse
  expect(fetched.status()).toBe(200)
  const independentFetch = await realApi(page, page.context().request, "POST", "/api/tools/browser-fetch", fetched.request().postDataJSON())
  expect(independentFetch.status()).toBe(200)
  const fetchBody = await independentFetch.json() as { readonly text?: unknown; readonly finalUrl?: unknown }
  expect(fetchBody.text).toContain("Example Domain")
  expect(fetchBody.finalUrl).toBe("https://example.com/")

  const frames = parseTurnFrames(await traffic.read())
  const execution = toolExecution(frames, "browser.open")
  expect(execution?.args).toBe("https://example.com/")
  const card = transcript(page).locator('.smithers-card[data-kind="browser"]')
  await expect(card.locator(".browser-card-url")).toContainText("https://example.com/")
  await attachJson(testInfo, "browser-tool-evidence", { execution, fetchBody, frames })
})

test("Stop generating cancels the live backend turn and leaves an honest stable interruption", scenario("chat.stop-real-turn", {
  capabilities: ["agent"],
  coverage: ["action:chat.send", "action:chat.stop", "host:local", "host:production", "path:success", "door:button", "door:user-only", "dimension:cancellation", "evidence:backend-cancel-ack"],
  description: "Start a long real model response, stop it through the visible control, and verify the cancellation endpoint and stable interrupted state."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const marker = `STOP_REAL_${Date.now()}`
  await command(page, `Write a detailed 2500-word technical essay about distributed systems. Begin with ${marker}.`)
  await openComposer(page)
  const stop = page.locator('[data-flow="chat.stop"]:visible')
  await expect(stop).toBeVisible({ timeout: 30_000 })
  const cancelTraffic = await captureCancelReply(page)
  const cancelling = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/turn/cancel")
  await stop.click()

  const cancelResponse = await cancelling
  expect(cancelResponse.status()).toBe(200)
  const cancelBodies = await cancelTraffic.read()
  expect(cancelBodies).toHaveLength(1)
  const cancelBody = JSON.parse(cancelBodies[0]!) as { readonly ok?: unknown; readonly status?: unknown }
  expect(cancelBody.ok).toBe(true)
  expect(cancelBody.status).toBe("cancelled")
  const interrupted = assistantMessages(page).last()
  await expect(interrupted.locator(".bubble-system-note")).toContainText("Turn interrupted")
  await expect(transcript(page)).toHaveAttribute("aria-busy", "false")
  const stableText = await interrupted.textContent()
  await page.waitForTimeout(750)
  expect(await interrupted.textContent()).toBe(stableText)
  await attachJson(testInfo, "cancel-evidence", cancelBody)
})

test("a killed real chat transport fails visibly and Retry succeeds after the process returns", scenario("chat.failure-retry-process", {
  capabilities: ["agent"],
  coverage: ["action:chat.send", "action:chat.retry", "host:local", "path:error", "path:success", "door:button", "dimension:process-fault", "dimension:retry", "evidence:killed-upstream-process-and-retry"],
  description: "Kill an actual passthrough process used by a real product server, observe the failed turn, restart it, and retry through the UI."
}), async ({ page, request }, testInfo) => {
  const harness = await launchFaultHarness()
  try {
    await bootWorkspace(page, harness.origin)
    const bootstrapResponse = await realApi(page, request, "GET", "/api/bootstrap")
    expect(bootstrapResponse.status()).toBe(200)
    const bootstrap = await bootstrapResponse.json() as { readonly host?: unknown; readonly capabilities?: unknown }
    expect(bootstrap.host).toBe("local")
    expect(Array.isArray(bootstrap.capabilities) && bootstrap.capabilities.includes("agent")).toBe(true)

    const marker = `RETRY_RECOVERED_${Date.now()}`
    const prompt = `Reply with exactly ${marker}`
    await harness.fault()
    const failedTraffic = await captureTurnTraffic(page)
    await command(page, prompt)
    const failed = assistantMessages(page).last()
    await expect(failed.locator(".bubble-system-note")).toHaveText("Turn failed", { timeout: 30_000 })
    const failedFrames = parseTurnFrames(await failedTraffic.read())
    expect(failedFrames.some((frame) => frame.type === "done" && typeof frame.error === "string")).toBe(true)

    await harness.restore()
    const retryTraffic = await captureTurnTraffic(page)
    await closeComposer(page)
    const retry = failed.getByRole("button", { name: "Retry turn", exact: true })
    await retry.focus()
    await retry.press("Enter")
    await completedAssistantContaining(page, marker)
    const retryFrames = parseTurnFrames(await retryTraffic.read())
    expect(retryFrames.some((frame) => frame.type === "done" && frame.error === undefined)).toBe(true)
    await expect(transcript(page).locator('.smithers-chat-message[data-role="user"]').filter({ hasText: prompt })).toHaveCount(1)
    await attachJson(testInfo, "process-fault-evidence", {
      processLog: harness.evidence(),
      failedFrames,
      retryFrames
    })
  } finally {
    await harness.close()
  }
})

test("a multiline draft survives keyboard dismissal and a real reload before submission", scenario("chat.multiline-draft-persistence", {
  capabilities: [],
  coverage: ["action:chat.open", "host:local", "host:production", "path:keyboard", "path:persistence", "door:user-only", "dimension:keyboard", "dimension:multiline-draft", "evidence:reload-draft-value"],
  description: "Create a multiline draft using Shift+Enter, dismiss and reopen the composer, then reload and verify the exact draft remains."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  const first = `draft-first-${Date.now()}`
  const second = `draft-second-${Date.now()}`
  await input.fill(first)
  await input.press("Shift+Enter")
  await input.type(second)
  const expected = `${first}\n${second}`
  await expect(input).toHaveValue(expected)
  await closeComposer(page)
  await openComposer(page)
  await expect(input).toHaveValue(expected)
  await closeComposer(page)
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "Chat", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveValue(expected)
  await attachJson(testInfo, "draft-persistence-evidence", { expected, url: page.url() })
})

test("Copy message writes the complete rendered catalog to the real browser clipboard", scenario("chat.copy-message-clipboard", {
  capabilities: [],
  coverage: ["action:chat.commands", "action:chat.copy-message", "host:local", "host:production", "path:success", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:clipboard", "evidence:browser-clipboard-readback"],
  description: "Render the command catalog, use its Copy message control, and independently read the browser clipboard contents."
}), async ({ page, context }, testInfo) => {
  await bootWorkspace(page)
  await command(page, "/chat.commands")
  const catalog = transcript(page).locator(".smithers-chat-message").filter({ hasText: "/chat.stop" }).last()
  await expect(catalog).toContainText("/chat.send")
  await closeComposer(page)
  const heading = await catalog.locator(".message-markdown p").first().innerText()
  const rows = await catalog.locator(".message-markdown li").evaluateAll((items) => {
    const markdown = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
      const contents = [...node.childNodes].map(markdown).join("")
      return node instanceof HTMLElement && node.tagName === "CODE" ? "`" + contents + "`" : contents
    }
    return items.map(markdown)
  })
  const expected = `${heading}\n\n${rows.map((row) => `- ${row}`).join("\n")}\n\nType \`/\` in the composer to filter these as you type.`
  expect(rows.length).toBeGreaterThan(1)
  const origin = new URL(page.url()).origin
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
  const copy = catalog.getByRole("button", { name: "Copy message", exact: true })
  await copy.focus()
  await expect(copy).toBeFocused()
  await copy.press("Enter")
  await expect(catalog.getByRole("button", { name: "Copied", exact: true })).toBeVisible()
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboard).toBe(expected)
  await attachJson(testInfo, "clipboard-evidence", { length: clipboard.length, exactMatch: clipboard === expected })

})

test("clear archives a conversation and its recovery link restores the exact card after reload", scenario("chat.clear-archive-restore", {
  capabilities: [],
  coverage: ["action:appearance.theme", "action:chat.clear", "host:local", "host:production", "path:success", "path:persistence", "door:slash", "door:button", "dimension:archive", "evidence:url-and-card-restoration"],
  description: "Create durable conversation content, archive via the UI, reload the new branch, and restore the previous branch through its rendered link."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  await command(page, "/appearance.theme")
  const card = transcript(page).locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = await card.getAttribute("data-testid")
  expect(typeof cardId).toBe("string")
  await closeComposer(page)
  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "false")
  const originalUrl = page.url()
  const originalFrame = await frameLocation(page)

  await command(page, "/chat.clear")
  await closeComposer(page)
  const recovery = page.getByRole("link", { name: "Open the archived conversation", exact: true })
  await expect(recovery).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect.poll(async () => (await frameLocation(page)).branchId).not.toBe(originalFrame.branchId)
  const archivedFrame = await frameLocation(page)
  expect(page.url()).toBe(originalUrl)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(recovery).toBeVisible()
  await recovery.click()
  await expect(page).toHaveURL(originalUrl)
  await expect(page.locator(".guide-shell")).toHaveCount(0)
  await expect.poll(() => frameLocation(page)).toEqual(originalFrame)
  await expect(page.getByTestId(cardId!)).toBeVisible()
  await page.goBack()
  await expect.poll(() => frameLocation(page)).toEqual(archivedFrame)
  await expect(page).toHaveURL(originalUrl)
  await expect(page.getByRole("link", { name: "Open the archived conversation", exact: true })).toBeVisible()
  await attachJson(testInfo, "archive-evidence", { originalUrl, originalFrame, archivedFrame, cardId })
})

test("repository switching routes successive model reads to the selected filesystem", scenario("chat.repository-tool-context", {
  capabilities: ["agent", "local.repositories"],
  coverage: ["action:repo.open", "action:repo.select", "action:files.read", "action:chat.send", "host:local", "path:success", "door:slash", "door:agent", "dimension:repository-context", "evidence:disk-and-model-tool-context"],
  description: "Read distinct same-named files through the real model after each UI repository selection, requiring both answers and tool calls to agree with the selected filesystem."
}), async ({ page, request }, testInfo) => {
  const stamp = Date.now()
  const firstText = "The orchard grows apricots.\n"
  const secondText = "The harbor shelters narwhals.\n"
  const first = await createOwnedLocalRepo({ name: `chat-alpha-${stamp}`, files: { "context.txt": firstText } })
  const second = await createOwnedLocalRepo({ name: `chat-beta-${stamp}`, files: { "context.txt": secondText } })
  await bootWorkspace(page)

  const firstOpened = await openOwnedRepoThroughSlash(page, first)
  const firstTurn = nextTurnResponse(page)
  const firstTraffic = await captureTurnTraffic(page)
  await command(page, "Use the commands tool to execute files.read with args context.txt in the active repository. Reply with its exact first line after reading the result.")
  expect((await firstTurn).status()).toBe(200)
  await completedAssistantContaining(page, "apricots")
  const firstFrames = parseTurnFrames(await firstTraffic.read())
  await attachJson(testInfo, "first-repository-model-frames", firstFrames)
  expect(toolExecution(firstFrames, "files.read")?.args).toMatch(/^context\.txt(?:\s|$)/)

  const secondOpened = await openOwnedRepoThroughSlash(page, second)
  const secondTurn = nextTurnResponse(page)
  const secondTraffic = await captureTurnTraffic(page)
  await command(page, "Use the commands tool to execute files.read with args context.txt in the newly active repository. Reply with its exact first line after reading the result.")
  expect((await secondTurn).status()).toBe(200)
  await expect(transcript(page)).toHaveAttribute("aria-busy", "false", { timeout: 90_000 })
  const secondFrames = parseTurnFrames(await secondTraffic.read())
  await attachJson(testInfo, "second-repository-model-frames", secondFrames)
  await completedAssistantContaining(page, "narwhals")
  expect(toolExecution(secondFrames, "files.read")?.args).toMatch(/^context\.txt(?:\s|$)/)
  await assertOwnedFile(first, "context.txt", firstText)
  await assertOwnedFile(second, "context.txt", secondText)
  await attachJson(testInfo, "selected-model-repositories", { firstOpened, secondOpened })
})

test("repository selection reads each filesystem and preserves both cards after reload", scenario("chat.repository-selection-persistence", {
  capabilities: ["local.repositories"],
  coverage: ["action:repo.open", "action:repo.select", "action:files.read", "host:local", "path:success", "path:persistence", "door:slash", "door:user-only", "dimension:repository-context", "evidence:disk-api-and-persisted-repository-cards"],
  description: "Independently verify repository selection and shared card persistence without allowing a model-context failure to block these UI and filesystem assertions."
}), async ({ page, request }, testInfo) => {
  const stamp = Date.now()
  const firstText = `ALPHA_DISK_TRUTH_${stamp}\n`
  const secondText = `BETA_DISK_TRUTH_${stamp}\n`
  const first = await createOwnedLocalRepo({ name: `chat-disk-alpha-${stamp}`, files: { "context.txt": firstText } })
  const second = await createOwnedLocalRepo({ name: `chat-disk-beta-${stamp}`, files: { "context.txt": secondText } })
  await bootWorkspace(page)
  const firstOpened = await openOwnedRepoThroughSlash(page, first)
  const secondOpened = await openOwnedRepoThroughSlash(page, second)
  await selectOwnedRepo(page, first)
  await command(page, "/files.read context.txt")
  await closeComposer(page)
  const alphaCard = page.getByTestId(`card-file-${firstOpened.id}-context.txt`)
  await expect(alphaCard).toContainText(firstText.trim())
  await expect(alphaCard).not.toContainText(secondText.trim())
  await selectOwnedRepo(page, second)
  await command(page, "/files.read context.txt")
  await closeComposer(page)
  const betaCard = page.getByTestId(`card-file-${secondOpened.id}-context.txt`)
  await expect(betaCard).toContainText(secondText.trim())
  await expect(betaCard).not.toContainText(firstText.trim())
  await page.reload()
  await expect(transcript(page)).toContainText(firstText.trim())
  await expect(transcript(page)).toContainText(secondText.trim())
  await expect(alphaCard).toContainText(firstText.trim())
  await expect(betaCard).toContainText(secondText.trim())

  const listedResponse = await realApi(page, request, "GET", "/api/repos")
  expect(listedResponse.status()).toBe(200)
  const listed = await listedResponse.json() as { readonly repos?: ReadonlyArray<{ readonly id?: unknown; readonly path?: unknown }> }
  expect(listed.repos?.some((repo) => repo.id === firstOpened.id && repo.path === first.path)).toBe(true)
  expect(listed.repos?.some((repo) => repo.id === secondOpened.id && repo.path === second.path)).toBe(true)
  await assertOwnedFile(first, "context.txt", firstText)
  await assertOwnedFile(second, "context.txt", secondText)
  await attachJson(testInfo, "repository-isolation-evidence", { firstOpened, secondOpened, listed })
})

test("slash browser.open fetches and renders a public page without interception", scenario("chat.browser-fetch-public", {
  capabilities: ["browser.read"],
  coverage: ["action:browser.open", "host:local", "host:production", "path:success", "door:slash", "dimension:network", "evidence:browser-fetch-response"],
  description: "Open a public URL through the slash door and verify the real fetch response and rendered browser card."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const fetching = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tools/browser-fetch")
  await command(page, "/browser.open https://example.com/")
  const response = await fetching
  expect(response.status()).toBe(200)
  const body = await response.json() as { readonly text?: unknown; readonly finalUrl?: unknown; readonly frameable?: unknown }
  expect(body.text).toContain("Example Domain")
  expect(body.finalUrl).toBe("https://example.com/")
  const card = transcript(page).locator('.smithers-card[data-kind="browser"]')
  await expect(card).toBeVisible()
  await expect(card.locator(".browser-card-url")).toContainText("https://example.com/")
  await attachJson(testInfo, "public-browser-fetch-evidence", body)
})

test("slash browser.open exposes the real service rejection for a loopback target", scenario("chat.browser-fetch-private-error", {
  capabilities: ["browser.read"],
  coverage: ["action:browser.open", "host:local", "host:production", "path:error", "door:slash", "dimension:ssrf", "dimension:network"],
  description: "Attempt a loopback fetch through the real UI and require the browser-fetch service and card to expose the protected-target error."
}), async ({ page }, testInfo) => {
  await bootWorkspace(page)
  const fetching = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tools/browser-fetch")
  await command(page, "/browser.open https://127.0.0.1/")
  const response = await fetching
  expect(response.status()).toBeGreaterThanOrEqual(400)
  const body = await response.json() as { readonly message?: unknown }
  expect(typeof body.message).toBe("string")
  const card = transcript(page).locator('.smithers-card[data-kind="browser"]')
  await expect(card).toBeVisible()
  await expect(card.getByRole("alert")).toBeVisible()
  await attachJson(testInfo, "private-browser-fetch-evidence", { status: response.status(), body })
})

test("production recommendations come from the live recommender and clicking one reports its outcome", scenario("chat.production-recommendation-outcome", {
  capabilities: ["agent", "cloud"],
  coverage: ["action:chat.send", "action:system.recommend", "host:production", "path:success", "door:button", "dimension:recommendations", "dimension:network", "evidence:recommend-answer-and-outcome"],
  description: "On smithers.sh, complete a real turn, match rendered pills to the live recommendation answer, and verify the chosen outcome request."
}), async ({ page, request }, testInfo) => {
  await bootWorkspace(page)
  const sessionResponse = await realApi(page, request, "GET", "/api/auth/session")
  expect(sessionResponse.status()).toBe(200)
  const identity = await sessionResponse.json() as { readonly login?: unknown; readonly allowlisted?: unknown }
  expect(identity.login,
    "Live recommendation success requires a real signed-in production browser session; anonymous refusal is not coverage.")
    .toEqual(expect.any(String))
  expect((identity.login as string).trim()).not.toBe("")
  expect(identity.allowlisted, "The real identity must have access to production chat.").toBe(true)
  const bootstrapResponse = await realApi(page, request, "GET", "/api/bootstrap")
  expect(bootstrapResponse.status()).toBe(200)
  const bootstrap = await bootstrapResponse.json() as { readonly host?: unknown; readonly buildSha?: unknown }
  expect(bootstrap.host, "This scenario requires the production cloud host.").toBe("cloud")
  expect(typeof bootstrap.buildSha).toBe("string")

  const marker = `RECOMMEND_${Date.now()}`
  const recommendation = page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/recommend") return false
    return response.request().postData()?.includes(marker) === true
  }, { timeout: 120_000 })
  await command(page, `Reply with exactly ${marker}`)
  await completedAssistantContaining(page, marker)
  const response = await recommendation
  expect(response.status()).toBe(200)
  const answer = await response.json() as { readonly id?: unknown; readonly model?: unknown; readonly commands?: readonly unknown[] }
  expect(typeof answer.id).toBe("string")
  expect(typeof answer.model).toBe("string")
  expect(Array.isArray(answer.commands) && answer.commands.length > 0).toBe(true)

  await openComposer(page)
  const offered = await page.locator(".smithers-suggestion").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-flow")).filter((flow): flow is string => flow !== null))
  expect(offered.length).toBeGreaterThan(0)
  const safeActions = new Set(["wiki", "chat.commands", "chat.surfaces", "appearance.theme", "search.open", "auth.prompt", "cloud.prompt"])
  const recommended = answer.commands!.find((entry): entry is string => typeof entry === "string" && safeActions.has(entry.replace(/^\/+/, "")) && offered.includes(entry.replace(/^\/+/, "")))
  expect(typeof recommended).toBe("string")
  const flow = recommended!.replace(/^\/+/, "")
  const outcome = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/recommend/outcome")
  await page.locator(`.smithers-suggestion[data-flow="${flow}"]`).click()
  const outcomeResponse = await outcome
  expect(outcomeResponse.status()).toBe(200)
  const outcomeRequest = outcomeResponse.request().postDataJSON() as { readonly id?: unknown; readonly command?: unknown }
  expect(outcomeRequest).toEqual({ id: answer.id, command: flow })
  await attachJson(testInfo, "recommendation-evidence", { bootstrap, answer, offered, outcomeRequest })
})

test("files.add explains the unavailable attachment capability through its slash action", scenario("chat.attachment-unavailable", {
  capabilities: [],
  coverage: ["action:files.add", "host:local", "host:production", "path:error", "door:slash", "dimension:attachment-unavailable"],
  description: "The shipped host explicitly lacks attachment upload; the registered files.add action must explain that limitation and its supported repository alternative."
}), async ({ page }) => {
  await bootWorkspace(page)
  await command(page, "/files.add")
  await closeComposer(page)
  await expect(transcript(page)).toContainText("Attachments aren't available on this host yet. Connect a repository and Smithers can read its files.")
})
