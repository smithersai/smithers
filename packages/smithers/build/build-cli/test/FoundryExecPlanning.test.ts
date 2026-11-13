import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as FoundryExec from "../src/FoundryExec.ts"
import * as HostProbes from "../src/internal/HostProbes.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const executable = async (directory: string, name: string, body: string): Promise<string> => {
  const path = NodePath.join(directory, name)
  await Fs.writeFile(path, `#!/bin/sh\n${body}`, { mode: 0o755 })
  return path
}

/** A Foundry forge: `--version` identifies it and `config --json` follows FAKE_FORGE_CONFIG. */
const foundryForge =
  `if [ "$1" = "--version" ]; then printf 'forge Version: 1.2.3-fake\\nCommit SHA: abc\\n'; exit 0; fi
if [ "$1" = "config" ]; then
  if [ -n "$FAKE_FORGE_LOG" ]; then printf '%s|%s|%s\\n' "$(pwd)" "$*" "$FOUNDRY_PROFILE" > "$FAKE_FORGE_LOG"; fi
  case "$FAKE_FORGE_CONFIG" in
    fail) printf 'Error: failed to parse foundry.toml\\n' >&2; exit 2;;
    text) printf 'Compiler run successful\\n';;
    custom) printf '{"out":"artifacts","cache_path":"compiler-cache","cache":false}\\n';;
    *) printf '{"out":"","cache_path":"","cache":true}\\n';;
  esac
  exit 0
fi
exit 64
`

/** A different program that happens to be called forge. */
const otherForge = `printf 'forge 0.3.1 - a static site generator\\n'\n`

interface Host {
  readonly root: string
  readonly bin: string
  readonly forge: string
  readonly environment: Record<string, string>
}

const host = async (): Promise<Host> => {
  const root = await temporary("smthrs-foundry-root-")
  const bin = await temporary("smthrs-foundry-bin-")
  const forge = await executable(bin, "forge", foundryForge)
  return { root, bin, forge, environment: { PATH: bin } }
}

const file = (path: string) => ({ _tag: "File", path })

const workspaceOf = (toolchains?: ReadonlyArray<unknown>) => (toolchains === undefined ? {} : { toolchains }) as never

const write = async (root: string, path: string, text: string): Promise<void> => {
  await Fs.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true })
  await Fs.writeFile(NodePath.join(root, path), text)
}

describe("S.Mise.bin resolution", () => {
  it("refuses without an S.Mise toolchain entry", async () => {
    const { root, environment } = await host()
    const resolved = await FoundryExec.resolveMiseBin(root, workspaceOf(), "node", environment)
    expect(resolved).toEqual({
      ok: false,
      refusal: "S.Mise.bin(\"node\") requires an S.Mise entry in Workspace toolchains",
      identity: { tag: "MiseBin", name: "node", authority: null, pinned: null }
    })
  })

  it("keys a missing mise config as absent and refuses when mise is not installed", async () => {
    const { root, environment } = await host()
    const workspace = workspaceOf([{ _tag: "Mise", config: file("//mise.toml") }])
    const resolved = await FoundryExec.resolveMiseBin(root, workspace, "node", environment)
    expect(resolved).toEqual({
      ok: false,
      refusal: "host binary \"mise\" is not present on PATH; S.Mise.bin(\"node\") is pinned by the declared mise " +
        "config but cannot execute on this host",
      identity: {
        tag: "MiseBin",
        name: "node",
        authority: { path: "mise.toml", digest: "absent" },
        pinned: null,
        absent: true
      }
    })
  })

  it("reads the pin from a config without a [tools] table and names it in the refusal", async () => {
    const { root, environment } = await host()
    await write(root, "mise.toml", "\"node.js\" = \"22.1.0\"\nnode = '20.0.0'\n")
    const workspace = workspaceOf([{ _tag: "Mise", config: file("//mise.toml") }])
    const resolved = await FoundryExec.resolveMiseBin(root, workspace, "node.js", environment)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? undefined : resolved.refusal).toContain("is pinned to 22.1.0 but cannot execute")
    expect(resolved.identity).toMatchObject({ pinned: "22.1.0", authority: { path: "mise.toml" } })
    expect((resolved.identity as { authority: { digest: string } }).authority.digest).not.toBe("absent")
  })

  it("probes an installed mise once per environment and keys a tool missing from [tools] as unpinned", async () => {
    const { root, bin, environment } = await host()
    const mise = await executable(bin, "mise", "printf '2025.10.0 linux-x64\\n'\n")
    await write(root, "mise.toml", "[tools]\npython = \"3.12\"\n[env]\nnode = \"18\"\n")
    const workspace = workspaceOf([null, { _tag: "Other" }, { _tag: "Mise", config: file("//mise.toml") }])
    const probes = HostProbes.make()
    const first = await FoundryExec.resolveMiseBin(root, workspace, "node", environment, probes)
    expect(first).toMatchObject({
      ok: true,
      path: mise,
      identity: { tag: "MiseBin", name: "node", pinned: null, path: mise, probe: { exitCode: 0 } }
    })
    expect((first.identity as { probe: { output: string } }).probe.output).toContain("2025.10.0")
    await Fs.writeFile(mise, "#!/bin/sh\nprintf 'replaced\\n'\n")
    const second = await FoundryExec.resolveMiseBin(root, workspace, "node", environment, probes)
    expect(second.identity).toEqual(first.identity)
  })
})

