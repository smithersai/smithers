import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GithubRender from "../src/GithubRender.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map(async (directory) => {
    await Fs.chmod(directory, 0o755).catch(() => undefined)
    await Fs.rm(directory, { recursive: true, force: true })
  }))
})

const temporaryRoot = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-github-boundaries-")))
  temporaryDirectories.push(root)
  return root
}

const unitWorkspace = S.Workspace("unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({
    version: "11.21.0",
    runtime: S.Runtime.Node({ version: ">=26.4.0" })
  }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})

type Workspace = typeof unitWorkspace

interface Row {
  readonly target: Target.AnyTarget
  readonly label: string
}

const renderWith = (
  workflows: ReadonlyArray<Target.AnyTarget>,
  labels: ReadonlyArray<Row> = [],
  options: { readonly workspace?: Workspace; readonly targets?: ReadonlyArray<Row> } = {}
): GithubRender.CiRender => {
  const ciGen = S.Github.CiGen({ workflows: [...workflows] })
  const rows: ReadonlyArray<Row> = [{ target: ciGen, label: "//.github:github" }, ...labels]
  return GithubRender.render({
    ciGen,
    workspace: options.workspace ?? unitWorkspace,
    resolve: {
      labelOf: (target) => rows.find((row) => row.target === target)?.label,
      ...(options.targets === undefined ? {} : { targets: () => options.targets! })
    },
    packageDir: ".github"
  })
}

const fileOf = (rendered: GithubRender.CiRender, path: string): string => {
  const file = rendered.files.find((entry) => entry.path === path)
  if (file === undefined) throw new Error(`no rendered ${path}; got ${rendered.files.map((entry) => entry.path)}`)
  return file.content
}

const setupActionFor = (workspace: Workspace, setup: Target.AnyTarget = S.Github.Setup({})): string =>
  fileOf(
    renderWith([S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [] })], [], { workspace }),
    "actions/setup/action.yml"
  )

/** The refusal a renderer call throws. */
const refusal = (work: () => unknown): GithubRender.GithubRenderError => {
  try {
    work()
  } catch (cause) {
    if (GithubRender.isGithubRenderError(cause)) return cause
    throw cause
  }
  throw new Error("expected a GithubRenderError")
}

const asyncRefusal = async (work: () => Promise<unknown>): Promise<GithubRender.GithubRenderError> => {
  try {
    await work()
  } catch (cause) {
    if (GithubRender.isGithubRenderError(cause)) return cause
    throw cause
  }
  throw new Error("expected a GithubRenderError")
}

/** A handle that passes `Target.isTarget` with attrs that skipped the rule's schema. */
const unvalidatedHandle = (rule: Target.AnyTarget, attrs: unknown): Target.AnyTarget => {
  const metadata = Target.metadata(rule)
  const handle = { _tag: metadata.target }
  Object.defineProperty(handle, Target.TargetTypeId, {
    value: Object.freeze({ ...metadata, attrs }),
    enumerable: false,
    configurable: false,
    writable: false
  })
  return handle as unknown as Target.AnyTarget
}

describe("trigger rendering", () => {
  it("renders pull_request branch filters without an activity list", () => {
    const content = fileOf(
      renderWith([
        S.Github.Workflow({ name: "ci", on: { pullRequest: { branches: ["main", "release/*"] } }, run: [] })
      ]),
      "workflows/ci.yml"
    )
    expect(content).toContain("on:\n  pull_request:\n    branches:\n      - \"main\"\n      - \"release/*\"\n")
    expect(content).not.toContain("    types:")
  })

  it("renders a bare issues trigger when no activity types are declared", () => {
    const content = fileOf(
      renderWith([S.Github.Workflow({ name: "triage", on: { issues: {} }, run: [] })]),
      "workflows/triage.yml"
    )
    expect(content).toContain("on:\n  issues:\njobs:")
  })

  it("renders dispatch inputs with only the fields each input declares", () => {
    const content = fileOf(
      renderWith([
        S.Github.Workflow({
          name: "dispatch",
          on: {
            workflowDispatch: {
              inputs: {
                dryRun: { type: "boolean", required: false },
                target: { type: "string" }
              }
            }
          },
          run: []
        })
      ]),
      "workflows/dispatch.yml"
    )
    expect(content).toContain(
      "  workflow_dispatch:\n    inputs:\n" +
        "      \"dryRun\":\n        required: false\n        type: boolean\n" +
        "      \"target\":\n        type: string\n"
    )
    expect(content).not.toContain("description:")
    expect(content).not.toContain("default:")
  })

  it("renders a dispatch trigger with an empty input table and no inputs key", () => {
    const content = fileOf(
      renderWith([S.Github.Workflow({ name: "manual", on: { workflowDispatch: { inputs: {} } }, run: [] })]),
      "workflows/manual.yml"
    )
    expect(content).toContain("on:\n  workflow_dispatch:\njobs:")
  })

  it("refuses a control character in a rendered scalar", () => {
    const failure = refusal(() =>
      renderWith([S.Github.Workflow({ name: "ci", on: { push: { branches: ["ma\u0007in"] } }, run: [] })])
    )
    expect(failure.code).toBe("invalid_path")
    expect(failure.message).toContain("contains a control character")
  })
})

