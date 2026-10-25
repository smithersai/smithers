import type { Page } from "@playwright/test"
import { step } from "./fixtures"
import { expect, test } from "./devices"
import { ownPlace, requires, scriptedAgent } from "./target"

// A generated view (docs/features/views.md#generated-views, decision 0004 §4 to §6), end to end: the real app, ChatApi,
// its presentation realm and Postgres, with the models the only scripted seam (`/app?agent=board`: the agent calls
// `ui/render`, and the renderer writes the tic-tac-toe module, src/test/scriptedAgent.ts). ChatApi checks and renders the
// module; the board shows in a sandboxed frame inline on every device; a click in it is a move ChatApi makes from the
// board it keeps; the same board opens full screen, where the person plays to a win; and it stays after a reload.

/** The latest generated view in the conversation on `page`. */
const latestView = (page: Page) => page.locator('.conversation-view[data-template="generated"]').last()

/** The frame a generated view shows in, inline or full screen. */
const frameOf = (page: Page, inline: boolean) =>
  (inline ? latestView(page) : page.getByRole("main", { name: "View" })).frameLocator("iframe")

/** A click on board cell `index` (0 to 8), as the person makes it. */
const play = (page: Page, inline: boolean, index: number) =>
  step(`move: cell ${index + 1}`, () => frameOf(page, inline).getByRole("button", { name: new RegExp(`^Cell ${index + 1}`) }).click())

test("show me a board: the agent shows a tic-tac-toe board, inline and full screen, and the person plays it to a win", {
  annotation: {
    type: "summary",
    description: "The agent shows a tic-tac-toe board in the chat; a move shows on both devices; full screen, the person plays to a win.",
  },
}, async ({ devices }) => {
  requires("personalModel", "scriptedAgent", "member", "ownConversation")
  test.setTimeout(240_000)
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  await a.page.goto(scriptedAgent("board"))
  await a.ready()

  const question = `Show me a tic-tac-toe board, ${word}`
  await a.askAndWaitTaken(question)
  await a.expectAnswered(question, "board", 90_000)
  // The board ChatApi rendered shows in its frame on both devices.
  for (const tab of [a, b]) {
    await expect(frameOf(tab.page, true).getByText("X to move"), `${tab.name}: the board shows`).toBeVisible({
      timeout: 30_000,
    })
  }
  // The frame is sandboxed: scripts only, an opaque origin, no forms, popups or navigation of the app.
  await expect(latestView(a.page).locator("iframe")).toHaveAttribute("sandbox", "allow-scripts")

  // A's move in the chat shows on B's board.
  await play(a.page, true, 4)
  for (const tab of [a, b]) {
    await expect(frameOf(tab.page, true).getByRole("button", { name: "Cell 5, X" }), `${tab.name}: X in the centre`)
      .toBeVisible({ timeout: 30_000 })
  }

  // Full screen: the same board, from the same row.
  await step("A: open the board full screen", () => latestView(a.page).getByRole("link", { name: "Full screen" }).click())
  await expect(a.page).toHaveURL(/\/app\/views\/[0-9a-f-]{36}/)
  await expect(frameOf(a.page, false).getByRole("button", { name: "Cell 5, X" })).toBeVisible({ timeout: 30_000 })
  // O, X, O, X: X takes the diagonal.
  for (const [index, mark] of [[0, "O"], [2, "X"], [1, "O"], [6, "X"]] as const) {
    await play(a.page, false, index)
    await expect(frameOf(a.page, false).getByRole("button", { name: `Cell ${index + 1}, ${mark}` })).toBeVisible({
      timeout: 30_000,
    })
  }
  await expect(frameOf(a.page, false).getByText("X wins"), "A: X wins full screen").toBeVisible()
  // A won board takes no more moves.
  await play(a.page, false, 3)
  await expect(frameOf(a.page, false).getByRole("button", { name: "Cell 4" })).toHaveAccessibleName("Cell 4")

  // B sees the win in the chat; A's reload keeps it.
  await expect(frameOf(b.page, true).getByText("X wins"), "B: the win syncs").toBeVisible({ timeout: 30_000 })
  await step("Reload A", () => a.page.reload())
  await expect(frameOf(a.page, false).getByText("X wins"), "A: the board survives a reload").toBeVisible({ timeout: 30_000 })
})

