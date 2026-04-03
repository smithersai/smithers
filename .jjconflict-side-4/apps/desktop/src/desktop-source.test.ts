import { describe, expect, it } from "bun:test"

import {
  DEFAULT_DESKTOP_VITE_URL,
  DESKTOP_BUNDLED_URL,
  resolveDesktopDevSource,
  resolveDesktopSourceUrl,
  resolveDesktopViteUrl,
} from "./desktop-source"

describe("desktop source resolution", () => {
  it("defaults to bundled views mode", () => {
    expect(resolveDesktopDevSource(undefined)).toBe("views")
    expect(resolveDesktopDevSource("anything-else")).toBe("views")
  })

  it("accepts vite mode", () => {
    expect(resolveDesktopDevSource("vite")).toBe("vite")
  })

  it("falls back to default vite URL for invalid values", () => {
    expect(resolveDesktopViteUrl(undefined)).toBe(DEFAULT_DESKTOP_VITE_URL)
    expect(resolveDesktopViteUrl("not-a-url")).toBe(DEFAULT_DESKTOP_VITE_URL)
    expect(resolveDesktopViteUrl("ftp://localhost:5173")).toBe(DEFAULT_DESKTOP_VITE_URL)
  })

  it("resolves to bundled views when source is views", async () => {
    const resolved = await resolveDesktopSourceUrl({
      devSource: "views",
      canReach: async () => false,
    })

    expect(resolved).toBe(DESKTOP_BUNDLED_URL)
  })

  it("uses vite URL when configured and reachable", async () => {
    const resolved = await resolveDesktopSourceUrl({
      devSource: "vite",
      viteUrl: "http://localhost:5173",
      canReach: async () => true,
    })

    expect(resolved).toBe("http://localhost:5173")
  })

  it("falls back to bundled views when vite is unreachable", async () => {
    const resolved = await resolveDesktopSourceUrl({
      devSource: "vite",
      viteUrl: "http://localhost:5173",
      canReach: async () => false,
    })

    expect(resolved).toBe(DESKTOP_BUNDLED_URL)
  })
})
