import { describe, expect, test } from "vitest"
import { type HostRecord, hostRecords, MAX_WAITING, thrownName } from "./hostRecords"

describe("the host's records", () => {
  test("wait for the program, up to a limit, then reach it in order; the next are heard as they come", () => {
    const records = hostRecords()
    for (let index = 0; index < MAX_WAITING + 5; index++) records.record({ _tag: "pwa.install" })
    const heard: Array<HostRecord> = []
    const stop = records.listen((record) => heard.push(record))
    expect(heard).toHaveLength(MAX_WAITING)
    records.record({ _tag: "render", boundary: "caught", name: "TypeError" })
    expect(heard.at(-1)).toEqual({ _tag: "render", boundary: "caught", name: "TypeError" })
    stop()
    // Stopped, it hears nothing more; what comes waits for the next listener.
    records.record({ _tag: "pwa.update", outcome: "activated" })
    expect(heard).toHaveLength(MAX_WAITING + 1)
    const next: Array<HostRecord> = []
    const stopNext = records.listen((record) => next.push(record))
    expect(next).toEqual([{ _tag: "pwa.update", outcome: "activated" }])
    // An earlier listener stopping late doesn't stop the one listening now.
    stop()
    records.record({ _tag: "pwa.install" })
    expect(next).toHaveLength(2)
    stopNext()
  })

  test("name a thrown value by its error's name or its type, never its message", () => {
    expect(thrownName(new TypeError("someone's words"))).toBe("TypeError")
    expect(thrownName("someone's words")).toBe("string")
    expect(thrownName(undefined)).toBe("undefined")
  })
})