describe("raw steps", () => {
  it("renders an unnamed one-line run inline and an unnamed line list as a block", () => {
    const content = fileOf(
      renderWith([
        S.Github.Workflow({
          name: "steps",
          on: { pullRequest: true },
          steps: [{ run: "echo one" }, { run: ["echo first", "echo second"] }]
        })
      ]),
      "workflows/steps.yml"
    )
    expect(content).toContain(
      "    steps:\n      - run: \"echo one\"\n      - run: |\n          echo first\n          echo second\n"
    )
  })
})

describe("job ids", () => {
  it("prefixes a job id derived from a label that starts with a digit", () => {
    const run = S.Shell.Test({ shell: "true" })
    const content = fileOf(
      renderWith([S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [run] })], [
        { target: run, label: "//1pkg:build" }
      ]),
      "workflows/ci.yml"
    )
    expect(content).toContain("\n  run-1pkg-build:\n")
  })
})

describe("setup toolchains", () => {
  it("installs Bun from a WORKSPACE.ts Bun declaration without setup-node", () => {
    const content = setupActionFor({
      ...unitWorkspace,
      runtime: { _tag: "BunRuntimeDeclaration", version: "1.2.3", executable: "bun" },
      packageManager: S.PackageManager.BunPackages({ runtime: S.Runtime.Bun({ version: "1.2.3" }) })
    })
    expect(content).toContain("    - uses: oven-sh/setup-bun@")
    expect(content).toContain("    - run: \"bun install --frozen-lockfile\"\n")
    expect(content).not.toContain("setup-node")
  })

  it("passes the pinned version of a BUILD-era Node runtime to setup-node", () => {
    const content = setupActionFor({ ...unitWorkspace, runtime: S.Runtime.Node({ version: ">=26.4.0" }) })
    expect(content).toContain("      with:\n        \"node-version\": \">=26.4.0\"\n")
  })

  it("passes an empty node-version for a Node declaration that names neither version nor manifest", () => {
    const content = setupActionFor({ ...unitWorkspace, runtime: { _tag: "NodeRuntimeDeclaration" } })
    expect(content).toContain("actions/setup-node@")
    expect(content).toContain("      with:\n        \"node-version\": \"\"\n")
  })

  it("reads the root go.mod for a Go layer that declares no module file", () => {
    const content = setupActionFor(
      S.Workspace("go", {
        repository: "git+https://example.invalid/go.git",
        cache: S.Cache({ directory: ".flows" }),
        toolchains: [{ _tag: "GoToolchain" }]
      })
    )
    expect(content).toContain("actions/setup-go@")
    expect(content).toContain("\"go-version-file\": \"go.mod\"")
  })
})

describe("setup credentials", () => {
  const writerWorkspace: Workspace = {
    ...unitWorkspace,
    cache: S.Cache({
      directory: ".flows",
      remote: S.RemoteCache.make({
        endpoint: "https://cache.example.invalid",
        read: S.Secret("CACHE_READ_TOKEN"),
        write: S.Secret("CACHE_WRITE_TOKEN")
      })
    })
  }

  it("refuses the workspace cache writer as the setup token under any letter case", () => {
    const failure = refusal(() =>
      setupActionFor(writerWorkspace, S.Github.Setup({ cacheToken: S.Secret("cache_write_token") }))
    )
    expect(failure.code).toBe("cache_writer_in_setup")
  })

  it("accepts the read token when the workspace declares a separate writer", () => {
    const content = setupActionFor(writerWorkspace, S.Github.Setup({ cacheToken: S.Secret("CACHE_READ_TOKEN") }))
    expect(content).toContain("SMTHRS_INPUT_CACHE_TOKEN: ${{ inputs.cache-token }}")
    expect(content).not.toContain("CACHE_WRITE_TOKEN")
  })

  it("refuses a setup secret name that is not an environment variable name", () => {
    const setup = unvalidatedHandle(S.Github.Setup({}), { cacheUrl: { _tag: "Secret", env: "CACHE-URL\"; rm -rf ~" } })
    const failure = refusal(() => setupActionFor(unitWorkspace, setup))
    expect(failure.code).toBe("invalid_path")
    expect(failure.message).toContain("is not an environment variable name")
  })
})

