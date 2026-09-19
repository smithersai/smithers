import { expect, test } from "bun:test"
import type { AppStore } from "../AppStore"
import { alreadySaid, claimSpokenLine, forgetVanishedClaims, latestOrdinal } from "./spokenLines"

/*
 * The rule's own unit, away from any door: a door's line is SPENT when an act
 * takes it. Everything the failure path does with it is these four functions.
 */

type Line = { readonly id: string; readonly ordinal: number; readonly text: string; readonly spoken?: true }

const transcript = (...lines: ReadonlyArray<Line>): Pick<AppStore["collections"], "messages"> =>
  ({ messages: { values: () => lines.values() } }) as unknown as Pick<AppStore["collections"], "messages">

const SAID = "This browser has no room left."

test("the high-water mark is the transcript's largest ordinal, and 0 when it is empty", () => {
  expect(latestOrdinal(transcript())).toBe(0)
  expect(latestOrdinal(transcript(
    { id: "a", ordinal: 4, text: SAID },
    { id: "b", ordinal: 2, text: SAID }
  ))).toBe(4)
})

test("only a door's own line, inside the window, carrying this sentence, can stand in for an act", () => {
  const lines = transcript(
    { id: "old", ordinal: 1, text: SAID, spoken: true },
    { id: "unspoken", ordinal: 3, text: SAID },
    { id: "other", ordinal: 4, text: "Something else.", spoken: true }
  )
  expect(alreadySaid(lines, SAID, 2)).toBe(false)
  expect(claimSpokenLine(lines, SAID, 2, new Set())).toBe(false)
  // The same line, one ordinal earlier in the window, is the act's to take.
  expect(claimSpokenLine(lines, SAID, 0, new Set())).toBe(true)
})

test("a door's line is spent on one act: the next act with the same sentence says its own", () => {
  const lines = transcript({ id: "said", ordinal: 2, text: SAID, spoken: true })
  const claimed = new Set<string>()
  expect(claimSpokenLine(lines, SAID, 1, claimed)).toBe(true)
  expect(claimed.has("said")).toBe(true)
  // The second lost act inside the same window. This is R104d's counterexample.
  expect(claimSpokenLine(lines, SAID, 1, claimed)).toBe(false)
  // Reading whether a line exists is not spending it: the form card's error
  // row yields to the door's line without taking it from the failure path.
  expect(alreadySaid(lines, SAID, 1)).toBe(true)
})

test("two doors that both spoke give two acts one line each, in ordinal order", () => {
  const lines = transcript(
    { id: "second", ordinal: 5, text: SAID, spoken: true },
    { id: "first", ordinal: 3, text: SAID, spoken: true }
  )
  const claimed = new Set<string>()
  expect(claimSpokenLine(lines, SAID, 2, claimed)).toBe(true)
  expect(claimSpokenLine(lines, SAID, 2, claimed)).toBe(true)
  expect([...claimed].sort()).toEqual(["first", "second"])
  expect(claimSpokenLine(lines, SAID, 2, claimed)).toBe(false)
})

test("a claim on a line the transcript no longer holds is forgotten", () => {
  const claimed = new Set(["gone", "kept"])
  forgetVanishedClaims(transcript({ id: "kept", ordinal: 1, text: SAID, spoken: true }), claimed)
  expect([...claimed]).toEqual(["kept"])
  // A cleared conversation leaves nothing to remember.
  forgetVanishedClaims(transcript(), claimed)
  expect([...claimed]).toEqual([])
})
