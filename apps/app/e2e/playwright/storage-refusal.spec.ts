import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import type { StorageRecoverySnapshot } from "../../src/mainview/chain/StorageRecovery"

const downloadRecovery = async (page: Page): Promise<StorageRecoverySnapshot> => {
  await expect(page.getByText("Recovery files can include private conversations", { exact: false })).toBeVisible()
  const downloaded = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download local recovery file" }).click()
  const file = await downloaded
  expect(file.suggestedFilename()).toBe("smithers-local-recovery.json")
  expect(await file.failure()).toBeNull()
  const snapshot = JSON.parse(await readFile((await file.path())!, "utf8")) as StorageRecoverySnapshot
  expect(snapshot.format).toBe("smithers-ui-recovery")
  expect(snapshot.version).toBe(1)
  await expect(page.getByRole("status").filter({ hasText: "Recovery download prepared." })).toBeVisible()
  return snapshot
}

// Test-only access to the shipped worker protocol. No application debug API is
// added: mutations target only this test's isolated browser-profile database.
type ProbeWindow = Window & typeof globalThis & {
  sqliteProbe?: { readonly worker: Worker; readonly url: string; readonly options?: WorkerOptions }
}

const trackDatabaseWorker = (page: Page) =>
  page.addInitScript(() => {
    const NativeWorker = window.Worker
    const instances = new WeakMap<Worker, { readonly url: string; readonly options?: WorkerOptions }>()
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        instances.set(this, { url: String(url), options })
      }
      override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]): void {
        if (
          typeof message === "object" && message !== null && "type" in message && message.type === "init" &&
          "databaseName" in message && message.databaseName === "smithers-mvp.sqlite"
        ) {
          const script = instances.get(this)!
          ;(window as ProbeWindow).sqliteProbe = { worker: this, ...script }
        }
        Reflect.apply(NativeWorker.prototype.postMessage, this, [message, options])
      }
    }
  })

/** Use the actual initialized worker, or reopen its raw database after boot refused/closed it. */
const queryDatabase = (page: Page, sql: string, reopen = false) =>
  page.evaluate(async ({ sql, reopen }) => {
    const probe = (window as ProbeWindow).sqliteProbe
    if (probe === undefined) throw new Error("The app never opened its SQLite worker")
    const worker = reopen ? new Worker(probe.url, probe.options) : probe.worker
    const send = (request: Record<string, unknown>): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const requestId = `storage-test-${crypto.randomUUID()}`
        const cleanup = () => {
          clearTimeout(timer)
          worker.removeEventListener("message", receive)
        }
        const receive = (event: MessageEvent) => {
          if (event.data.requestId !== requestId) return
          cleanup()
          if (event.data.ok) resolve(event.data.rows ?? [])
          else reject(new Error(event.data.error))
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error("SQLite test request timed out"))
        }, 10_000)
        worker.addEventListener("message", receive)
        try {
          worker.postMessage({ ...request, requestId })
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    try {
      if (reopen) await send({ type: "init", databaseName: "smithers-mvp.sqlite", vfsName: "opfs" })
      return await send({ type: "execute", sql, params: [] })
    } finally {
      if (reopen) {
        try {
          await send({ type: "close" })
        } finally {
          worker.terminate()
        }
      }
    }
  }, { sql, reopen })

