/**
 * Bun has no Web Locks. Supply the real Chromium LockManager to its host
 * tests; the engine, channels and SQLite still execute in Bun. No alternate
 * lock implementation decides acquisition, stealing, cancellation or queries.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Browser } from "playwright"
import { afterAll, beforeAll } from "vitest"
import type { LockManagerLike } from "../../src/WebLock.ts"

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
    const requests = new Map<number, (lock: unknown) => Promise<void>>()
    let next = 0
    await page.exposeFunction("granted", (id: number, held: boolean) => requests.get(id)!(held ? {} : null))
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await page.evaluate(() => {
      Object.assign(globalThis, { controllers: new Map<number, AbortController>(), cancelled: new Set<number>() })
    })
    const locks: LockManagerLike & { readonly query: () => Promise<LockManagerSnapshot> } = {
      request: (name, options, callback) => {
        const id = next++
        requests.set(id, callback)
        const signal = "signal" in options ? options.signal : undefined
        const abort = () =>
          void page.evaluate((id) => {
            ;(globalThis as any).cancelled.add(id)
            ;(globalThis as any).controllers.get(id)?.abort()
          }, id)
        signal?.addEventListener("abort", abort, { once: true })
        return page.evaluate(async ({ id, name, how, aborted }) => {
          const controller = new AbortController()
          ;(globalThis as any).controllers.set(id, controller)
          if (aborted || (globalThis as any).cancelled.has(id)) controller.abort()
          try {
            await navigator.locks.request(
              name,
              how === "steal"
                ? { steal: true }
                : how === "ifAvailable"
                ? { ifAvailable: true }
                : { signal: controller.signal },
              (lock) => (globalThis as any).granted(id, lock !== null)
            )
          } finally {
            ;(globalThis as any).controllers.delete(id)
            ;(globalThis as any).cancelled.delete(id)
          }
        }, {
          id,
          name,
          how: "steal" in options ? "steal" : "ifAvailable" in options ? "ifAvailable" : "wait",
          aborted: signal?.aborted ?? false
        }).finally(() => {
          requests.delete(id)
          signal?.removeEventListener("abort", abort)
        })
      },
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
