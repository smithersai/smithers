import { describe, expect, it } from "vitest"
import type { Job, Step } from "../../src/contract/Inventory.ts"
import {
  decide,
  type Decision,
  everything,
  type Facts,
  followed,
  inputsOf,
  keepCommand,
  preceded,
  understand
} from "../../src/decompose/Plan.ts"
import { readConfig } from "../../src/decompose/Turbo.ts"
import {
  assemble,
  graph,
  type Manager,
  manifestMentions,
  type Mentions,
  scanner
} from "../../src/decompose/Workspace.ts"

const step = (command: string, extra: Partial<Step> = {}): Step => ({
  id: "ci.yml:test:1",
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

interface Repository {
  readonly manager?: Manager
  readonly root?: Record<string, unknown>
  readonly orchestrated?: boolean
  readonly turbo?: unknown
  readonly packageTurbo?: Readonly<Record<string, unknown>>
  readonly files: Readonly<Record<string, string>>
  readonly wrappers?: ReadonlyArray<string>
}

const manifest = (
  name: string,
  scripts: Record<string, string> = {},
  dependencies: ReadonlyArray<string> = []
): string =>
  JSON.stringify({
    name,
    scripts,
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "workspace:*"]))
  })

/** The facts of an in-memory repository: every `package.json` below the root is a package. */
const factsOf = (repository: Repository): Facts => {
  const manifests = Object.entries(repository.files).filter(([file]) => file.endsWith("/package.json")).map((
    [file, text]
  ) => [file.slice(0, -"/package.json".length), text] as const)
  const workspace = assemble(
    repository.manager ?? "pnpm",
    repository.root ?? { name: "root" },
    repository.orchestrated ?? false,
    manifests
  )
  if (workspace === undefined) throw new Error("the test repository has no workspace")
  const scan = scanner(workspace)
  const none: Mentions = { names: [], relative: [], rooted: [] }
  const files = new Set(["package.json", ...Object.keys(repository.files)])
  return {
    workspace,
    graph: graph(workspace, files, (file) => {
      const text = repository.files[file]
      if (text === undefined) return none
      return file.endsWith("package.json") ? manifestMentions(scan, text) : scan(text, false)
    }),
    turbo: repository.turbo === undefined
      ? undefined
      : readConfig(
        JSON.stringify(repository.turbo),
        Object.entries(repository.packageTurbo ?? {}).map(([name, own]) => [name, JSON.stringify(own)])
      )
  }
}

const plan = (
  repository: Repository,
  command: string,
  extra: Partial<Step> = {}
): Decision => {
  const facts = factsOf(repository)
  const subject = step(command, extra)
  const understood = understand(subject, facts.workspace, repository.wrappers)
  return understood === undefined ? { kind: "whole" } : decide(subject, understood, facts)
}

/** The parts of a split decision, by package name. */
const parts = (decision: Decision): Readonly<Record<string, { command: string; inputs: ReadonlyArray<string> }>> => {
  if (decision.kind !== "split") throw new Error(`expected a split, got ${decision.kind}`)
  return Object.fromEntries(decision.parts.map((part) => [part.name, { command: part.command, inputs: part.inputs }]))
}

const scoped = (decision: Decision): ReadonlyArray<string> => {
  if (decision.kind !== "scope") throw new Error(`expected a scope, got ${decision.kind}`)
  return decision.inputs
}

const whole: Decision = { kind: "whole" }

/** Three packages: `app` depends on `lib`, `lone` on nothing; `docs` has no test. */
const plain: Repository = {
  files: {
    "pnpm-lock.yaml": "",
    "tsconfig.base.json": "{}",
    "scripts/check.mjs": "",
    "packages/app/package.json": manifest("app", { test: "vitest run", build: "tsc" }, ["lib"]),
    "packages/app/src/index.ts": `import "lib"`,
    "packages/lib/package.json": manifest("lib", { test: "vitest run", build: "tsc" }),
    "packages/lone/package.json": manifest("lone", { test: "node --test" }),
    "packages/docs/package.json": manifest("docs", { build: "mkdocs" })
  }
}

const outside = ["*", "packages/*", "scripts/**"]

