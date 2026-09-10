/**
 * `smthrs update`: the version comparison, without the network.
 *
 * The one thing this has to get right is that a release candidate is never
 * told to "upgrade" to an older stable release: an rc.0 install reading a
 * `latest` of 0.35.0 would otherwise be told to downgrade.
 */
import { describe, expect, it } from "vitest"
import * as Update from "../src/Update.ts"

describe("version comparison", () => {
  it("orders numeric segments numerically", () => {
    expect(Update.isNewer("1.0.10", "1.0.9")).toBe(true)
    expect(Update.isNewer("1.0.9", "1.0.10")).toBe(false)
    expect(Update.isNewer("2.0.0", "1.9.9")).toBe(true)
  })

  it("orders a release ahead of its own prereleases", () => {
    expect(Update.isNewer("1.0.0", "1.0.0-rc.0")).toBe(true)
    expect(Update.isNewer("1.0.0-rc.0", "1.0.0")).toBe(false)
    expect(Update.isNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true)
    expect(Update.isNewer("1.0.0-rc.0", "1.0.0-rc.0")).toBe(false)
  })

  it("orders unequal non-numeric segments lexically", () => {
    expect(Update.isNewer("1.0.0-rc.0", "1.0.0-beta.0")).toBe(true)
  })

  // The precedence chain from SemVer 2.0.0 section 11, oldest first.
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0-rc.1.1",
    "1.0.0"
  ]

  it.each(chain.flatMap((older, index) => chain.slice(index + 1).map((newer) => [newer, older])))(
    "orders %s after %s",
    (newer, older) => {
      expect(Update.isNewer(newer, older)).toBe(true)
      expect(Update.isNewer(older, newer)).toBe(false)
    }
  )

  it("ranks a longer prerelease above its own prefix", () => {
    expect(Update.isNewer("1.0.0-rc.1.1", "1.0.0-rc.1")).toBe(true)
    expect(Update.isNewer("1.0.0-rc.1", "1.0.0-rc.1.1")).toBe(false)
  })

  it("ranks a numeric identifier below any non-numeric one", () => {
    expect(Update.isNewer("1.0.0-rc.1a", "1.0.0-rc.2")).toBe(true)
    expect(Update.isNewer("1.0.0-rc.2", "1.0.0-rc.1a")).toBe(false)
  })

  it("keeps a hyphen inside a prerelease identifier", () => {
    expect(Update.isNewer("1.0.0-rc-1", "1.0.0-rc.1")).toBe(true)
    expect(Update.isNewer("1.0.0-rc.1", "1.0.0-rc-1")).toBe(false)
  })

  it("ignores build metadata", () => {
    expect(Update.isNewer("1.0.0+build.2", "1.0.0+build.1")).toBe(false)
    expect(Update.isNewer("1.0.0-rc.1+build.9", "1.0.0-rc.1")).toBe(false)
    expect(Update.isNewer("1.0.0-rc.1", "1.0.0-rc.1+build.9")).toBe(false)
    expect(Update.isNewer("1.0.0-rc.2+build.1", "1.0.0-rc.1+build.9")).toBe(true)
  })
})

describe("the status", () => {
  it("prefers the next tag, so a candidate is never told to downgrade", () => {
    const status = Update.compare("1.0.0-rc.0", { latest: "0.35.0", next: "1.0.0-rc.1" })

    expect(status).toMatchObject({ available: "1.0.0-rc.1", tag: "next", upToDate: false })
    expect(status.install).toBe("npm install -g @smthrs/cli@1.0.0-rc.1")
  })

  it("falls through to latest when the next tag has nothing newer", () => {
    expect(Update.compare("1.0.0-rc.0", { latest: "1.0.0", next: "1.0.0-rc.0" }))
      .toMatchObject({ available: "1.0.0", tag: "latest" })
  })

  it("never recommends a shared-prefix prerelease that is older", () => {
    expect(Update.compare("1.0.0-rc.1.1", { next: "1.0.0-rc.1" })).toMatchObject({ upToDate: true })
    expect(Update.compare("1.0.0-rc.1", { next: "1.0.0-rc.1.1" }))
      .toMatchObject({ available: "1.0.0-rc.1.1", tag: "next", upToDate: false })
  })

  it("reports up to date when neither tag is newer", () => {
    const status = Update.compare("1.0.0-rc.1", { latest: "0.35.0", next: "1.0.0-rc.1" })

    expect(status).toEqual({
      current: "1.0.0-rc.1",
      available: undefined,
      tag: undefined,
      upToDate: true,
      install: undefined
    })
    expect(Update.compare("1.0.0-rc.1", {})).toMatchObject({ upToDate: true })
  })

  it("renders the current state and the install command", () => {
    expect(Update.render(Update.compare("1.0.0-rc.1", { next: "1.0.0-rc.1" })))
      .toBe("@smthrs/cli 1.0.0-rc.1 is current.")
    expect(Update.render(Update.compare("1.0.0-rc.0", { next: "1.0.0-rc.1" })))
      .toContain("npm install -g @smthrs/cli@1.0.0-rc.1")
  })

  it("names the package and the registry endpoint it reads", () => {
    expect(Update.packageName).toBe("@smthrs/cli")
    expect(Update.registryUrl).toBe("https://registry.npmjs.org/-/package/@smthrs/cli/dist-tags")
  })
})
