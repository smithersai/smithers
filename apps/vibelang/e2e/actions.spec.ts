// Playwright discovers and loads test files only by JavaScript/TypeScript extension.
import { expect, test } from "./coverage"

async function chat(page: import("@playwright/test").Page) {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("Hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("button", { name: "Expand Actions", exact: true })).toBeVisible()
}
test("registered actions, an empty run list, a button start, live trace, cancel and minimize", async ({ page }) => {
  await chat(page)
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  const pane = page.getByRole("region", { name: "Actions", exact: true })
  await pane.getByRole("button", { name: "Tour", exact: true }).click()
  await expect(pane.getByText("No runs yet", { exact: true })).toBeVisible()
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  const card = page.getByRole("button", { name: /Open Tour run/ })
  await expect(card).toBeVisible()
  await card.click()
  await expect(pane).toHaveAttribute("data-maximized", "true")
  await expect(page.locator("main.vl-chat")).toHaveAttribute("inert", "")
  await expect(pane.getByLabel("Logs", { exact: true })).toContainText(/start|guide/)
  await pane.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(pane.getByText("Cancelled", { exact: true }).first()).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(pane).toHaveAttribute("data-maximized", "false")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await pane.getByRole("button", { name: "Maximize Actions", exact: true }).click()
  await pane.getByRole("button", { name: "Collapse Actions", exact: true }).click()
  await expect(page.getByRole("button", { name: "Expand Actions", exact: true })).toBeVisible()
  await expect(page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })).toBeEnabled()
})
test("the public slash menu filters, moves, dismisses, and starts its real registered flow", async ({ page }) => {
  await chat(page)
  const composer = page.locator('form[data-docked="true"]')
  const input = composer.getByRole("textbox", { name: "Message", exact: true })
  await input.fill("/")
  const menu = composer.getByRole("listbox", { name: "Commands", exact: true })
  await expect(menu.getByRole("option", { name: "/tour Explore VibeLang", exact: true })).toBeVisible()
  await expect(menu.getByRole("option", { name: /\/post/ })).toHaveCount(0)
  await input.press("ArrowDown")
  await input.press("Escape")
  await expect(menu).toHaveCount(0)
  await input.fill("/to")
  await input.press("Enter")
  await expect(page.locator(".vl-theatre-bar")).toBeVisible()
  await page.keyboard.press("Escape")
})

test("a run the scripted agent requests appears as its live card", async ({ page }) => {
  await chat(page)
  const input = page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })
  await input.fill("Run /tour")
  await input.press("Enter")
  await expect(page.getByRole("button", { name: /Open Tour run/ })).toBeVisible()
  const card = page.locator("article").filter({ has: page.getByRole("button", { name: /Open Tour run/ }) })
  await expect(card.getByText("VibeLang agent", { exact: true })).toBeVisible()
})

test("a history note the scripted agent requests is signed as the agent's", async ({ page }) => {
  // Live starts an agent-door run as the agent (worker/actionsDecision.vibe `startActor`); the mock does the same.
  await chat(page)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  const input = page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })
  await input.fill('Run /note {"id":"m1","section":"tried","text":"From the chat."}')
  await input.press("Enter")
  // The history is read only after the note's run settles: a read that overtakes the write finds no note.
  await expect(page.getByRole("button", { name: /Open Note run/ })).toContainText("Passed")
  await input.fill('Run /history {"what":"commit","id":"m1"}')
  await input.press("Enter")
  const show = page.getByRole("button", { name: /Open show run/ })
  await expect(show).toBeVisible()
  await show.click()
  const result = page.getByRole("region", { name: "Actions", exact: true }).getByLabel("Result", { exact: true })
  await expect(result).toContainText("From the chat.")
  await expect(result).toContainText("(agent)")
})

test("the agent runs each history and sandbox command a maintainer may run", async ({ page }) => {
  // One run of each kind the action host prepares and executes (src/actions/execution.vibe), through the agent's door.
  test.setTimeout(90_000)
  await chat(page)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  const input = page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })
  const plan = { how: "append", epic: "e1", newEpic: "", target: "", title: "fix(actions): planned by the agent", task: "" }
  const commands: ReadonlyArray<readonly [string, RegExp]> = [
    [`Run /plan ${JSON.stringify(plan)}`, /Open Plan run/],
    ['Run /start {"id":"m1","lane":"lane-a"}', /Open Start run/],
    ["Run /sandbox", /Open start run/],
    ['Run /sandbox-run {"command":"ls","generation":1}', /Open command run/],
    ['Run /sandbox-stop {"generation":1}', /Open stop run/],
  ]
  for (const [text, card] of commands) {
    await input.fill(text)
    await input.press("Enter")
    await expect(page.getByRole("button", { name: card })).toBeVisible()
  }
  await page.getByRole("button", { name: /Open Plan run/ }).click()
  await expect(page.getByRole("region", { name: "Actions", exact: true }).getByLabel("Result", { exact: true })).toContainText("refusal")
})

