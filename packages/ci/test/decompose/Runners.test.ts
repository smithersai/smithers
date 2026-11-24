import { describe, expect, it } from "vitest"
import { bun, executorOf, type Invocation, npm, pnpm, recognize, turbo, yarn } from "../../src/decompose/Runners.vibe"

const split = (command: string): ReadonlyArray<string> => command.split(" ")

/** Reads a command at the repository root. */
const at = (command: string, cwd = "", wrappers: ReadonlyArray<string> = []): Invocation | undefined =>
  recognize(split(command), cwd, { wrappers, rootScripts: [] })

const rendered = (command: string, names: ReadonlyArray<string>): string | undefined =>
  at(command)?.render(names).join(" ")

const names = (...patterns: ReadonlyArray<string>) => ({
  kind: "patterns",
  patterns: patterns.map((name) => ({ name, directory: undefined }))
})

describe("turbo", () => {
  it("reads tasks, keeps the flags it knows, and limits a run with --filter", () => {
    const read = at("turbo run lint test --concurrency=4 --output-logs errors-only --continue")
    expect(read).toMatchObject({
      runner: "turbo",
      tasks: ["lint", "test"],
      selection: { kind: "all" },
      strict: false,
      args: []
    })
    expect(read?.render(["web"]).join(" ")).toBe(
      "turbo run lint test --concurrency=4 --output-logs errors-only --continue --filter=web"
    )
  })

  it("keeps the words a package manager runs it with", () => {
    for (const prefix of ["pnpm exec", "yarn exec", "bun x", "npx", "bunx"]) {
      expect(rendered(`${prefix} turbo run build`, ["a"]), prefix).toBe(`${prefix} turbo run build --filter=a`)
    }
  })

  it("reads the short form without run, and refuses Turborepo's own commands", () => {
    expect(rendered("turbo test", ["a"])).toBe("turbo test --filter=a")
    expect(rendered("pnpm exec turbo --filter=web build lint --concurrency=2", ["web"])).toBe(
      "pnpm exec turbo build lint --concurrency=2 --filter=web"
    )
    for (const command of ["turbo watch test", "turbo prune web", "turbo login", "turbo", "turbo --continue"]) {
      expect(at(command), command).toBeUndefined()
    }
  })

  it("reads turbo after a package manager alone, unless a root script is named turbo", () => {
    for (const manager of ["pnpm", "bun", "yarn"]) {
      expect(rendered(`${manager} turbo build`, ["a"]), manager).toBe(`${manager} turbo build --filter=a`)
      const scripted = recognize(split(`${manager} turbo build`), "", { wrappers: [], rootScripts: ["turbo"] })
      // The word is then a script's name, and for Bun without `run` it is nothing this reads.
      expect(scripted?.runner, manager).toBe(manager === "bun" ? undefined : manager)
    }
    expect(at("npm turbo build")).toBeUndefined()
  })

  it("reads filters as names and directories, and replaces them when it renders", () => {
    const read = at("turbo run build --filter=@acme/* -F ./apps/* --filter web")
    expect(read?.selection).toEqual({
      kind: "patterns",
      patterns: [
        { name: "@acme/*", directory: undefined },
        { name: undefined, directory: "apps/*" },
        { name: "web", directory: undefined }
      ]
    })
    expect(read?.render(["web"]).join(" ")).toBe("turbo run build --filter=web")
  })

  it("passes words after -- on to the tasks", () => {
    expect(at("turbo --continue dependencies-successful test")?.tasks).toEqual(["test"])
    const read = at("turbo run test --continue=always -- --coverage")
    expect(read?.args).toEqual(["--coverage"])
    expect(read?.render(["a"]).join(" ")).toBe("turbo run test --continue=always --filter=a -- --coverage")
    expect(recognize(["turbo", "run", "test", "--", "--path=${{ inputs.test_path }}"], "")).toBeUndefined()
  })

  it("refuses a run it cannot limit soundly", () => {
    const refused = [
      "turbo run",
      "turbo run build --affected",
      "turbo run build --dry",
      "turbo run build --only",
      "turbo run build --filter=...web",
      "turbo run build --filter=web...",
      "turbo run build --filter=[HEAD^1]",
      "turbo run build --filter=!web",
      "turbo run build --filter=.",
      "turbo run build --filter=../x",
      "turbo run build --filter",
      "turbo run build -- ../outside",
      "turbo run build -- /etc/passwd"
    ]
    for (const command of refused) expect(at(command), command).toBeUndefined()
  })

  it("is not read inside a package, where it runs that package only", () => {
    expect(at("turbo run build", "packages/a")).toBeUndefined()
    expect(turbo(["turbo"], ["prune"])).toBeUndefined()
  })

  it("reads a file the owner says stands for turbo, and keeps it in the command", () => {
    const wrappers = ["scripts/run-turbo.ts"]
    const read = at("bun scripts/run-turbo.ts run build --concurrency=4", "", wrappers)
    expect(read).toMatchObject({ runner: "turbo", tasks: ["build"], program: "scripts/run-turbo.ts" })
    expect(read?.render(["a"]).join(" ")).toBe("bun scripts/run-turbo.ts run build --concurrency=4 --filter=a")
    expect(at("./scripts/run-turbo.ts run build", "", wrappers)?.render(["a"]).join(" ")).toBe(
      "./scripts/run-turbo.ts run build --filter=a"
    )
    expect(at("node scripts/run-turbo.ts run build", "", wrappers)?.program).toBe("scripts/run-turbo.ts")
    // Not named by the owner, not at the root, or not a run: unknown.
    expect(at("bun scripts/run-turbo.ts run build")).toBeUndefined()
    expect(at("bun scripts/run-turbo.ts run build", "packages/a", wrappers)).toBeUndefined()
    expect(at("bun scripts/run-turbo.ts prune", "", wrappers)).toBeUndefined()
    expect(at("bun", "", wrappers)).toBeUndefined()
  })
})

