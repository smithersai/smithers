import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import type { StorageRecoverySnapshot } from "./chain/StorageRecovery"
import { createStartupRecovery } from "./StartupRecovery"

GlobalRegistrator.register()
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const snapshot: StorageRecoverySnapshot = {
  format: "smithers-ui-recovery",
  version: 1,
  capturedAt: "fixture",
  localStorage: [{ key: "smithers-mvp.store", value: "private original" }]
}
const until = async (condition: () => boolean) => {
  for (let turn = 0; turn < 100; turn++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("projection did not settle")
}

describe("startup recovery's non-React projection", () => {
  test("an unavailable lazy binding produces a visible safe failure and can be retried", async () => {
    let fails = true
    let downloads = 0
    const recovery = createStartupRecovery(document, {
      read: async () => snapshot,
      download: () => {
        downloads++
      }
    }, async () => {
      if (fails) throw new Error("private bundle failure")
      return import("./flows/StorageRecoveryFlow")
    })
    try {
      const button = recovery.element.querySelector("button")!
      button.click()
      await until(() => recovery.element.textContent?.includes("could not be read completely") === true)
      expect(recovery.element.textContent).not.toContain("private bundle failure")
      expect(downloads).toBe(0)
      fails = false
      button.click()
      await until(() => downloads === 1)
    } finally {
      await recovery.dispose()
    }
  })
  test("shows safe failure, supports retry, and never renders the private file", async () => {
    let fails = true
    const downloads: string[] = []
    const recovery = createStartupRecovery(document, {
      read: async () => {
        if (fails) throw new Error("private original")
        return snapshot
      },
      download: (json) => {
        downloads.push(json)
      }
    })
    try {
      const button = recovery.element.querySelector("button")!
      button.click()
      await until(() => recovery.element.textContent?.includes("could not be read completely") === true)
      expect(button.disabled).toBe(false)
      expect(recovery.element.textContent).not.toContain("private original")
      expect(downloads).toEqual([])
      fails = false
      button.click()
      await until(() => recovery.element.textContent?.includes("Recovery download prepared.") === true)
      expect(downloads).toEqual([JSON.stringify(snapshot)])
      expect(recovery.element.textContent).not.toContain("private original")
    } finally {
      await recovery.dispose()
    }
  })

  test("closing the panel during capture disables the action, removes the subscription, and suppresses the late download", async () => {
    let release!: (snapshot: StorageRecoverySnapshot) => void
    let reads = 0
    let downloads = 0
    const held = new Promise<StorageRecoverySnapshot>((resolve) => {
      release = resolve
    })
    const recovery = createStartupRecovery(document, {
      read: () => {
        reads++
        return held
      },
      download: () => {
        downloads++
      }
    })
    try {
      const button = recovery.element.querySelector("button")!
      button.click()
      await until(() => reads === 1)
      expect(button.disabled).toBe(true)
      const closing = recovery.dispose()
      expect(recovery.dispose()).toBe(closing)
      expect(button.onclick).toBeNull()
      const before = recovery.element.textContent
      release(snapshot)
      await closing
      expect(downloads).toBe(0)
      expect(recovery.element.textContent).toBe(before)
    } finally {
      release(snapshot)
      await recovery.dispose()
    }
  })
})
