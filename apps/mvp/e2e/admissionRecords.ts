import { writeFile } from "node:fs/promises"
import { wholeText } from "./console"
import type { Page, TestInfo } from "@playwright/test"

/** Observe real browser operations, without changing their results or recording their inputs. */
export const admissionRecords = async (page: Page, info: TestInfo) => {
  const records: unknown[] = []
  const consoleReads: Array<Promise<void>> = []
  page.on("console", message => {
    const text = message.text()
    if (text.startsWith("write.probe ")) records.push(JSON.parse(text.slice("write.probe ".length)))
    if (text.includes("write.admission") || text.includes("write.identity")) consoleReads.push(wholeText(message).then(line => {
      const fields = line.slice(line.indexOf("{"))
      try {
        const value = JSON.parse(fields) as Record<string, unknown>
        const allowed = ["commandId", "executionId", "writeId", "flow", "stage", "outcome", "atMs", "durationMs"]
        records.push({ at: Date.now(), ...Object.fromEntries(Object.entries(value).filter(([key]) => allowed.includes(key))) })
      } catch { /* A document that closed before its console arguments could be read has no receipt. */ }
    }))
  })
  page.on("request", request => {
    if (request.method() !== "POST") return
    const path = new URL(request.url()).pathname
    if (!/\/(writes|stack)$/.test(path)) return
    const value = request.postDataJSON() as { writeId?: string; opId?: string }
    records.push({ stage: "http.start", commandId: value.writeId ?? value.opId, at: Date.now() })
  })
  page.on("response", response => {
    if (response.request().method() === "POST" && /\/(writes|stack)$/.test(new URL(response.url()).pathname)) {
      const value = response.request().postDataJSON() as { writeId?: string; opId?: string }
      records.push({ stage: "http.receipt", commandId: value.writeId ?? value.opId, status: response.status(), at: Date.now() })
    }
  })
  page.on("requestfailed", request => {
    if (request.method() !== "POST" || !/\/(writes|stack)$/.test(new URL(request.url()).pathname)) return
    const value = request.postDataJSON() as { writeId?: string; opId?: string }
    records.push({ stage: "http.failed", commandId: value.writeId ?? value.opId, at: Date.now() })
  })
  await page.addInitScript(() => {
    let pressing = false
    const record = (stage: string, commandId?: string) => console.info("write.probe " + JSON.stringify({ stage, commandId, at: Date.now() }))
    const uuid = crypto.randomUUID.bind(crypto)
    crypto.randomUUID = () => { const id = uuid(); if (pressing) record("identity", id); return id }
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    crypto.subtle.digest = (...args) => {
      if (pressing) record("identity.digest.start")
      return digest(...args).then(value => { if (pressing) record("identity.digest.receipt"); return value })
    }
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args)
      if (this.transaction.db.name.includes("outbox")) {
        const key = args[1]
        const id = typeof key === "string" ? key.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0] : undefined
        record("outbox.store.start", id)
        request.addEventListener("success", () => record("outbox.store.receipt", id))
        this.transaction.addEventListener("complete", () => record("outbox.transaction.receipt", id))
        this.transaction.addEventListener("abort", () => record("outbox.transaction.aborted", id))
      }
      return request
    }
    addEventListener("submit", () => { pressing = true; record("input.submit") }, true)
    addEventListener("keydown", event => { if (event.key === "Enter") { pressing = true; record("input.enter") } }, true)
    addEventListener("pagehide", () => record("page.hide"))
    record("page.open")
  })
  return async () => {
    await Promise.all(consoleReads)
    const path = info.outputPath("write-admission-records.json")
    await writeFile(path, JSON.stringify(records, null, 2))
    await info.attach("write-admission-records", { path, contentType: "application/json" })
  }
}
