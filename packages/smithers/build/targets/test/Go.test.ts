import { describe, expect, it } from "vitest"
import { Smithers as S } from "../src/index.ts"
import * as Target from "../src/Target.ts"

const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({
  mod: S.file("//go.mod"),
  sum: S.file("//go.sum"),
  versions: nix,
  cgo: false,
  experiments: ["jsonv2"]
})

describe("S.Go", () => {
  it("rejects a non-object toolchain declaration", () => {
    expect(() => S.Go.Toolchain(null as never)).toThrow(/options must be an object/)
  })

  it("constructs the workspace toolchain and tool references", () => {
    expect(go._tag).toBe("GoToolchain")
    expect(S.Go.bin).toEqual({ _tag: "GoBin" })
    expect(S.Go.run("example.test/tool@v1.2.3")).toEqual({ _tag: "GoRun", spec: "example.test/tool@v1.2.3" })
  })

  it("accepts Mise as the version authority", () => {
    const mise = S.Mise({ config: S.file("//mise.toml") })
    expect(S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: mise }).versions)
      .toBe(mise)
  })

  it.each([
    ["Go.Packages", S.Go.Packages({ pkgs: ["./..."] })],
    ["Go.Test", S.Go.Test({ pkgs: ["./..."] })],
    ["Go.Binary", S.Go.Binary({ pkg: "./cmd/app", out: "//bin/app" })],
    [
      "Go.ModDownload",
      S.Go.ModDownload({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), outDirs: ["//.gomodcache"] })
    ],
    ["Go.Lint", S.Go.Lint({ config: S.file("//.golangci.yml"), version: "v2.8.0", pkgs: ["./..."] })],
    ["Go.Generate", S.Go.Generate({ pkgs: ["./..."], changes: ["**/generated.go"] })],
    ["Go.Fuzz", S.Go.Fuzz({ pkg: "./pkg", fuzz: "FuzzParse", time: "1x", parallel: 1 })]
  ])("constructs %s with strict attrs", (rule, target) => {
    expect(Target.metadata(target).target).toBe(rule)
  })

  it("composes Go package operands with Files.difference", () => {
    const all = S.Go.Packages({ pkgs: ["./..."] })
    const excluded = S.Go.Packages({ pkgs: ["./internal/..."] })
    expect(S.Files.difference(all, excluded)).toMatchObject({ _tag: "FilesDifference", left: all, right: excluded })
  })

  it("rejects excess properties", () => {
    expect(() => S.Go.Test({ pkgs: ["./..."], nope: true } as never)).toThrow(/excess property[\s\S]*nope/)
    expect(() =>
      S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix, nope: true } as never)
    ).toThrow(/unknown option/)
    expect(() => S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock"), nope: true } as never))
      .toThrow(/unknown option/)
    expect(() => S.Nix.DevShell(null as never)).toThrowError(
      new TypeError("Nix.DevShell options must be an object")
    )
    expect(() => S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: "flake.lock" } as never)).toThrowError(
      new TypeError("Nix.DevShell flake and lock must be S.file declarations")
    )
    expect(() => S.Nix.DevShell({ flake: "flake.nix", lock: S.file("//flake.lock") } as never)).toThrowError(
      new TypeError("Nix.DevShell flake and lock must be S.file declarations")
    )
  })

  it("admits a toolchain-only workspace and keeps Node declarations all-or-none", () => {
    const workspace = S.Workspace("go", {
      repository: "git+https://example.test/go.git",
      cache: S.Cache({ directory: ".flows" }),
      toolchains: [nix, go]
    })
    expect(workspace.runtime).toBeUndefined()
    expect(workspace.toolchains).toEqual([nix, go])
    expect(() =>
      S.Workspace("bad", {
        repository: "git+https://example.test/bad.git",
        cache: S.Cache({ directory: ".flows" }),
        runtime: S.Runtime.Node({ version: "26" })
      })
    ).toThrow(/declared together/)
  })

  it("renders shared ldflags as -X pairs whose stamps stay unresolved", () => {
    const rendered = S.Go.ldflags({ strip: true, stamp: { "main.Version": S.Stamp.version } })
    expect(rendered).toBe(`-s -w -X main.Version=${S.Stamp.token("main.Version", S.Stamp.version)}`)
    // The token spells the stamp's name only, so the flag string keys.
    expect(rendered).not.toContain("Stamp")
    expect(() =>
      S.Go.Binary({
        pkg: "./cmd/app",
        out: "//bin/app",
        // The type rejects this too; the runtime assertion protects JavaScript callers.
        // @ts-expect-error secrets may cross only the outbound proxy boundary
        stamp: { "a.Key": S.Secret("POSTHOG_API_KEY") }
      })
    ).toThrow(/Expected .*Stamp.*string/)
    expect(() =>
      S.Go.ldflags({
        // @ts-expect-error secrets may not be embedded in linker arguments
        stamp: { "a.Key": S.Secret("POSTHOG_API_KEY") }
      })
    ).toThrow(/Expected .*Stamp.*string/)
  })
})

describe("Go linker flag defaults", () => {
  it("emits no stripping or stamping flags unless requested", () => {
    expect(S.Go.ldflags({})).toBe("")
    expect(S.Go.ldflags({ strip: false })).toBe("")
    expect(S.Go.ldflags({ strip: true })).toBe("-s -w")
  })
})
