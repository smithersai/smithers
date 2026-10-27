import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member")
test("bug report: whitespace is refused visibly without losing the draft or sending", async ({ page }) => {
  const sends: string[] = []
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/bugs") sends.push(request.url()) })
  await page.goto("/app/bugs/report")
  const field = page.getByRole("textbox", { name: "What happened?" })
  await field.fill("   \n ")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("form", { name: "Report a bug" }).getByRole("status")).toHaveText("Write what happened")
  await expect(field).toHaveValue("   \n ")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  expect(sends).toEqual([])
})
