import { expect, test } from "./devices"
import { requires } from "./target"

requires("member")

for (const [kind, path] of [
  ["file", "/smithersai/smithers/blob/main/package.json"],
  ["issue", "/smithersai/smithers/issues/4255"],
] as const) {
  test(`uncached ${kind}: offline navigation says Offline and keeps a way back`, async ({ devices }) => {
    const [tab] = await devices.open("Laptop")
    await tab.page.goto("/smithersai/smithers")
    await tab.device.offline()
    await tab.page.goto(path)
    // Chromium otherwise reports online after an emulated offline document navigation.
    const network = await tab.device.context.newCDPSession(tab.page)
    await network.send("Network.overrideNetworkState", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await expect(tab.page.getByText("Offline", { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await expect(tab.page.getByRole("link", { name: "Back to chat", exact: true }).first()).toBeVisible()
    await tab.device.online()
    await network.send("Network.overrideNetworkState", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  })
}
