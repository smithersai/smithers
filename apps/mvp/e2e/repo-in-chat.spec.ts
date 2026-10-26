import type { Page, Request } from "@playwright/test"
import { step } from "./fixtures"
import { expect, test } from "./devices"
import { ownPlace, requires, scriptedAgent } from "./target"

// A repository lives in the chat shell (ruling FE-9; docs/features/views.md#a-repository-and-its-issues, decision 0004
// §3), end to end: the real app, ChatApi, RepoApi and GitHub. `/repo` adds a repository's own view to the conversation,
// small; Full screen opens the repository's own page, whose Back to chat minimizes it back into the chat, where the
// view stays once. A deep link's Back to chat leaves the repository in the chat. Asked for a repository's issues, the
// agent shows its issues view, which opens the issues page full screen. The models are the only scripted seam.

/**
 * The app's views of `template` in the conversation `page` shows whose view is the region `name`: only this test's
 * repository, since tests running beside it add views of others to the same conversation.
 */
const appViews = (page: Page, template: "repo" | "issues", name: string) =>
  page.locator(`.conversation-view[data-template="${template}"]`).filter({ has: page.getByRole("region", { name, exact: true }) })

/** The page's Back to chat. */
const backToChat = (page: Page) => page.getByRole("link", { name: "Back to chat" }).first()

for (const fromBranch of [false, true]) {
  test(`${fromBranch ? "branch: " : ""}open a repository from chat and toggle full screen: small in the chat, its own page full screen, and back`, {
    annotation: {
      type: "summary",
      description: "/repo shows the repository small in the chat; Full screen opens its page; Back to chat minimizes it back.",
    },
  }, async ({ devices }) => {
    requires("member", "ownConversation")
    test.setTimeout(180_000)
    const [a] = await devices.open("A")
    await a.ready()
    if (fromBranch) {
      await a.page.goto(ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/test-branch")
      await expect(a.page.getByRole("navigation", { name: "Branch" })).toBeVisible({ timeout: 60_000 })
      await expect(a.page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0, { timeout: 60_000 })
    }
    const chat = a.page.url()
    // The route can be ready before Electric delivers older views. Identify this command's
    // view from its real write receipt, rather than counting a still-syncing conversation.
    const writes = new Set<string>()
    const isRepoWrite = (request: Request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/views") return false
      const body = request.postDataJSON()
      return body.template === "repo" && body.props?.repo === "octocat/Spoon-Knife"
    }
    const written = (request: Request) => {
      if (isRepoWrite(request)) writes.add(request.postDataJSON().id)
    }
    a.page.context().on("request", written)
    const receipt = a.page.context().waitForEvent("response", {
      predicate: response => isRepoWrite(response.request()) && response.ok(),
    })
    await a.send("/repo octocat/Spoon-Knife")
    const viewId = (await receipt).request().postDataJSON().id as string
    const added = a.page.locator(`.conversation-view[data-view="${viewId}"]`)
    await step("the repository shows small in the chat, with its README", async () => {
      await expect(added).toHaveCount(1, { timeout: 60_000 })
      await expect(added.getByRole("article", { name: "README.md" })).toBeVisible({ timeout: 60_000 })
    })

    await step("A: Full screen", () => added.getByRole("link", { name: "Full screen" }).click())
    await expect(a.page).toHaveURL(/\/octocat\/Spoon-Knife\/tree\/main$/)
    await expect(a.page.getByRole("heading", { name: "octocat / Spoon-Knife" })).toBeVisible({ timeout: 30_000 })

    await step("A: Back to chat", () => backToChat(a.page).click())
    await expect(a.page).toHaveURL(chat)
    // Minimized: the same view, still once.
    await expect(added).toBeVisible({ timeout: 30_000 })
    await expect(added).toHaveCount(1)
    expect([...writes]).toEqual([viewId])
    a.page.context().off("request", written)
  })
}

test("a repository's own URL is its full-screen view: Back to chat leaves it in the chat", {
  annotation: {
    type: "summary",
    description: "A repository opened by its URL minimizes into the chat with Back to chat, where it shows small.",
  },
}, async ({ devices }) => {
  requires("member", "homeConversation")
  test.setTimeout(180_000)
  const [a] = await devices.open("A")
  await a.ready()
  const helloWorld = appViews(a.page, "repo", "Hello-World")
  const before = await helloWorld.count()
  await step("A: open octocat/Hello-World by its URL", () => a.page.goto("/octocat/Hello-World"))
  await expect(a.page.getByRole("heading", { name: "octocat / Hello-World" })).toBeVisible({ timeout: 30_000 })

  await step("A: Back to chat", () => backToChat(a.page).click())
  await expect(a.page).toHaveURL(/\/app$/)
  await expect(helloWorld).toHaveCount(before + 1, { timeout: 60_000 })
})

for (const live of [false, true]) {
  test(`${live ? "live: " : ""}ask the agent to show a repository's issues: its issues view in the chat, the page full screen`, {
    annotation: {
      type: "summary",
      description: "Asked for a repository's issues, the agent shows its issues view in the chat; Full screen opens the issues page.",
    },
  }, async ({ devices }) => {
    requires(live ? "liveModel" : "scriptedAgent", "member", "ownConversation")
    test.setTimeout(240_000)
    const word = devices.word
    const [a] = await devices.open("A")
    if (!live) await a.page.goto(scriptedAgent("show-issues"))
    await a.ready()
    const chat = a.page.url()
    const issues = appViews(a.page, "issues", "smithersai/smithers issues")
    const before = await issues.count()

    const question = `Show me the issues of smithersai/smithers in the chat, ${word}`
    await a.askAndWaitTaken(question)
    const view = issues.nth(before)
    await step("the issues view shows in the chat", () => expect(view).toBeVisible({ timeout: 120_000 }))
    await expect(a.answerTo(question)).toHaveAttribute("data-role", "assistant", { timeout: 60_000 })

    await step("A: Full screen", () => view.getByRole("link", { name: "Full screen" }).click())
    await expect(a.page).toHaveURL(/\/smithersai\/smithers\/issues$/)
    await step("A: Back to chat", () => backToChat(a.page).click())
    // Back where the view was opened from, the scripted agent's page included.
    await expect(a.page).toHaveURL(chat)
    await expect(issues).toHaveCount(before + 1)
  })
}
