import { describe, expect, it } from "vitest"
import { chooseJourney, DEFAULT_CHOICE, Facts, FrontDoor, shadowedJourneys } from "../src/FrontDoor.ts"
import { catalogFixtures, placeholderRules, visitFacts } from "./fixtures/FrontDoor.ts"

describe("front door", () => {
  const rules = () => FrontDoor.parse(placeholderRules)
  it.each(catalogFixtures)("catalog row $row", ({ row, facts }) => {
    const result = chooseJourney(rules(), Facts.parse(facts))
    expect(result.journey).toBe(({ 5: "no-repo", 9: "effeck-anon", 16: "default" })[row])
    if (row === 5) expect(result.order[0]).toBe("open-existing")
    if (row === 9) expect(result.order[1]).toBe("explore")
    if (row === 16) expect(result).toEqual(DEFAULT_CHOICE)
  })
  it("never treats unknown, loading or refused reads as zero", () => {
    expect(chooseJourney(rules(), { ...visitFacts, signedIn: true })).toEqual(DEFAULT_CHOICE)
    for (const key of ["ownRepos", "coveredNotImported", "activeRuns", "modelConnections"]) {
      const r = FrontDoor.parse({
        ...placeholderRules,
        journeys: [
          { ...placeholderRules.journeys[0], when: { [key]: {} } }
        ]
      })
      expect(chooseJourney(r, visitFacts)).toEqual(DEFAULT_CHOICE)
    }
  })
  it("holds out only signed-out visits", () => {
    expect(chooseJourney(rules(), { ...visitFacts, source: "effeck", arm: "hold" })).toEqual(DEFAULT_CHOICE)
    expect(
      chooseJourney(rules(), { ...visitFacts, signedIn: true, arm: "hold", ownRepos: { state: "known", value: 0 } })
        .journey
    ).toBe("no-repo")
  })
  it("uses inclusive ranges and first match", () => {
    const r = rules()
    r.journeys[0]!.when.ownRepos = { min: 1, max: 2 }
    for (const value of [0, 1, 2, 3]) {
      expect(chooseJourney(r, { ...visitFacts, signedIn: true, ownRepos: { state: "known", value } }).journey)
        .toBe(value === 1 || value === 2 ? "no-repo" : "default")
    }
  })
  it("detects complete shadowing, including bounded ranges and source subsets", () => {
    const r = rules()
    r.journeys.unshift({ ...r.journeys[0]!, id: "earlier", when: { signedIn: true, ownRepos: { min: 0, max: 10 } } })
    expect(shadowedJourneys(r)).toEqual([{ journey: "no-repo", by: "earlier" }])
    r.journeys[0]!.when.ownRepos = { min: 1 }
    expect(shadowedJourneys(r)).toEqual([])
    r.journeys.unshift({ ...r.journeys[1]!, id: "all", when: {} })
    expect(shadowedJourneys(r).map((x) => x.journey)).toContain("default")
  })
  it("rejects visitor memo facts, unsafe actions, HTML blocks, invalid ranges and duplicate sections", () => {
    expect(Facts.safeParse({ ...visitFacts, everSignedIn: true }).success).toBe(false)
    for (const flow of ["repos.import", "repos.create", "approval.approve", "flow.run", "sign-in", "bogus"]) {
      expect(
        FrontDoor.safeParse({
          ...placeholderRules,
          journeys: [
            { ...placeholderRules.journeys[0], lead: [{ type: "action", flow, label: "placeholder" }] }
          ]
        }).success
      ).toBe(false)
    }
    for (const when of [{ visits: { min: 1 } }, { ownRepos: { min: 2, max: 1 } }]) {
      expect(
        FrontDoor.safeParse({ ...placeholderRules, journeys: [{ ...placeholderRules.journeys[0], when }] }).success
      ).toBe(false)
    }
    expect(
      FrontDoor.safeParse({
        ...placeholderRules,
        journeys: [
          { ...placeholderRules.journeys[0], order: Array(5).fill("open") }
        ]
      }).success
    ).toBe(false)
  })
  it("empty rules are exactly today's launcher", () => {
    expect(chooseJourney(FrontDoor.parse({ version: 1, journeys: [] }), { ...visitFacts, source: "effeck" })).toEqual(
      DEFAULT_CHOICE
    )
  })
})

describe("front door ranges and labels", () => {
  const facts = (ownRepos: number) => ({
    ...visitFacts,
    signedIn: true,
    ownRepos: { state: "known", value: ownRepos } as const
  })
  it("a range with only a minimum has no upper bound", () => {
    const r = FrontDoor.parse({
      ...placeholderRules,
      journeys: [{ ...placeholderRules.journeys[0], when: { ownRepos: { min: 3 } } }]
    })
    for (const value of [2, 3, 1_000_000]) {
      expect(chooseJourney(r, facts(value)).journey).toBe(value >= 3 ? "no-repo" : "default")
    }
  })
  it("an earlier label rule shadows only a later rule whose labels it all allows", () => {
    const journey = (id: string, when: object) => ({ ...placeholderRules.journeys[2], id, when })
    const shadowed = (later: object) =>
      shadowedJourneys(FrontDoor.parse({
        ...placeholderRules,
        journeys: [journey("earlier", { source: ["effeck", "github"] }), journey("later", later)]
      }))
    expect(shadowed({ source: ["github"] })).toEqual([{ journey: "later", by: "earlier" }])
    expect(shadowed({ source: ["github", "search"] })).toEqual([])
    expect(shadowed({})).toEqual([])
    expect(shadowed({ medium: ["email"] })).toEqual([])
  })
})
