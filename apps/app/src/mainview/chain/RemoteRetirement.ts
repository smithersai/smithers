import type { StorageApi } from "@tanstack/db"
import { acknowledgeRemoteErasure, pendingRemoteErasures, readPrivacyRetirement } from "./PrivacyRetirement"
import type { EraseRemoteTurn } from "../runtime/TurnErasure"

/** One owner drains bounded passes. Retries never require account/agent startup. */
export const createRemoteRetirementWorker = (storage: StorageApi, erase: EraseRemoteTurn | undefined,
  options: { readonly budgetMs?: number; readonly retryMs?: number } = {}) => {
  let closed = false, running: Promise<void> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let abort: AbortController | undefined
  const wake = (): void => {
    if (closed || erase === undefined || running !== undefined) return
    clearTimeout(retry)
    running = (async () => {
      const entries = pendingRemoteErasures(storage)
      if (entries.length === 0) return
      const controller = new AbortController()
      abort = controller
      const stopped = new Promise<false>(resolve => controller.signal.addEventListener("abort", () => resolve(false), { once: true }))
      const deadline = setTimeout(() => controller.abort(), options.budgetMs ?? 5_000)
      try {
        for (const entry of entries.slice(0, 32)) {
          if (closed || controller.signal.aborted || readPrivacyRetirement(storage)?.phase === "pending") break
          const accepted = await Promise.race([stopped, Promise.resolve().then(() => erase(entry, controller.signal)).then(() => true, () => false)])
          if (!accepted || closed || controller.signal.aborted) break
          // Read current intent at acknowledgement time: a newer account may
          // have merged this same obligation while the request was in flight.
          acknowledgeRemoteErasure(storage, entry)
        }
      } finally { clearTimeout(deadline); controller.abort(); if (abort === controller) abort = undefined }
    })().catch(() => { /* Durable obligation remains; never report/log capability bytes. */ }).finally(() => {
      running = undefined
      if (closed) return
      try {
        if (pendingRemoteErasures(storage).length > 0) retry = setTimeout(wake, options.retryMs ?? 10_000)
      } catch { /* A corrupt fence stays blocked until explicit recovery. */ }
    })
  }
  return {
    wake,
    settled: (): Promise<void> => running ?? Promise.resolve(),
    dispose: async (): Promise<void> => { closed = true; clearTimeout(retry); abort?.abort(); await running }
  }
}
