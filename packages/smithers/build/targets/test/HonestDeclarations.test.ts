import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import * as Manifest from "../src/ManifestJson.ts"
import * as Nix from "../src/Nix.ts"
import * as Owners from "../src/Owners.ts"
import * as Package from "../src/Package.ts"
import * as Template from "../src/PackageJsonTemplate.ts"
import * as RemoteCache from "../src/RemoteCache.ts"
import * as Secret from "../src/Secret.ts"
import * as Workspace from "../src/WorkspaceDeclaration.ts"
import { packageManager, runtime } from "./toolchain.ts"

describe("workspace option boundaries", () => {
  it.each([
    [null, /plain object/],
    [{ [Symbol("extra")]: true }, /symbol/],
    [{ cacheDirectory: 1 }, /string/]
  ])("refuses malformed cache policy", (options, message) => {
    expect(() => Config.Workspace(options as never)).toThrow(message as RegExp)
  })
  it("bounds the complete cache path after validating each segment", () => {
    expect(() => Config.normalizeCacheDirectory(Array(100).fill("a".repeat(100)).join("/"))).toThrow(/at most/)
  })
  it.each([
    [{ runtime: {} }, /runtime/],
    [{ packageManager: {} }, /packageManager/],
    [{ nodeModules: {} }, /nodeModules/],
    [{ toolchains: [], environment: Nix.Environment({ flake: { _tag: "File", path: "flake.nix" } }) }, /non-empty/],
    [{ flags: {} }, /flags/],
    [{ host: {} }, /host/],
    [{ memory: {} }, /memory/],
    [{ sandboxes: {} }, /sandboxes/],
    [{ agents: {} }, /agents/],
    [{ repos: null }, /repos/],
    [{ gitHooks: null }, /gitHooks/]
  ])("refuses invalid workspace capability declarations", (options, message) => {
    expect(() =>
      Workspace.Workspace(
        "honest-tests",
        {
          repository: "example/honest-tests",
          cache: Workspace.Cache({ directory: ".cache" }),
          runtime,
          packageManager,
          nodeModules: Workspace.NodeModules({ packageJson: { _tag: "File", path: "package.json" } }),
          toolchains: [{ _tag: "TestToolchain" }],
          ...options
        } as never
      )
    ).toThrow(message as RegExp)
  })
  it("rejects noncanonical host cache directories and accepts canonical ones", () => {
    expect(() => Workspace.Cache({ directory: ".cache", hostDirectories: "cache" } as never)).toThrow(/array/)
    expect(() => Workspace.Cache({ directory: ".cache", hostDirectories: ["./cache"] })).toThrow(/canonical/)
    expect(() => Workspace.Cache({ directory: ".cache", hostDirectories: ["cache/*"] })).toThrow(/canonical/)
    expect(Workspace.Cache({ directory: ".cache", hostDirectories: ["cache/tools"] }).hostDirectories).toEqual([
      "cache/tools"
    ])
  })
})

describe("JSON/template boundaries", () => {
  it.each([false, ["./polyfill.js"]])("retains the declared side-effect policy", (sideEffects) => {
    expect(Template.make({ sideEffects }).fields.sideEffects).toEqual(sideEffects)
  })
  it("rejects an invalid side-effect policy and accessor options", () => {
    expect(() => Template.make({ sideEffects: 1 } as never)).toThrow(/sideEffects/)
    let invoked = false
    const options = Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => {
        invoked = true
        return "module"
      }
    })
    expect(() => Template.make(options)).toThrow(/accessor/)
    expect(invoked).toBe(false)
    expect(Template.isTemplate({})).toBe(false)
  })
  it.each([1n, Symbol("x"), () => 1])("refuses values JSON cannot represent", (value) => {
    expect(() => Manifest.cloneValue(value, "value")).toThrow(/bigint|symbol|function/)
  })
  it("refuses arrays whose enumerable indices are not dense", () => {
    const value = ["a", "b"]
    delete value[0]
    Object.assign(value, { extra: true })
    expect(() => Manifest.cloneValue(value, "value")).toThrow(/sparse|extra/)
  })
})

describe("ownership and secret declaration boundaries", () => {
  it.each([
    [null, /plain object/],
    [{ agents: 1 }, /agents/],
    [{ perFile: 1 }, /perFile/],
    [{ noparent: 1 }, /boolean/],
    [{ upstream: { mode: "review", extra: true } }, /unknown key/],
    [{ upstream: { mode: "write" } }, /mode/],
    [{ upstream: { mode: "review", packages: Array(5000).fill("x") } }, /more than/]
  ])("refuses unusable owner policies", (options, message) => {
    expect(() => Owners.declare(options as never)).toThrow(message as RegExp)
  })
  it("accepts upstream review without a package override", () => {
    expect(Owners.declare({ upstream: { mode: "review" } }).upstream).toEqual({ mode: "review" })
  })
  it("rejects malformed team rosters and excessive membership", () => {
    expect(() => Owners.Teams(null as never)).toThrow(/plain object/)
    expect(() => Owners.Teams({ large: Array(5000).fill("login") })).toThrow(/more than/)
  })
  it("does not treat forged package and credential values as declarations", () => {
    expect(Package.isPackage(1)).toBe(false)
    expect(() => Package.metadata({} as never)).toThrow(/well-formed Package/)
    expect(Secret.isSecret(new Date())).toBe(false)
    expect(Secret.isHttpCredential(new Date())).toBe(false)
    expect(Secret.isHttpCredential({ _tag: "HttpCredential", secret: "bad", audiences: [] })).toBe(false)
  })
  it("rejects malformed remote-cache configuration", () => {
    expect(() => RemoteCache.make({ endpoint: 1 } as never)).toThrow(/string/)
    expect(() => RemoteCache.smithersCloud(null as never)).toThrow(/object/)
  })
  it("rejects non-string Nix attrs", () => {
    expect(() => Nix.Environment({ flake: { _tag: "File", path: "flake.nix" }, attr: 1 } as never)).toThrow(/string/)
  })
})

it("freezes normalized discovery exclusions, including an omitted prune list", () => {
  const create = (discovery: { readonly prune?: ReadonlyArray<string> }) =>
    Workspace.Workspace("honest-tests", {
      repository: "example/honest-tests",
      cache: Workspace.Cache({ directory: ".cache" }),
      runtime,
      packageManager,
      nodeModules: Workspace.NodeModules({ packageJson: { _tag: "File", path: "package.json" } }),
      toolchains: [{ _tag: "TestToolchain" }],
      discovery
    })
  const empty = create({})
  const populated = create({ prune: ["fixtures", "vendor"] })
  expect(empty.discovery?.prune).toEqual([])
  expect(populated.discovery?.prune).toEqual(["fixtures", "vendor"])
  expect(Object.isFrozen(populated.discovery?.prune)).toBe(true)
})