test("a history write the sequencer refuses says why in its run", async ({ page }) => {
  // Each run on a fresh page: one run card of its kind, so its Result is the one opened. Refusals: src/history/mythical.vibe
  // `decide`; only the agent's door sends a blank lane or note, so its Result names the field (src/web/actionModel.vibe).
  test.setTimeout(90_000)
  const refused: ReadonlyArray<readonly [string, RegExp, string]> = [
    ['Run /start {"id":"m-none","lane":"lane-a"}', /Open Start run/, "No such epic or commit."],
    ['Run /start {"id":"m1","lane":" "}', /Open Start run/, "Needs a lane."],
    ['Run /note {"id":"m-none","section":"tried","text":"Nowhere."}', /Open Note run/, "No such epic or commit."],
    ['Run /note {"id":"m1","section":"evidence","text":" "}', /Open Note run/, "Needs text."],
  ]
  for (const [text, card, words] of refused) {
    await chat(page)
    await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
    const input = page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })
    await input.fill(text)
    await input.press("Enter")
    const run = page.getByRole("button", { name: card })
    await expect(run).toHaveCount(1)
    await run.click()
    const result = page.getByRole("region", { name: "Actions", exact: true }).getByLabel("Result", { exact: true })
    await expect(result).toHaveText(words)
  }
})

test.describe("local real-engine action faults and role views", () => {
  test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_4511 ?? process.env.E2E_PORT ?? 4173}` })
  test("all five roles see only commands they may run", async ({ page }) => {
    for (const role of ["viewer", "new", "community", "contributor", "maintainer"]) {
      await page.goto(`/e2e/actions-runtime/index.html?role=${role}`)
      await page.keyboard.press("ControlOrMeta+k")
      const input = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
      await input.fill("/")
      await expect(page.getByRole("option", { name: "/tour Explore VibeLang", exact: true })).toBeVisible()
      await expect(page.getByRole("option", { name: "/post Ask the agent", exact: true })).toHaveCount(role === "contributor" || role === "maintainer" ? 1 : 0)
    }
  })
  test("a faulty service leaves a failed trace, and Re-run opens a new run", async ({ page }) => {
    await page.goto("/e2e/actions-runtime/index.html?role=contributor&fault=fail")
    await page.keyboard.press("ControlOrMeta+k")
    const input = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
    await input.fill("Hello")
    await input.press("Enter")
    await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
    await page.getByRole("region", { name: "Actions", exact: true }).getByRole("button", { name: "Tour", exact: true }).click()
    await page.getByRole("region", { name: "Actions", exact: true }).getByRole("button", { name: "Run", exact: true }).click()
    const card = page.getByRole("button", { name: /Open Tour run/ })
    await expect(card).toContainText("Failed")
    await card.click()
    const pane = page.getByRole("region", { name: "Actions", exact: true })
    await expect(pane.getByLabel("Logs", { exact: true })).toContainText("failed")
    await expect(pane).toContainText("#a1")
    await pane.getByRole("button", { name: "Re-run", exact: true }).click()
    await expect(pane).toContainText("#a2")
    await expect(pane.getByText("Running", { exact: true })).toBeVisible()
    await pane.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(pane.getByText("Cancelled", { exact: true }).first()).toBeVisible()
  })
})

test("a lost action follow exposes Reconnect and resumes the same run", async ({ page }) => {
  await page.goto("/e2e/actions-runtime/index.html?role=contributor&fault=actions-follow")
  await page.keyboard.press("ControlOrMeta+k")
  const input = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
  await input.fill("Hello")
  await input.press("Enter")
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  const pane = page.getByRole("region", { name: "Actions", exact: true })
  await pane.getByRole("button", { name: "Tour", exact: true }).click()
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  const card = page.getByRole("button", { name: /Open Tour run/ })
  await expect(card).toContainText("Disconnected")
  const id = await card.getAttribute("aria-label")
  await pane.getByRole("button", { name: "Reconnect", exact: true }).click()
  await expect(card).toContainText("Running")
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0)
  await expect(card).toHaveAttribute("aria-label", id!)
  await card.click()
  await pane.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(pane.getByText("Cancelled", { exact: true }).first()).toBeVisible()
})

test("a command picked from the slash menu starts its run and clears the composer", async ({ page }) => {
  await chat(page)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  const composer = page.locator('form[data-docked="true"]')
  const input = composer.getByRole("textbox", { name: "Message", exact: true })
  await input.fill("/post What is a tuple?")
  await composer.getByRole("option", { name: "/post Ask the agent", exact: true }).click()
  await expect(page.getByRole("button", { name: /Open Post run/ })).toBeVisible()
  await page.getByRole("button", { name: /Open Post run/ }).click()
  const pane = page.getByRole("region", { name: "Actions", exact: true })
  await expect(pane.getByText("Passed", { exact: true }).first()).toBeVisible()
  await expect(input).toHaveValue("")
})