describe("job setup", () => {
  it("uses the shared setup action without inputs when it declares no cache secrets", () => {
    const run = S.Shell.Test({ shell: "true" })
    const content = fileOf(
      renderWith(
        [S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup: S.Github.Setup({}), run: [run] })],
        [
          { target: run, label: "//:build" }
        ]
      ),
      "workflows/ci.yml"
    )
    expect(content).toContain(
      "      - uses: ./.github/actions/setup\n      - run: \"pnpm exec smithers-build '//:build'\"\n"
    )
  })

  it("keeps workflows under workflows/ when the write-set names no workflows directory", () => {
    const ciGen = S.Github.CiGen({
      workflows: [S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [] })],
      changes: ["actions/**"]
    })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: { labelOf: (target) => target === ciGen ? "//.github:github" : undefined },
      packageDir: ".github"
    })
    expect(rendered.files.map((file) => file.path)).toEqual(["workflows/ci.yml"])
  })
})

describe("declaration refusals", () => {
  it("refuses a workflow setup that is not a Github.Setup target", () => {
    const failure = refusal(() =>
      renderWith([
        S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup: S.Shell.Test({ shell: "true" }), run: [] })
      ])
    )
    expect(failure.code).toBe("not_a_setup")
    expect(failure.message).toContain("expected a Github.Setup target")
  })

  it("refuses a Cron whose generated workflow name collides with a declared workflow", () => {
    const run = S.Shell.Test({ shell: "true" })
    const cron = S.Cron({ schedule: "0 6 * * 1", run: [run] })
    const failure = refusal(() =>
      renderWith(
        [S.Github.Workflow({ name: "cron-nightly", on: { pullRequest: true }, run: [] })],
        [{ target: run, label: "//:verify" }],
        {
          workspace: S.Workspace("bare", {
            repository: "git+https://example.invalid/bare.git",
            cache: S.Cache({ directory: ".flows" })
          }),
          targets: [{ target: cron, label: "//:nightly" }]
        }
      )
    )
    expect(failure.code).toBe("duplicate_workflow_name")
    expect(failure.message).toContain("Cron //:nightly collides with workflow cron-nightly")
  })

  it("refuses a Cron that runs an unlabeled target", () => {
    const cron = S.Cron({ schedule: "0 6 * * 1", run: [S.Shell.Test({ shell: "true" })] })
    const failure = refusal(() =>
      renderWith([], [], {
        workspace: S.Workspace("bare", {
          repository: "git+https://example.invalid/bare.git",
          cache: S.Cache({ directory: ".flows" })
        }),
        targets: [{ target: cron, label: "//:nightly" }]
      })
    )
    expect(failure.code).toBe("unlabeled_run_target")
    expect(failure.message).toContain("Cron //:nightly")
  })
})

describe("file ordering", () => {
  it.each([["zeta", "alpha"], ["alpha", "zeta"]])(
    "returns rendered files sorted by path when workflows are declared %s then %s",
    (first, second) => {
      const rendered = renderWith([
        S.Github.Workflow({ name: first!, on: { pullRequest: true }, run: [] }),
        S.Github.Workflow({ name: second!, on: { pullRequest: true }, run: [] })
      ])
      expect(rendered.files.map((file) => file.path)).toEqual(["workflows/alpha.yml", "workflows/zeta.yml"])
    }
  )
})

