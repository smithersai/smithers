/**
 * The Nix environment declaration and its CI counterpart.
 *
 * A declaration is inert data with the same validation discipline as
 * `Runtime.Node` and `NodeModules`: unknown options are refused, the two forms
 * are exclusive, and the lock beside a flake is declared with it so an edit to
 * either re-keys what runs under the environment.
 */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as CiToolchain from "../src/CiToolchain.ts"
import { actions, GithubCiGen, render as renderWorkflow } from "../src/GithubCiGen.ts"
import * as Input from "../src/Input.ts"
import * as Nix from "../src/Nix.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import { Secret } from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as Verb from "../src/Verb.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const flake = Input.file("//flake.nix")
const runtime = Runtime.Node({ version: ">=26.4.0" })
const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })

describe("Nix.Environment", () => {
  it.each([
    "//tools/my env/flake.nix",
    "//tools/$(run)/flake.nix",
    "//tools/a;run/flake.nix",
    "//tools/a|b/flake.nix",
    "//tools/a&b/flake.nix",
    "//tools/env';touch PWN;#/flake.nix",
    "//tools/env`run`/flake.nix"
  ])(
    "refuses shell-shaped environment paths in constructors and guards: %s",
    (path) => {
      const file = Input.file(path)
      for (const options of [{ flake: file }, { file }, { flake, lock: file }]) {
        expect(() => Nix.Environment(options)).toThrow(/usable Nix.Environment/)
        expect(Nix.isEnvironment({ _tag: "NixEnvironment", ...options })).toBe(false)
        const declaration = { _tag: "NixEnvironment", ...options }
        expect(Schema.is(Nix.EnvironmentDeclaration)(declaration)).toBe(false)
        expect(() => Schema.decodeUnknownSync(Nix.EnvironmentDeclaration)(declaration)).toThrow()
        expect(() => CiToolchain.Needs({ nix: { installer: "determinate", environment: declaration } as never }))
          .toThrow()
        expect(() => CiToolchain.Nix({ environment: { _tag: "NixEnvironment", ...options } as never }))
          .toThrow(/must be an S.Nix.Environment/)
      }
    }
  )

  it("rejects an environment path that does not resolve inside the workspace", () => {
    expect(Nix.isEnvironment({ _tag: "NixEnvironment", file: { _tag: "File", path: "/etc/environment.nix" } }))
      .toBe(false)
  })

  it.each(["ci;curl evil|sh", "ci$(run)", "ci&run", "a".repeat(Nix.maximumAttrLength + 1)])(
    "rejects unsafe attributes in both the schema and guard: %s",
    (attr) => {
      const declaration = { _tag: "NixEnvironment", flake, lock: Input.file("//flake.lock"), attr }
      expect(Schema.is(Nix.EnvironmentDeclaration)(declaration)).toBe(false)
      expect(Nix.isEnvironment(declaration)).toBe(false)
      expect(() => CiToolchain.Nix({ environment: declaration as never })).toThrow(/must be an S.Nix.Environment/)
    }
  )

  it.each(["a".repeat(Nix.maximumAttrLength), "devShells.x86_64-linux.ci"])(
    "accepts bounded safe attributes through the schema and guard",
    (attr) => {
      const environment = Nix.Environment({ flake, attr })
      expect(Schema.is(Nix.EnvironmentDeclaration)(environment)).toBe(true)
      expect(Nix.isEnvironment(environment)).toBe(true)
    }
  )

  it("declares the flake form with the lock beside the flake", () => {
    const environment = Nix.Environment({ flake })
    expect(environment._tag).toBe("NixEnvironment")
    expect(environment.flake).toEqual(flake)
    expect(environment.lock).toEqual(Input.file("//flake.lock"))
    expect(environment.attr).toBeUndefined()
    expect(environment.file).toBeUndefined()
    expect(Object.isFrozen(environment)).toBe(true)
    expect(Nix.isEnvironment(environment)).toBe(true)
    expect(Nix.environmentInputs(environment)).toEqual([flake, Input.file("//flake.lock")])
  })

  it("derives the lock next to a flake below the root and keeps an explicit one", () => {
    const nested = Nix.Environment({ flake: Input.file("//infra/flake.nix") })
    expect(nested.lock).toEqual(Input.file("//infra/flake.lock"))
    expect(Nix.flakeDirectory(nested)).toBe("infra")
    const explicit = Nix.Environment({ flake, lock: Input.file("//locks/flake.lock") })
    expect(explicit.lock).toEqual(Input.file("//locks/flake.lock"))
  })

  it("declares the file form with the expression as its only input", () => {
    const environment = Nix.Environment({ file: Input.file("//.smithers/environment.nix") })
    expect(environment.file).toEqual(Input.file("//.smithers/environment.nix"))
    expect(environment.flake).toBeUndefined()
    expect(Nix.environmentInputs(environment)).toEqual([Input.file("//.smithers/environment.nix")])
    expect(Nix.developArguments(environment)).toEqual(["--file", "./.smithers/environment.nix"])
  })

  it("resolves a bare attr to the host system's dev shell and keeps a dotted path", () => {
    const named = Nix.Environment({ flake, attr: "ci" })
    expect(Nix.outputAttribute(named, "x86_64-linux")).toBe("devShells.x86_64-linux.ci")
    expect(Nix.developArguments(named)).toEqual([".#ci"])
    const dotted = Nix.Environment({ flake, attr: "devShells.aarch64-darwin.ci" })
    expect(Nix.outputAttribute(dotted, "x86_64-linux")).toBe("devShells.aarch64-darwin.ci")
    expect(Nix.outputAttribute(Nix.Environment({ flake }), "x86_64-linux")).toBeUndefined()
    expect(Nix.developArguments(Nix.Environment({ flake }))).toEqual(["."])
    expect(Nix.developArguments(Nix.Environment({ flake: Input.file("//infra/flake.nix"), attr: "ci" })))
      .toEqual(["./infra#ci"])
  })

  it("refuses malformed declarations", () => {
    expect(() => Nix.Environment(null as never)).toThrowError(
      new TypeError("Nix.Environment options must be an object")
    )
    expect(() => Nix.Environment({ flake, nope: true } as never)).toThrowError(
      new TypeError("Nix.Environment received unknown option \"nope\"")
    )
    expect(() => Nix.Environment({} as never)).toThrowError(/requires a flake or a file/)
    expect(() => Nix.Environment({ flake, file: Input.file("//shell.nix") } as never)).toThrowError(/not both/)
    expect(() => Nix.Environment({ file: Input.file("//shell.nix"), attr: "ci" } as never)).toThrowError(
      /accompany a flake/
    )
    expect(() => Nix.Environment({ flake: "flake.nix" } as never)).toThrowError(/must be an S.file declaration/)
    expect(() => Nix.Environment({ flake, attr: "ci shell" })).toThrowError(/shell name or a dotted attribute path/)
    expect(() => Nix.Environment({ flake, attr: "" })).toThrowError(/shell name or a dotted attribute path/)
  })
})

