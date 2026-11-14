// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// Sandboxes in live mode (src/core/LiveFactory.vibe) on a live site whose API Worker has sign-in configured and runs
// the production sandbox gateway, account and machine objects in workerd on an in-memory Container
// (test/workerd/liveSandboxes.vibe, served by e2e/authbroker-host.vibe). A fault is the in-memory Container's own.
import { expect, test, type Page } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_CORE_TEST_ORIGINS!)

/** A fixture session for person `id`, as the browser's cookie; returns the cookie for direct requests. */
async function signIn(page: Page, origin: string, id: string, login: string, browser = true) {
  const issued = await (await page.request.get(`${origin}/__fixture/issue?id=${id}&login=${login}`)).json() as { cookie: string }
  // The fixture names the HTTPS cookie; plain local HTTP has no Secure cookie, so its session is `vibelang-session`.
  const value = issued.cookie.slice(issued.cookie.indexOf("=") + 1)
  if (browser) await page.context().addCookies([{ name: "vibelang-session", value, url: origin, httpOnly: true, sameSite: "Lax" }])
  return `vibelang-session=${value}`
}

/** Opens the live site, sends one message and opens the Sandboxes pane; answers the pane's conversation. */
async function openSandboxes(page: Page, origin: string) {
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/")
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByRole("textbox", { name: "Message" }).fill("hello")
  await page.keyboard.press("Enter")
  const read = page.waitForRequest(request => /\/api\/sandboxes\/[^/]+$/.test(new URL(request.url()).pathname))
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  return new URL((await read).url()).pathname.split("/").pop()!
}

test("a signed-in maintainer starts a live sandbox, runs commands in it and stops it", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await signIn(page, origin, "1", "will")
  await openSandboxes(page, origin)
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(page.getByRole("status", { name: "Sandbox" })).toHaveText("Running")
  const command = page.getByRole("textbox", { name: "Terminal command" })
  for (const line of ["echo saved > keep", "cat keep"]) {
    await command.fill(line)
    await command.press("Enter")
    await expect(command).toBeEnabled()
  }
  await expect(page.getByLabel("Terminal output")).toContainText("saved")
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(page.getByRole("status", { name: "Sandbox" })).not.toHaveText("Running")
  await page.screenshot({ path: info.outputPath("live-sandbox.png"), fullPage: true })
})

test("a live sandbox whose machine never starts shows the refusal and Retry", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await signIn(page, origin, "1", "will")
  const conversation = await openSandboxes(page, origin)
  await page.request.post(`${origin}/__fault/sandbox?machine=1/${conversation}&fault=no-start`)
  await page.getByRole("button", { name: /^(New sandbox|Start)$/ }).first().click()
  const alert = page.getByRole("alert")
  await expect(alert).toBeVisible()
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("live-sandbox-refused.png"), fullPage: true })
})

/** Signs in a fresh contributor `id`, granted by maintainer 1, so their account object holds no earlier journey's sandbox. */
async function signInContributor(page: Page, origin: string, id: string) {
  const maintainer = await signIn(page, origin, "1", "will", false)
  const granted = await page.request.post(`${origin}/api/roles`, { headers: { cookie: maintainer, origin }, data: { id, role: "contributor" } })
  expect(granted.status()).toBe(200)
  await signIn(page, origin, id, `person-${id}`)
}

/** Sets how person `owner`'s account object fails next; no options clears it. */
async function accountFault(page: Page, origin: string, owner: string, fault: { fail?: string; revoked?: boolean } = {}) {
  const query = new URLSearchParams({ account: owner, ...(fault.fail ? { fail: fault.fail } : {}), ...(fault.revoked ? { revoked: "1" } : {}) })
  expect((await page.request.post(`${origin}/__fault/sandbox?${query}`)).status()).toBe(200)
}

