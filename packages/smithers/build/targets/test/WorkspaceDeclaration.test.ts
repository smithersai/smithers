/**
 * Runtime validation contracts for workspace-only declarations.
 *
 * PACKAGE.ts and WORKSPACE.ts files are loaded as executable JavaScript, so
 * callers are owed precise rejection types for malformed names, options,
 * repositories, flags, and sandbox declarations rather than type-only safety.
 */
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LocalRepository from "../src/LocalRepository.ts"
import * as Nix from "../src/Nix.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const cache = WorkspaceDeclaration.Cache({ directory: ".flows" })
const toolchain = RustToolchain.Toolchain({ workspace: Input.file("//Cargo.toml"), channel: "1.91" })
const options = {
  repository: "git+https://example.invalid/workspace.git",
  cache,
  toolchains: [toolchain]
}

const thrown = (operation: () => unknown): Error => {
  try {
    operation()
  } catch (cause) {
    if (cause instanceof Error) return cause
    throw new Error("expected an Error instance")
  }
  throw new Error("expected the declaration to be rejected")
}

describe("Workspace refusal types", () => {
  it.each([
    [
      "a non-string name",
      () => WorkspaceDeclaration.Workspace(42 as never, options),
      TypeError,
      "Workspace name must be a string; Workspace(name, options) takes the name first"
    ],
    [
      "a non-portable name",
      () => WorkspaceDeclaration.Workspace("bad name", options),
      Error,
      "Workspace name must be a portable identifier: \"bad name\""
    ],
    [
      "non-object options",
      () => WorkspaceDeclaration.Workspace("fixture", null as never),
      TypeError,
      "Workspace options must be an object"
    ],
    [
      "an unknown option",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, typo: true } as never),
      TypeError,
      "Workspace received unknown option \"typo\""
    ],
    [
      "a remotes value that is not an S.Remotes declaration",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, remotes: { remotes: {} } } as never),
      TypeError,
      "Workspace remotes must be an S.Remotes declaration"
    ],
    [
      "a non-object discovery",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, discovery: 42 } as never),
      TypeError,
      "Workspace discovery must be an object"
    ],
    [
      "an unknown discovery option",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, discovery: { skip: [] } } as never),
      TypeError,
      "Workspace discovery received unknown option \"skip\""
    ],
    [
      "a non-array discovery prune",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, discovery: { prune: "dist" } } as never),
      TypeError,
      "Workspace discovery prune must be an array of workspace-relative paths"
    ],
    [
      "a non-string discovery prune path",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, discovery: { prune: [1] } } as never),
      TypeError,
      "Workspace discovery prune must be an array of workspace-relative paths"
    ],
    [
      "a repeated discovery prune path",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, discovery: { prune: ["dist", "dist/"] } }),
      TypeError,
      "Workspace discovery prune paths must be distinct: \"dist\""
    ],
    [
      "a non-string repository",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, repository: 42 } as never),
      TypeError,
      "Workspace repository must be a non-empty string"
    ],
    [
      "an empty repository",
      () => WorkspaceDeclaration.Workspace("fixture", { ...options, repository: "" }),
      TypeError,
      "Workspace repository must be a non-empty string"
    ],
    [
      "a non-portable repo name",
      () =>
        WorkspaceDeclaration.Workspace("fixture", {
          ...options,
          repos: { "bad name": LocalRepository.make("vendor/child") }
        }),
      TypeError,
      "Workspace repo name is not portable: \"bad name\""
    ]
  ])("rejects %s with the documented error class", (_name, operation, Constructor, message) => {
    const error = thrown(operation)
    expect(error).toBeInstanceOf(Constructor)
    expect(error.message).toBe(message)
  })
})

describe("Flags declarations", () => {
  it("brands and freezes a valid name-to-text record", () => {
    const flags = WorkspaceDeclaration.Flags({ production: "--production" })

    expect(WorkspaceDeclaration.isFlagsDeclaration(flags)).toBe(true)
    expect(WorkspaceDeclaration.isFlagsDeclaration(null)).toBe(false)
    expect(WorkspaceDeclaration.isFlagsDeclaration({})).toBe(false)
    expect(flags.flags).toEqual({ production: "--production" })
    expect(Object.isFrozen(flags.flags)).toBe(true)
  })

  it.each([
    [null, TypeError, "Flags requires a name-to-text record"],
    [{ "bad name": "--bad" }, Error, "Flags name is not a legal reference name: \"bad name\""],
    [{ empty: "" }, TypeError, "Flags entry \"empty\" must be non-empty text"],
    [{ numeric: 42 }, TypeError, "Flags entry \"numeric\" must be non-empty text"]
  ])("rejects an invalid flags record", (value, Constructor, message) => {
    const error = thrown(() => WorkspaceDeclaration.Flags(value as never))
    expect(error).toBeInstanceOf(Constructor)
    expect(error.message).toBe(message)
  })
})

