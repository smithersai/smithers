import { expect, test } from "./devices"
import { step } from "./fixtures"
import { OWN_BRANCH, ownPlace, requires } from "./target"

// A branch's page opened offline (docs/features/branch-workspace.md#the-page): the device can't say whether this person
// may open the branch, so the page shows the branch's public chrome at once instead of waiting out `branch/track`'s 30 s
// of retries, keeps it however long the person stays offline, and once the network returns the route loads again in
// place and opens the workspace, with no reload. A deployment run
// opens its own branch; locally, the public `octocat/Spoon-Knife`'s `test-branch`, as the branch workspace's tests do.

requires("member")

const branch = () => {
  const place = ownPlace()
  return place === undefined
    ? { path: "/octocat/Spoon-Knife/tree/test-branch", name: "test-branch" }
    : { path: place.path, name: OWN_BRANCH.ref }
}

test("branch offline: a branch's page opened offline shows at once, and opens its workspace in place when the network returns", {
  annotation: { type: "summary", description: "Offline, a branch's page shows at once and stays; back online, however long after, its workspace opens with no reload." },
}, async ({ devices, browserName }) => {
  test.setTimeout(180_000)
  const { path, name } = branch()
  const [tab] = await devices.open("Laptop")
  const { page } = tab
  // The log lines before going offline: tracking's run settling after them is this page's.
  let offlineFrom = 0
  const network = await step("Go offline and open the branch: the page shows its name, without its workspace", async () => {
    await tab.device.offline()
    offlineFrom = tab.log.length
    await page.goto(path)
    // Chromium starts a new page's navigator.onLine as true despite the context's emulation: correct it, as a browser
    // offline reports.
    const network = browserName === "chromium" ? await tab.device.context.newCDPSession(page) : undefined
    await network?.send("Network.overrideNetworkState", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    // Well within the 30 s `branch/track` would spend trying a ChatApi it can't reach.
    await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(name, { timeout: 10_000 })
    await expect(tab.conversation).toHaveCount(0)
    // A mark on this page: a reload would lose it.
    await page.evaluate(() => Object.assign(window, { e2eSamePage: true }))
    return network
  })
  await step("Stay offline longer than tracking tries: the page keeps the branch's name", async () => {
    // The engine's `branch/track` run spends its 30 s budget trying a ChatApi it can't reach, then settles failed.
    await expect
      .poll(() => tab.log.slice(offlineFrom).some((line) => line.includes("flow.run.settled") && line.includes("branch/track")), {
        message: "tracking gave up offline",
        timeout: 60_000,
      })
      .toBe(true)
    await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(name)
  })
  await step("Back online, the branch's workspace opens in place", async () => {
    await tab.device.online()
    await network?.send("Network.overrideNetworkState", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(/Owner|Can edit|Can view/, { timeout: 30_000 })
    await expect(tab.conversation).toBeVisible()
    expect(await page.evaluate(() => (window as { e2eSamePage?: boolean }).e2eSamePage), "the page never reloaded").toBe(true)
  })
})