describe("Workspace environment", () => {
  const cache = WorkspaceDeclaration.Cache({ directory: ".flows" })
  const environment = Nix.Environment({ flake })

  it("is a workspace option beside the Node trio", () => {
    const workspace = WorkspaceDeclaration.Workspace("force", {
      repository: "git+https://example.invalid/force.git",
      cache,
      runtime,
      packageManager,
      nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: Input.file("//package.json") }),
      environment
    })
    expect(workspace.environment).toBe(environment)
    expect(WorkspaceDeclaration.nixEnvironment(workspace)).toBe(environment)
  })

  it("satisfies the toolchain requirement on its own", () => {
    const workspace = WorkspaceDeclaration.Workspace("nixonly", {
      repository: "git+https://example.invalid/nixonly.git",
      cache,
      environment
    })
    expect(workspace.toolchains).toEqual([])
    expect(WorkspaceDeclaration.nixEnvironment(workspace)).toBe(environment)
  })

  it("reads a toolchains entry and leaves a dev shell pin alone", () => {
    const listed = WorkspaceDeclaration.Workspace("listed", {
      repository: "git+https://example.invalid/listed.git",
      cache,
      toolchains: [environment]
    })
    expect(WorkspaceDeclaration.nixEnvironment(listed)).toBe(environment)
    const shell = Nix.DevShell({ flake, lock: Input.file("//flake.lock") })
    const pinned = WorkspaceDeclaration.Workspace("pinned", {
      repository: "git+https://example.invalid/pinned.git",
      cache,
      toolchains: [shell]
    })
    expect(WorkspaceDeclaration.nixEnvironment(pinned)).toBeUndefined()
  })

  it("refuses an environment that is not a declaration", () => {
    expect(() =>
      WorkspaceDeclaration.Workspace("bad", {
        repository: "git+https://example.invalid/bad.git",
        cache,
        environment: { _tag: "NixEnvironment" } as never
      })
    ).toThrowError(/environment must be an S.Nix.Environment declaration/)
  })
})

