// Stays .ts: Playwright collects browser tests by JS/TS extension only.
import { expect, test } from "@playwright/test"
const origin = process.env.AUTH_BROKER_TEST_ORIGIN!
test("signs in through smithers' callback and returns a local session with no token in any URL", async ({ page, context }) => {
  const requests: string[] = []
  const errors: string[] = []
  page.on("request", request => requests.push(request.url()))
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(origin)
  await page.getByRole("link", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(/http:\/\/localhost:\d+\/__github\?/)
  await page.getByRole("link", { name: "Continue", exact: true }).click()
  await expect(page).toHaveURL(origin + "/")
  await expect(page.getByText("ada", { exact: true })).toBeVisible()
  const session = await page.request.get(origin + "/api/auth/session")
  expect(await session.json()).toMatchObject({ id: "7", login: "ada", role: "new" })
  const cookies = await context.cookies()
  expect(cookies.find(cookie => cookie.name === "vibelang-session")).toMatchObject({ httpOnly: true, sameSite: "Lax", domain: "127.0.0.1" })
  expect(cookies.find(cookie => cookie.name === "smithers-broker")?.value ?? "").toBe("")
  expect(requests.some(url => /localhost:\d+\/api\/auth\/callback\?/.test(url))).toBe(true)
  expect(requests.filter(url => url.includes("127.0.0.1") && url.includes("/api/auth/callback")).every(url => !url.includes("code="))).toBe(true)
  expect(requests.join(" ")).not.toMatch(/fixture-token|access_token/)
  expect(errors).toEqual([])
})