describe("understand", () => {
  const workspace = factsOf(plain).workspace

  it("finds the script runs and Zig build steps of a step", () => {
    const found = understand(step("set -euo pipefail\npnpm -r run test\nzig build test && zig build"), workspace)
    expect(found?.runs.map((run) => run.invocation.tasks)).toEqual([["test"]])
    expect(found?.zig).toEqual(["install", "test"])
  })

  it("gives where a run can be replaced, and not when it is piped, conditional, nested or in the background", () => {
    const place = (command: string) => understand(step(command), workspace)?.runs[0]?.replace
    expect(place("set -e\npnpm -r run test")).toEqual([7, 23])
    expect(place("pnpm -r run test | tee out.log")).toBeUndefined()
    expect(place("echo start | pnpm -r run test")).toBeUndefined()
    expect(place("pnpm -r run test &\nwait")).toBeUndefined()
    expect(place(`if [ -n "$CI" ]; then pnpm -r run test; fi`)).toBeUndefined()
    expect(place("bash -eo pipefail -c 'pnpm -r run test'")).toBeUndefined()
    expect(place("pnpm -r run test 2>&1 --coverage")).toBeUndefined()
  })

  it("reads through commands that read no file", () => {
    const inert = [
      "set -euo pipefail",
      "set -e -o pipefail +x",
      "status=0",
      "export CI=1 NODE_ENV",
      ":",
      "true",
      "echo \"$GITHUB_SHA\" >> \"$GITHUB_OUTPUT\"",
      "printf '%s\\n' hi",
      "[ -n \"$CI\" ]",
      "[[ \"$A\" == b ]]",
      "test \"$A\" -eq 1",
      "wait \"$pid\"",
      "exit \"$status\"",
      "exit"
    ]
    for (const command of inert) {
      expect(understand(step(`${command}\npnpm -r run test`), workspace)?.runs.length, command).toBe(1)
    }
  })

  it("refuses a step with a command it does not know", () => {
    const refused = [
      "node scripts/check.mjs",
      "set -- a b",
      "exit 1 2",
      "export $(cat .env)",
      "export A=1 -p",
      "[ -f package.json ]",
      "test -d node_modules",
      "[ a -nt b ]",
      "tee out.log",
      "pnpm -r run test | cat",
      "pnpm -r run test \"$EXTRA\"",
      "CI=\"$CI\" pnpm -r run test",
      "bash script.sh",
      "bash -c \"$SCRIPT\"",
      "bash -c 'node x.js'",
      "bash -c 'echo $('",
      "bash --login -c 'pnpm -r run test'",
      "bash -c 'pnpm -r run test' extra",
      "zig build test -Doptimize=ReleaseFast",
      "zig build --release",
      "zig test src/main.zig",
      "echo only inert commands"
    ]
    for (const command of refused) expect(understand(step(command), workspace), command).toBeUndefined()
    expect(understand(step("echo $("), workspace)).toBeUndefined()
  })

  it("follows cd, and refuses one it cannot follow", () => {
    const directory = (command: string, cwd = "") => {
      const selection = understand(step(command, { cwd }), workspace)?.runs[0]?.invocation.selection
      return selection?.kind === "directory" ? selection.directory : selection?.kind
    }
    expect(directory("cd packages/app && pnpm run test")).toBe("packages/app")
    expect(directory("cd packages\ncd ./app; pnpm run test")).toBe("packages/app")
    expect(directory("cd .. && pnpm run test", "packages/app")).toBe("packages")
    expect(directory("pnpm run test", "./packages/lib/")).toBe("packages/lib")
    expect(directory("bash -c 'cd packages/app && pnpm run test'\npnpm --filter lib run build", "")).toBe(
      "packages/app"
    )
    for (
      const command of [
        "cd \"$DIR\" && pnpm run test",
        "cd packages/app || pnpm run test",
        "cd packages/app || echo failed\npnpm run test",
        "cd packages/app | pnpm run test",
        "cd packages/app &\npnpm run test",
        "cd /tmp && pnpm run test",
        "cd ~ && pnpm run test",
        "cd - && pnpm run test",
        "cd ../.. && pnpm run test",
        "cd a b && pnpm run test",
        "cd && pnpm run test",
        `if [ -n "$A" ]; then cd packages/app; fi\npnpm run test`
      ]
    ) expect(understand(step(command), workspace), command).toBeUndefined()
  })

  it("leaves the inner directory of a nested shell inside it", () => {
    const found = understand(step("bash -c 'cd packages/app'\npnpm run test", { cwd: "packages/lib" }), workspace)
    expect(found?.runs[0]?.invocation.selection).toEqual({ kind: "directory", directory: "packages/lib" })
  })

  it("reads a run over many packages and a Zig build only at the root", () => {
    expect(understand(step("pnpm -r run test", { cwd: "packages" }), workspace)).toBeUndefined()
    expect(understand(step("zig build test", { cwd: "native" }), workspace)).toBeUndefined()
    expect(understand(step("zig build test"), undefined)).toEqual({ runs: [], zig: ["test"] })
  })

  it("refuses a step whose directory or command still holds an expression, or leaves the repository", () => {
    expect(understand(step("pnpm run test", { cwd: "${{ matrix.dir }}" }), workspace)).toBeUndefined()
    expect(understand(step("pnpm --filter ${{ matrix.package }} run test"), workspace)).toBeUndefined()
    expect(understand(step("pnpm run test", { cwd: "../elsewhere" }), workspace)).toBeUndefined()
    expect(understand(step("pnpm run test", { cwd: "/abs" }), workspace)).toBeUndefined()
  })

  it("refuses a step that gives a package manager a setting through a variable", () => {
    expect(understand(step("pnpm -r run test", { env: { npm_config_workspaces: "true" } }), workspace)).toBeUndefined()
    expect(understand(step("pnpm -r run test", { env: { NPM_CONFIG_FILTER: "a" } }), workspace)).toBeUndefined()
    expect(understand(step("pnpm_config_filter=app pnpm -r run test"), workspace)).toBeUndefined()
    expect(understand(step("export npm_config_include_workspace_root=true\npnpm -r run test"), workspace))
      .toBeUndefined()
    expect(
      understand(step("export CI=1\nnpm_package_x=1 pnpm -r run test", { env: { CI: "true" } }), workspace)?.runs.length
    ).toBe(1)
  })

  it("refuses a script run when the repository has no workspace", () => {
    expect(understand(step("pnpm -r run test"), undefined)).toBeUndefined()
  })
})