describe("CiToolchain.Nix", () => {
  const environment = Nix.Environment({ flake })

  it("declares the installer and the optional cache secrets", () => {
    const setup = CiToolchain.Nix({ environment })
    expect(setup.installer).toBe("determinate")
    expect(setup.environment).toEqual(environment)
    expect(setup.substituter).toBeUndefined()
    const cached = CiToolchain.Nix({
      environment,
      installer: "cachix",
      substituter: Secret("NIX_CACHE_URL"),
      publicKey: Secret("NIX_CACHE_PUBLIC_KEY")
    })
    expect(cached.installer).toBe("cachix")
    expect(cached.substituter?.env).toBe("NIX_CACHE_URL")
    expect(cached.publicKey?.env).toBe("NIX_CACHE_PUBLIC_KEY")
  })

  it("refuses half a cache declaration and non-declarations", () => {
    expect(() => CiToolchain.Nix({ environment, substituter: Secret("NIX_CACHE_URL") })).toThrowError(
      /declared together/
    )
    expect(() => CiToolchain.Nix({ environment: {} as never })).toThrowError(/must be an S.Nix.Environment/)
    expect(() => CiToolchain.Nix({ environment, publicKey: "key" as never })).toThrowError(/must be an S.Secret/)
    // The substituter is checked on its own rather than only through the
    // pairing rule below it: a cache URL written as a bare string would
    // otherwise reach the workflow as a literal instead of a secret read.
    expect(() => CiToolchain.Nix({ environment, substituter: "https://cache.example" as never })).toThrowError(
      /substituter must be an S.Secret/
    )
    expect(() => CiToolchain.Nix(null as never)).toThrowError(/options must be an object/)
  })

  it("refuses a job that installs both the environment and a per-tool setup", () => {
    const nix = CiToolchain.Nix({ environment })
    expect(CiToolchain.Needs({ nix }).nix).toEqual(nix)
    expect(() =>
      CiToolchain.Needs({
        nix,
        runtimes: [CiToolchain.Node({ runtime, release: "26.4.0" })],
        jj: CiToolchain.Jj({ release: "0.39.0" })
      })
    ).toThrowError(/a Nix environment supplies the toolchain; remove runtimes, jj from the job/)
    expect(() => CiToolchain.Needs({ nix, ripgrep: CiToolchain.Ripgrep({ release: "14.1.1" }) })).toThrowError(
      /remove ripgrep/
    )
    expect(() => CiToolchain.Needs({ nix, postgres: CiToolchain.Postgres({ release: "18" }) })).toThrowError(
      /remove postgres/
    )
    expect(() => CiToolchain.Needs({ nix, uv: { release: "0.8.22" } })).toThrowError(/remove uv/)
    expect(CiToolchain.Needs({ nix, runtimes: [] }).nix).toEqual(nix)
  })
})

