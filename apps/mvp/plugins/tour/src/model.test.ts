import { describe, expect, test } from "vitest"
import { choosePreview, clampStop, nextStop, previousStop, restartTour, stateAt, STOPS } from "./model"

describe("tour model", () => {
  test("clamps out-of-range and non-finite indices cleanly", () => {
    expect(clampStop(-5)).toBe(0)
    expect(clampStop(999)).toBe(STOPS.length - 1)
    expect(clampStop(Number.NaN)).toBe(0)
    expect(clampStop(2.9)).toBe(2)
  })

  test("advances, steps back, remembers preview choices per stop, and restarts", () => {
    const start = stateAt(0)
    expect(start.index).toBe(0)
    expect(start.hasPrevious).toBe(false)
    expect(start.hasNext).toBe(true)
    expect(start.percent).toBe(Math.round((1 / STOPS.length) * 100))
    expect(previousStop(start).index).toBe(0)

    const picked = choosePreview(start, start.stop.choices[1]!.id)
    expect(picked.activeChoice.id).toBe(start.stop.choices[1]!.id)
    // Unknown choice id is ignored cleanly
    expect(choosePreview(picked, "nonexistent")).toBe(picked)

    const second = nextStop(picked)
    expect(second.index).toBe(1)
    expect(second.hasPrevious).toBe(true)
    // Returning to stop 0 retains the earlier choice
    expect(previousStop(second).activeChoice.id).toBe(start.stop.choices[1]!.id)

    const last = stateAt(STOPS.length - 1, second.chosen)
    expect(last.hasNext).toBe(false)
    expect(last.percent).toBe(100)
    expect(nextStop(last).index).toBe(STOPS.length - 1)

    const reset = restartTour()
    expect(reset.index).toBe(0)
    expect(reset.chosen).toEqual({})
    expect(reset.activeChoice.id).toBe(STOPS[0]!.choices[0]!.id)
  })
})
