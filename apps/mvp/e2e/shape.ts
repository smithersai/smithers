import { type APIRequestContext, expect } from "@playwright/test"
import { ownPlace } from "./target"

// The `messages` rows a signed-in person reads, through ChatApi's shape proxy, as their devices read them
// (worker/Chat.ts). The local-first tests compare them with what each device shows; the spend guard (e2e/spend.ts)
// adds up their answers' tokens.

/** A row of Postgres `messages` as Electric's shape serves it (snake_case columns). */
export type Row = {
  id: string
  role: string
  text: string
  status: string
  question_id: string | null
  failure: string | null
  position: string
  input_tokens?: string | null
  output_tokens?: string | null
  created_at?: string
}

type ShapeMessage<A = Row> = {
  key?: string
  value?: Partial<A>
  headers: { operation?: "insert" | "update" | "delete"; control?: string }
}

/** A fresh complete snapshot. Electric caches each immutable HTTP page; one nonce survives all its continuations. */
export const shapeRows = async <A extends object>(request: APIRequestContext, path: string): Promise<Array<A>> => {
  const rows = new Map<string, A>()
  const query = new URLSearchParams({ offset: "-1", "cache-buster": crypto.randomUUID() })
  for (let page = 0; page < 1_000; page++) {
    const response = await request.get(`${path}${path.includes("?") ? "&" : "?"}${query}`)
    expect(response.status(), `${path} serves a complete fixture snapshot`).toBe(200)
    const messages = await response.json() as Array<ShapeMessage<A>>
    for (const message of messages) {
      if (message.key === undefined) continue
      if (message.headers.operation === "delete") rows.delete(message.key)
      else if (message.headers.operation !== undefined) rows.set(message.key, { ...rows.get(message.key), ...message.value } as A)
    }
    const headers = response.headers()
    // The protocol control closes the snapshot; HTTP metadata alone must not discard later chunks.
    if (messages.some((message) => message.headers.control === "up-to-date")) return [...rows.values()]
    expect(headers["electric-offset"], "a snapshot continuation needs an offset").toBeTruthy()
    expect(headers["electric-handle"], "a snapshot continuation needs a handle").toBeTruthy()
    query.set("offset", headers["electric-offset"]!)
    query.set("handle", headers["electric-handle"]!)
  }
  throw new Error(`${path} did not finish its fixture snapshot`)
}

// Every row of Postgres `messages`, in `position` order, read the way devices read them: Electric's shape through
// ChatApi's proxy, from the start of its log until it is up to date.
// It reads the conversation the run asks in: the app's home, or a deployment run's own branch (e2e/target.ts `home`).
export const allServerRows = async (request: APIRequestContext): Promise<Array<Row>> => {
  const rows = new Map<string, Row>()
  const place = ownPlace()
  const conversation = place === undefined ? "" : `conversation=${place.conversationId}&`
  let query = `${conversation}offset=-1`
  for (let page = 0; page < 1_000; page++) {
    const response = await request.get(`/api/shapes/messages?${query}`)
    expect(response.status(), "ChatApi serves the messages shape").toBe(200)
    for (const message of (await response.json()) as Array<ShapeMessage>) {
      const key = message.key ?? message.value?.id
      if (key === undefined) continue
      if (message.headers.operation === "delete") rows.delete(key)
      else if (message.headers.operation !== undefined) rows.set(key, { ...rows.get(key), ...message.value } as Row)
    }
    const headers = response.headers()
    if ("electric-up-to-date" in headers) break
    query = `${conversation}offset=${headers["electric-offset"]}&handle=${headers["electric-handle"]}`
  }
  return [...rows.values()].sort((left, right) => Number(left.position) - Number(right.position))
}
