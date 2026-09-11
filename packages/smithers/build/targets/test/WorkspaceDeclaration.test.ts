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
