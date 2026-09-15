import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"

GlobalRegistrator.register()
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { resetLocalBrowserStorage } = await import("./AppStore")

/*
 * The reset offered on the startup failure panel. The profile that could not
 * boot — "prepare runtime and persisted state: Invalid string length" against
 * 890415370 bytes of OPFS fileSystem usage, smithers.sh build 8e55636b — shares
 * its origin with the marketing site, so the erase has to be prefix-scoped.
 */
describe("resetLocalBrowserStorage", () => {
  test("removes only this app's localStorage keys, then reloads", async () => {
    window.localStorage.clear()
    window.localStorage.setItem("smithers-mvp.app-messages", "conversation")
    window.localStorage.setItem("smithers-mvp.persistenceBackend", "opfs")
    window.localStorage.setItem("smithers-mvp-quarantine.10.app-cards", "older envelope")
    window.localStorage.setItem("someone-elses-key", "not ours")
    let reloads = 0
    await resetLocalBrowserStorage(() => {
      reloads += 1
    })
    expect(reloads).toBe(1)
    expect(window.localStorage.getItem("smithers-mvp.app-messages")).toBeNull()
    expect(window.localStorage.getItem("smithers-mvp.persistenceBackend")).toBeNull()
    expect(window.localStorage.getItem("smithers-mvp-quarantine.10.app-cards")).toBeNull()
    expect(window.localStorage.getItem("someone-elses-key")).toBe("not ours")
  })
})