describe("check and write against the tree", () => {
  const rendered = (): GithubRender.CiRender =>
    renderWith([S.Github.Workflow({ name: "zeta", on: { pullRequest: true }, run: [] })])

  it("reports every rendered file missing when the package directory does not exist", async () => {
    const root = await temporaryRoot()
    expect(await GithubRender.check(root, rendered())).toEqual({
      clean: false,
      entries: [{ path: "workflows/zeta.yml", status: "missing" }]
    })
  })

  it("sorts unexpected files matched by a single-segment glob among the rendered entries", async () => {
    const root = await temporaryRoot()
    const set: GithubRender.CiRender = { ...rendered(), changes: ["workflows/*.yml"] }
    await GithubRender.write(root, set)
    await Fs.writeFile(NodePath.join(root, ".github/workflows/alpha.yml"), "stale\n", "utf8")
    await Fs.writeFile(NodePath.join(root, ".github/workflows/zulu.yml"), "stale\n", "utf8")
    await Fs.mkdir(NodePath.join(root, ".github/workflows/nested"))
    await Fs.writeFile(NodePath.join(root, ".github/workflows/nested/deep.yml"), "kept\n", "utf8")
    expect(await GithubRender.check(root, set)).toEqual({
      clean: false,
      entries: [
        { path: "workflows/alpha.yml", status: "unexpected" },
        { path: "workflows/zeta.yml", status: "clean" },
        { path: "workflows/zulu.yml", status: "unexpected" }
      ]
    })
  })

  it("ignores a symbolic link inside the write-set", async () => {
    const root = await temporaryRoot()
    const set: GithubRender.CiRender = { ...rendered(), changes: ["workflows/**"] }
    await GithubRender.write(root, set)
    await Fs.symlink("zeta.yml", NodePath.join(root, ".github/workflows/link.yml"))
    expect(await GithubRender.check(root, set)).toEqual({
      clean: true,
      entries: [{ path: "workflows/zeta.yml", status: "clean" }]
    })
  })

  it("refuses when a rendered file's directory is occupied by a regular file", async () => {
    const root = await temporaryRoot()
    await Fs.mkdir(NodePath.join(root, ".github"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, ".github/workflows"), "not a directory\n", "utf8")
    const failure = await asyncRefusal(() => GithubRender.write(root, rendered()))
    expect(failure.code).toBe("write_failed")
    expect(failure.message).toMatch(/workflows\/zeta\.yml could not be published: (EEXIST|ENOTDIR)/)
    expect(await Fs.readFile(NodePath.join(root, ".github/workflows"), "utf8")).toBe("not a directory\n")
  })

  it("writes without a write-set and leaves every unrendered file in place", async () => {
    const root = await temporaryRoot()
    const set: GithubRender.CiRender = { ...rendered(), changes: [] }
    await Fs.mkdir(NodePath.join(root, ".github"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, ".github/README.md"), "hand\n", "utf8")
    expect(await GithubRender.write(root, set)).toEqual({
      wrote: ["workflows/zeta.yml"],
      unchanged: [],
      removed: [],
      preserved: []
    })
    expect(await Fs.readFile(NodePath.join(root, ".github/README.md"), "utf8")).toBe("hand\n")
  })

  it("reports the text of a content source that fails without an Error", async () => {
    const root = await temporaryRoot()
    const failing: Iterable<string> = {
      [Symbol.iterator]: () => ({
        next: () => {
          throw "content source closed"
        }
      })
    }
    const set: GithubRender.CiRender = {
      ...rendered(),
      files: [{ path: "workflows/zeta.yml", content: failing as unknown as string }]
    }
    const failure = await asyncRefusal(() => GithubRender.write(root, set))
    expect(failure.code).toBe("write_failed")
    expect(failure.message).toContain("workflows/zeta.yml could not be published: content source closed")
    expect(await Fs.readdir(NodePath.join(root, ".github/workflows"))).toEqual([])
  })

  it("refuses when a stale generated file cannot be removed", async () => {
    const root = await temporaryRoot()
    const set: GithubRender.CiRender = { ...rendered(), changes: ["workflows/**"] }
    await GithubRender.write(root, set)
    const directory = NodePath.join(root, ".github/workflows")
    await Fs.writeFile(NodePath.join(directory, "old.yml"), "stale\n", "utf8")
    await Fs.chmod(directory, 0o555)
    try {
      const failure = await asyncRefusal(() => GithubRender.write(root, set))
      expect(failure.code).toBe("write_failed")
      expect(failure.message).toContain("stale generated file workflows/old.yml could not be removed: EACCES")
    } finally {
      await Fs.chmod(directory, 0o755)
    }
    expect(await Fs.readFile(NodePath.join(directory, "old.yml"), "utf8")).toBe("stale\n")
  })
})