describe("Foundry forge resolution", () => {
  it("refuses when no forge is on PATH", async () => {
    const { root } = await host()
    const empty = await temporary("smthrs-foundry-empty-")
    const plan = await FoundryExec.plan({
      root,
      packagePath: "contracts",
      workspace: workspaceOf(),
      rule: "Foundry.Build",
      mode: "execute",
      environment: { PATH: empty },
      attrs: {} as never
    })
    expect(plan).toEqual({
      cwd: "contracts",
      env: {},
      outDirs: [],
      writeSet: [],
      toolchain: {
        forge: { tag: "FoundryForge", candidates: [], absent: true },
        config: null,
        versions: null,
        pinned: null
      },
      refusal: "host binary \"forge\" is not present on PATH"
    })
  })

  it("refuses when every forge on PATH is some other program", async () => {
    const { root } = await host()
    const other = await temporary("smthrs-foundry-other-")
    const impostor = await executable(other, "forge", otherForge)
    const plan = await FoundryExec.plan({
      root,
      packagePath: "",
      workspace: workspaceOf(),
      rule: "Foundry.Test",
      mode: "execute",
      environment: { PATH: other },
      attrs: {} as never
    })
    expect(plan.cwd).toBe(".")
    expect(plan.refusal).toBe("the PATH entries named \"forge\" are not Foundry forge executables")
    expect(plan.toolchain).toMatchObject({ forge: { candidates: [impostor], absent: true } })
  })

  it("skips an earlier impostor and keeps the Foundry forge later on PATH", async () => {
    const { root, bin, forge } = await host()
    const other = await temporary("smthrs-foundry-other-")
    await executable(other, "forge", otherForge)
    const plan = await FoundryExec.plan({
      root,
      packagePath: "",
      workspace: workspaceOf(),
      rule: "Foundry.Fmt",
      mode: "write",
      environment: { PATH: `${other}${NodePath.delimiter}${bin}` },
      attrs: {} as never
    })
    expect(plan.refusal).toBeUndefined()
    expect(plan.argv).toEqual([forge, "fmt"])
    expect(plan.toolchain).toMatchObject({ forge: { tag: "FoundryForge", path: forge } })
  })

  it("defaults to the host environment and a fresh probe cache", async () => {
    const { root } = await host()
    const options = {
      root,
      packagePath: "",
      workspace: workspaceOf(),
      rule: "Foundry.Fmt" as const,
      mode: "check" as const,
      attrs: {} as never
    }
    const ambient = await FoundryExec.plan(options)
    const explicit = await FoundryExec.plan({ ...options, environment: process.env, probes: HostProbes.make() })
    expect(ambient).toEqual(explicit)
  })
})

