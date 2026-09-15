import { scenario } from "./coverage/types"
import { authenticatedTest, readAuthenticatedSession } from "./auth-permissions/profile"
import { command, expect, realApi, test as anonymousTest } from "./support/test"
import { expectFlowOutcome } from "./repositories-github/local"
import { enableVerboseEvidence } from "./repositories-github/production"

const REPO = "smithersai/smithers"

const openChat = async (page: Parameters<typeof command>[0]): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await expect(input).toBeVisible()
}

type ChangeList = { readonly items?: readonly { readonly change_id?: unknown }[] }

const liveChangeId = async (page: Parameters<typeof realApi>[0], request: Parameters<typeof realApi>[1]): Promise<string> => {
  const response = await realApi(page, request, "GET", `/api/repos/${REPO}/changes?limit=30`)
  expect(response.status()).toBe(200)
  const body = await response.json() as ChangeList
  const changeId = body.items?.find((row) => typeof row.change_id === "string")?.change_id
  expect(changeId, "The public mirror must expose a real change for mutation-boundary checks").toEqual(expect.any(String))
  return changeId as string
}

anonymousTest(
  "every review and change mutation waits behind the real sign-in door without a provider write",
  scenario("review-mutations.production-signed-out-auth-boundaries", {
    capabilities: ["identity", "cloud"],
    description: "Exercise every mutation command that is exposed from ChangeCards while signed out. Each command must render the real auth door and emit no POST or PUT request.",
    coverage: [
      "action:change.split", "action:change.split-ready", "action:change.resolve",
      "action:change.land", "action:change.revert", "action:change.pins", "action:change.checks", "action:change.open-computer",
      "action:review.done", "action:review.ack", "action:review.reopen", "action:auth.prompt",
      "action:findings.please-fix", "action:findings.not-useful",
      "host:production", "path:permission", "door:slash", "dimension:no-mutation", "dimension:mutation-auth-matrix",
      "evidence:real-session-and-network-methods"
    ]
  }),
  async ({ page }, testInfo) => {
    const mutations: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() !== "GET" && (path.includes("/landings/") || path.includes("/changes/"))) {
        mutations.push(`${request.method()} ${path}`)
      }
    })
    await page.goto(`/${REPO}`, { waitUntil: "domcontentloaded" })
    expect(await readAuthenticatedSession(page)).toBeUndefined()
    const commands = [
      "/change.split qupxosqw docs/guide.md",
      "/change.split-ready qupxosqw",
      "/change.resolve qupxosqw src/app.ts",
      "/change.land qupxosqw",
      "/change.revert qupxosqw",
      "/change.pins qupxosqw parent current",
      "/change.checks qupxosqw 1",
      "/change.open-computer qupxosqw snapshot-e2e",
      "/review.done qupxosqw 3",
      "/review.ack qupxosqw 3",
      "/review.reopen qupxosqw 3",
      "/findings.please-fix qupxosqw 7",
      "/findings.not-useful qupxosqw 7"
    ]
    for (const input of commands) {
      await openChat(page)
      await command(page, input)
      await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
    }
    expect(mutations).toEqual([])
    await testInfo.attach("review-mutation-auth-boundaries", {
      body: Buffer.from(JSON.stringify({ repository: REPO, commands, mutations }, null, 2)),
      contentType: "application/json"
    })
  }
)

authenticatedTest(
  "the real production Change seam refuses split-ready honestly and preserves the live change",
  scenario("review-mutations.production-split-ready-refusal", {
    capabilities: ["identity", "cloud"],
    description: "Read a real public change, invoke the authenticated split-ready action, and require the platform-backed changeset lookup and honest no-route refusal without a fabricated mutation.",
    coverage: [
      "action:change.view", "action:change.split-ready", "host:production", "path:error", "path:persistence",
      "door:slash", "dimension:unwired-mutation", "dimension:real-changeset-lookup", "evidence:live-change-and-no-write"
    ]
  }),
  async ({ page, request }, testInfo) => {
    expect(await readAuthenticatedSession(page)).toEqual({ login: "codeplanesmithers", allowlisted: true, admin: true })
    await page.goto(`/${REPO}`, { waitUntil: "domcontentloaded" })
    const changeId = await liveChangeId(page, request)
    const writes: string[] = []
    page.on("request", (event) => {
      const url = new URL(event.url())
      if (event.method() !== "GET" && (url.pathname.includes("/changes/") || url.pathname.includes("/landings/"))) {
        writes.push(`${event.method()} ${url.pathname}`)
      }
    })
    await openChat(page)
    await enableVerboseEvidence(page)
    await command(page, `/change.split-ready ${changeId}`)
    await expectFlowOutcome(page, "change.split-ready", changeId, "failed")
    await expect(page.getByTestId("transcript")).toContainText(/changeset|nothing was split|no route/i)
    expect(writes).toEqual([])
    await page.reload({ waitUntil: "domcontentloaded" })
    const reread = await realApi(page, request, "GET", `/api/repos/${REPO}/changes/${changeId}`)
    expect(reread.status()).toBe(200)
    await testInfo.attach("split-ready-refusal", {
      body: Buffer.from(JSON.stringify({ repository: REPO, changeId, responseStatus: reread.status(), writes }, null, 2)),
      contentType: "application/json"
    })
  }
)