describe("understand: a root script", () => {
  const withRoot = (scripts: Record<string, string>, manager: Manager = "pnpm") =>
    factsOf({ ...plain, manager, root: { name: "root", scripts } }).workspace
  const found = (command: string, scripts: Record<string, string>, manager: Manager = "pnpm") =>
    understand(step(command), withRoot(scripts, manager))?.runs[0]

  it("follows a root script to the one command it runs", () => {
    const run = found("pnpm run test", { test: "pnpm -r run test" })
    expect(run?.invocation.selection).toEqual({ kind: "all" })
    expect(run?.replace).toEqual([0, 13])
    expect(run?.before).toBe("")
  })

  it("puts turbo behind the package manager's own runner, and keeps the script's variables", () => {
    for (
      const [manager, words] of [["pnpm", "pnpm exec turbo"], ["bun", "bunx turbo"], ["npm", "npx turbo"], [
        "yarn",
        "yarn exec turbo"
      ]] as const
    ) {
      const run = found(`${manager} run check`, {
        check: "NODE_OPTIONS='--max-old-space-size=8192' CI=1 turbo run typecheck"
      }, manager)
      expect(run?.invocation.render(["app"]).join(" "), manager).toBe(`${words} run typecheck --filter=app`)
      expect(run?.before).toBe("NODE_OPTIONS=--max-old-space-size=8192 CI=1 ")
    }
  })

  it("adds the words a step passes on to the root script's command", () => {
    const lint = { lint: "turbo run lint --continue -- --cache" }
    expect(found("pnpm lint --cache-strategy content", lint)?.invocation.render(["app"]).join(" ")).toBe(
      "pnpm exec turbo run lint --continue --filter=app -- --cache --cache-strategy content"
    )
    expect(found("npm run lint -- --fix", lint, "npm")?.invocation.args).toEqual(["--cache", "--fix"])
    // Through a second root script, the words go on with it.
    const run = found("pnpm test --bail", { test: "pnpm run test:all --silent", "test:all": "pnpm -r run test" })
    expect(run?.invocation.args).toEqual(["--silent", "--bail"])
    // A word that would change which packages run makes the command unknown.
    expect(found("pnpm lint --affected", { lint: "turbo run lint" })).toBeUndefined()
  })

  it("reads turbo after the package manager alone when no root script takes the name", () => {
    expect(found("pnpm turbo build", {})?.invocation.runner).toBe("turbo")
    expect(found("pnpm turbo build", { turbo: "pnpm -r run test" })?.invocation.runner).toBe("pnpm")
  })

  it("follows a script that runs another root script", () => {
    const run = found("pnpm test", { test: "A=1 pnpm run test:all", "test:all": "B='x y' pnpm -r run test" })
    expect(run?.invocation.selection).toEqual({ kind: "all" })
    expect(run?.before).toBe("A=1 B='x y' ")
  })

  it("refuses a root script it cannot stand in for", () => {
    const refused: ReadonlyArray<readonly [string, Record<string, string>]> = [
      ["pnpm run missing", {}],
      ["pnpm run test", { test: "pnpm -r run test && pnpm run lint" }],
      ["pnpm run test", { test: "pnpm -r run test > out.log" }],
      ["pnpm run test", { test: "pnpm -r run test", pretest: "node gen.js" }],
      ["pnpm run test", { test: "pnpm -r run test", posttest: "node clean.js" }],
      ["pnpm run test", { test: "pnpm -r run test &" }],
      ["pnpm run test", { test: "pnpm -r run $TASK" }],
      ["pnpm run test", { test: "CI=$CI pnpm -r run test" }],
      ["pnpm run test", { test: "vitest run" }],
      ["pnpm run test", { test: "echo $(" }],
      ["pnpm run test", { test: "" }],
      ["pnpm run test ../outside", { test: "pnpm -r run test" }],
      ["pnpm run test", { test: "pnpm -C packages/app run test" }],
      ["pnpm run a", { a: "pnpm run b", b: "pnpm run a" }],
      ["pnpm run a", { a: "pnpm run missing" }]
    ]
    for (const [command, scripts] of refused) expect(found(command, scripts), JSON.stringify(scripts)).toBeUndefined()
  })
})