test.describe("Live generated views", () => {
  requires("personalModel", "member", "ownConversation", "liveModel")

  test("Show a board: a real tic-tac-toe view renders inline, opens full screen and accepts a move", {
    annotation: { type: "summary", description: "Ask for a board, open that generated view full screen, and play a move that returns to the chat." },
  }, async ({ devices }) => {
    test.setTimeout(360_000)
    const [a] = await devices.open("Tic-tac-toe")
    const path = ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/main"
    await step("Open the branch conversation", async () => {
      if (new URL(a.page.url()).pathname !== path) await a.page.goto(path)
      await expect(a.page.getByRole("navigation", { name: "Branch", exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(a.page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0, { timeout: 60_000 })
    })

    const added = a.device.context.waitForEvent("request", {
      predicate: request => new URL(request.url()).pathname === "/api/views" && request.method() === "POST" &&
        request.postDataJSON()?.template === "generated",
      timeout: 180_000,
    })
    // Request the presentation we exercise, so SVG/numbered cells aren't mistaken for broken text-button boards.
    // The renderer still writes the real view; its title, cell labels and event names remain its choice.
    const question = `Show me a tic-tac-toe board with nine empty buttons. Put the text X or O in a button when it is played. (${devices.word})`
    await step("Ask for a tic-tac-toe board", () => a.askAndWaitTaken(question))
    const created = (await added).postDataJSON() as { id: string; answerId: string }
    const { answerId } = a.asked.find(asked => asked.text === question)!
    expect(created.answerId, "the board belongs to this answer").toBe(answerId)
    const view = a.page.locator(`.conversation-view[data-template="generated"][data-view="${created.id}"]`)
    // Empty cells or X/O marks distinguish the nine playable cells from controls such as New game.
    const inlineCells = view.frameLocator("iframe").locator("button[data-event]").filter({ hasText: /^\s*[XO]?\s*$/i })
    await step("See nine board cells inline in the chat", async () => {
      await expect(view).toBeVisible({ timeout: 180_000 })
      await expect(view.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts")
      await expect(inlineCells).toHaveCount(9, { timeout: 30_000 })
      await expect(inlineCells.first()).toBeVisible()
      await expect(a.conversation.locator(`[data-id="${answerId}"]`)).toHaveAttribute("data-state", "done", { timeout: 180_000 })
    })
    await step("Open the same board full screen", async () => {
      await view.getByRole("link", { name: "Full screen", exact: true }).click()
      await expect(a.page).toHaveURL(new RegExp(`/app/views/${created.id}(?:\\?|$)`))
      await expect(a.page.getByRole("main", { name: "View", exact: true })).toBeVisible()
    })
    const full = a.page.getByRole("main", { name: "View", exact: true }).frameLocator("iframe")
    const cells = full.locator("button[data-event]").filter({ hasText: /^\s*[XO]?\s*$/i })
    await expect(cells).toHaveCount(9, { timeout: 30_000 })
    const empty = cells.filter({ hasText: /^\s*$/ }).first()
    const event = await empty.getAttribute("data-event")
    expect(event, "an empty cell declares its move").toBeTruthy()
    const cellSelector = `button[data-event=${JSON.stringify(event)}]`
    await step("Play an empty cell and see the move", async () => {
      const moved = a.page.waitForResponse(response => new URL(response.url()).pathname === `/api/views/${created.id}/state` &&
        response.request().method() === "POST")
      await empty.click()
      const response = await moved
      expect(response.status(), "ChatApi accepts the move").toBe(200)
      const changed = await response.json() as { revision: number }
      const sent = response.request().postDataJSON() as { revision: number }
      expect(changed.revision).toBeGreaterThan(sent.revision)
      await expect(full.locator(cellSelector), "the played cell shows a mark").toHaveText(/^\s*[XO]\s*$/i, { timeout: 30_000 })
    })
    const mark = await full.locator(cellSelector).textContent()
    await step("Return to the chat and see the same move inline", async () => {
      await a.page.goBack()
      await expect(a.page).toHaveURL(new RegExp(`${path}$`))
      await expect(view.frameLocator("iframe").locator(cellSelector)).toHaveText(mark!, { timeout: 30_000 })
    })
  })
})
