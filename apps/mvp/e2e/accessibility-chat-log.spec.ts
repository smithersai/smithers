import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { ownPlace, requires } from "./target"

test("chat has one named live message log", async ({ page }) => {
  await page.goto("/app")
  const conversation = page.getByRole("region", { name: "Conversation", exact: true })
  await expect(conversation, "one named Conversation landmark").toHaveCount(1)
  await expect(conversation.getByRole("log", { name: "Messages", exact: true })).toHaveCount(1)
  await expect(page.getByRole("log", { name: "Messages", exact: true })).toHaveCount(1)
  await expect(page.getByRole("log")).toHaveCount(1)
  await expect(page.getByRole("log").getByRole("navigation")).toHaveCount(0)
})

test("branch workspace has one Conversation landmark containing its message log", async ({ page }) => {
  requires("member")
  await page.goto(ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/test-branch")
  const conversation = page.getByRole("region", { name: "Conversation", exact: true })
  await expect(conversation).toBeVisible({ timeout: 30_000 })
  await expect(conversation).toHaveCount(1)
  await expect(conversation.getByRole("region", { name: "Conversation", exact: true })).toHaveCount(0)
  await expect(conversation.getByRole("log", { name: "Messages", exact: true })).toHaveCount(1)
})