describe("decide: pnpm, Bun and npm", () => {
  it("splits a recursive run into one part per package that has the script", () => {
    const decided = parts(plan(plain, "set -e\npnpm -r run test"))
    expect(Object.keys(decided)).toEqual(["app", "lib", "lone"])
    // app's command also runs lib's test: nothing says a test does not need its dependencies' test.
    expect(decided["app"]?.command).toBe("set -e\npnpm --filter=app --filter=lib run test")
    expect(decided["lib"]?.command).toBe("set -e\npnpm --filter=lib run test")
    expect(decided["app"]?.inputs).toEqual([...outside, "packages/app/**", "packages/lib/**"].sort())
    expect(decided["lib"]?.inputs).toEqual([...outside, "packages/lib/**"].sort())
    expect(decided["lone"]?.inputs).toEqual([...outside, "packages/lone/**"].sort())
  })

  it("runs each package's dependencies once, through a cycle", () => {
    const cyclic: Repository = {
      files: {
        "packages/x/package.json": manifest("x", { test: "t" }, ["y", "z"]),
        "packages/y/package.json": manifest("y", { test: "t" }, ["x", "z"]),
        "packages/z/package.json": manifest("z", { test: "t" })
      }
    }
    const decided = parts(plan(cyclic, "pnpm -r run test"))
    expect(decided["x"]?.command).toBe("pnpm --filter=x --filter=y --filter=z run test")
    expect(decided["y"]?.command).toBe("pnpm --filter=x --filter=y --filter=z run test")
    expect(decided["z"]?.command).toBe("pnpm --filter=z run test")
    expect(decided["x"]?.inputs).toEqual(["*", "packages/*", "packages/x/**", "packages/y/**", "packages/z/**"])
  })

  it("limits a run to the packages its filters select", () => {
    expect(Object.keys(parts(plan(plain, "pnpm --filter 'l*' run test")))).toEqual(["lib", "lone"])
    expect(Object.keys(parts(plan(plain, "pnpm --filter './**' run test")))).toEqual(["app", "lib", "lone"])
    expect(Object.keys(parts(plan(plain, "pnpm --filter './packages/*' --filter app run test")))).toEqual([
      "app",
      "lib",
      "lone"
    ])
    // A dependency outside the selection is not run.
    expect(parts(plan(plain, "pnpm --filter app --filter lone run test"))["app"]?.command).toBe(
      "pnpm --filter=app run test"
    )
  })

  it("keeps the command of a step that runs one package, and names its inputs", () => {
    const expected = [...outside, "packages/app/**", "packages/lib/**"].sort()
    expect(scoped(plan(plain, "pnpm --filter app run test"))).toEqual(expected)
    expect(scoped(plan(plain, "pnpm run test", { cwd: "packages/app" }))).toEqual(expected)
    expect(scoped(plan(plain, "set -euo pipefail\npnpm -C packages/app run test 2>&1 | tee \"$LOG\""))).toEqual(
      expected
    )
    // One package has the script: the command already does what a split would.
    const one = {
      ...plain,
      files: { ...plain.files, "packages/docs/package.json": manifest("docs", { publish: "mkdocs gh-deploy" }) }
    }
    expect(scoped(plan(one, "pnpm -r run publish"))).toEqual([...outside, "packages/docs/**"].sort())
  })

  it("gives one step the union of its runs when it cannot replace them", () => {
    expect(scoped(plan(plain, "pnpm -r run test | tee out.log"))).toEqual(
      [...outside, "packages/app/**", "packages/lib/**", "packages/lone/**"].sort()
    )
    expect(scoped(plan(plain, "pnpm --filter lib run test && pnpm --filter lone run test"))).toEqual(
      [...outside, "packages/lib/**", "packages/lone/**"].sort()
    )
  })

  it("leaves a step whole when the run cannot be resolved", () => {
    expect(plan(plain, "pnpm -r run missing")).toEqual(whole)
    expect(plan(plain, "pnpm --filter nothing run test")).toEqual(whole)
    expect(plan(plain, "pnpm run test", { cwd: "packages" })).toEqual(whole)
    expect(plan(plain, "pnpm run test", { cwd: "packages/app/src" })).toEqual(whole)
    // The package manager's own settings choose packages: pnpm and npm runs stay whole, Bun's do not read them.
    expect(plan({ ...plain, orchestrated: true }, "pnpm -r run test")).toEqual(whole)
    expect(plan({ ...plain, orchestrated: true }, "pnpm --filter app run test")).toEqual(whole)
    expect(plan({ ...plain, orchestrated: true, manager: "npm" }, "npm run test --workspaces --if-present")).toEqual(
      whole
    )
    expect(plan({ ...plain, orchestrated: true, manager: "bun" }, "bun run --filter '*' test").kind).toBe("split")
    // The filter matches the root package, which has the script: the root would run too.
    const rooted = { ...plain, root: { name: "root", scripts: { test: "echo root" } } }
    expect(plan(rooted, "pnpm --filter '*' run test")).toEqual(whole)
    expect(plan(rooted, "pnpm --filter 'r*' --filter app run test")).toEqual(whole)
    expect(Object.keys(parts(plan(rooted, "pnpm -r run test")))).toEqual(["app", "lib", "lone"])
    expect(plan({ ...rooted, root: { scripts: { test: "x" } } }, "pnpm --filter '*' run test")).toEqual(whole)
  })

  it("splits a Bun filter run, and refuses one that may include the root", () => {
    const bun: Repository = { ...plain, manager: "bun" }
    expect(parts(plan(bun, "bun run --filter '*' test"))["app"]?.command).toBe("bun run --filter app --filter lib test")
    expect(Object.keys(parts(plan(bun, "bun run --workspaces --if-present test")))).toEqual(["app", "lib", "lone"])
    // Without --if-present a package without the script fails the run.
    expect(plan(bun, "bun run --workspaces test")).toEqual(whole)
    const rooted = { ...bun, root: { name: "root", scripts: { test: "echo root" } } }
    expect(plan(rooted, "bun run --workspaces --if-present test")).toEqual(whole)
    expect(plan(rooted, "bun run --filter '*' test")).toEqual(whole)
    expect(Object.keys(parts(plan(rooted, "bun run --filter 'l*' test")))).toEqual(["lib", "lone"])
  })

  it("splits an npm workspaces run, by name or by directory", () => {
    const npm: Repository = { ...plain, manager: "npm" }
    expect(parts(plan(npm, "npm run test --workspaces --if-present"))["app"]?.command).toBe(
      "npm run test --workspace=app --workspace=lib --if-present"
    )
    expect(plan(npm, "npm run test --workspaces")).toEqual(whole)
    expect(Object.keys(parts(plan(npm, "npm run test -w lib -w ./packages/lone")))).toEqual(["lib", "lone"])
    // npm never runs the root's script with its workspaces.
    const rooted = { ...npm, root: { name: "root", scripts: { test: "echo root" } } }
    expect(Object.keys(parts(plan(rooted, "npm run test --workspaces --if-present")))).toEqual(["app", "lib", "lone"])
  })

  it("scopes a Yarn run of one workspace", () => {
    expect(scoped(plan({ ...plain, manager: "yarn" }, "yarn workspace lone test"))).toEqual(
      [...outside, "packages/lone/**"].sort()
    )
  })

  it("splits through a root script", () => {
    const rooted = { ...plain, root: { name: "root", scripts: { "test:all": "CI=1 pnpm -r run test" } } }
    expect(parts(plan(rooted, "set -e\npnpm run test:all"))["lone"]?.command).toBe(
      "set -e\nCI=1 pnpm --filter=lone run test"
    )
  })

  it("reads everything when a script that runs reaches beyond its package", () => {
    const wide = (script: string) => ({
      ...plain,
      files: { ...plain.files, "packages/lone/package.json": manifest("lone", { test: script }) }
    })
    for (
      const script of [
        "turbo run build && vitest",
        "git diff --name-only | xargs eslint",
        "pnpm --filter app build && vitest",
        "pnpm -r build",
        "npm run build --workspaces",
        "yarn workspaces foreach run build",
        "cat $(ls)",
        "cat `ls`",
        "cp $INIT_CWD/x .",
        "ls ~/x",
        "nx run-many -t build"
      ]
    ) expect(parts(plan(wide(script), "pnpm -r run test"))["lone"]?.inputs, script).toEqual([everything])
    // A flag of another program is not a package manager's.
    for (const script of ["rm -r dist && vitest", "tsc -w false", "cp -r a b"]) {
      expect(parts(plan(wide(script), "pnpm -r run test"))["lone"]?.inputs, script).not.toEqual([everything])
    }
  })

  it("follows a script's hooks and the scripts it names", () => {
    const hooked = (scripts: Record<string, string>) => ({
      ...plain,
      files: { ...plain.files, "packages/lone/package.json": manifest("lone", scripts) }
    })
    const inputs = (scripts: Record<string, string>) => parts(plan(hooked(scripts), "pnpm -r run test"))["lone"]?.inputs
    expect(inputs({ test: "vitest", pretest: "git status" })).toEqual([everything])
    expect(inputs({ test: "vitest", posttest: "turbo run clean" })).toEqual([everything])
    expect(inputs({ test: "pnpm run unit", unit: "vitest && pnpm run deep", deep: "git log" })).toEqual([everything])
    expect(inputs({ test: "pnpm run test", unrelated: "git log" })).not.toEqual([everything])
    // app's command runs lib's test too.
    const viaDependency = {
      ...plain,
      files: { ...plain.files, "packages/lib/package.json": manifest("lib", { test: "git ls-files | xargs cat" }) }
    }
    expect(parts(plan(viaDependency, "pnpm -r run test"))["app"]?.inputs).toEqual([everything])
  })
})

