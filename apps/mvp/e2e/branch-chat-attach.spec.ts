import { createHash, randomBytes } from "node:crypto"
import { request } from "@playwright/test"
import { expect, test } from "./fixtures"
import { openComposer } from "./composer"
import { ownPlace, requires } from "./target"

requires("member", "ownConversation")
// This human consent exchange contains single-use credentials. Keep it out of persistent test media.
test.use({ video: "off", trace: "off", screenshot: "off" })

test("A branch question waits for its agent and an approved attachment answers the existing question", async ({ page, ignoreHTTPSErrors }) => {
  const text = "Which package owns this fixture? " + crypto.randomUUID()
  await page.goto(ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/main")
  const composer = await openComposer(page)
  await composer.fill(text)
  await composer.press("Enter")
  const question = page.locator('article[data-role="user"]').filter({ hasText: text })
  await expect(question).toBeVisible()
  const answer = question.locator('xpath=following-sibling::article[@data-role="assistant"][1]')
  await expect(answer).toContainText("Waiting for your agent")
  await expect(answer.getByRole("link", { name: "Debug info" })).toHaveCount(0)
  const questionId = await question.getAttribute("data-id")
  await page.getByRole("button", { name: "Attach agent", exact: true }).click()
  const dialog = page.getByRole("dialog")
  const command = dialog.locator("code").first()
  await expect(command).toContainText("smthrs attach")
  const reference = (await command.textContent())?.match(/--intent ([A-Z0-9]{4}-[A-Z0-9]{4})$/)?.[1]
  if (!reference) throw new Error("Missing attach reference")

  const agent = await request.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors })
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  try {
    const claimed = await agent.post("/api/attach/claims", { data: { reference, client: "Fixture agent", challenge } })
    expect(claimed.status()).toBe(201)
    const { claim, pairing } = await claimed.json()
    await dialog.getByRole("button", { name: "Review request" }).click()
    await expect(dialog).toContainText("Fixture agent")
    await dialog.getByLabel("Pairing code").fill(pairing)
    await dialog.getByRole("button", { name: "Approve attachment" }).click()
    await expect(dialog.getByRole("button", { name: "Revoke access" })).toBeVisible()
    const code = await dialog.locator("code").textContent()
    const redeemed = await agent.post("/api/attach/tokens", { data: { claim, verifier, code } })
    expect(redeemed.status()).toBe(200)
    const { token, mcpPath } = await redeemed.json()
    const call = async (name: string, args: object) => agent.post(mcpPath, {
      headers: { authorization: `Bearer ${token}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    })
    const read = await call("conversation_read", {})
    expect(read.status()).toBe(200)
    const messages = (await read.json()).result.structuredContent.messages as Array<{ id: string; text: string }>
    expect(messages.some(message => message.id === questionId && message.text === text)).toBe(true)
    const replied = await call("conversation_respond", { questionId, text: "The fixture is in the app package." })
    expect((await replied.json()).result.structuredContent.answered).toBe(true)
    await dialog.getByRole("button", { name: "Revoke access" }).click()
    await expect(dialog).toBeHidden()
    await expect(answer).toContainText("The fixture is in the app package.")
    expect((await call("conversation_read", {})).status()).toBe(401)
  } finally {
    await agent.dispose()
  }
})
