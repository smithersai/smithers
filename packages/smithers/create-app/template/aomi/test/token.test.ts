// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { authHeaders, clearToken, readToken } from "../src/shell/token.ts"

vi.mock("virtual:smthrs-app/brand.css", () => ({}))
vi.mock("@smthrs/ui", () => ({ SmithersUiStyles: () => null }))
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: vi.fn() }) }))
vi.mock("../routes.gen.ts", () => ({ flows: [] }))
vi.mock("../routes.ui.gen.ts", () => ({ layout: undefined, pages: [], panes: {}, flowSummaries: [] }))
vi.mock("../src/shell/keys.ts", () => ({ startShortcuts: vi.fn() }))

const KEY = "aomi.api-token"

beforeEach(() => {
  // Node 26 exposes a disabled native localStorage; use the DOM implementation.
  vi.stubGlobal("localStorage", new window.Storage())
  window.history.replaceState(null, "", "/")
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("browser token", () => {
  test("claims a fragment into session storage, preserving other URL fields", () => {
    window.history.replaceState({ kept: true }, "", "/build?view=all#token=secret%2Bvalue&section=recent")
    expect(readToken()).toBe("secret+value")
    expect(window.sessionStorage.getItem(KEY)).toBe("secret+value")
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/build?view=all#section=recent"
    )
    expect(window.history.state).toEqual({ kept: true })
    expect(authHeaders()).toEqual({ authorization: "Bearer secret+value" })
    clearToken()
    expect(authHeaders()).toEqual({})
  })

  test("accepts the legacy query form with a warning that contains no credential", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    window.history.replaceState(null, "", "/build?token=legacy-secret&view=all#/build")
    expect(readToken()).toBe("legacy-secret")
    expect(window.sessionStorage.getItem(KEY)).toBe("legacy-secret")
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(window.location.search).toBe("?view=all")
    expect(window.location.hash).toBe("#/build")
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain("#token=")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("legacy-secret")
    readToken()
    expect(warn).toHaveBeenCalledOnce()
  })

  test("prefers the fragment and strips both supplied credentials", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    window.history.replaceState(null, "", "/build?token=old#token=new")
    expect(readToken()).toBe("new")
    expect(window.location.search + window.location.hash).toBe("")
  })

  test("does not recover credentials from persistent local storage", () => {
    window.localStorage.setItem(KEY, "previous-session")
    expect(authHeaders()).toEqual({})
  })

  test("strips the URL even when session storage is disabled", () => {
    window.history.replaceState(null, "", "/build#token=secret")
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError")
    })
    expect(readToken()).toBeUndefined()
    expect(window.location.hash).toBe("")
    expect(() => clearToken()).not.toThrow()
  })

  test("ignores an empty token without disturbing a stored credential or hash route", () => {
    window.sessionStorage.setItem(KEY, "existing")
    window.history.replaceState(null, "", "/?token=#/build")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(readToken()).toBe("existing")
    expect(window.location.search).toBe("")
    expect(window.location.hash).toBe("#/build")
  })

  test.each(["#token=bootstrap-secret", "?token=bootstrap-secret"])(
    "main claims %s before the root redirect and first API request",
    async (bootstrap) => {
      vi.resetModules()
      vi.spyOn(console, "warn").mockImplementation(() => {})
      window.history.replaceState(null, "", `/${bootstrap}`)
      document.body.innerHTML = '<div id="root"></div>'
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] })))
      vi.stubGlobal("fetch", fetch)
      await import("../src/main.tsx")
      expect(window.location.pathname).toBe("/build")
      expect(window.location.search + window.location.hash).toBe("")
      expect(window.sessionStorage.getItem(KEY)).toBe("bootstrap-secret")
      expect(window.localStorage.getItem(KEY)).toBeNull()
      expect(fetch).toHaveBeenCalled()
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer bootstrap-secret" })
    }
  )
})
