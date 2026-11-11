// When a repository's flows run (worker/ci/Triggers.ts): the manifest's trigger rows, and which GitHub events match.
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import * as Triggers from "./Triggers.ts"

const manifest = (triggers: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ apiVersion: 1, id: "repository", contributes: { triggers }, ...extra })

const push = (branch: string | null, tag: string | null = null): Triggers.Event => ({ event: "push", branch, tag, action: null })
const pull = (base: string, action = "opened"): Triggers.Event => ({ event: "pull_request", branch: base, tag: null, action })

describe("triggersOf", () => {
  test("reads a Plugin.Manifest's push and pull request rows, skipping what this slice can't read", () => {
    expect(Triggers.triggersOf(manifest([
      { on: "github.push", flow: "ci", branches: ["main"] },
      { on: "github.pull_request", flow: "ci", title: "Pull requests" },
      { on: "cron", flow: "nightly" },
      { on: "github.push", flow: "../escape" },
      "not a row",
    ]))).toEqual([
      { on: "github.push", flow: "ci", branches: ["main"] },
      { on: "github.pull_request", flow: "ci", title: "Pull requests" },
    ])
  })

  test("reads nothing from what isn't a Plugin.Manifest: S.Factory's factory.json, other JSON, not JSON", () => {
    expect(Triggers.triggersOf(JSON.stringify({ summary: "x", on: { "github.push:main": { flow: "ci" } } }))).toEqual([])
    expect(Triggers.triggersOf(JSON.stringify({ apiVersion: 2, contributes: { triggers: [{ on: "github.push", flow: "ci" }] } })))
      .toEqual([])
    expect(Triggers.triggersOf(JSON.stringify({ apiVersion: 1 }))).toEqual([])
    expect(Triggers.triggersOf(JSON.stringify({ apiVersion: 1, contributes: {} }))).toEqual([])
    expect(Triggers.triggersOf("{")).toEqual([])
  })

  test("reads at most MAX_TRIGGERS rows", () => {
    const rows = Array.from({ length: 70 }, (_, index) => ({ on: "github.push", flow: `f${index}` }))
    expect(Triggers.triggersOf(manifest(rows))).toHaveLength(Triggers.MAX_TRIGGERS)
  })
})

describe("schedulesOf", () => {
  test("reads cron rows on the package's Schedule, with its defaults, and skips what isn't one", () => {
    expect(Triggers.schedulesOf(manifest([
      { on: "cron", flow: "nightly", cron: "0 3 * * *", timezone: "Europe/Paris", title: "Nightly" },
      { on: "cron", flow: "hourly", cron: "0 * * * *", overlap: "buffer-one", catchUp: "one", maxCatchUp: 3 },
      { on: "github.push", flow: "ci" },
      { on: "cron", flow: "../escape", cron: "0 * * * *" },
      { on: "cron", flow: "empty", cron: "" },
      { on: "cron", flow: "seconds", cron: "*/10 * * * * *" },
      { on: "cron", flow: "policy", cron: "0 * * * *", overlap: "sometimes" },
      { on: "cron", flow: "missing" },
    ]))).toEqual([
      { on: "cron", flow: "nightly", cron: "0 3 * * *", timezone: "Europe/Paris", title: "Nightly", overlap: "skip", catchUp: "none", maxCatchUp: 0 },
      { on: "cron", flow: "hourly", cron: "0 * * * *", overlap: "buffer-one", catchUp: "one", maxCatchUp: 3 },
    ])
  })

  test("cron rows are not events: triggersOf skips them, and schedulesOf reads nothing from what isn't a manifest", () => {
    expect(Triggers.triggersOf(manifest([{ on: "cron", flow: "nightly", cron: "0 3 * * *" }]))).toEqual([])
    expect(Triggers.schedulesOf("{")).toEqual([])
    expect(Triggers.schedulesOf(JSON.stringify({ apiVersion: 2, contributes: { triggers: [{ on: "cron", flow: "n", cron: "0 * * * *" }] } })))
      .toEqual([])
    const rows = Array.from({ length: 70 }, (_, index) => ({ on: "cron", flow: `f${index}`, cron: "0 * * * *" }))
    expect(Triggers.schedulesOf(manifest(rows))).toHaveLength(Triggers.MAX_TRIGGERS)
  })
})

