import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.ts"
import { variables } from "../../src/inventory/Cache.ts"
import { before, lockVariable, setupCache } from "../../src/inventory/SetupCache.ts"
import { jobsOf, type Repository, repository, runJob } from "./run.ts"

const file = ".github/workflows/ci.yml"
const made: Array<Repository> = []

afterEach(() => {
  for (const repo of made.splice(0)) repo.remove()
})

const withWorkflow = (workflow: string, files: Readonly<Record<string, string>> = {}): Repository => {
  const repo = repository({ [file]: workflow, ...files })
  made.push(repo)
  return repo
}

const jobOf = (repo: Repository, id = "ci.yml:build"): Job => {
  const job = jobsOf(repo, file).find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

/** A directory of programs for a test's steps to find first, each a shell script. */
const tools = (repo: Repository, scripts: Readonly<Record<string, string>>): string => {
  const bin = join(repo.temp, "tools")
  mkdirSync(bin, { recursive: true })
  for (const [name, script] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return `${bin}:${process.env["PATH"] ?? ""}`
}

const run = (repo: Repository, path?: string, id = "ci.yml:build") =>
  runJob(repo, jobOf(repo, id), {}, path).map((step) => ({ status: step.status, output: step.output.trim() }))

const job = (setup: string, rest: string): string => `
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setup}
${rest}
`

// actions/setup-node, "Caching global packages data": "The action has a built-in functionality for caching and
// restoring dependencies. It uses actions/cache under the hood"; the lock file is hashed into the key and
// `npm config get cache` names the directory. The `npm` here is the machine's own.
describe("actions/setup-node with cache: npm", () => {
  const workflow = job(
    `      - id: node
        uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }`,
    `      - run: |
          cache=$(npm config get cache)
          echo "hit=[\${{ steps.node.outputs.cache-hit }}] $(cat "$cache/fetched" 2>/dev/null)"
          mkdir -p "$cache" && echo "lodash" >> "$cache/fetched"`
  )

  it("restores npm's own cache from the store, keyed by the lockfile, and saves it after the job", () => {
    const repo = withWorkflow(workflow, { "package-lock.json": "{\"lockfileVersion\": 3}\n" })
    const read = jobOf(repo)
    expect(read.unsupported.map((entry) => entry.feature)).toEqual(["host-action", "host-action"])
    expect(read.steps.map((step) => step.name)).toEqual([
      "actions/setup-node@v4",
      undefined,
      "Post actions/setup-node@v4"
    ])
    const first = run(repo)
    expect(first[0]?.output).toMatch(
      /^Cache not found for input keys: node-cache-npm-(Linux|macOS)-(X64|ARM64)-[0-9a-f]{64}$/
    )
    // setup-node: `core.setOutput('cache-hit', Boolean(cacheKey))`, so a miss is `false`, where actions/cache leaves
    // the output empty.
    expect(first[1]?.output).toBe("hit=[false]")
    expect(first[2]?.output).toMatch(/\nCache saved with key: node-cache-npm-/)
    // A new machine: the home is empty but for the store.
    rmSync(join(repo.temp, ".npm"), { recursive: true })
    const second = run(repo)
    expect(second[1]?.output).toBe("hit=[true] lodash")
    // Another lockfile is another key.
    writeFileSync(join(repo.root, "package-lock.json"), "{\"lockfileVersion\": 3, \"packages\": {}}\n")
    rmSync(join(repo.temp, ".npm"), { recursive: true })
    expect(run(repo)[1]?.output).toBe("hit=[false]")
  })

  it("knows only cache-hit of what the action gives: another output leaves the job out", () => {
    const repo = withWorkflow(
      job(
        `      - id: node
        uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }`,
        `      - if: steps.node.outputs.node-version != ''
        run: exit 1`
      ),
      { "package-lock.json": "{}\n" }
    )
    const read = jobOf(repo)
    expect(read.unsupported.map((entry) => entry.detail).join("\n")).toContain(
      "an output of actions/setup-node@v4, which a replay does not run"
    )
  })

  it("reads an expression in cache-dependency-path", () => {
    const repo = withWorkflow(
      `
on: pull_request
env: { DIR: web }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          cache: npm
          cache-dependency-path: \${{ env.DIR }}/package-lock.json
      - run: mkdir -p "$(npm config get cache)" && echo x > "$(npm config get cache)/fetched"
`,
      { "web/package-lock.json": "web\n" }
    )
    const ran = run(repo)
    expect(ran.map((step) => step.status)).toEqual([0, 0, 0])
    expect(ran[0]?.output).toMatch(/^Cache not found for input keys: node-cache-npm-/)
    expect(ran[2]?.output).toMatch(/\nCache saved with key: node-cache-npm-/)
  })

  it("keeps no cache, and runs the job, when cache-dependency-path holds a matrix value", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    strategy: { matrix: { dir: [web] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          cache: npm
          cache-dependency-path: \${{ matrix.dir }}/package-lock.json
      - run: echo ran
`,
      { "web/package-lock.json": "web\n" }
    )
    expect(runJob(repo, jobOf(repo), { dir: "web" }).map((step) => step.output.trim())).toEqual(["ran"])
  })
})

// actions/setup-go, "Caching dependency files and build outputs": "The action has a built-in functionality for
// caching and restoring go modules and build outputs ... The cache input is optional, and caching is turned on by
// default". The `go` here is a script that answers `go env` as Go does.
describe("actions/setup-go", () => {
  const go = "case \"$2\" in GOMODCACHE) echo \"$HOME/go/pkg/mod\";; GOCACHE) echo \"$HOME/.cache/go-build\";; esac"
  const workflow = (uses: string, more = "") =>
    job(
      `      - uses: ${uses}
        with: { go-version: "1.24"${more} }`,
      `      - run: |
          cat "$HOME/go/pkg/mod/fetched" "$HOME/.cache/go-build/built" 2>/dev/null || echo cold
          mkdir -p "$HOME/go/pkg/mod" "$HOME/.cache/go-build"
          echo module > "$HOME/go/pkg/mod/fetched"; echo object > "$HOME/.cache/go-build/built"`
    )

  it("keeps the module cache and the build cache, keyed by go.sum", () => {
    const repo = withWorkflow(workflow("actions/setup-go@v5"), { "go.sum": "example.com/a v1.0.0 h1:abc=\n" })
    const path = tools(repo, { go })
    expect(run(repo, path).map((step) => step.output)).toEqual([
      expect.stringMatching(/^Cache not found for input keys: setup-go-1\.24-(Linux|macOS)-(X64|ARM64)-[0-9a-f]{64}$/),
      "cold",
      expect.stringMatching(/\nCache saved with key: setup-go-1\.24-/)
    ])
    rmSync(join(repo.temp, "go"), { recursive: true })
    rmSync(join(repo.temp, ".cache", "go-build"), { recursive: true })
    expect(run(repo, path)[1]?.output).toBe("module\nobject")
  })

  // A Go module cache is read-only, and a home can already hold it. `@actions/cache` (`restoreCache`): a failure to
  // restore is a warning and the step goes on as after a miss.
  it("goes on as after a miss when a cache cannot be unpacked over what is there", () => {
    const repo = withWorkflow(
      job(
        `      - id: go
        uses: actions/setup-go@v5
        with: { go-version: "1.24" }`,
        `      - run: |
          echo "hit=[\${{ steps.go.outputs.cache-hit }}]"
          [ -e "$HOME/go/pkg/mod/a@v1" ] && exit 0
          mkdir -p "$HOME/go/pkg/mod/a@v1"; echo module > "$HOME/go/pkg/mod/a@v1/a.go"; chmod -R a-w "$HOME/go/pkg/mod/a@v1"`
      ),
      { "go.sum": "a\n" }
    )
    const path = tools(repo, { go })
    try {
      expect(run(repo, path)[1]?.output).toBe("hit=[false]")
      const again = run(repo, path)
      expect(again.map((step) => step.status)).toEqual([0, 0, 0])
      expect(again[0]?.output).toContain("::warning::Failed to restore: the cache setup-go-1.24-")
      expect(again[0]?.output).toContain("Cache not found for input keys: setup-go-1.24-")
      expect(again[1]?.output).toBe("hit=[false]")
    } finally {
      execFileSync("chmod", ["-R", "u+w", join(repo.temp, "go")])
    }
  })

  // actions/setup-go, `src/package-managers.ts`: `dependencyFilePattern` is `go.sum` up to v6.2.0, `go.mod` from v6.3.0.
  it.each<[string, string]>([
    ["actions/setup-go@v5", "go.sum"],
    ["actions/setup-go@v6.2.0", "go.sum"],
    ["actions/setup-go@v6.3.0", "go.mod"],
    ["actions/setup-go@v6.10", "go.mod"],
    ["actions/setup-go@v6", "go.mod"],
    ["actions/setup-go@v7", "go.mod"],
    ["actions/setup-go@v10", "go.mod"]
  ])("%s hashes %s", (uses, file) => {
    const cache = setupCache(uses, {})
    expect(cache?.lock).toBe(`\${{ hashFiles('${file}') }}`)
    expect(cache?.missing.said).toContain(`Supported file pattern: ${file}`)
  })

  it("takes a version range out of the key, which may hold no comma", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    strategy: { matrix: { go: [">=1.22, <1.24"] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: "\${{ matrix.go }}" }
      - run: mkdir -p "$HOME/go/pkg/mod" && echo module > "$HOME/go/pkg/mod/fetched"
`,
      { "go.sum": "a\n" }
    )
    const ran = runJob(repo, jobOf(repo), { go: ">=1.22, <1.24" }, tools(repo, { go }))
    expect(ran.map((step) => step.status)).toEqual([0, 0, 0])
    expect(ran[0]?.output).toContain("Cache not found for input keys: setup-go->=1.22_ <1.24-")
  })

  it("goes on without a cache, as the action does, when the repository has no go.sum", () => {
    const repo = withWorkflow(workflow("actions/setup-go@v5"))
    const ran = run(repo, tools(repo, { go }))
    expect(ran.map((step) => step.status)).toEqual([0, 0, 0])
    expect(ran[0]?.output).toBe(
      `Restore cache failed: Dependencies file is not found in ${repo.root}. Supported file pattern: go.sum`
    )
    expect(ran[2]?.output).toBe("smithers-ci: no cache is saved, the step that restores it did not run")
    expect(existsSync(join(repo.temp, ".cache", "smithers-ci"))).toBe(false)
  })

  it.each<[string, string, boolean]>([
    ["version 4, which caches unless told not to", "actions/setup-go@v4", true],
    ["version 6.1", "actions/setup-go@v6.1.0", true],
    ["version 12", "actions/setup-go@v12", true],
    ["version 3, which does not", "actions/setup-go@v3", false],
    [
      "a release named by its commit, which does not say",
      "actions/setup-go@0aaccfd150d50ccaeb58ebd88d36e91967a5f35b",
      false
    ],
    ["no release at all", "actions/setup-go", false]
  ])("reads %s", (_name, uses, cached) => {
    expect(setupCache(uses, { "go-version": "1.24" }) !== undefined).toBe(cached)
    expect(setupCache(uses, { cache: true }) !== undefined).toBe(true)
    expect(setupCache(uses, { cache: false })).toBeUndefined()
  })
})

// actions/setup-python, "Caching packages dependencies": "The action defaults to searching for a dependency file
// (requirements.txt or pyproject.toml for pip ...) in the repository, and uses its hash as a part of the cache key".
describe("actions/setup-python with cache: pip", () => {
  const pip = "[ \"$1 $2\" = \"cache dir\" ] && echo \"$HOME/.cache/pip\""
  const workflow = job(
    `      - uses: actions/setup-python@v5
        with: { python-version: "3.13", cache: pip }`,
    `      - run: cat "$HOME/.cache/pip/wheel" 2>/dev/null || { mkdir -p "$HOME/.cache/pip" && echo wheel > "$HOME/.cache/pip/wheel"; echo cold; }`
  )

  it("keeps pip's cache, keyed by the requirements files wherever they are", () => {
    const repo = withWorkflow(workflow, { "services/api/requirements.txt": "flask==3.1\n" })
    const path = tools(repo, { pip })
    expect(run(repo, path).map((step) => step.output)).toEqual([
      expect.stringMatching(
        /^Cache not found for input keys: setup-python-3\.13-pip-(Linux|macOS)-(X64|ARM64)-[0-9a-f]{64}$/
      ),
      "cold",
      expect.stringMatching(/\nCache saved with key: setup-python-3\.13-pip-/)
    ])
    rmSync(join(repo.temp, ".cache", "pip"), { recursive: true })
    expect(run(repo, path)[1]?.output).toBe("wheel")
  })

  it("finds pyproject.toml when the files it is told of match nothing, as the action does", () => {
    const repo = withWorkflow(
      job(
        `      - uses: actions/setup-python@v5
        with: { python-version: "3.13", cache: pip, cache-dependency-path: reqs/dev.txt }`,
        `      - run: echo ran`
      ),
      { "pyproject.toml": "[project]\n" }
    )
    const ran = run(repo, tools(repo, { pip }))
    expect(ran.map((step) => step.status)).toEqual([0, 0, 0])
    expect(ran[0]?.output).toMatch(/^Cache not found for input keys: setup-python-3\.13-pip-/)
  })

  it("names the files it was told of when nothing matches, as text the shell leaves alone", () => {
    const repo = withWorkflow(job(
      `      - uses: actions/setup-python@v5
        with: { python-version: "3.13", cache: pip, cache-dependency-path: "reqs/$(touch made)\`x\`.txt" }`,
      `      - run: echo ran`
    ))
    const ran = run(repo, tools(repo, { pip }))
    expect(ran[0]?.status).toBe(1)
    expect(ran[0]?.output).toContain("matched to [reqs/$(touch made)`x`.txt or **/pyproject.toml]")
    expect(existsSync(join(repo.root, "made"))).toBe(false)
  })

  it("restores nothing and goes on when the tool cannot say where its cache is", () => {
    const repo = withWorkflow(workflow, { "requirements.txt": "flask\n" })
    for (const script of ["exit 127", "exit 0"]) {
      const ran = run(repo, tools(repo, { pip: script }))
      expect(ran.map((step) => step.status)).toEqual([0, 0, 0])
      expect(ran[0]?.output).toBe("smithers-ci: nothing is restored, this machine cannot say where the cache is kept")
      expect(ran[2]?.output).toBe("smithers-ci: no cache is saved, the step that restores it did not run")
    }
  })

  it("stops, as the action does, when no requirements file is there", () => {
    const repo = withWorkflow(workflow)
    const ran = run(repo, tools(repo, { pip }))
    expect(ran).toHaveLength(1)
    expect(ran[0]?.output).toBe(
      `No file in ${repo.root} matched to [**/requirements.txt or **/pyproject.toml], make sure you have checked out the target repository`
    )
  })
})

describe("setupCache", () => {
  it("asks each package manager of setup-node for its own cache", () => {
    expect(setupCache("actions/setup-node@v4", { cache: "pnpm" })).toMatchObject({
      paths: "pnpm store path --silent",
      lock: "${{ hashFiles('pnpm-lock.yaml') }}",
      key: "node-cache-pnpm-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml') }}"
    })
    const yarn = setupCache("actions/setup-node@v4", {
      cache: "yarn",
      "cache-dependency-path": "web/yarn.lock\n\nit's/yarn.lock"
    })
    expect(yarn?.paths).toContain("yarn cache dir")
    expect(yarn?.paths).toContain("yarn config get cacheFolder")
    // A quote in a path is written as an expression writes one.
    expect(yarn?.lock).toBe("${{ hashFiles('web/yarn.lock', 'it''s/yarn.lock') }}")
  })

  it("reads no cache where the step asks for none, or for one it does not follow", () => {
    expect(setupCache("actions/setup-node@v4", { "node-version": 22 })).toBeUndefined()
    expect(setupCache("actions/setup-node@v4", { cache: "bun" })).toBeUndefined()
    expect(setupCache("actions/setup-node@v4", undefined)).toBeUndefined()
    expect(setupCache("actions/setup-python@v5", { cache: "poetry" })).toBeUndefined()
    expect(setupCache("actions/setup-python@v5", {})).toBeUndefined()
    expect(setupCache("actions/setup-java@v4", { cache: "maven" })).toBeUndefined()
    expect(setupCache("oven-sh/setup-bun@v2", {})).toBeUndefined()
  })

  it("names the tool's version in the key when the step gives one, by number or by file", () => {
    expect(setupCache("actions/setup-go@v5", { "go-version-file": "go.mod" })?.key).toMatch(/^setup-go-go\.mod-/)
    expect(setupCache("actions/setup-go@v5", {})?.key).toMatch(/^setup-go--/)
    expect(setupCache("actions/setup-go@v5", { "go-version": "1.${{ matrix.go }}.x" })?.key).toMatch(
      /^setup-go-1\.\$\{\{ matrix\.go \}\}\.x-/
    )
    expect(setupCache("actions/setup-python@v5", { cache: "pip", "python-version-file": ".python version" })?.key)
      .toMatch(/^setup-python-\.python_version-pip-/)
    expect(setupCache("actions/setup-python@v5", { cache: "pip" })?.key).toMatch(/^setup-python--pip-/)
  })

  it("writes the lines that ask the tool and meet a missing lockfile", () => {
    const cache = setupCache("actions/setup-go@v5", {})
    expect(before(cache as NonNullable<typeof cache>)).toBe([
      `if [ -z "\${${lockVariable}-}" ]; then`,
      `  echo "Restore cache failed: Dependencies file is not found in $GITHUB_WORKSPACE. Supported file pattern: go.sum" >&2`,
      `  exit 0`,
      `fi`,
      `echo "cache-hit=false" >> "$GITHUB_OUTPUT"`,
      `${variables.key}=\${${variables.key}//,/_}`,
      `if ! ${variables.path}=$({ go env GOMODCACHE; go env GOCACHE; } 2>/dev/null) || [ -z "$${variables.path}" ]; then`,
      `  echo "smithers-ci: nothing is restored, this machine cannot say where the cache is kept"`,
      `  exit 0`,
      `fi`
    ].join("\n"))
  })

  it("builds a pattern that holds an expression with format, keeping its braces and quotes as text", () => {
    const cache = setupCache("actions/setup-node@v4", {
      cache: "npm",
      "cache-dependency-path": "it's/{a}/${{ matrix.dir }}/${{matrix.lock}}"
    })
    expect(cache?.lock).toBe("${{ hashFiles(format('it''s/{{a}}/{0}/{1}', matrix.dir, matrix.lock)) }}")
  })
})
