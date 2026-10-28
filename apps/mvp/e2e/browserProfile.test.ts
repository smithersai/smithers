import { describe, expect, test } from "vitest"
import { browserProfile } from "./browserProfile"

describe("persistent browser environment", () => {
  const directory = "/temporary/profile"
  test("macOS WebKit isolates Foundation storage and preserves other launch options", () => {
    expect(browserProfile("webkit", "darwin", directory, { headless: true, locale: "en-GB" }, { PATH: "/tools", CFFIXED_USER_HOME: "/shared" })).toEqual({
      headless: true, locale: "en-GB", env: { PATH: "/tools", CFFIXED_USER_HOME: directory },
    })
  })
  test("an explicit environment remains explicit and cannot override this device's storage boundary", () => {
    const options = { env: { PATH: "/chosen", CFFIXED_USER_HOME: "/wrong-device" } }
    expect(browserProfile("webkit", "darwin", directory, options, { HOST_ONLY: "withheld" })).toEqual({
      env: { PATH: "/chosen", CFFIXED_USER_HOME: directory },
    })
    expect(browserProfile("webkit", "darwin", directory, { env: {} }, { HOST_ONLY: "withheld" })).toEqual({ env: { CFFIXED_USER_HOME: directory } })
    expect(options.env.CFFIXED_USER_HOME).toBe("/wrong-device")
  })
  test("other browsers and platforms retain their configured environment", () => {
    for (const [browser, platform] of [["chromium", "darwin"], ["webkit", "linux"], ["webkit", "win32"]] as const) {
      const options = { headless: true, env: { CFFIXED_USER_HOME: "/chosen" } }
      expect(browserProfile(browser, platform, directory, options, { HOST_ONLY: "withheld" })).toEqual(options)
      expect(browserProfile(browser, platform, directory, {}, { HOST_ONLY: "withheld" })).toEqual({})
    }
  })
})