test("a live sandbox whose account object resets during a start, a command or a stop shows each failure, and Retry recovers", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const owner = "7"
  await signInContributor(page, origin, owner)
  await openSandboxes(page, origin)
  const status = page.getByRole("status", { name: "Sandbox" })
  const alert = page.getByRole("alert")
  await accountFault(page, origin, owner, { fail: "start" })
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(alert).toBeVisible()
  await expect(status).not.toHaveText("Running")
  await accountFault(page, origin, owner)
  await alert.getByRole("button", { name: "Retry" }).click()
  await expect(status).toHaveText("Running")
  await expect(alert).toHaveCount(0)
  await accountFault(page, origin, owner, { fail: "command" })
  const command = page.getByRole("textbox", { name: "Terminal command" })
  await command.fill("echo lost")
  await command.press("Enter")
  await expect(alert).toBeVisible()
  await expect(page.getByLabel("Terminal output")).not.toContainText("lost")
  await accountFault(page, origin, owner, { fail: "stop" })
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(status).toHaveText("Running")
  await accountFault(page, origin, owner)
  await alert.getByRole("button", { name: "Retry" }).click()
  await expect(status).not.toHaveText("Running")
  await expect(alert).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("live-sandbox-reset.png"), fullPage: true })
})

test("a person whose role was taken away after the page's last read is refused: the read fails, then a start", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const owner = "8"
  await signInContributor(page, origin, owner)
  await openSandboxes(page, origin)
  const start = page.getByRole("button", { name: "New sandbox" })
  await expect(start).toBeEnabled()
  await accountFault(page, origin, owner, { revoked: true })
  const alert = page.getByRole("alert")
  // The open pane's next read is refused and shown; the last snapshot, with its Start, stays.
  await expect(alert).toBeVisible()
  await start.click()
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(page.getByRole("status", { name: "Sandbox" })).not.toHaveText("Running")
  await page.screenshot({ path: info.outputPath("live-sandbox-revoked.png"), fullPage: true })
  await accountFault(page, origin, owner)
})

test("a live message past the sequencer's limit is refused, two past the body limit fail and a retry fails again; the next one is sent", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await signIn(page, origin, "1", "will")
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/")
  await expect(page.locator(".vl-app")).toHaveAttribute("data-mode", "live")
  await page.keyboard.press("ControlOrMeta+k")
  const message = page.getByRole("textbox", { name: "Message" })
  // 8,001 characters: the request fits, and the real sequencer refuses the text (409).
  await message.fill("a".repeat(8001))
  await message.press("Enter")
  await expect(page.getByText("Message too long")).toBeVisible()
  // 40,000 characters: past the Worker's post body limit, which answers 413 before the sequencer.
  const failed = page.getByText("Send failed")
  const retry = page.getByRole("button", { name: "Retry" })
  for (const letter of ["b", "c"]) {
    await message.fill(letter.repeat(40000))
    await message.press("Enter")
  }
  await expect(failed).toHaveCount(2)
  await expect(retry).toHaveCount(3)
  // Retrying one failed post leaves the others as they are; it fails again.
  await retry.nth(1).click()
  await expect(failed).toHaveCount(2)
  await expect(retry).toHaveCount(3)
  // The live conversation outlives an attempt: a retry or repeat must not find the earlier attempt's post.
  const sent = `short and sent ${info.repeatEachIndex}-${info.retry}`
  await message.fill(sent)
  await message.press("Enter")
  await expect(page.getByText(sent)).toBeVisible()
  await expect(page.getByText("Message too long")).toBeVisible()
  await page.screenshot({ path: info.outputPath("live-post-limits.png"), fullPage: true })
})

test("a site whose API Worker fails its health check starts in the mock", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  expect((await page.request.post(`${origin}/__fault/health?down=1`)).status()).toBe(200)
  try {
    await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
    await page.goto(origin + "/")
    await expect(page.locator(".vl-app")).toHaveAttribute("data-mode", "mock")
    await expect(page.getByText("Mock", { exact: true })).toBeVisible()
  } finally {
    expect((await page.request.post(`${origin}/__fault/health?down=0`)).status()).toBe(200)
  }
})