describe("pnpm", () => {
  it("reads a recursive run and renders it for named packages", () => {
    const read = at("pnpm -r --if-present run test --coverage")
    expect(read).toMatchObject({ runner: "pnpm", tasks: ["test"], selection: { kind: "all" }, args: ["--coverage"] })
    expect(read?.render(["a", "b"]).join(" ")).toBe("pnpm --filter=a --filter=b --if-present run test --coverage")
    expect(at("pnpm --recursive test")?.selection).toEqual({ kind: "all" })
    expect(at("pnpm run -r --workspace-concurrency=1 --reporter append-only build")?.render(["a"]).join(" ")).toBe(
      "pnpm --filter=a --workspace-concurrency=1 --reporter append-only run build"
    )
  })

  it("reads filters before or after run", () => {
    expect(at("pnpm --filter @acme/web run build")?.selection).toEqual(names("@acme/web"))
    expect(at("pnpm run --filter=web -F ./apps/* build")?.selection).toEqual({
      kind: "patterns",
      patterns: [{ name: "web", directory: undefined }, { name: undefined, directory: "apps/*" }]
    })
    expect(at("pnpm --filter ./apps/web/ lint")?.selection).toEqual({
      kind: "patterns",
      patterns: [{ name: undefined, directory: "apps/web" }]
    })
  })

  it("reads a run in one directory: the step's, or the one -C names", () => {
    expect(at("pnpm run build", "packages/a")?.selection).toEqual({ kind: "directory", directory: "packages/a" })
    expect(at("pnpm test")?.selection).toEqual({ kind: "directory", directory: "" })
    expect(at("pnpm -C packages/a run build")?.selection).toEqual({ kind: "directory", directory: "packages/a" })
    expect(at("pnpm --dir=../b run build", "packages/a")?.selection).toEqual({
      kind: "directory",
      directory: "packages/b"
    })
    expect(at("pnpm --dir ./ run build", "packages/a")?.selection).toEqual({
      kind: "directory",
      directory: "packages/a"
    })
    expect(at("pnpm lint:check --fix")).toMatchObject({ tasks: ["lint:check"], args: ["--fix"] })
  })

  it("refuses its own commands, unknown flags and paths that leave", () => {
    const refused = [
      "pnpm",
      "pnpm install",
      "pnpm exec vitest",
      "pnpm run",
      "pnpm run --unknown build",
      "pnpm -w run build",
      "pnpm --include-workspace-root -r run build",
      "pnpm --filter ...web run build",
      "pnpm --filter {apps} run build",
      "pnpm -r -C packages/a run build",
      "pnpm -C /abs run build",
      "pnpm -C ~/x run build",
      "pnpm -C ../.. run build",
      "pnpm run test ../../other.test.ts",
      "pnpm run test /abs/file",
      "pnpm --filter"
    ]
    for (const command of refused) expect(at(command), command).toBeUndefined()
    // `run` names the script even when the script shares a pnpm command's name.
    expect(at("pnpm run install")?.tasks).toEqual(["install"])
    expect(pnpm(split("npm run build"), "")).toBeUndefined()
  })
})

