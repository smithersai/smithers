import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { dataOf, serve, type Served, until } from "./Harness.ts"

let served: Served
beforeAll(() => {
  served = serve()
})
afterAll(() => served.dispose())

interface Seen {
  readonly type: string
  readonly properties: Record<string, unknown>
}

/** Tails `/global/event` into a list, from `server.connected` on. */
const watch = async (): Promise<Array<Seen>> => {
  const response = await served.handler(new Request("http://test/global/event"))
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const seen: Array<Seen> = []
  let buffered = ""
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) return
      buffered += decoder.decode(value)
      const chunks = buffered.split("\n\n")
      buffered = chunks.pop() ?? ""
      for (const chunk of chunks) {
        const data = dataOf(chunk)
        if (data !== undefined) seen.push(JSON.parse(data).payload as Seen)
      }
    }
  })()
  await until(async () => seen.some((event) => event.type === "server.connected"))
  return seen
}

const post = async (path: string, body: string): Promise<Response> =>
  served.handler(
    new Request(`http://test${path}`, { method: "POST", body, headers: { "content-type": "application/json" } })
  )

const json = async (path: string): Promise<unknown> => (await served.handler(new Request(`http://test${path}`))).json()

describe("DELETE /session/:id on a busy session", () => {
  it("answers true only once the turn it aborted has ended", async () => {
    const seen = await watch()
    const session = (await (await post("/session", "{}")).json()) as { id: string }
    expect((await post(`/session/${session.id}/prompt_async`, `{"parts":[{"type":"text","text":"go"}]}`)).status)
      .toBe(204)
    // The turn parks on the demo script's permission card, which is the busy
    // session a person deletes: the row is on screen and the turn is running.
    await until(async () =>
      seen.some((event) => event.type === "permission.asked" && event.properties["sessionID"] === session.id)
    )
    expect(await json("/session/status")).toMatchObject({ [session.id]: { type: "busy" } })

    const deleted = await served.handler(new Request(`http://test/session/${session.id}`, { method: "DELETE" }))
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toBe(true)

    // True means gone. The turn is over before the answer is written, so
    // nothing is left to run and nothing writes the session back.
    expect(await json("/session/status")).toEqual({})
    expect((await served.handler(new Request(`http://test/session/${session.id}`))).status).toBe(404)
    expect(await json("/session")).toEqual([])

    // Nothing about the session is published after it was deleted. The fold
    // of the aborted turn used to land here, writing its messages back into
    // a store the delete had already emptied.
    await until(async () => seen.some((event) => event.type === "session.deleted"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const mine = seen.filter((event) =>
      event.properties["sessionID"] === session.id ||
      (event.properties["info"] as { id?: string } | undefined)?.id === session.id
    )
    expect(mine[mine.length - 1]!.type).toBe("session.deleted")
  })
})
