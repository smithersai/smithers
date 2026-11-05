/**
 * Bun has no Web Locks. Supply the real Chromium LockManager to its host
 * tests; the engine, channels and SQLite still execute in Bun. No alternate
 * lock implementation decides acquisition, stealing, cancellation or queries.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Browser } from "playwright"
import { afterAll, beforeAll } from "vitest"

let close: (() => Promise<void>) | undefined
beforeAll(async () => {
  if (navigator.locks !== undefined) return
  const server = createServer((_request, response) => response.end("<!doctype html>"))
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")
  let browser: Browser | undefined
  const cleanup = async () => {
    if (descriptor === undefined) delete (navigator as { locks?: unknown }).locks
    else Object.defineProperty(navigator, "locks", descriptor)
    try {
      await browser?.close()
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      }
    }
  }
  close = cleanup
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const { chromium } = await import("playwright")
    browser = await chromium.launch()
    const page = await browser.newPage()
    const requests = new Map<number, LockGrantedCallback<unknown>>()
    let next = 0
    await page.exposeFunction("granted", (id: number, lock: Lock | null) => requests.get(id)!(lock))
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await page.evaluate(() => {
      Object.assign(globalThis, { controllers: new Map<number, AbortController>(), cancelled: new Set<number>() })
    })
    const request = (
      name: string,
      how: LockOptions | LockGrantedCallback<unknown>,
      granted?: LockGrantedCallback<unknown>
    ) => {
      const options = typeof how === "function" ? {} : how
      const callback = typeof how === "function" ? how : granted!
      const id = next++
      requests.set(id, callback)
      const { signal, ...settings } = options
      // Cancellation errors belong to the request promise too. Closing the
      // page while a finalizer aborts must not create a detached rejection.
      let abortFailed!: (error: unknown) => void
      const abortFailure = new Promise<never>((_resolve, reject) => {
        abortFailed = reject
      })
      const abort = () => {
        void page.evaluate((id) => {
          ;(globalThis as any).cancelled.add(id)
          ;(globalThis as any).controllers.get(id)?.abort()
        }, id).catch(abortFailed)
      }
      signal?.addEventListener("abort", abort, { once: true })
      const requested = page.evaluate(async ({ id, name, settings, aborted }) => {
        const controller = new AbortController()
        ;(globalThis as any).controllers.set(id, controller)
        if (aborted || (globalThis as any).cancelled.has(id)) controller.abort()
        try {
          return await navigator.locks.request(
            name,
            settings.steal || settings.ifAvailable ? settings : { ...settings, signal: controller.signal },
            (lock) => (globalThis as any).granted(id, lock === null ? null : { name: lock.name, mode: lock.mode })
          )
        } finally {
          ;(globalThis as any).controllers.delete(id)
          ;(globalThis as any).cancelled.delete(id)
        }
      }, { id, name, settings, aborted: signal?.aborted ?? false })
      return Promise.race([requested, abortFailure]).finally(() => {
        requests.delete(id)
        signal?.removeEventListener("abort", abort)
      })
    }
    const locks: LockManager = {
      request: request as LockManager["request"],
      query: () => page.evaluate(() => navigator.locks.query())
    }
    Object.defineProperty(navigator, "locks", { configurable: true, value: locks })
  } catch (error) {
    await cleanup()
    close = undefined
    throw error
  }
})
afterAll(() => close?.())
