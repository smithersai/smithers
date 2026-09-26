/** A bounded, same-origin OpenRouter transport. Keys and spend reservations stay server-side. */
import { createHash, randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
export function cheapest(models) {
  return models.flatMap((model) => {
    const input = Number(model.pricing?.prompt),
      output = Number(model.pricing?.completion),
      request = Number(model.pricing?.request ?? 0)
    if (
      !model.id || (!Number.isInteger(model.context_length) || model.context_length < 32_768) ||
      !Number.isFinite(input) || !Number.isFinite(output) ||
      !Number.isFinite(request) || Math.min(input, output, request) < 0
    ) return []
    if (model.architecture?.output_modalities && !model.architecture.output_modalities.includes("text")) return []
    return [{ id: model.id, input, output, request, cost: input * 33_000 + output * 2048 + request }]
  }).sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))[0]
}
export class Sponsor {
  constructor({ key, database, fetchImpl = fetch, dailyDollars = 0.5, dailyCalls = 100, now = () => Date.now() }) {
    this.key = key
    this.fetch = fetchImpl
    this.dailyDollars = dailyDollars
    this.dailyCalls = dailyCalls
    this.now = now
    if (!Number.isFinite(dailyDollars) || dailyDollars < 0 || !Number.isInteger(dailyCalls) || dailyCalls < 1) {
      throw new Error("Invalid sponsor budget")
    }
    this.db = new DatabaseSync(database)
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, day TEXT NOT NULL, visitor TEXT NOT NULL, digest TEXT NOT NULL, reserved REAL NOT NULL, response TEXT); CREATE INDEX IF NOT EXISTS attempts_day ON attempts(day);"
    )
  }
  close() {
    this.db.close()
  }
  async handle(request, origin) {
    const json = (body, status = 200, headers = {}) =>
      Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405)
    if (request.headers.get("origin") !== origin) return json({ error: "Origin refused" }, 403)
    if (!this.key) return json({ error: "Sponsored access is not configured" }, 503)
    const reader = request.body?.getReader()
    if (!reader) return json({ error: "Missing request" }, 400)
    const chunks = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 32_000) {
        await reader.cancel()
        return json({ error: "Request too large" }, 413)
      }
      chunks.push(part.value)
    }
    let input
    try {
      input = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      return json({ error: "Invalid JSON" }, 400)
    }
    if (
      !Array.isArray(input.messages) || input.messages.length > 80 ||
      input.messages.some((m) => !["user", "assistant", "system"].includes(m.role) || typeof m.content !== "string")
    ) return json({ error: "Invalid messages" }, 400)
    const existing = /\bsmithers_demo=([a-f0-9-]{36})\b/.exec(request.headers.get("cookie") || "")?.[1]
    const visitor = existing || randomUUID(),
      cookie = {
        "Set-Cookie": `smithers_demo=${visitor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${
          origin.startsWith("https:") ? "; Secure" : ""
        }`
      }
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const digest = createHash("sha256").update(JSON.stringify(input.messages)).digest("hex")
    const cached = this.db.prepare(
      "SELECT response FROM attempts WHERE visitor=? AND digest=? AND day=? AND response IS NOT NULL ORDER BY rowid DESC LIMIT 1"
    ).get(visitor, digest, day)
    if (cached) return json(JSON.parse(cached.response), 200, cookie)
    if (!this.catalog || this.catalog.expires < this.now()) {
      const response = await this.fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(15_000),
        redirect: "error"
      })
      if (!response.ok) return json({ error: "Model catalog unavailable" }, 503, cookie)
      this.catalog = { model: cheapest((await response.json()).data ?? []), expires: this.now() + 3_600_000 }
    }
    const model = this.catalog.model
    if (!model) return json({ error: "No eligible model" }, 503, cookie)
    const reservation = model.input * (size + 1000) + model.output * 2048 + model.request
    this.db.exec("BEGIN IMMEDIATE")
    const id = randomUUID()
    try {
      const total = this.db.prepare(
        "SELECT COUNT(*) AS calls, COALESCE(SUM(reserved),0) AS dollars FROM attempts WHERE day=?"
      ).get(day)
      const perVisitor = this.db.prepare("SELECT COUNT(*) AS calls FROM attempts WHERE day=? AND visitor=?").get(
        day,
        visitor
      )
      if (total.calls >= this.dailyCalls || perVisitor.calls >= 16 || total.dollars + reservation > this.dailyDollars) {
        this.db.exec("ROLLBACK")
        return json({ error: "Sponsored limit reached. Use your own provider." }, 429, cookie)
      }
      this.db.prepare("INSERT INTO attempts(id,day,visitor,digest,reserved) VALUES(?,?,?,?,?)").run(
        id,
        day,
        visitor,
        digest,
        reservation
      )
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    // Reservations are never refunded on an ambiguous transport failure.
    const response = await this.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        messages: input.messages,
        stream: false,
        max_tokens: 2048,
        provider: { sort: "price", allow_fallbacks: false }
      })
    })
    if (!response.ok) return json({ error: "Provider unavailable" }, response.status === 429 ? 429 : 502, cookie)
    const data = await response.json(), choice = data.choices?.[0]
    if (
      choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string" ||
      choice.message.content.length > 100_000
    ) return json({ error: "Incomplete provider response" }, 502, cookie)
    const result = {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: choice.message.content } }]
    }
    this.db.prepare("UPDATE attempts SET response=? WHERE id=?").run(JSON.stringify(result), id)
    return json(result, 200, cookie)
  }
}
