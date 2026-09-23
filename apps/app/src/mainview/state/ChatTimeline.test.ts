import { describe, expect, test } from "bun:test"
import { active, all, lanesFromCards, merge, toggle, type Lane, type MainEntry } from "./ChatTimeline"
import type { Card, Message } from "./AppState"

const message = (id: string, at: number): MainEntry => ({ kind: "message", message: { id, ordinal: at, createdAt: at, text: id } as Message })
const lane = (id: string, rows: Lane["rows"]): Lane => ({ id, title: id, color: 0, createdAt: 0, rows })
const keys = (entries: ReturnType<typeof merge>): string[] => entries.map(entry => entry.kind === "lane" ? entry.row.id : entry.kind === "card" ? entry.card.id : entry.message.id)

describe("chat timeline", () => {
  test("interleaves lanes with the main timeline while preserving each source's order", () => {
    const rows = merge([message("chat-1", 10), message("chat-2", 30)], [lane("agent", [
      { id: "a", at: 20, text: "first" }, { id: "b", at: 25, text: "second" }
    ])])
    expect(keys(rows)).toEqual(["chat-1", "a", "b", "chat-2"])
    expect(rows[1]?.kind === "lane" && rows[1].first).toBe(true)
    expect(rows[2]?.kind === "lane" && rows[2].first).toBe(false)
  })

  test("clamps skewed lane times and lets missing time inherit the preceding row", () => {
    const rows = merge([message("chat", 18)], [lane("agent", [
      { id: "a", at: 20, text: "one" }, { id: "b", at: 5, text: "two" }, { id: "c", text: "three" }
    ])])
    expect(keys(rows)).toEqual(["chat", "a", "b", "c"])
  })

  test("source, kind, and case insensitive text filters compose and reset", () => {
    const main = [message("Hello", 10)]
    const lanes = [lane("agent", [{ id: "a", at: 20, text: "Needle" }])]
    const hidden = toggle(all, "agent")
    expect(keys(merge(main, lanes, hidden))).toEqual(["Hello"])
    expect(keys(merge(main, lanes, toggle(all, "messages")))).toEqual(["a"])
    expect(keys(merge(main, lanes, { ...all, query: "nEeDlE" }))).toEqual(["a"])
    expect(keys(merge(main, lanes, { ...all, query: "missing" }))).toEqual([])
    expect(active(hidden)).toBe(true)
    expect(toggle(hidden, "agent")).toEqual(all)
    expect(merge(main, lanes, all)).toHaveLength(2)
  })

  test("projects cloud, run, and local lanes from their cards with distinct, order-independent colors", () => {
    const cloud = { id: "cloud", kind: "agent", title: "Cloud", createdAt: 50, payload: {
      cloud: true, displayName: "Delegate", transcript: [{ id: 7, sequence: 1, role: "assistant", createdAt: "2026-09-14T09:00:00Z", parts: [{ type: "text", text: "done" }] }]
    } } as Card
    const local = { id: "local", kind: "agent", title: "Local", createdAt: 50, payload: { displayName: "Terminal" } } as Card
    const run = { id: "run", kind: "run-trace", title: "Build", createdAt: 51, payload: {
      transcriptRows: [{ sequence: 1, at: 60, kind: "answer", text: "built" }]
    } } as Card
    const lanes = lanesFromCards([cloud, local, run])
    expect(lanes.map(lane => [lane.id, lane.rows.length])).toEqual([["cloud", 1], ["local", 0], ["run", 1]])
    expect(new Set(lanes.map(lane => lane.color)).size).toBe(3)
    expect(lanesFromCards([run, local, cloud]).map(lane => [lane.id, lane.color])).toEqual(lanes.map(lane => [lane.id, lane.color]))
    expect(lanes[0]?.rows[0]?.text).toBe("done")
    expect(lanes[2]?.rows[0]?.text).toBe("built")
    const main: MainEntry[] = [{ kind: "card", card: local }, message("chat", 55)]
    expect(keys(merge(main, lanes, toggle(all, "local")))).not.toContain("local")
    expect(keys(merge(main, lanes, toggle(all, "chat")))).toContain("local")
  })
})
