import { expect, test } from "./devices"
import { requires } from "./target"

requires("localServer", "member", "hostedModelOff")

test("chat opens and stores a question while hosted inference is off", {
  annotation: { type: "summary", description: "Opening chat and sending a question need no model connection." },
}, async ({ devices }) => {
  const [tab] = await devices.open("Chat without a model")
  const question = `A question for my attached agent ${devices.word}`
  await tab.askAndWaitTaken(question)
  await expect(tab.question(question)).toHaveAttribute("data-state", "done", { timeout: 60_000 })
  await tab.reload()
  await expect(tab.chatButton).toBeEnabled({ timeout: 30_000 })
  await expect(tab.question(question)).toBeVisible()
})