test("a newer physical OPFS store refuses the normal app boot without replacing its version", async ({ page }) => {
  await trackDatabaseWorker(page)
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  await queryDatabase(page, "UPDATE smithers_metadata SET value = '2147483647' WHERE key = 'schema-version'")
  await page.reload()
  await expect(page.getByRole("heading", { name: "Smithers failed to start" })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  expect(await queryDatabase(page, "SELECT value FROM smithers_metadata WHERE key = 'schema-version'", true))
    .toEqual([{ value: "2147483647" }])
  const recovered = await downloadRecovery(page)
  expect(recovered.session).toBe("unopened")
  expect(recovered.sqlite?.find((table) => table.name === "smithers_metadata")?.rows)
    .toContainEqual([{ type: "text", value: "schema-version" }, { type: "text", value: "2147483647" }])
  expect(await queryDatabase(page, "SELECT value FROM smithers_metadata WHERE key = 'schema-version'", true))
    .toEqual([{ value: "2147483647" }])
})

test("corrupt physical OPFS execution evidence survives failed boot and is never displayed as an error payload", async ({ page }) => {
  await trackDatabaseWorker(page)
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  await queryDatabase(
    page,
    "INSERT INTO smithers_collection_rows VALUES ('app-chain-events', 's:private-fixture', 'v1', 'private raw recovery fixture')"
  )
  await page.reload()
  await expect(page.getByRole("heading", { name: "Smithers failed to start" })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("private raw recovery fixture")
  expect(
    await queryDatabase(
      page,
      "SELECT value FROM smithers_collection_rows WHERE collection_id = 'app-chain-events' AND row_key = 's:private-fixture'",
      true
    )
  )
    .toEqual([{ value: "private raw recovery fixture" }])
  expect(JSON.stringify((await downloadRecovery(page)).sqlite)).toContain("private raw recovery fixture")
  await expect(page.locator("body")).not.toContainText("private raw recovery fixture")
})

test("an unreadable localStorage envelope stops boot without erasing the original or displaying its contents", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage")
    localStorage.setItem("smithers-mvp.store", "private unreadable envelope")
  })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Smithers failed to start" })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("private unreadable envelope")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.store"))).toBe("private unreadable envelope")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("localStorage")
  expect((await downloadRecovery(page)).localStorage).toContainEqual({
    key: "smithers-mvp.store",
    value: "private unreadable envelope"
  })
  await expect(page.locator("body")).not.toContainText("private unreadable envelope")
})

test("a pre-backend-stamp localStorage conversation survives boot without creating fresh OPFS history", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("legacy-fixture-created") === null) {
      localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage")
      sessionStorage.setItem("legacy-fixture-created", "1")
    }
  })
  await page.goto("/")
  await page.getByTestId("composer-input").fill("/appearance.theme")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("transcript").locator(".smithers-card[data-kind=\"theme-picker\"]")
  await expect(card).toBeVisible()
  const cardId = await card.getAttribute("data-testid")
  await page.evaluate(() => localStorage.removeItem("smithers-mvp.persistenceBackend"))
  await page.reload()
  await expect(page.getByTestId(cardId!)).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("localStorage")
  const fileExists = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    try {
      await root.getFileHandle("smithers-mvp.sqlite")
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return false
      throw error
    }
  })
  expect(fileExists).toBe(false)
})

test("two unstamped stores refuse an arbitrary choice and leave the legacy original alone", async ({ page }) => {
  await trackDatabaseWorker(page)
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  await page.evaluate(() => {
    localStorage.setItem("smithers-mvp.app-messages", "separate legacy original")
    localStorage.removeItem("smithers-mvp.persistenceBackend")
  })
  await page.reload()
  await expect(page.getByRole("heading", { name: "Smithers failed to start" })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  await expect(page.locator("body")).toContainText("another database may exist")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.app-messages"))).toBe("separate legacy original")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBeNull()
  expect(await page.evaluate(() => (window as ProbeWindow).sqliteProbe === undefined)).toBe(true)
  const recovered = await downloadRecovery(page)
  expect(recovered.localStorage).toContainEqual({ key: "smithers-mvp.app-messages", value: "separate legacy original" })
  expect(recovered.sqlite?.some((table) => table.name === "smithers_collection_rows")).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBeNull()
})

test("the running app offers the same private download through an embedded slash reply", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await page.evaluate(() =>
    localStorage.setItem("smithers-mvp-quarantine.private-test", "older quarantined private fixture")
  )
  await page.getByTestId("composer-input").fill("/storage.recovery")
  await page.getByTestId("composer-send").click()
  const recovered = await downloadRecovery(page)
  expect(recovered.session).toBe("opfs")
  expect(recovered.localStorage).toContainEqual({
    key: "smithers-mvp-quarantine.private-test",
    value: "older quarantined private fixture"
  })
  expect(recovered.sqlite?.some((table) => table.name === "smithers_collection_rows")).toBe(true)
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.locator("body")).not.toContainText("older quarantined private fixture")
})