describe("Sandbox declarations", () => {
  it.each([
    [null],
    [{}],
    [{ image: "" }],
    [{ image: 42 }]
  ])("rejects an invalid Docker image declaration", (value) => {
    const error = thrown(() => WorkspaceDeclaration.Sandbox.Docker(value as never))
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toBe("Sandbox.Docker requires an image name")
  })

  it("keeps a valid Docker image as inert frozen data", () => {
    const docker = WorkspaceDeclaration.Sandbox.Docker({ image: "node:26-alpine" })

    expect(docker).toEqual({ _tag: "SandboxDocker", image: "node:26-alpine" })
    expect(Object.isFrozen(docker)).toBe(true)
  })

  it("keeps a Microsandbox declaration with its Nix environment as inert frozen data", () => {
    const environment = Nix.Environment({ flake: Input.file("//flake.nix") })
    const bare = WorkspaceDeclaration.Sandbox.Microsandbox()
    const declared = WorkspaceDeclaration.Sandbox.Microsandbox({ image: "nixos/nix:2.24.10", environment })

    expect(bare).toEqual({ _tag: "SandboxMicrosandbox" })
    expect(declared).toEqual({ _tag: "SandboxMicrosandbox", image: "nixos/nix:2.24.10", environment })
    expect(Object.isFrozen(declared)).toBe(true)
    expect(WorkspaceDeclaration.isSandboxDeclaration(declared)).toBe(true)
    expect(WorkspaceDeclaration.isSandboxesDeclaration(WorkspaceDeclaration.Sandboxes({ default: declared }))).toBe(
      true
    )
  })

  it.each([
    [{ image: "" }, "Sandbox.Microsandbox image must be a non-empty image name"],
    [{ image: 42 }, "Sandbox.Microsandbox image must be a non-empty image name"],
    [
      { environment: { flake: "//flake.nix" } },
      "Sandbox.Microsandbox environment must be an S.Nix.Environment declaration"
    ],
    [{ flake: Input.file("//flake.nix") }, "Sandbox.Microsandbox received unknown option \"flake\""],
    // `null` is what a caller reading options out of parsed JSON hands over
    // when the key is present and empty; the default parameter only covers
    // `undefined`, so it reaches the body and would otherwise be walked.
    [null, "Sandbox.Microsandbox options must be an object"],
    ["nixos/nix:2.24.10", "Sandbox.Microsandbox options must be an object"]
  ])("rejects an invalid Microsandbox declaration", (value, message) => {
    const error = thrown(() => WorkspaceDeclaration.Sandbox.Microsandbox(value as never))
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toBe(message)
  })
})

describe("Sandboxes declarations", () => {
  it("brands and freezes each validated declaration", () => {
    const sandboxes = WorkspaceDeclaration.Sandboxes({
      local: WorkspaceDeclaration.Sandbox.Bubblewrap(),
      container: WorkspaceDeclaration.Sandbox.Docker({ image: "node:26-alpine" })
    })

    expect(WorkspaceDeclaration.isSandboxesDeclaration(sandboxes)).toBe(true)
    expect(WorkspaceDeclaration.isSandboxesDeclaration(null)).toBe(false)
    expect(WorkspaceDeclaration.isSandboxesDeclaration({})).toBe(false)
    expect(Object.isFrozen(sandboxes)).toBe(true)
    expect(Object.isFrozen(sandboxes.sandboxes)).toBe(true)
    expect(Object.keys(sandboxes.sandboxes)).toEqual(["local", "container"])
  })

  it.each([
    [null, TypeError, "Sandboxes requires a name-to-sandbox record"],
    [
      { "bad name": WorkspaceDeclaration.Sandbox.Bubblewrap() },
      Error,
      "Sandboxes name is not a legal reference name: \"bad name\""
    ],
    [{ broken: { _tag: "SandboxUnknown" } }, TypeError, "Sandboxes entry \"broken\" is not a sandbox declaration"]
  ])("rejects an invalid sandbox table", (value, Constructor, message) => {
    const error = thrown(() => WorkspaceDeclaration.Sandboxes(value as never))
    expect(error).toBeInstanceOf(Constructor)
    expect(error.message).toBe(message)
  })
})

