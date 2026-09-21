import { expect, test } from "bun:test"
import { scenario } from "./types"
import { extractRequestedGrep, hostGrep, scenarioGrep } from "./selection"

test("portable scenarios carry every declared host tag", () => {
  const details = scenario("browser.reload", { capabilities: [], coverage: ["action:chat.reload", "host:local", "host:production", "path:persistence", "door:button"] })
  expect(details.tag).toEqual(["@real-scenario:browser.reload", "@real-host:local", "@real-host:production"])
})

test("host selection includes portable cases and excludes other hosts without skips", () => {
  const local = hostGrep("local")
  expect(local.test("suite portable @real-host:local @real-host:production")).toBe(true)
  expect(local.test("suite cloud-only @real-host:production")).toBe(false)
  expect(local.test("suite wrong suffix @real-host:localish")).toBe(false)
  expect(local.test("suite no declared host")).toBe(false)
})

test("a test-name expression cannot broaden the selected host", () => {
  const selected = hostGrep("production", "reload|fork")
  expect(selected.test("suite reload @real-host:production")).toBe(true)
  expect(selected.test("suite fork @real-host:local")).toBe(false)
  expect(selected.test("suite edit @real-host:production")).toBe(false)
})

test("scenario selection uses one shared set independently of host tags", () => {
  const selected = scenarioGrep(["chat.stream-grounded", "chat.stop-real-turn"])
  expect(selected.test("turn @real-scenario:chat.stream-grounded @real-host:local")).toBe(true)
  expect(selected.test("turn @real-scenario:chat.stream-grounded @real-host:production")).toBe(true)
  expect(selected.test("turn @real-scenario:other @real-host:production")).toBe(false)
})

test("a caller expression cannot broaden the selected scenario set", () => {
  const selected = scenarioGrep(["chat.stream-grounded"], "title-match")
  expect(selected.test("title-match @real-scenario:chat.stream-grounded")).toBe(true)
  expect(selected.test("other @real-scenario:chat.stream-grounded")).toBe(false)
  expect(selected.test("title-match @real-scenario:other")).toBe(false)
})

test("extracts CLI grep while preserving file and invert filters", () => {
  expect(extractRequestedGrep(["wiki.spec.ts", "--grep", "reload|fork", "--grep-invert", "schema", "--list"]))
    .toEqual({ args: ["wiki.spec.ts", "--grep-invert", "schema", "--list"], grep: "reload|fork" })
  expect(extractRequestedGrep(["--grep=reload"])).toEqual({ args: [], grep: "reload" })
  expect(extractRequestedGrep(["-g", "fork"])).toEqual({ args: [], grep: "fork" })
  expect(extractRequestedGrep(["--list"])).toEqual({ args: ["--list"] })
})

test("invalid selectors fail before services start", () => {
  expect(() => extractRequestedGrep(["--grep"])).toThrow("requires")
  expect(() => extractRequestedGrep(["--grep="])).toThrow("requires")
  expect(() => extractRequestedGrep(["--grep", "["])).toThrow()
  expect(() => extractRequestedGrep(["--grep=a", "-g", "b"])).toThrow("only one")
})
