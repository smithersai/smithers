/**
 * `smithers-ci` as a stranger gets it: the packed tarball, run by `npx` and by
 * `bunx` in a clean directory, with no workspace around it.
 *
 * The first-party packages come from the release tarballs through a loopback
 * registry, so this proves a version before it is on npm. Everything else comes
 * from the public registry, as it does for a stranger.
 *
 * usage: pnpm exec smthrs build '//packages/...:lib'
 *        node packages/ci/test/package/tarball.e2e.mjs [pack-directory]
 *
 * With no directory it packs the release set from the built packages. The
 * release workflow passes the directory it has already packed and smoke-tested.
 */
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { releaseRegistry } from "../../../../.smithers/flows/release/release-registry.mjs"

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url))

const packRelease = () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-ci-packs-"))
  execFileSync(process.execPath, [".smithers/flows/release/pack-release.mjs", directory, "--built"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "inherit"]
  })
  return directory
}

const given = process.argv[2]
const packs = given === undefined ? packRelease() : resolve(given)
const entries = JSON.parse(readFileSync(join(packs, "manifest.json"), "utf8"))
const packed = entries.find((entry) => entry.name === "smithers-ci")
const tarball = join(packs, packed.filename)

/** Installing the whole release takes minutes on a loaded machine. */
const commandLimitMs = 15 * 60 * 1000

const onPath = (name) => {
  const found = spawnSync("which", [name], { encoding: "utf8" }).stdout.trim()
  assert.notEqual(found, "", `${name} must be installed to run this test`)
  return realpathSync(found)
}

/** A directory holding only the named programs, so one runtime can be left off the path. */
const toolDirectory = (root, tools) => {
  const directory = join(root, "tools")
  mkdirSync(directory, { recursive: true })
  for (const [name, target] of Object.entries(tools)) symlinkSync(target, join(directory, name))
  return directory
}

const nodeTools = () => {
  const bin = dirname(process.execPath)
  return { node: process.execPath, npm: join(bin, "npm"), npx: join(bin, "npx") }
}

const bunTools = () => ({ bun: onPath("bun"), bunx: onPath("bun") })

/**
 * `replays` is false where no Node exists: `smthrs` runs on Node, so the replay
 * refuses and says why. `applies` also runs the workflow `apply` writes.
 */
const ways = [
  {
    name: "npx under Node",
    tools: nodeTools,
    start: ["npx", "--yes", "--package", tarball, "smithers-ci"],
    replays: true,
    applies: true
  },
  {
    name: "bunx beside Node",
    tools: () => ({ ...nodeTools(), ...bunTools() }),
    start: ["bunx", "--package", tarball, "smithers-ci"],
    replays: true
  },
  {
    name: "bunx --bun beside Node",
    tools: () => ({ ...nodeTools(), ...bunTools() }),
    start: ["bunx", "--bun", "--package", tarball, "smithers-ci"],
    replays: true
  },
  {
    name: "bunx with no Node",
    tools: bunTools,
    start: ["bunx", "--package", tarball, "smithers-ci"],
    replays: false,
    skip: ["/usr/bin/node", "/bin/node"].some(existsSync) && "this machine has a Node in its system directories"
  }
]

const run = (command, args, options) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], timeout: commandLimitMs, killSignal: "SIGKILL" })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (status, signal) => resolveRun({ status, signal, stdout, stderr }))
  })

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=Stranger", "-c", "user.email=stranger@example.test", ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}

/** A small real repository: one CI job that runs one shell command, and three commits. */
const repositoryIn = (root) => {
  const repository = join(root, "repository")
  mkdirSync(join(repository, ".github/workflows"), { recursive: true })
  writeFileSync(join(repository, ".github/workflows/ci.yml"), [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: test -f app.txt",
    ""
  ].join("\n"))
  git(root, "init", "-q", "-b", "main", repository)
  for (const text of ["one", "two", "three"]) {
    writeFileSync(join(repository, "app.txt"), `${text}\n`)
    git(repository, "add", "--all")
    git(repository, "commit", "-q", "-m", text)
  }
  return repository
}

/**
 * A workflow step's command and environment as a runner runs them: each `${{ }}`
 * expression replaced by its value in `values`. An expression with no value
 * fails here, by name, before any of it reaches a shell.
 */