describe("Remote declarations", () => {
  it("keeps a command remote as inert frozen data, with the default CLI and no setup", () => {
    const remote = WorkspaceDeclaration.Remote.Command({ machines: [["ssh", "box-1"], []], workdir: "/srv/ci" })

    expect(remote).toEqual({
      _tag: "RemoteCommand",
      machines: [["ssh", "box-1"], []],
      workdir: "/srv/ci",
      setup: [],
      cli: ["npx", "--no", "smthrs"]
    })
    expect(remote.cli).toBe(WorkspaceDeclaration.defaultRemoteCli)
    expect(Object.isFrozen(remote)).toBe(true)
    expect(Object.isFrozen(remote.machines)).toBe(true)
    expect(Object.isFrozen(remote.machines[0])).toBe(true)
    expect(Object.isFrozen(remote.setup)).toBe(true)
    expect(WorkspaceDeclaration.isRemoteDeclaration(remote)).toBe(true)
  })

  it("copies the declared setup and CLI, so a later edit to the caller's arrays changes nothing", () => {
    const machines = [["docker", "exec", "-i", "ci"]]
    const setup = ["pnpm install --frozen-lockfile"]
    const cli = ["pnpm", "exec", "smthrs"]
    const remote = WorkspaceDeclaration.Remote.Command({ machines, workdir: "/work", setup, cli })
    machines[0]!.push("extra")
    setup.push("rm -rf /")
    cli.push("--extra")

    expect(remote).toEqual({
      _tag: "RemoteCommand",
      machines: [["docker", "exec", "-i", "ci"]],
      workdir: "/work",
      setup: ["pnpm install --frozen-lockfile"],
      cli: ["pnpm", "exec", "smthrs"]
    })
    expect(Object.isFrozen(remote.cli)).toBe(true)
  })

  it.each([
    [null, "Remote.Command options must be an object"],
    [{ machines: [[]], workdir: "/w", hosts: [] }, "Remote.Command received unknown option \"hosts\""],
    [{ workdir: "/w" }, "Remote.Command machines must be a non-empty array of argv prefixes, one per machine"],
    [
      { machines: [], workdir: "/w" },
      "Remote.Command machines must be a non-empty array of argv prefixes, one per machine"
    ],
    [
      { machines: ["ssh box"], workdir: "/w" },
      "Remote.Command machines must be a non-empty array of argv prefixes, one per machine"
    ],
    [
      { machines: [[1]], workdir: "/w" },
      "Remote.Command machines must be a non-empty array of argv prefixes, one per machine"
    ],
    [
      { machines: [["a\0b"]], workdir: "/w" },
      "Remote.Command machines must be a non-empty array of argv prefixes, one per machine"
    ],
    [{ machines: [[]] }, "Remote.Command workdir must be an absolute guest path"],
    [{ machines: [[]], workdir: "relative" }, "Remote.Command workdir must be an absolute guest path"],
    [{ machines: [[]], workdir: "/a\0b" }, "Remote.Command workdir must be an absolute guest path"],
    [
      { machines: [[]], workdir: "/w", setup: "pnpm install" },
      "Remote.Command setup must be an array of non-empty shell commands"
    ],
    [
      { machines: [[]], workdir: "/w", setup: [""] },
      "Remote.Command setup must be an array of non-empty shell commands"
    ],
    [{ machines: [[]], workdir: "/w", cli: [] }, "Remote.Command cli must be a non-empty array of non-empty words"],
    [
      { machines: [[]], workdir: "/w", cli: ["smthrs", ""] },
      "Remote.Command cli must be a non-empty array of non-empty words"
    ],
    [
      { machines: [[]], workdir: "/w", cli: "smthrs" },
      "Remote.Command cli must be a non-empty array of non-empty words"
    ]
  ])("rejects an invalid command remote %j", (value, message) => {
    const error = thrown(() => WorkspaceDeclaration.Remote.Command(value as never))
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toBe(message)
  })
})

describe("Remotes declarations", () => {
  const remote = WorkspaceDeclaration.Remote.Command({ machines: [[]], workdir: "/w" })

  it("brands and freezes each validated declaration, and reaches the workspace", () => {
    const remotes = WorkspaceDeclaration.Remotes({ boxes: remote, local_pair: remote })

    expect(WorkspaceDeclaration.isRemotesDeclaration(remotes)).toBe(true)
    expect(WorkspaceDeclaration.isRemotesDeclaration(null)).toBe(false)
    expect(WorkspaceDeclaration.isRemotesDeclaration({ remotes: {} })).toBe(false)
    expect(Object.isFrozen(remotes)).toBe(true)
    expect(Object.isFrozen(remotes.remotes)).toBe(true)
    expect(Object.keys(remotes.remotes)).toEqual(["boxes", "local_pair"])
    expect(WorkspaceDeclaration.Workspace("fixture", { ...options, remotes }).remotes).toBe(remotes)
  })

  it("adds no remotes key to a workspace that declares none", () => {
    expect(Object.hasOwn(WorkspaceDeclaration.Workspace("fixture", options), "remotes")).toBe(false)
  })

  it.each([
    [null, TypeError, "Remotes requires a name-to-remote record"],
    [{ "bad name": remote }, Error, "Remotes name is not a legal reference name: \"bad name\""],
    [{ broken: { _tag: "RemoteUnknown" } }, TypeError, "Remotes entry \"broken\" is not a remote declaration"]
  ])("rejects an invalid remote table", (value, Constructor, message) => {
    const error = thrown(() => WorkspaceDeclaration.Remotes(value as never))
    expect(error).toBeInstanceOf(Constructor)
    expect(error.message).toBe(message)
  })
})

describe("NodeModules declarations", () => {
  it("preserves an optional workspace graph file without inventing one", () => {
    const packageJson = Input.file("//package.json")
    const workspaces = Input.file("//pnpm-workspace.yaml")

    expect(WorkspaceDeclaration.NodeModules({ packageJson })).toEqual({ _tag: "NpmNodeModules", packageJson })
    expect(WorkspaceDeclaration.NodeModules({ packageJson, workspaces })).toEqual({
      _tag: "NpmNodeModules",
      packageJson,
      workspaces
    })
  })
})
