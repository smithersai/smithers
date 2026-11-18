import { describe, expect, it } from "vitest"
import * as Bun from "../src/internal/bun.ts"

/** A Bun text lockfile in the trailing-comma form Bun writes. */
const lock = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "fixture" } }, packages: {}, ...fields }, null, 2)
    .replaceAll(/([}\]"0-9a-z])\n/g, "$1,\n")

const lockfile = (fields?: Record<string, unknown>) => Bun.readLockfile(lock(fields))

describe("Bun.readLockfile", () => {
  it("reads the lockfile Bun writes, trailing commas and all", () => {
    expect(lock()).toContain("},\n")
    expect(lockfile()).toEqual({ members: [], patches: [] })
  })

  it("reads a lockfile that has no packages table", () => {
    expect(lockfile({ packages: undefined })).toEqual({ members: [], patches: [] })
  })

  it("lists workspace members and patch files, sorted, without the root or duplicates", () => {
    expect(lockfile({
      workspaces: { "": {}, "packages/b": {}, "packages/a": {} },
      patchedDependencies: {
        "z@1.0.0": "patches/z@1.0.0.patch",
        "a@1.0.0": "patches/a@1.0.0.patch",
        "a@2.0.0": "patches/a@1.0.0.patch"
      },
      packages: {
        "a": ["a@workspace:packages/a"],
        "@scope/pkg": ["@scope/pkg@1.2.3", "", {}, "sha512-x"],
        "remote": ["remote@https://example.com/remote.tgz", {}],
        "git": ["git@github:owner/repo#abc", {}]
      }
    })).toEqual({
      members: ["packages/a", "packages/b"],
      patches: ["patches/a@1.0.0.patch", "patches/z@1.0.0.patch"]
    })
  })

  it.each([
    ["text that is not JSON", "not a lockfile"],
    ["a binary lockfile", "\u0000\u0001bun-lockfile-format-v0"],
    ["an array", "[]"],
    ["a document without a version", JSON.stringify({ workspaces: { "": {} } })]
  ])("refuses %s", (_name, text) => {
    expect(Bun.readLockfile(text)).toEqual({
      _tag: "Refusal",
      code: "lockfile_unreadable",
      message: "bun.lock is not a Bun text lockfile"
    })
  })

  it.each([
    ["no workspaces", { workspaces: undefined }],
    ["workspaces without a root", { workspaces: { "packages/a": {} } }],
    ["workspaces that are a list", { workspaces: ["packages/a"] }]
  ])("refuses a lockfile with %s", (_name, fields) => {
    expect(lockfile(fields)).toMatchObject({
      code: "lockfile_unreadable",
      message: "bun.lock declares no root workspace"
    })
  })

  it.each([
    ["patchedDependencies", { patchedDependencies: ["a.patch"] }],
    ["packages", { packages: [] }]
  ])("refuses %s that is not a table", (_name, fields) => {
    expect(lockfile(fields)).toMatchObject({ code: "lockfile_unreadable" })
  })

  it.each([
    ["an absolute path", "/etc"],
    ["a drive path", "C:/outside"],
    ["a parent segment", "packages/../../outside"],
    ["a current-directory segment", "./packages/a"],
    ["an empty segment", "packages//a"],
    ["a backslash", "packages\\a"],
    ["a control character", "packages/a\nb"],
    ["a lone surrogate", "packages/\ud800"],
    ["a path inside node_modules", "node_modules/dep"],
    ["a path inside node_modules in another case", "packages/NODE_MODULES/dep"],
    ["a path inside the install store", ".flows/store/bun/fetch"],
    ["a path inside the install store in another case", ".Flows/store/bun/fetch"],
    ["an oversized path", "p".repeat(1025)]
  ])("refuses a workspace at %s", (_name, path) => {
    expect(lockfile({ workspaces: { "": {}, [path]: {} } })).toMatchObject({
      code: "lockfile_unreadable",
      message: "bun.lock names a workspace or patch path outside the workspace sources"
    })
  })

  it("refuses a patch path that is not text or leaves the sources", () => {
    for (const path of [7, "../outside.patch", "/tmp/x.patch"]) {
      expect(lockfile({ patchedDependencies: { "a@1.0.0": path } })).toMatchObject({ code: "lockfile_unreadable" })
    }
  })

  it("refuses a patch file the declared read set would not cover", () => {
    expect(lockfile({ patchedDependencies: { "a@1.0.0": "patches/a.diff" } })).toEqual({
      _tag: "Refusal",
      code: "unsupported",
      message: "bun.lock names the patch file patches/a.diff; a patch file must end in .patch"
    })
  })

  it("refuses more workspaces or patch files than it will stage", () => {
    const many = (prefix: string, suffix: string) =>
      Object.fromEntries(
        Array.from({ length: Bun.maximumLockfilePaths + 1 }, (_, index) => [`${prefix}${index}${suffix}`, {}])
      )
    expect(lockfile({ workspaces: { "": {}, ...many("packages/p", "") } })).toMatchObject({
      code: "lockfile_unreadable",
      message: "bun.lock names more than 4096 workspaces or patch files"
    })
    const patches = Object.fromEntries(Object.keys(many("patches/p", ".patch")).map((path) => [path, path]))
    expect(lockfile({ patchedDependencies: patches })).toMatchObject({ code: "lockfile_unreadable" })
  })

  it.each([
    ["a folder", "local@file:../local"],
    ["a link", "local@link:local"],
    ["a relative tarball", "local@./vendor/local.tgz"],
    ["a parent tarball", "local@../local.tgz"],
    ["an absolute path", "local@/opt/local"],
    ["a home path", "local@~/local"],
    ["a drive path", "local@C:\\local"],
    ["a scoped folder", "@scope/local@file:packages/local"],
    // Bun writes a tarball inside the project with no `./` and no `file:`.
    ["a bare tarball path", "local@vendor/local.tgz"],
    ["a repository on this host", "local@git+file:///opt/repo"],
    ["an identifier with no source", "local"]
  ])("refuses a dependency resolved from %s", (_name, identifier) => {
    const refused = lockfile({ packages: { local: [identifier, {}] } })
    expect(refused).toMatchObject({ code: "unsupported" })
    expect((refused as Bun.Refusal).message).toContain("bun.lock resolves local from a local path")
  })

  it("refuses a workspace package that is not one of the lockfile's workspaces", () => {
    expect(lockfile({
      workspaces: { "": {}, "packages/a": {} },
      packages: { a: ["a@workspace:packages/a"], out: ["out@workspace:../../out"] }
    })).toEqual({
      _tag: "Refusal",
      code: "lockfile_unreadable",
      message: "bun.lock holds a workspace package outside its workspaces"
    })
  })

  it("refuses a package entry that names nothing", () => {
    for (const entry of [{}, [], [7]]) {
      expect(lockfile({ packages: { broken: entry } })).toMatchObject({
        code: "lockfile_unreadable",
        message: "bun.lock holds a package entry without an identifier"
      })
    }
  })
})

describe("Bun.checkBunfig", () => {
  const refusal = (text: string, credential = false) => (Bun.checkBunfig(text, credential))

  it("admits a file with no install table, and every documented setting that keeps the boundaries", () => {
    expect(Bun.checkBunfig("", false)).toBeUndefined()
    expect(Bun.checkBunfig(`[test]\ntimeout = 60000\n[run]\nshell = "bun"\n`, false)).toBeUndefined()
    expect(Bun.checkBunfig(`[install]\ncache = true\nauto = "fallback"\n`, false)).toBeUndefined()
    expect(Bun.checkBunfig(
      `[install]
auto = "fallback"
dev = true
dryRun = false
exact = true
frozenLockfile = true
linker = "isolated"
offline = false
optional = true
peer = false
production = false
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = ["@types/node"]
publicHoistPattern = ["*eslint*"]
registry = "http://127.0.0.1:4873/"
ca = "-----BEGIN CERTIFICATE-----"
cafile = "certs/ca.pem"

[install.cache]
dir = "elsewhere"
disable = false
disableManifest = true

[install.lockfile]
save = true

[install.scopes]
"@one" = "https://one.example/"
"@two" = { url = "https://two.example/" }
`,
      false
    )).toBeUndefined()
  })

  it("refuses text it cannot parse without repeating it", () => {
    expect(refusal("[install\nregistry = ")).toEqual({
      _tag: "Refusal",
      code: "unsafe_configuration",
      message: "bunfig.toml cannot be safely parsed"
    })
  })

  it("refuses an install value that is not a table", () => {
    expect(refusal(`install = "all"`)?.message).toBe("bunfig.toml setting install must be a table")
  })

  it.each([
    ["dryRun = true", "install.dryRun would stop the fetch"],
    ["offline = true", "install.offline would stop the fetch"],
    ["cache = false", "install.cache disables the cache"],
    ["cache = \"off\"", "install.cache must be a table"],
    ["[install.cache]\ndisable = true", "install.cache disables the cache"],
    ["[install.cache]\ndirectory = \"x\"", "install.cache.directory is not a setting the install knows"],
    ["[install.lockfile]\npath = \"x\"", "install.lockfile.path is not a setting the install knows"],
    ["lockfile = true", "install.lockfile must be a table"],
    ["[install.lockfile]\nprint = \"yarn\"", "install.lockfile.print writes a second lockfile into the project"],
    ["[install.security]\nscanner = \"@acme/scanner\"", "install.security runs a scanner package"],
    ["registry = 7", "install.registry must be a registry URL"],
    ["registry = { url = \"https://r.example/\", extra = true }", "install.registry must be a registry URL"],
    ["scopes = \"@one\"", "install.scopes must be a table"],
    ["[install.scopes]\n\"@one\" = 7", "install.scopes.@one must be a registry URL"],
    ["futureSetting = true", "install.futureSetting is not a setting the install knows"]
  ])("refuses %j", (setting, message) => {
    const refused = refusal(setting.startsWith("[") ? setting : `[install]\n${setting}`)
    expect(refused?.code).toBe("unsafe_configuration")
    expect(refused?.message).toContain(message)
  })

  it.each([
    ["registry = \"https://$HOST/\"", "setting install.registry uses an environment placeholder"],
    ["registry = \"https://\\u0024HOST/\"", "setting install.registry uses an environment placeholder"],
    ["hoistPattern = [\"a\", \"$b\"]", "setting install.hoistPattern.1 uses an environment placeholder"],
    ["[install.scopes]\n\"$SCOPE\" = \"https://r.example/\"", "table install.scopes has a setting name"],
    ["registry = \"https://user:hunter2@r.example/\"", "setting install.registry embeds a credential"],
    [
      "registry = { url = \"https://r.example/\", token = \"abc\" }",
      "setting install.registry.token embeds a credential"
    ],
    [
      "[install.scopes]\n\"@one\" = { url = \"https://r.example/\", username = \"u\", password = \"p\" }",
      "embeds a credential"
    ],
    ["[install.scopes.\"@one\"]\n_authToken = \"abc\"", "setting install.scopes.@one._authToken embeds a credential"]
  ])("refuses a placeholder or credential in %j and never repeats its value", (setting, message) => {
    const refused = refusal(setting.startsWith("[") ? setting : `[install]\n${setting}`)
    expect(refused?.code).toBe("unsafe_configuration")
    expect(refused?.message).toContain(message)
    expect(refused?.message).not.toMatch(/hunter2|abc|HOST/)
  })

  it("holds transport to the host while a credential is forwarded", () => {
    const https =
      `[install]\nregistry = "https://r.example/"\n[install.scopes]\n"@one" = { url = "HTTPS://one.example/" }\n`
    expect(Bun.checkBunfig(https, true)).toBeUndefined()
    expect(refusal(`[install]\nregistry = "http://r.example/"`, true)?.message)
      .toContain("install.registry changes how a forwarded credential travels; registries must be https")
    expect(refusal(`[install.scopes]\n"@one" = "http://one.example/"`, true)?.message)
      .toContain("install.scopes.@one changes how a forwarded credential travels")
    for (const key of ["ca", "cafile"]) {
      expect(refusal(`[install]\n${key} = "x"`, true)?.message)
        .toContain(`install.${key} changes how a forwarded credential travels; TLS settings come from the host`)
    }
  })
})

describe("Bun.reservedAssignment", () => {
  it("passes a file that sets only application variables", () => {
    expect(Bun.reservedAssignment("")).toBeUndefined()
    expect(Bun.reservedAssignment(
      "# BUN_INSTALL_CACHE_DIR=/elsewhere\nDATABASE_URL=postgres://localhost/app\nNOTE=\"BUN_CONFIG_REGISTRY=x\"\n"
    )).toBeUndefined()
  })

  it.each([
    ["BUN_INSTALL_CACHE_DIR=/elsewhere", "BUN_INSTALL_CACHE_DIR"],
    ["  export BUN_CONFIG_SKIP_INSTALL_PACKAGES=1", "BUN_CONFIG_SKIP_INSTALL_PACKAGES"],
    ["A=1\r\nNPM_CONFIG_REGISTRY = https://r.example/", "NPM_CONFIG_REGISTRY"],
    ["npm_config_ignore_scripts=false", "npm_config_ignore_scripts"],
    ["\"BUN_CONFIG_REGISTRY\"=https://r.example/", "BUN_CONFIG_REGISTRY"],
    ["BUN_FUTURE_SETTING: yes", "BUN_FUTURE_SETTING"]
  ])("names the installer variable %j assigns, and not its value", (text, name) => {
    expect(Bun.reservedAssignment(text)).toBe(name)
  })
})
