import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Keys from "../src/keys.ts"

const read = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8")
const app = read("app.tsx")

/** A key literal a handler compares against, with whether Ctrl must be held. */
interface Handled {
  readonly name: string
  readonly ctrl: boolean
  readonly at: string
}

const literal = String.raw`"(?:[^"\\]|\\.)*"`
const ctrlBefore = String.raw`(key\.ctrl\s*&&\s*\(?\s*)?`
/** Every way the handlers name a key; a shape outside these fails the guard below. */
const shapes = [
  new RegExp(String.raw`${ctrlBefore}key\.name\s*===\s*(${literal})`, "g"),
  new RegExp(String.raw`${ctrlBefore}\[((?:\s*${literal}\s*,?)+)\]\.includes\(key\.name\)`, "g")
]

const handled = (source: string, file: string): ReadonlyArray<Handled> =>
  shapes.flatMap((shape) =>
    [...source.matchAll(shape)].flatMap((match) =>
      [...match[2]!.matchAll(new RegExp(literal, "g"))].map((each) => ({
        name: JSON.parse(each[0]) as string,
        ctrl: match[1] !== undefined,
        at: `${file}: ${match[0]}`
      }))
    )
  )

/** Pure helpers take the name as a parameter and compare it or switch on it. */
const helper = (file: string, parameter: string): ReadonlyArray<Handled> =>
  [...read(file).matchAll(new RegExp(String.raw`(?:\b${parameter}\s*===|\bcase)\s*(${literal})`, "g"))].map((match) => ({
    name: JSON.parse(match[1]!) as string,
    ctrl: false,
    at: `${file}: ${match[0]}`
  }))

const handlerKeys = (source: string): ReadonlyArray<Handled> => [
  ...handled(source, "app.tsx"),
  ...helper("approvals.ts", "name"),
  ...helper("panels.ts", "key"),
  ...helper("scrubber.ts", "name")
]

const unregistered = (keys: ReadonlyArray<Handled>): ReadonlyArray<string> =>
  keys.filter(({ name, ctrl }) =>
    !Keys.registry.some((binding) =>
      binding.keys.some((spelling) => {
        const parts = spelling.split("+")
        // An unmarked comparison may sit under an outer `key.ctrl` test, so it matches either form.
        return Keys.normalizeName(parts.at(-1)!) === Keys.normalizeName(name) && (!ctrl || parts.includes("ctrl"))
      })
    )
  ).map(({ at }) => at)

/** `key.name` read outside a recognized comparison: passed on, never compared here. */
const passedOn = [
  "Approvals.key(key.name",
  "Panels.navigate(current, key.name",
  "Activity.move(monitored.activity, activeInspection.seq, key.name)",
  "panelScroll.current?.(key.name",
  "(at + (key.name",
  "\"]\" : key.name"
]
const strayReads = (source: string): ReadonlyArray<string> => {
  let rest = source
  for (const shape of shapes) rest = rest.replace(shape, "")
  for (const use of passedOn) rest = rest.split(use).join("")
  return rest.split("\n").filter((line) => line.includes("key.name")).map((line) => line.trim())
}

describe("key registry", () => {
  it("has no duplicate spelling in one context", () => {
    expect(Keys.duplicateKeys()).toEqual([])
  })

  it("keeps every label to three words", () => {
    expect(Keys.registry.every((binding) => binding.label.trim().split(/\s+/).length <= 3)).toBe(true)
  })

  it("registers every key a handler compares, with its Ctrl modifier", () => {
    const keys = handlerKeys(app)
    // Non-vacuous: the scan sees the tab keys that arrive through `.includes`.
    expect(keys.some(({ name, ctrl }) => name === "]" && ctrl)).toBe(true)
    expect(keys.some(({ name }) => name === "y")).toBe(true)
    expect(keys.some(({ name }) => name === "j")).toBe(true)
    expect(unregistered(keys)).toEqual([])
    expect(strayReads(app)).toEqual([])
  })

  it("fails for a handler key added without a binding", () => {
    const withCtrlA = app.replace(
      "if (key.ctrl && key.name === \"k\") {",
      "if (key.ctrl && key.name === \"a\") return\n    if (key.ctrl && key.name === \"k\") {"
    )
    expect(withCtrlA).not.toBe(app)
    expect(unregistered(handlerKeys(withCtrlA))).toEqual(["app.tsx: key.ctrl && key.name === \"a\""])

    const withArray = app.replace("[\"right\", \"left\", \"]\", \"\\\\\"]", "[\"right\", \"left\", \"]\", \"\\\\\", \"b\"]")
    expect(withArray).not.toBe(app)
    expect(unregistered(handlerKeys(withArray))).toEqual([expect.stringContaining("\"b\"")])

    const withSwitch = app.replace("useKeyboard(handleKey)", "switch (key.name) {}\n  useKeyboard(handleKey)")
    expect(strayReads(withSwitch)).toEqual(["switch (key.name) {}"])
  })

  it("lists only keys some handler compares", () => {
    const names = new Set([...handlerKeys(app).map(({ name }) => Keys.normalizeName(name)), "?", "/", "@", "!", "shift+enter", "linefeed"])
    const composerKeys = [...app.matchAll(/\{ name: "([^"]+)"/g)].map((match) => match[1]!)
    for (const name of composerKeys) names.add(Keys.normalizeName(name))
    const orphans = Keys.registry.flatMap((binding) =>
      binding.keys.filter((spelling) => !names.has(Keys.normalizeName(spelling.split("+").at(-1)!)) && !names.has(spelling))
    )
    expect(orphans).toEqual([])
  })

  it("covers the dispatch contexts and provides useful hints", () => {
    for (const context of ["composer", "working", "shell", "panel", "picker", "form", "approval", "selection", "completion"] as const) {
      expect(Keys.bindingsFor(context).length).toBeGreaterThan(0)
      expect(Keys.hintsFor(context).length).toBeGreaterThan(0)
    }
    expect(Keys.hintsFor("composer").map(Keys.primaryKey)).toEqual(["ctrl+k", "ctrl+s", "ctrl+]", "?"])
    expect(Keys.hintsFor("working").map(Keys.primaryKey)).toEqual(["esc", "enter", "alt+enter", "?"])
    expect(Keys.hintsFor("approval").map((binding) => binding.id)).toEqual(["allow", "deny", "allow-all"])
  })

  it("matches the terminal forms the app dispatches", () => {
    expect(Keys.matches({ name: "p", ctrl: true, shift: true }, "ctrl+shift+p")).toBe(true)
    expect(Keys.matches({ name: "kpenter" }, "enter")).toBe(true)
    expect(Keys.bindingFor({ name: "]", ctrl: true })?.id).toBe("next-tab")
    expect(Keys.bindingFor({ name: "\\", ctrl: true })?.id).toBe("previous-tab")
    expect(Keys.bindingFor({ name: "?" }, "composer")?.id).toBe("keys")
    expect(Keys.bindingFor({ name: "y" }, "approval")?.id).toBe("allow")
  })
})

describe("transcript scrolling", () => {
  it("scrolls a line with shift+up and shift+down from any context", () => {
    expect(Keys.bindingFor({ name: "up", shift: true }, "composer")?.id).toBe("scroll-line")
    expect(Keys.bindingFor({ name: "down", shift: true }, "working")?.id).toBe("scroll-line")
    expect(Keys.bindingFor({ name: "up" }, "composer")?.id).not.toBe("scroll-line")
  })
})
