// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "@playwright/test"
import type { Client, Conversation } from "../src/core/conversation.vibe"

declare global {
  interface Window {
    recovery: {
      snapshot: () => { client: Client; subscriptions: Array<{ conversation: string; after: number }>; delivered: number[] }
      canonical: () => Promise<Conversation>
      release: () => Promise<void>
    }
  }
}

test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_4502 ?? process.env.E2E_PORT ?? 4173}` })

for (const fault of ["drop", "disconnect", "end"] as const) {
  test(`11: ${fault} recovers through the real subscriptions and stays live without duplicates`, async ({ page }) => {
    // This fixture is local-only; deployment runs still exercise the same browser runtime via the local test host.
    await page.goto(`/e2e/runtime/index.html?fault=${fault}`)
    await page.keyboard.press("ControlOrMeta+k")
    const prompt = page.getByRole("textbox", { name: "Message" })
    await expect(prompt).toBeFocused()
    await prompt.pressSequentially("What is a service?")
    await expect(prompt).toHaveValue("What is a service?")
    await prompt.press("Enter")
    const answers = page.locator(".sui-chat-message[data-role='assistant']")
    if (fault !== "drop") {
      const reconnect = page.getByRole("button", { name: "Reconnect" })
      await expect(reconnect).toBeVisible()
      await expect(answers).toHaveAttribute("data-done", "false")
      await expect(answers.locator(".sui-chat-bubble")).not.toBeEmpty()
      const interrupted = await page.evaluate(() => window.recovery.snapshot())
      expect(interrupted.client.conversation.seq).toBe(3)
      expect(interrupted.subscriptions.map(item => item.after)).toEqual([0])
      const connection = page.getByRole("status", { name: "Connection" })
      await expect(connection).toHaveText("Disconnected")
      const cdp = await page.context().newCDPSession(page)
      const { nodes } = await cdp.send("Accessibility.getFullAXTree")
      const status = nodes.find(node => node.role?.value === "status" && node.name?.value === "Connection")!
      expect(status.properties).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "live", value: expect.objectContaining({ value: "polite" }) }),
      ]))
      await reconnect.click()
      await expect(connection).toHaveText("Connected")
    }
    await expect(answers).toHaveAttribute("data-done", "true", { timeout: 15_000 })
    const [snapshot, canonical] = await page.evaluate(async () => [window.recovery.snapshot(), await window.recovery.canonical()] as const)
    expect(snapshot.subscriptions).toEqual([
      { conversation: "home", after: 0 }, { conversation: "home", after: fault === "drop" ? 2 : 3 },
    ])
    expect(snapshot.client.conversation).toEqual(canonical)
    expect(snapshot.client.pending).toEqual([])
    expect(snapshot.client.conversation.entries).toHaveLength(2)
    expect(new Set(snapshot.client.conversation.entries.map(entry => entry.id)).size).toBe(2)
    if (fault === "drop") expect(snapshot.delivered.filter(seq => seq === 4)).toHaveLength(2)
    await expect(prompt).toBeFocused()
    await prompt.pressSequentially("How do I install it?")
    await expect(prompt).toHaveValue("How do I install it?")
    await prompt.press("Enter")
    await expect(answers).toHaveCount(2)
    await expect(answers.last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
    await expect(answers.last()).toContainText("npm create vibelang@latest my-app")
    const continued = await page.evaluate(() => window.recovery.snapshot())
    expect(continued.client.conversation.entries).toHaveLength(4)
    expect(continued.subscriptions).toEqual(snapshot.subscriptions)
  })
}


test("a failed post offers Retry, preserving its identity and neutral wire name", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?fault=refuse")
  await expect(page.locator(".vl-pill")).not.toHaveAttribute("title")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  const prompt = page.getByRole("textbox", { name: "Message" })
  await expect(prompt).toBeFocused()
  await prompt.fill("install")
  await prompt.press("Enter")
  const pending = page.locator("[data-pending='true']")
  await expect(pending).toContainText("Send failed")
  await expect(pending).not.toContainText("Factory closed")
  const before = await page.evaluate(() => window.recovery.snapshot().client.pending)
  await pending.getByRole("button", { name: "Retry" }).click()
  await expect(prompt).toBeFocused()
  await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(1)
  await expect(pending).toHaveCount(0)
  const entries = await page.evaluate(() => window.recovery.snapshot().client.conversation.entries)
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ clientId: before[0]!.clientId, name: "Guest", text: "install" })
  expect(entries[1]!.inReplyTo).toBe(entries[0]!.id)
  await expect(page.locator("[data-role='user'] .sui-chat-message-label")).toHaveText("You")
})
