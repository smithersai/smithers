// APP_ALIASES (worker/aliases.ts): the text infra/Domain.ts reads at deploy time and the site Worker at run time.
import { describe, expect, test } from "vitest"
import { aliasLocation, parseAliases } from "./aliases.ts"

describe("parseAliases", () => {
  test("reads host=path entries, trimmed, skipping blank ones", () => {
    expect(parseAliases(" factory.example.com = /acme/widgets/-/factory ,, status.example.org=/app/runs ")).toEqual([
      { host: "factory.example.com", path: "/acme/widgets/-/factory" },
      { host: "status.example.org", path: "/app/runs" },
    ])
    expect(parseAliases("")).toEqual([])
    expect(parseAliases(" , ")).toEqual([])
    expect(parseAliases("a.example.com=/")).toEqual([{ host: "a.example.com", path: "/" }])
  })

  test.each([
    ["factory.example.com", "no ="],
    ["factory.example.com=acme/app", "a relative path"],
    ["factory.example.com=//evil.example/x", "a protocol-relative path"],
    ["factory.example.com=/\\evil.example", "a backslash after the slash"],
    ["factory.example.com=/a?b=c", "a query"],
    ["factory.example.com=/a#b", "a fragment"],
    ["factory.example.com=/a b", "a space"],
    ["factory.example.com=https://evil.example/", "a URL"],
    [`factory.example.com=/${"a".repeat(512)}`, "a path over 512 characters"],
    ["Factory.example.com=/a", "an uppercase hostname"],
    ["factory=/a", "one label"],
    ["https://factory.example.com=/a", "a scheme"],
    ["=/a", "no hostname"],
  ])("refuses %s (%s)", (entry) => {
    expect(parseAliases(`ok.example.com=/a,${entry}`)).toEqual({ invalid: entry.trim() })
  })

  test("refuses a hostname listed twice, at its second entry", () => {
    expect(parseAliases("a.example.com=/x,a.example.com=/y")).toEqual({ invalid: "a.example.com=/y" })
  })
})

describe("aliasLocation", () => {
  const listed = "factory.example.com=/acme/widgets/-/factory,other.example.com=/app"

  test("sends an alias's / to its page on the same origin, the query kept", () => {
    expect(aliasLocation(listed, new URL("https://factory.example.com/"))).toBe(
      "https://factory.example.com/acme/widgets/-/factory",
    )
    expect(aliasLocation(listed, new URL("https://factory.example.com/?tab=agents"))).toBe(
      "https://factory.example.com/acme/widgets/-/factory?tab=agents",
    )
    expect(aliasLocation(listed, new URL("http://other.example.com:8787/"))).toBe("http://other.example.com:8787/app")
  })

  test("leaves every other request alone", () => {
    expect(aliasLocation(listed, new URL("https://factory.example.com/app"))).toBeUndefined()
    expect(aliasLocation(listed, new URL("https://example.com/"))).toBeUndefined()
    expect(aliasLocation(undefined, new URL("https://factory.example.com/"))).toBeUndefined()
    expect(aliasLocation("", new URL("https://factory.example.com/"))).toBeUndefined()
    // A list the deploy would have refused sends nobody anywhere.
    expect(aliasLocation("factory.example.com=//evil.example", new URL("https://factory.example.com/"))).toBeUndefined()
  })
})