describe("Foundry plans", () => {
  it("plans fmt in check mode without a config path or forge config", async () => {
    const { root, forge, environment } = await host()
    const log = NodePath.join(root, "forge.log")
    const plan = await FoundryExec.plan({
      root,
      packagePath: "contracts",
      workspace: workspaceOf([{ _tag: "FoundryToolchain", config: file("//contracts/foundry.toml") }]),
      rule: "Foundry.Fmt",
      mode: "check",
      environment: { ...environment, FAKE_FORGE_LOG: log },
      attrs: { profile: "lint" } as never
    })
    expect(plan).toMatchObject({
      argv: [forge, "fmt", "--check"],
      cwd: "contracts",
      env: { FOUNDRY_PROFILE: "lint" },
      outDirs: [],
      writeSet: []
    })
    await expect(Fs.access(log)).rejects.toThrow()
  })

  it("plans a build without config, falling back to forge's default out and cache directories", async () => {
    const { root, forge, environment } = await host()
    await Fs.mkdir(NodePath.join(root, "contracts"))
    const log = NodePath.join(root, "forge.log")
    const plan = await FoundryExec.plan({
      root,
      packagePath: "contracts",
      workspace: workspaceOf(),
      rule: "Foundry.Build",
      mode: "execute",
      environment: { ...environment, FAKE_FORGE_LOG: log },
      attrs: { profile: "ci", skip: ["test", "script"], outDirs: ["dist"] } as never
    })
    expect(plan).toEqual({
      argv: [forge, "build", "--skip", "test", "--skip", "script"],
      cwd: "contracts",
      env: { FOUNDRY_PROFILE: "ci" },
      outDirs: ["contracts/dist"],
      writeSet: ["contracts/out", "contracts/cache"],
      toolchain: {
        forge: expect.objectContaining({ tag: "FoundryForge", path: forge }),
        config: null,
        versions: null,
        pinned: null
      }
    })
    expect(await Fs.readFile(log, "utf8")).toBe(`${NodePath.join(root, "contracts")}|config --json|ci\n`)
  })

  it("passes the workspace foundry.toml to build and test and reads forge's resolved directories", async () => {
    const { root, forge, environment } = await host()
    await write(root, "contracts/foundry.toml", "[profile.default]\nout = \"artifacts\"\n")
    await write(root, "mise.toml", "[tools]\nforge = \"1.2.3\"\n")
    await Fs.mkdir(NodePath.join(root, "pkg"))
    const log = NodePath.join(root, "forge.log")
    const workspace = workspaceOf([{
      _tag: "FoundryToolchain",
      config: file("//contracts/foundry.toml"),
      versions: { config: file("//mise.toml") }
    }])
    const plan = await FoundryExec.plan({
      root,
      packagePath: "pkg",
      workspace,
      rule: "Foundry.Test",
      mode: "execute",
      environment: { ...environment, FAKE_FORGE_CONFIG: "custom", FAKE_FORGE_LOG: log },
      attrs: {} as never
    })
    expect(plan.refusal).toBeUndefined()
    expect(plan.argv).toEqual([forge, "test", "--config-path", "../contracts/foundry.toml"])
    expect(plan.outDirs).toEqual([])
    expect(plan.writeSet).toEqual(["contracts/artifacts"])
    expect(plan.toolchain).toMatchObject({
      config: { path: "contracts/foundry.toml" },
      versions: { path: "mise.toml" },
      pinned: "1.2.3"
    })
    expect(await Fs.readFile(log, "utf8")).toBe(
      `${NodePath.join(root, "pkg")}|config --json --config-path ../contracts/foundry.toml|\n`
    )
  })

  it("resolves a target-declared config against its package and names a same-path config by basename", async () => {
    const { root, forge, environment } = await host()
    await write(root, "contracts/foundry.toml", "")
    const local = await FoundryExec.plan({
      root,
      packagePath: "contracts",
      workspace: workspaceOf([{ _tag: "FoundryToolchain", config: file("//elsewhere/foundry.toml") }]),
      rule: "Foundry.Build",
      mode: "execute",
      environment,
      attrs: { config: file("foundry.toml") } as never
    })
    expect(local.argv).toEqual([forge, "build", "--config-path", "foundry.toml"])
    expect(local.writeSet).toEqual(["contracts/out", "contracts/cache"])
    const samePath = await FoundryExec.plan({
      root,
      packagePath: "contracts",
      workspace: workspaceOf(),
      rule: "Foundry.Build",
      mode: "execute",
      environment,
      attrs: { config: file("//contracts") } as never
    })
    expect(samePath.argv).toEqual([forge, "build", "--config-path", "contracts"])
    expect(samePath.toolchain).toMatchObject({ config: { path: "contracts", digest: "absent" } })
  })

  it("refuses with forge's own error when forge config fails", async () => {
    const { root, forge, environment } = await host()
    await write(root, "foundry.toml", "[profile.default\n")
    const plan = await FoundryExec.plan({
      root,
      packagePath: "",
      workspace: workspaceOf([{ _tag: "FoundryToolchain", config: file("//foundry.toml") }]),
      rule: "Foundry.Test",
      mode: "execute",
      environment: { ...environment, FAKE_FORGE_CONFIG: "fail" },
      attrs: {} as never
    })
    expect(plan.argv).toEqual([forge, "test", "--config-path", "foundry.toml"])
    expect(plan.refusal).toBe("forge config failed: Error: failed to parse foundry.toml")
    expect(plan.writeSet).toEqual([])
  })

  it("refuses when forge config prints something other than JSON", async () => {
    const { root, environment } = await host()
    const plan = await FoundryExec.plan({
      root,
      packagePath: "",
      workspace: workspaceOf(),
      rule: "Foundry.Build",
      mode: "execute",
      environment: { ...environment, FAKE_FORGE_CONFIG: "text" },
      attrs: {} as never
    })
    expect(plan.refusal).toBe("forge config did not print JSON")
    expect(plan.outDirs).toEqual([])
  })

  it("asks forge config once per project, profile and environment within one probe cache", async () => {
    const { root, environment } = await host()
    const log = NodePath.join(root, "forge.log")
    const probes = HostProbes.make()
    const options = {
      root,
      packagePath: "",
      workspace: workspaceOf(),
      rule: "Foundry.Build" as const,
      mode: "execute" as const,
      probes,
      environment: { ...environment, FAKE_FORGE_LOG: log },
      attrs: {} as never
    }
    const first = await FoundryExec.plan(options)
    await Fs.rm(log)
    const second = await FoundryExec.plan({ ...options, rule: "Foundry.Test" })
    expect(second.writeSet).toEqual(first.writeSet)
    await expect(Fs.access(log)).rejects.toThrow()
    await FoundryExec.plan({ ...options, attrs: { profile: "ci" } as never })
    expect(await Fs.readFile(log, "utf8")).toContain("|ci\n")
  })
})
