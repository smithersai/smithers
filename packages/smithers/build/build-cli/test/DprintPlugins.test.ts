/**
 * The dprint plugins a format check is keyed on and shown: real files in a
 * temporary cache, as dprint lays it out.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as DprintPlugins from "../src/internal/DprintPlugins.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) NodeFs.rmSync(root, { recursive: true, force: true })
})

const typescript = `https://plugins.dprint.dev/typescript-0.93.4.wasm@${"a".repeat(64)}`
const json = `https://plugins.dprint.dev/json-0.21.1.wasm@${"b".repeat(64)}`

/** A cache holding two compiled variants of the TypeScript plugin, the JSON plugin, and one nobody names. */
const fixture = () => {
  const root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smithers-dprint-plugins-"))
  roots.push(root)
  const cache = NodePath.join(root, "cache")
  const plugins = NodePath.join(cache, "plugins")
  NodeFs.mkdirSync(plugins, { recursive: true })
  const plugin = (stem: string, source: string, compiled: string | undefined) => {
    NodeFs.writeFileSync(NodePath.join(plugins, `${stem}.json`), JSON.stringify({ source: `remote:${source}` }))
    if (compiled !== undefined) NodeFs.writeFileSync(NodePath.join(plugins, `${stem}.cwasm`), compiled)
  }
  plugin("1111", typescript.slice(0, typescript.lastIndexOf("@")), "typescript")
  plugin("2222", typescript.slice(0, typescript.lastIndexOf("@")), "typescript for musl")
  plugin("3333", json.slice(0, json.lastIndexOf("@")), undefined)
  plugin("4444", "https://plugins.dprint.dev/markdown-0.20.0.wasm", "markdown")
  NodeFs.writeFileSync(NodePath.join(plugins, "5555.json"), "not json")
  NodeFs.writeFileSync(NodePath.join(plugins, "6666.json"), JSON.stringify({ name: "no source" }))
  NodeFs.writeFileSync(NodePath.join(plugins, "7777.cwasm"), "stray")
  const config = (value: unknown, text = JSON.stringify(value)) => {
    const path = NodePath.join(root, `dprint-${Math.random().toString(36).slice(2)}.json`)
    NodeFs.writeFileSync(path, text)
    return path
  }
  return { cache, plugins, config }
}

describe("where dprint keeps its cache", () => {
  it("is the declared directory, else the platform's cache directory", () => {
    expect(DprintPlugins.cacheDirectory({ DPRINT_CACHE_DIR: "/declared" }, "linux", "/home/u")).toBe("/declared")
    expect(DprintPlugins.cacheDirectory({ DPRINT_CACHE_DIR: "" }, "linux", "/home/u")).toBe(
      "/home/u/.cache/dprint/cache"
    )
    expect(DprintPlugins.cacheDirectory({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/u")).toBe("/xdg/dprint/cache")
    expect(DprintPlugins.cacheDirectory({ XDG_CACHE_HOME: "" }, "linux", "/home/u")).toBe("/home/u/.cache/dprint/cache")
    expect(DprintPlugins.cacheDirectory({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Caches/dprint/cache")
    expect(DprintPlugins.cacheDirectory({}, "win32", "C:\\u")).toBeUndefined()
  })

  it("is found inside a confined run where its private directories put it", () => {
    expect(DprintPlugins.privateCachePath("linux")).toBe("cache/dprint/cache")
    expect(DprintPlugins.privateCachePath("darwin")).toBe("home/Library/Caches/dprint/cache")
  })
})

describe("the plugins a configuration names", () => {
  it("are every compiled variant of each named plugin, measured by content", () => {
    const { cache, plugins, config } = fixture()
    const named = config({ plugins: [typescript, json] })
    const measured = DprintPlugins.measure(named, cache)
    if (typeof measured === "string") throw new Error(measured)
    expect(measured.cache).toBe(cache)
    expect(measured.files.map((file) => NodePath.basename(file))).toEqual([
      "1111.cwasm",
      "1111.json",
      "2222.cwasm",
      "2222.json",
      "3333.json"
    ])
    // The same bytes measure the same; a plugin nobody names changes nothing.
    NodeFs.writeFileSync(NodePath.join(plugins, "4444.cwasm"), "markdown, recompiled")
    expect(DprintPlugins.measure(named, cache)).toEqual(measured)
    // A named plugin's bytes move the digest.
    NodeFs.writeFileSync(NodePath.join(plugins, "2222.cwasm"), "typescript for musl, patched")
    expect((DprintPlugins.measure(named, cache) as DprintPlugins.Measured).digest).not.toBe(measured.digest)
  })

  it("are none for a configuration that names none", () => {
    const { cache, config } = fixture()
    expect(DprintPlugins.measure(config({}), cache)).toMatchObject({ files: [] })
    expect(DprintPlugins.measure(config({}), NodePath.join(cache, "never-made"))).toMatchObject({ files: [] })
  })

  it("leave the check unreused, with the reason, when they cannot be measured", () => {
    const { cache, config } = fixture()
    expect(DprintPlugins.measure(config({ plugins: [typescript] }), undefined)).toBe(
      "dprint's plugin cache cannot be shown to a confined run on this platform"
    )
    const commented = config(undefined, "{ // a comment\n}")
    expect(DprintPlugins.measure(commented, cache)).toBe(
      `the dprint configuration ${commented} is not plain JSON, so the plugins it names cannot be read`
    )
    expect(DprintPlugins.measure(config({ extends: "../dprint.json" }), cache)).toBe(
      "the dprint configuration extends another, whose plugins no key covers"
    )
    for (const plugins of ["one", [42], ["https://plugins.dprint.dev/x.wasm"], ["./local.wasm@" + "c".repeat(64)]]) {
      expect(DprintPlugins.measure(config({ plugins }), cache)).toBe(
        "a dprint plugin is not a remote .wasm pinned by its checksum"
      )
    }
    const unfetched = `https://plugins.dprint.dev/toml-0.6.0.wasm@${"d".repeat(64)}`
    expect(DprintPlugins.measure(config({ plugins: [typescript, unfetched] }), cache)).toBe(
      "dprint has not fetched https://plugins.dprint.dev/toml-0.6.0.wasm; one run of dprint on this host fetches it"
    )
  })
})