const runnerStep = (step, values) => {
  const fill = (text) =>
    String(text).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
      assert.ok(Object.hasOwn(values, expression), `the step uses \${{ ${expression} }}, which this test gives no value`)
      return values[expression]
    })
  return {
    run: fill(step.run),
    env: Object.fromEntries(Object.entries(step.env ?? {}).map(([name, value]) => [name, fill(value)]))
  }
}

let registry
before(async () => {
  registry = await releaseRegistry(packs, entries)
})
after(async () => {
  await registry.close()
  if (given === undefined) rmSync(packs, { recursive: true, force: true })
})

for (const way of ways) {
  describe(way.name, { skip: way.skip ?? false }, () => {
    let root
    let repository
    let environment

    const attempt = (...args) => {
      const [command, ...start] = way.start
      return run(command, [...start, ...args], { cwd: repository, env: environment })
    }

    const smithersCi = async (...args) => {
      const result = await attempt(...args)
      assert.equal(result.status, 0, `${way.start.join(" ")} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
      return result.stdout
    }

    before(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-ci-stranger-")))
      const home = join(root, "home")
      mkdirSync(home)
      // Bun drops the last path segment of a registry URL with no trailing slash.
      writeFileSync(join(home, ".npmrc"), `@smthrs:registry=${registry.url}/\n`)
      // bunx keeps its install in the temporary directory, under the tarball's path, and reuses it.
      const temporary = join(root, "tmp")
      mkdirSync(temporary)
      repository = repositoryIn(root)
      environment = {
        HOME: home,
        PATH: [toolDirectory(root, way.tools()), "/usr/bin", "/bin"].join(delimiter),
        TMPDIR: temporary
      }
    })
    after(() => rmSync(root, { recursive: true, force: true }))

    it("prints its help", async () => {
      assert.match(await smithersCi("--help"), /smithers-ci <subcommand>/)
    })

    it("prints what the repository's CI runs", async () => {
      assert.match(await smithersCi("inventory"), /\$ test -f app\.txt/)
    })

    it(way.replays ? "replays two commits" : "refuses the replay and names Node", async () => {
      if (!way.replays) {
        const result = await attempt("replay", "--commits", "2", "--json")
        assert.equal(result.status, 3, result.stderr)
        assert.match(result.stderr, /needs Node\.js 22\.19 or newer/)
        return
      }
      const report = JSON.parse(await smithersCi("replay", "--commits", "2", "--json"))
      assert.equal(report.commits.length, 2)
      assert.equal(report.mismatches, 0)
      for (const commit of report.commits) {
        assert.equal(commit.baseline.ok, true)
        assert.equal(commit.normal.ok, true)
      }
      assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).stdout, "")
    })

    if (way.applies) {
      it("writes a workflow whose pinned smthrs accepts what it wrote", async () => {
        await smithersCi("apply")
        git(repository, "add", "--all")
        git(repository, "commit", "-q", "-m", "apply")
        const workflow = readFileSync(join(repository, ".github/workflows/smithers-ci.yml"), "utf8")
        const step = parse(workflow).jobs.ci.steps.find((each) =>
          typeof each.run === "string" && each.run.startsWith("npx ") && each.run.includes(" smthrs ci ")
        )
        assert.ok(step?.run.includes(`--package=@smthrs/cli@${packed.version} `), workflow)
        const temporary = join(root, "runner-temp")
        mkdirSync(temporary)
        const filled = runnerStep(step, {
          "runner.temp": temporary,
          // A repository that has set neither the variable nor the secrets, as after `apply`.
          "vars.SMITHERS_CACHE_URL": "",
          "github.event_name == 'pull_request' && secrets.SMITHERS_CACHE_READ_TOKEN || secrets.SMITHERS_CACHE_TOKEN": ""
        })
        const result = await run("bash", ["-e", "-c", filled.run], { cwd: repository, env: { ...environment, ...filled.env } })
        assert.equal(result.status, 0, `${filled.run}\n${result.stdout}\n${result.stderr}`)
        assert.ok(existsSync(join(temporary, "smithers-ci", "cache")), "the run keeps its results under the runner's temporary directory")
      })
    }
  })
}
