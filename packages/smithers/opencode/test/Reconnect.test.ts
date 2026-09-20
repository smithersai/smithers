import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { dataOf, serve, type Served, until } from "./Harness.ts"

let served: Served
beforeAll(() => {
  served = serve()
})
afterAll(() => served.dispose())

interface Frame {
  readonly id: string | undefined
  readonly type: string
  readonly properties: Record<string, unknown>
}

interface Tail {
  readonly frames: Array<Frame>
  readonly stop: () => Promise<void>
}

/**
 * Reads `/global/event` the way an `EventSource` does: the `id:` line of a
 * frame is the last event id, and it is what the browser sends back as
 * `Last-Event-ID` on the reconnect.
 */
const tail = async (lastEventID?: string): Promise<Tail> => {
  const response = await served.handler(
    new Request("http://test/global/event", {
      headers: lastEventID === undefined ? {} : { "last-event-id": lastEventID }
    })
  )
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Array<Frame> = []
  let buffered = ""
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) return
      buffered += decoder.decode(value)
      const chunks = buffered.split("\n\n")
      buffered = chunks.pop() ?? ""
      for (const chunk of chunks) {
        const lines = chunk.split("\n")
        const data = lines.find((line) => line.startsWith("data: "))
        if (data === undefined) continue
        const id = lines.find((line) => line.startsWith("id: "))
        const payload = JSON.parse(data.slice("data: ".length)).payload as Omit<Frame, "id">
        frames.push({ id: id?.slice("id: ".length), type: payload.type, properties: payload.properties })
      }
    }
  })()
  await until(async () => frames.some((frame) => frame.type === "server.connected"))
  return {
    frames,
    stop: async () => {
      await reader.cancel().catch(() => {})
      await pump
    }
  }
}

const createSession = async (title: string): Promise<string> => {
  const response = await served.handler(
    new Request("http://test/session", {
      method: "POST",
      body: JSON.stringify({ title }),
      headers: { "content-type": "application/json" }
    })
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

const titles = (frames: ReadonlyArray<Frame>): Array<string> =>
  frames
    .filter((frame) => frame.type === "session.created")
    .map((frame) => (frame.properties["info"] as { title: string }).title)

describe("an EventSource that drops and reconnects", () => {
  it("names the last event id on every buffered frame and replays only the gap", async () => {
    const first = await tail()
    // `server.connected` is the state of the stream, not an event anything
    // remembers, so it names no id: a browser that stored it would ask for a
    // replay from an id no buffer holds.
    expect(first.frames.find((frame) => frame.type === "server.connected")!.id).toBeUndefined()

    await createSession("before")
    await until(async () => titles(first.frames).includes("before"))
    const seen = first.frames.filter((frame) => frame.type === "session.created")
    const lastEventID = seen[seen.length - 1]!.id
    // The id line is the whole point: without it the browser sends no
    // `Last-Event-ID` and the gap below is lost with nothing saying so.
    expect(lastEventID).toMatch(/^evt_/)
    await first.stop()

    await createSession("during the gap")
    await createSession("also during the gap")

    const second = await tail(lastEventID)
    await until(async () => titles(second.frames).includes("also during the gap"))
    expect(titles(second.frames)).toEqual(["during the gap", "also during the gap"])
    // The replayed frames carry their own ids, so a second drop asks from
    // where this stream left off rather than from the start of the buffer.
    expect(second.frames.filter((frame) => frame.type === "session.created").every((frame) => frame.id !== undefined))
      .toBe(true)
    await second.stop()
  })
})