describe("GithubCiGen with a Nix environment", () => {
  const environment = Nix.Environment({ flake, attr: "ci" })
  const attrs = (nix: CiToolchain.NixSetup) =>
    Target.metadata(GithubCiGen({
      packageManager,
      jobs: [{
        id: "test",
        name: "workspace graph",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ nix }),
        steps: [{ verb: Verb.Ci, pattern: "//packages/...", parallelism: 2 }]
      }]
    })).attrs as Parameters<typeof renderWorkflow>[0]

  it.each(
    [
      { _tag: "NixEnvironment", file: Input.file("//env';touch PWN;#.nix") },
      { _tag: "NixEnvironment", flake, attr: "ci;touch PWN" }
    ] as const
  )("refuses unsafe structural environments at the renderer boundary", (unsafe) => {
    const base = attrs(CiToolchain.Nix({ environment }))
    const job = base.jobs[0]!
    const toolchain = { ...job.toolchain, nix: { installer: "determinate", environment: unsafe } } as const
    expect(() => renderWorkflow({ ...base, jobs: [{ ...job, toolchain }] }))
      .toThrow(/Nix environment must contain usable paths and a valid attribute/)
  })

  it.each(
    [
      [Nix.Environment({ flake: Input.file("//tools/*/flake.nix"), attr: "ci" }), "'./tools/*#ci'"],
      [Nix.Environment({ file: Input.file("//tools/*.nix") }), "'--file' './tools/*.nix'"]
    ] as const
  )("quotes every Nix environment argument", (environment, argument) => {
    const rendered = renderWorkflow(attrs(CiToolchain.Nix({ environment })))
    expect(rendered).toContain("nix develop " + argument + " --command pnpm install")
    expect(rendered).toContain("nix develop " + argument + " --command pnpm exec")
  })

  it("installs Nix, installs the workspace inside the shell, and runs every step inside it", () => {
    const rendered = renderWorkflow(attrs(CiToolchain.Nix({ environment })))
    expect(rendered).toContain(`uses: "${actions.nixInstallerDeterminate}"`)
    expect(rendered).not.toContain("actions/setup-node")
    expect(rendered).not.toContain("pnpm/action-setup")
    expect(rendered).toContain("nix develop '.#ci' --command pnpm install --frozen-lockfile --ignore-scripts")
    expect(rendered).toContain("nix develop '.#ci' --command pnpm exec smthrs ci '//packages/...' --jobs 2")
    expect(rendered).not.toContain("extra-conf")
  })

  it("installs Cachix without adding cache configuration when no cache is declared", () => {
    const rendered = renderWorkflow(attrs(CiToolchain.Nix({ environment, installer: "cachix" })))
    expect(rendered).toContain(`uses: "${actions.nixInstallerCachix}"`)
    expect(rendered).not.toContain("extra_nix_config")
    expect(rendered).not.toContain("secrets.")
    expect(rendered).toContain("nix develop '.#ci' --command pnpm install --frozen-lockfile --ignore-scripts")
    expect(rendered).toContain("nix develop '.#ci' --command pnpm exec smthrs ci '//packages/...' --jobs 2")
  })

  it("trusts a declared binary cache only through secrets expressions", () => {
    const rendered = renderWorkflow(attrs(CiToolchain.Nix({
      environment,
      substituter: Secret("NIX_CACHE_URL"),
      publicKey: Secret("NIX_CACHE_PUBLIC_KEY")
    })))
    expect(rendered).toContain("\"extra-conf\":")
    expect(rendered).toContain("extra-substituters = ${{ secrets.NIX_CACHE_URL }}")
    expect(rendered).toContain("extra-trusted-public-keys = ${{ secrets.NIX_CACHE_PUBLIC_KEY }}")
    const cachix = renderWorkflow(attrs(CiToolchain.Nix({
      environment,
      installer: "cachix",
      substituter: Secret("NIX_CACHE_URL"),
      publicKey: Secret("NIX_CACHE_PUBLIC_KEY")
    })))
    expect(cachix).toContain(`uses: "${actions.nixInstallerCachix}"`)
    expect(cachix).toContain("\"extra_nix_config\":")
  })
})

describe("Nix environment partial input discovery", () => {
  it("returns exactly the files present in a decoded environment", () => {
    expect(Nix.environmentInputs({ _tag: "NixEnvironment" })).toEqual([])
    expect(Nix.environmentInputs({ _tag: "NixEnvironment", flake })).toEqual([flake])
    const lock = Input.file("//flake.lock")
    expect(Nix.environmentInputs({ _tag: "NixEnvironment", lock })).toEqual([lock])
  })
})