describe("decide: Turborepo", () => {
  const turbo: Repository = {
    ...plain,
    root: { name: "root", scripts: { test: "turbo run test" } },
    turbo: {
      globalDependencies: ["tsconfig.base.json", "!ignored.json", "packages/lone/shared.json"],
      tasks: {
        build: { dependsOn: ["^build"], inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/packages/docs/theme.css"] },
        test: { dependsOn: ["build"] },
        lint: {}
      }
    }
  }

  it("splits a run into one part per package with work, and lets Turborepo run what the task depends on", () => {
    const decided = parts(plan(turbo, "pnpm exec turbo run test --concurrency=2"))
    // docs has no test script and still has work: test depends on its build.
    expect(Object.keys(decided)).toEqual(["app", "lib", "lone", "docs"])
    expect(decided["app"]?.command).toBe("pnpm exec turbo run test --concurrency=2 --filter=app")
    const global = [...outside, "tsconfig.base.json"]
    // app's build and lib's build run, and build reads the theme file by declaration.
    expect(decided["app"]?.inputs).toEqual(
      [...global, "packages/app/**", "packages/docs/theme.css", "packages/lib/**", "packages/lone/shared.json"].sort()
    )
    // lone has no build script, so nothing reads the theme file there.
    expect(decided["lone"]?.inputs).toEqual([...global, "packages/lone/**"].sort())
    expect(decided["docs"]?.inputs).toEqual([...global, "packages/docs/**", "packages/lone/shared.json"].sort())
  })

  it("splits through a root script, behind the package manager's runner", () => {
    expect(parts(plan(turbo, "pnpm test"))["lib"]?.command).toBe("pnpm exec turbo run test --filter=lib")
  })

  it("gives no part to a package the task has no work for", () => {
    // No package has a lint script: nothing to split.
    expect(plan(turbo, "pnpm exec turbo run lint")).toEqual(whole)
    const linted = {
      ...turbo,
      files: {
        ...turbo.files,
        "packages/lone/package.json": manifest("lone", { test: "node --test", lint: "eslint ." })
      }
    }
    // One package has work: the command already does what a split would.
    expect(scoped(plan(linted, "pnpm exec turbo run lint"))).toEqual(
      [...outside, "packages/lone/**", "tsconfig.base.json"].sort()
    )
    expect(Object.keys(parts(plan(linted, "pnpm exec turbo run lint test")))).toEqual(["app", "lib", "lone", "docs"])
  })

  it("leaves the step whole without a readable configuration, a defined task, or a root task it models", () => {
    expect(plan({ ...turbo, turbo: undefined }, "pnpm exec turbo run test")).toEqual(whole)
    expect(plan(turbo, "pnpm exec turbo run deploy")).toEqual(whole)
    expect(plan({ ...turbo, turbo: { tasks: { test: {}, "//#test": {} } } }, "pnpm exec turbo run test")).toEqual(whole)
    expect(plan(turbo, "pnpm exec turbo run test --filter=nothing")).toEqual(whole)
  })

  it("reads everything when a task of the root package runs first, or a script reaches wide", () => {
    const rootFirst = { ...turbo, turbo: { tasks: { test: { dependsOn: ["//#codegen"] }, "//#codegen": {} } } }
    expect(parts(plan(rootFirst, "pnpm exec turbo run test"))["lone"]?.inputs).toEqual([everything])
    const wide = {
      ...turbo,
      files: {
        ...turbo.files,
        "packages/lib/package.json": manifest("lib", { test: "vitest", build: "git describe && tsc" })
      }
    }
    const decided = parts(plan(wide, "pnpm exec turbo run test"))
    expect(decided["app"]?.inputs).toEqual([everything])
    expect(decided["lone"]?.inputs).not.toEqual([everything])
  })

  it("reads a wrapper the owner names as turbo, with the wrapper's file and what it mentions", () => {
    const wrapped: Repository = {
      ...turbo,
      wrappers: ["packages/tools/run-turbo.ts"],
      files: {
        ...turbo.files,
        "packages/tools/package.json": manifest("tools", {}, ["app"]),
        "packages/tools/run-turbo.ts": `import "./lockfile.ts"`,
        "packages/tools/lockfile.ts": ``,
        "packages/tools/unrelated.ts": ``
      }
    }
    const decided = parts(plan(wrapped, "bun packages/tools/run-turbo.ts run test"))
    expect(decided["lone"]?.command).toBe("bun packages/tools/run-turbo.ts run test --filter=lone")
    expect(decided["lone"]?.inputs).toEqual(
      [
        ...outside,
        "packages/lone/**",
        "packages/tools/lockfile.ts",
        "packages/tools/run-turbo.ts",
        "tsconfig.base.json"
      ]
        .sort()
    )
    expect(plan({ ...wrapped, wrappers: [] }, "bun packages/tools/run-turbo.ts run test")).toEqual(whole)
  })
})

describe("decide: Zig", () => {
  const none: Repository = { files: {} }

  it("never holds a step that runs a Zig build to a list of files", () => {
    // Zig's tests write where they start, so the step runs in the open: the splitter gives it Zig's caches instead.
    expect(plan(none, `if [ -n "" ]; then zig build test -Dtest-filter=""; else zig build test; fi`)).toEqual(whole)
    expect(plan(none, "zig build test && zig build bench")).toEqual(whole)
    expect(plan(plain, "zig build test && pnpm --filter lone run test")).toEqual(whole)
    expect(decide(step("zig build test"), { runs: [], zig: ["test"] }, undefined)).toEqual(whole)
    expect(decide(step("zig build test"), { runs: [], zig: ["test"] }, factsOf(plain))).toEqual(whole)
    // A step nothing was read from reads nothing anyone knows of.
    expect(decide(step("true"), { runs: [], zig: [] }, factsOf(plain))).toEqual(whole)
  })

  it("reads everything when a step's one package does", () => {
    const wide = {
      ...plain,
      files: { ...plain.files, "packages/lone/package.json": manifest("lone", { test: "git log" }) }
    }
    expect(scoped(plan(wide, "pnpm --filter lone run test"))).toEqual([everything])
    expect(scoped(plan(plain, "pnpm --filter lone run test"))).toEqual([...outside, "packages/lone/**"].sort())
  })

  it("decides without a workspace: a script run stays whole", () => {
    const understood = understand(step("pnpm -r run test"), factsOf(plain).workspace)
    expect(understood === undefined ? undefined : decide(step("pnpm -r run test"), understood, undefined)).toEqual(
      whole
    )
  })
})

describe("followed, preceded and keepCommand", () => {
  const job = (id: string, steps: ReadonlyArray<Step>, extra: Partial<Job> = {}): Job => ({
    id,
    source: "github-actions",
    file: ".github/workflows/ci.yml",
    name: id,
    needs: [],
    triggers: ["push"],
    matrix: [],
    steps,
    unsupported: [],
    ...extra
  })
  const named = (id: string): Step => step("true", { id })

  it("finds every step but a job's last", () => {
    const found = followed([
      job("one", [named("a"), named("b"), named("c")]),
      job("two", [named("only")]),
      job("empty", [])
    ])
    expect([...found].map((each) => each.id)).toEqual(["a", "b"])
  })

  it("finds the last step of a job that another job follows in the same working tree", () => {
    const recipes = followed([
      job("build", [named("build")], { source: "justfile" }),
      job("test", [named("test")], { source: "justfile", needs: ["build"] })
    ])
    expect([...recipes].map((each) => each.id)).toEqual(["build"])
    // GitHub jobs run on separate machines: a need only orders them.
    const hosted = followed([job("build", [named("build")]), job("lint", [named("lint")], { needs: ["build"] })])
    expect([...hosted]).toEqual([])
    // Recipes of one file run in the order listed even when none needs another: all but the last are followed.
    const listed = [
      job("tidy", [named("tidy")], { source: "justfile", file: "justfile" }),
      job("test", [named("test")], { source: "justfile", file: "justfile" }),
      job("other", [named("other")], { source: "makefile", file: "Makefile" })
    ]
    expect([...followed(listed)].map((each) => each.id)).toEqual(["tidy"])
    expect([...preceded(listed)].map((each) => each.id)).toEqual(["test"])
  })

  it("finds every step that follows another in one working tree", () => {
    const found = preceded([
      job("one", [named("a"), named("b"), named("c")]),
      job("two", [named("only")]),
      job("empty", [])
    ])
    expect([...found].map((each) => each.id)).toEqual(["b", "c"])
    // Recipes share a tree: every step of a recipe that needs another follows it.
    const recipes = preceded([
      job("build", [named("build")], { source: "justfile" }),
      job("test", [named("test"), named("report")], { source: "justfile", needs: ["build"] })
    ])
    expect([...recipes].map((each) => each.id)).toEqual(["test", "report"])
    // GitHub jobs run on separate machines: a needed job leaves no file behind.
    const hosted = preceded([job("build", [named("build")]), job("lint", [named("lint")], { needs: ["build"] })])
    expect([...hosted]).toEqual([])
  })

  it("keeps a step's command by leaving nothing to replace", () => {
    const facts = factsOf(plain)
    const subject = step("pnpm -r run test")
    const understood = understand(subject, facts.workspace)
    if (understood === undefined) throw new Error("the step was not understood")
    expect(understood.runs[0]?.replace).toEqual([0, 16])
    const kept = keepCommand(understood)
    expect(kept.runs[0]?.replace).toBeUndefined()
    expect(decide(subject, understood, facts).kind).toBe("split")
    expect(scoped(decide(subject, kept, facts))).toEqual(
      [...outside, "packages/app/**", "packages/lib/**", "packages/lone/**"].sort()
    )
  })
})

describe("inputsOf", () => {
  it("drops what a reached directory already covers", () => {
    const reach = {
      packages: new Set(["packages/cloud", "packages/cloud/api"]),
      files: new Set(["packages/cloud/x.ts", "packages/b/y.ts"])
    }
    expect(inputsOf(["*", "packages/*", "docs/**"], [reach], ["docs/guide.md", "extra/*.json"])).toEqual([
      "*",
      "docs/**",
      "extra/*.json",
      "packages/*",
      "packages/b/y.ts",
      "packages/cloud/**"
    ])
  })

  it("reads everything when a path cannot be written as a glob", () => {
    const reach = (path: string) => ({ packages: new Set<string>(), files: new Set([path]) })
    for (const path of ["app/[id]/page.tsx", "a/*.ts", "a/b?.ts", "a/{b}.ts", "a\\b", "a/+(b)", "!a", "#a"]) {
      expect(inputsOf(["*"], [reach(path)], []), path).toEqual([everything])
    }
    expect(inputsOf(["*"], [{ packages: new Set(["packages/[x]"]), files: new Set() }], [])).toEqual([everything])
    expect(inputsOf(["*"], [reach("packages/@scope/a+b/(group)/x.ts")], [])).toEqual([
      "*",
      "packages/@scope/a+b/(group)/x.ts"
    ])
  })
})