describe("bun", () => {
  it("reads filters with or without the word run", () => {
    const read = at("bun run --filter * --if-present test")
    expect(read).toMatchObject({ runner: "bun", tasks: ["test"], strict: false, selection: names("*") })
    expect(read?.render(["a", "@x/b"]).join(" ")).toBe("bun run --if-present --filter a --filter @x/b test")
    expect(at("bun --filter=@acme/* -F ./apps/* build")?.selection).toEqual({
      kind: "patterns",
      patterns: [{ name: "@acme/*", directory: undefined }, { name: undefined, directory: "apps/*" }]
    })
  })

  it("reads --workspaces as every package, strict unless --if-present", () => {
    expect(at("bun run --workspaces test")).toMatchObject({ selection: { kind: "all" }, strict: true })
    expect(at("bun run --workspaces --if-present test")).toMatchObject({ selection: { kind: "all" }, strict: false })
  })

  it("reads a run in one directory", () => {
    expect(at("bun run --cwd packages/core test voice")).toMatchObject({
      tasks: ["test"],
      args: ["voice"],
      selection: { kind: "directory", directory: "packages/core" }
    })
    expect(at("bun --cwd=packages/core run --silent --elide-lines 0 test")?.selection).toEqual({
      kind: "directory",
      directory: "packages/core"
    })
    expect(at("bun run build", "packages/a")?.selection).toEqual({ kind: "directory", directory: "packages/a" })
  })

  it("refuses a file run, a test run, and mixed selections", () => {
    const refused = [
      "bun",
      "bun test",
      "bun scripts/build.ts",
      "bun run",
      "bun run --unknown test",
      "bun --filter a --cwd packages/a test",
      "bun run --workspaces --filter a test",
      "bun run --filter a... test",
      "bun run --cwd /abs test",
      "bun run test ../outside"
    ]
    for (const command of refused) expect(at(command), command).toBeUndefined()
    expect(bun(split("pnpm run build"), "")).toBeUndefined()
  })
})

describe("npm", () => {
  it("reads --workspaces as every package, strict unless --if-present", () => {
    const read = at("npm run test --workspaces")
    expect(read).toMatchObject({ runner: "npm", tasks: ["test"], selection: { kind: "all" }, strict: true })
    expect(read?.render(["a", "b"]).join(" ")).toBe("npm run test --workspace=a --workspace=b")
    const lenient = at("npm run build -ws --if-present --silent -- --watch=false")
    expect(lenient).toMatchObject({ strict: false, args: ["--watch=false"] })
    expect(lenient?.render(["a"]).join(" ")).toBe("npm run build --workspace=a --if-present --silent -- --watch=false")
  })

  it("reads --workspace values as a name or a directory", () => {
    expect(at("npm run build -w @acme/web --workspace=./packages/b/")?.selection).toEqual({
      kind: "patterns",
      patterns: [{ name: "@acme/web", directory: "@acme/web" }, { name: "./packages/b/", directory: "packages/b" }]
    })
  })

  it("reads npm test and a run in one directory", () => {
    expect(at("npm run test -w 'packages/*'")).toBeUndefined()
    expect(at("npm test")).toMatchObject({ tasks: ["test"], selection: { kind: "directory", directory: "" } })
    expect(at("npm test extra", "packages/a")).toMatchObject({
      args: ["extra"],
      selection: { directory: "packages/a" }
    })
    expect(at("npm --prefix packages/a run-script build one")).toMatchObject({
      tasks: ["build"],
      args: ["one"],
      selection: { kind: "directory", directory: "packages/a" }
    })
    expect(at("npm run build one -- two")?.render([]).join(" ")).toBe("npm run build -- one two")
  })

  it("refuses its other commands, unknown flags and mixed selections", () => {
    const refused = [
      "npm",
      "npm install",
      "npm run",
      "npm run build --include-workspace-root --workspaces",
      "npm run build --workspaces -w a",
      "npm run build --workspaces --prefix packages/a",
      "npm run build -w ../outside",
      "npm run build -- ../outside",
      "npm run build ../outside",
      "npm --prefix /abs run build"
    ]
    for (const command of refused) expect(at(command), command).toBeUndefined()
    expect(npm(split("pnpm run build"), "")).toBeUndefined()
  })
})

describe("yarn", () => {
  it("reads a script run in one directory or one named workspace", () => {
    expect(at("yarn build", "packages/a")).toMatchObject({
      runner: "yarn",
      tasks: ["build"],
      selection: { kind: "directory", directory: "packages/a" }
    })
    expect(at("yarn run test --ci")).toMatchObject({ tasks: ["test"], args: ["--ci"] })
    expect(at("yarn run install")?.tasks).toEqual(["install"])
    expect(at("yarn workspace @acme/web run build")?.selection).toEqual(names("@acme/web"))
    expect(at("yarn workspace @acme/web test")?.tasks).toEqual(["test"])
    expect(rendered("yarn workspace web build", ["ignored"])).toBe("yarn workspace web build")
  })

  it("refuses its own commands and the forms over many workspaces", () => {
    const refused = [
      "yarn",
      "yarn install",
      "yarn workspaces foreach -A run build",
      "yarn workspace",
      "yarn workspace web",
      "yarn --silent build",
      "yarn run",
      "yarn build ../outside",
      "yarn workspace web workspace"
    ]
    for (const command of refused) expect(at(command), command).toBeUndefined()
    expect(yarn(split("npm run build"), "")).toBeUndefined()
  })
})

describe("recognize", () => {
  it("reads nothing else as a script run", () => {
    for (const command of ["vitest run", "node scripts/build.js", "zig build test", "make test", "tsx x.ts"]) {
      expect(at(command), command).toBeUndefined()
    }
  })

  it("names the words that run a package's program for each package manager", () => {
    expect(executorOf).toEqual({ pnpm: ["pnpm", "exec"], bun: ["bunx"], npm: ["npx"], yarn: ["yarn", "exec"] })
  })
})