describe("matches", () => {
  test("a push trigger: every branch unless it names some, by glob; never a tag unless it names tags", () => {
    const all: Triggers.Trigger = { on: "github.push", flow: "ci" }
    const main: Triggers.Trigger = { on: "github.push", flow: "ci", branches: ["main", "release/*"] }
    expect(Triggers.matches(all, push("feature/x"))).toBe(true)
    expect(Triggers.matches(all, push(null, "v1.0.0"))).toBe(false)
    expect(Triggers.matches(main, push("main"))).toBe(true)
    expect(Triggers.matches(main, push("release/1.0"))).toBe(true)
    expect(Triggers.matches(main, push("release/1.0/hotfix"))).toBe(false)
    expect(Triggers.matches(main, push("mainline"))).toBe(false)
    expect(Triggers.matches(main, pull("main"))).toBe(false)
  })

  test("a push trigger naming tags runs on those tags and, unless it names branches too, on no branch", () => {
    const tags: Triggers.Trigger = { on: "github.push", flow: "release", tags: ["v*"] }
    expect(Triggers.matches(tags, push(null, "v1.2.3"))).toBe(true)
    expect(Triggers.matches(tags, push(null, "nightly"))).toBe(false)
    expect(Triggers.matches(tags, push("main"))).toBe(false)
    expect(Triggers.matches({ ...tags, branches: ["main"] }, push("main"))).toBe(true)
  })

  test("a pull request trigger: GitHub's default actions unless it names some, and its base branch", () => {
    const any: Triggers.Trigger = { on: "github.pull_request", flow: "ci" }
    expect(Triggers.matches(any, pull("main", "opened"))).toBe(true)
    expect(Triggers.matches(any, pull("main", "synchronize"))).toBe(true)
    expect(Triggers.matches(any, pull("main", "reopened"))).toBe(true)
    expect(Triggers.matches(any, pull("main", "closed"))).toBe(false)
    expect(Triggers.matches({ ...any, actions: ["closed"] }, pull("main", "closed"))).toBe(true)
    expect(Triggers.matches({ ...any, branches: ["main"] }, pull("dev"))).toBe(false)
    expect(Triggers.matches(any, { ...pull("main"), branch: null })).toBe(false)
    expect(Triggers.matches(any, { ...pull("main"), action: null })).toBe(false)
    expect(Triggers.matches(any, push("main"))).toBe(false)
  })

  test("globs: `*` stops at a slash, `**` doesn't, and every other character is literal", () => {
    expect(Triggers.globMatches("release/**", "release/1/2")).toBe(true)
    expect(Triggers.globMatches("release/*", "release/1/2")).toBe(false)
    expect(Triggers.globMatches("**", "")).toBe(true)
    expect(Triggers.globMatches("*", "a/b")).toBe(false)
    expect(Triggers.globMatches("v1.*", "v1x2")).toBe(false)
    expect(Triggers.globMatches("v1.*", "v1.2")).toBe(true)
    expect(Triggers.globMatches("a+b", "a+b")).toBe(true)
    expect(Triggers.globMatches("a", "")).toBe(false)
  })

  test("a pattern built to backtrack matches in a blink: no regular expression", () => {
    const started = performance.now()
    for (let i = 0; i < 100; i++) {
      expect(Triggers.globMatches(`${"*a".repeat(120)}b`, "a".repeat(255))).toBe(false)
    }
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe("flowsFor", () => {
  test("each matching flow once, in the manifest's order", () => {
    const triggers = Triggers.triggersOf(manifest([
      { on: "github.push", flow: "lint" },
      { on: "github.push", flow: "ci", branches: ["main"] },
      { on: "github.push", flow: "lint", branches: ["main"] },
      { on: "github.pull_request", flow: "review" },
    ]))
    expect(Triggers.flowsFor(triggers, push("main"))).toEqual(["lint", "ci"])
    expect(Triggers.flowsFor(triggers, pull("main"))).toEqual(["review"])
  })
})

test("smithersai/smithers factory at main eeb01ea499d0 is legacy data and never triggers runs", () => {
  const source = readFileSync(new URL("./test/smithers-factory.json", import.meta.url), "utf8")
  expect(Object.keys(JSON.parse(source))).toEqual(expect.arrayContaining(["summary", "flows", "on", "github"]))
  const triggers = Triggers.triggersOf(source)
  expect(triggers).toEqual([])
  expect(Triggers.flowsFor(triggers, push("main"))).toEqual([])
  expect(Triggers.flowsFor(triggers, pull("main"))).toEqual([])
})

describe("manualFlows", () => {
  test("the flows a person may run by hand: each manual row's flow once, in order, with its title; no event starts one", () => {
    const triggers = Triggers.triggersOf(manifest([
      { on: "github.push", flow: "ci" },
      { on: "manual", flow: "release", title: "Release" },
      { on: "manual", flow: "hand" },
      { on: "manual", flow: "release", title: "Again" },
    ]))
    expect(Triggers.manualFlows(triggers)).toEqual([{ name: "release", title: "Release" }, { name: "hand" }])
    expect(Triggers.flowsFor(triggers, push("main"))).toEqual(["ci"])
    expect(Triggers.flowsFor(triggers, pull("main"))).toEqual([])
  })
})
