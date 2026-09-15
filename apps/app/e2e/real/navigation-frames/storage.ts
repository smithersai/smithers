import type { BrowserContext, Page, TestInfo, Worker as PlaywrightWorker } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { expect } from "../support/test"
import type { StorageRecoverySnapshot } from "../../../src/mainview/chain/StorageRecovery"

type SqlRow = Readonly<Record<string, unknown>>

type WorkerReply = {
  readonly requestId: string
  readonly ok: boolean
  readonly rows?: ReadonlyArray<SqlRow>
  readonly error?: string
}

export interface DatabaseControl {
  readonly page: Page
  readonly appUrl: string
  readonly controlUrl: string
  readonly execute: (sql: string, params?: ReadonlyArray<unknown>) => Promise<ReadonlyArray<SqlRow>>
}

const sqliteWorker = (workers: ReadonlyArray<PlaywrightWorker>): PlaywrightWorker | undefined =>
  workers.find((worker) => /opfs|sqlite/i.test(worker.url())) ?? (workers.length === 1 ? workers[0] : undefined)

/**
 * Discover the URL of the real OPFS worker which the built product launched.
 * This is read-only browser introspection; the app's Worker constructor and
 * worker instance are never replaced or patched.
 */
const databaseWorkerUrl = async (page: Page): Promise<string> => {
  await expect.poll(() => sqliteWorker(page.workers())?.url() ?? "", {
    message: "the built app should launch its real OPFS SQLite worker"
  }).not.toBe("")
  return sqliteWorker(page.workers())!.url()
}

const runWorkerSql = async (
  page: Page,
  workerUrl: string,
  sql: string,
  params: ReadonlyArray<unknown>
): Promise<ReadonlyArray<SqlRow>> => page.evaluate(async ({ workerUrl, sql, params }) => {
  const worker = new Worker(workerUrl, { type: "module" })
  let sequence = 0
  const send = (message: Record<string, unknown>): Promise<ReadonlyArray<Record<string, unknown>>> =>
    new Promise((resolve, reject) => {
      const requestId = `navigation-storage-${Date.now()}-${++sequence}`
      const finish = () => {
        clearTimeout(timer)
        worker.removeEventListener("message", receive)
        worker.removeEventListener("error", failed)
        worker.removeEventListener("messageerror", failed)
      }
      const receive = (event: MessageEvent<WorkerReply>) => {
        if (event.data.requestId !== requestId) return
        finish()
        if (event.data.ok) resolve(event.data.rows ?? [])
        else reject(new Error(event.data.error ?? "The SQLite worker refused the request without an error."))
      }
      const failed = () => {
        finish()
        reject(new Error("The real SQLite worker terminated while executing the fault probe."))
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error("The real SQLite worker did not answer the fault probe within 10 seconds."))
      }, 10_000)
      worker.addEventListener("message", receive)
      worker.addEventListener("error", failed)
      worker.addEventListener("messageerror", failed)
      worker.postMessage({ ...message, requestId })
    })

  try {
    await send({ type: "init", databaseName: "smithers-mvp.sqlite", vfsName: "opfs" })
    return await send({ type: "execute", sql, params })
  } finally {
    try {
      await send({ type: "close" })
    } finally {
      worker.terminate()
    }
  }
}, { workerUrl, sql, params })

/**
 * Unload the app's database owner, then operate the same physical OPFS file
 * through another instance of the package's shipped worker. Lock handoff is
 * retried because a closing document may briefly retain an OPFS access handle.
 */
export const takeDatabaseControl = async (page: Page, context: BrowserContext): Promise<DatabaseControl> => {
  const appUrl = page.url()
  const production = process.env.SMITHERS_REAL_E2E_HOST === "production"
  if (production && !await page.evaluate(() => crossOriginIsolated)) {
    throw new Error("Production OPFS preflight failed: the real app document is not cross-origin isolated.")
  }
  const workerUrl = await databaseWorkerUrl(page)
  const controlPage = await context.newPage()
  const controlUrl = new URL(production ? "/api/bootstrap" : "/api/health", appUrl).toString()
  const control = await controlPage.goto(controlUrl)
  if (control === null || !control.ok()) throw new Error(`The same-origin database control document failed: HTTP ${control?.status() ?? "none"}.`)
  if (production && !await controlPage.evaluate(() => crossOriginIsolated)) {
    throw new Error("Production OPFS preflight failed: /api/bootstrap is not a cross-origin-isolated worker control document.")
  }
  await page.close()

  const execute = async (sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<SqlRow>> => {
    let lastFailure: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await runWorkerSql(controlPage, workerUrl, sql, params)
      } catch (error) {
        lastFailure = error
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
      }
    }
    throw lastFailure
  }
  return { page: controlPage, appUrl, controlUrl, execute }
}

export const downloadRecovery = async (
  page: Page,
  testInfo: TestInfo,
  attachmentName: string
): Promise<StorageRecoverySnapshot> => {
  await expect(page.getByText("Recovery files can include private conversations", { exact: false })).toBeVisible()
  const recoveryButton = page.getByRole("button", { name: "Download local recovery file" })
  await expect(recoveryButton).toHaveAttribute("data-flow", "storage.recovery.export")
  const event = page.waitForEvent("download")
  await recoveryButton.click()
  const download = await event
  expect(download.suggestedFilename()).toBe("smithers-local-recovery.json")
  expect(await download.failure()).toBeNull()
  const path = await download.path()
  if (path === null) throw new Error("The browser completed the recovery download without a readable file path.")
  const snapshot = JSON.parse(await readFile(path, "utf8")) as StorageRecoverySnapshot
  expect(snapshot).toMatchObject({ format: "smithers-ui-recovery", version: 1 })
  await testInfo.attach(attachmentName, { path, contentType: "application/json" })
  await expect(page.getByRole("status").filter({ hasText: "Recovery download prepared." })).toBeVisible()
  return snapshot
}
