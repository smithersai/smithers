import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.vibe"
import { cacheUse, handedOn, restoreScript, saveScript, shell, variables } from "../../src/inventory/Cache.vibe"
import { jobsOf, type Repository, repository, runJob } from "./run.ts"

const file = ".github/workflows/ci.yml"
const made: Array<Repository> = []

afterEach(() => {
  for (const repo of made.splice(0)) repo.remove()
})

/** A repository holding one workflow and the files given. Its steps' home, and so its cache store, is `repo.temp`. */
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

/** What each step of a job printed, run as the baseline runs it. */
const run = (repo: Repository, id = "ci.yml:build"): ReadonlyArray<string> =>
  runJob(repo, jobOf(repo, id)).map((step) => step.output.trim())

/** The entries of the store, as the keys they were saved under. */
const saved = (repo: Repository): ReadonlyArray<string> => {
  const store = join(repo.temp, ".cache", "smithers-ci", "actions-cache")
  if (!existsSync(store)) return []
  return readdirSync(store).flatMap((paths) =>
    readdirSync(join(store, paths)).flatMap((entry) => {
      const key = join(store, paths, entry, "key")
      return existsSync(key) ? [readFileSync(key, "utf8")] : []
    })
  ).sort()
}

/** Makes every entry of the store an hour older, so the next one saved is the newest whatever the clock's grain. */
const age = (repo: Repository): void => {
  const store = join(repo.temp, ".cache", "smithers-ci", "actions-cache")
  for (const paths of readdirSync(store)) {
    for (const entry of readdirSync(join(store, paths))) {
      const older = new Date(statSync(join(store, paths, entry)).mtimeMs - 3_600_000)
      utimesSync(join(store, paths, entry), older, older)
    }
  }
}

const steps = (cache: string, rest: string): string => `
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${cache}
${rest}
`

/** A cache step over one directory, keyed by a file, and a step that says what it found and adds to it. */
const building = steps(
  `      - id: cache
        uses: actions/cache@v4
        with:
          path: |
            .build-cache
            ~/tools
            \${{ runner.temp }}/downloads
          key: build-\${{ hashFiles('lock.txt') }}
          restore-keys: |
            other-
            build-`,
  `      - run: |
          echo "hit=[\${{ steps.cache.outputs.cache-hit }}]"
          cat .build-cache/made ~/tools/made "$RUNNER_TEMP/downloads/made" 2>/dev/null || echo nothing
          mkdir -p .build-cache ~/tools "$RUNNER_TEMP/downloads"
          cat lock.txt >> .build-cache/made
          echo tool > ~/tools/made
          echo download > "$RUNNER_TEMP/downloads/made"`
)

/** A fresh checkout and a fresh machine but for the store: what a cache step restores must come from the store. */
const forget = (repo: Repository): void => {
  rmSync(join(repo.root, ".build-cache"), { recursive: true, force: true })
  rmSync(join(repo.temp, "tools"), { recursive: true, force: true })
}

// "Caching dependencies to speed up workflows": "the cache action first searches for cache hits for key ... If
// there is no hit for key, the action sequentially searches for restore-keys"; "when a cache hit occurs for the
// exact key, cache-hit is true". actions/cache README, "Outputs": `cache-hit` is `false` for a restore key, and
// the action sets none when nothing was found.
describe("a cache step", () => {
  it("restores nothing the first time, saves after the job's steps, and restores it at the next run", () => {
    const repo = withWorkflow(building, { "lock.txt": "one\n" })
    const job = jobOf(repo)
    expect(job.unsupported).toEqual([])
    expect(job.steps.map((step) => step.name)).toEqual(["actions/cache@v4", undefined, "Post actions/cache@v4"])

    const first = run(repo)
    expect(first[0]).toMatch(/^Cache not found for input keys: build-[0-9a-f]{64}$/)
    expect(first[1]).toBe("hit=[]\nnothing")
    expect(first[2]).toMatch(/\nCache saved with key: build-[0-9a-f]{64}$/)
    expect(saved(repo)).toHaveLength(1)

    forget(repo)
    const second = run(repo)
    expect(second[0]).toMatch(/\nCache restored from key: build-[0-9a-f]{64}$/)
    // From the checkout, the home and the job's temporary directory, which the job emptied when it started.
    expect(second[1]).toBe("hit=[true]\none\ntool\ndownload")
    expect(second[2]).toMatch(/^Cache hit occurred on the primary key build-[0-9a-f]{64}, not saving cache\.$/)
    // An entry is never written twice: the store still holds what the first run saved.
    forget(repo)
    expect(run(repo)[1]).toBe("hit=[true]\none\ntool\ndownload")
    expect(saved(repo)).toHaveLength(1)
  })

  it("takes the newest entry whose key starts with a restore key, and saves under the new key", () => {
    const repo = withWorkflow(building, { "lock.txt": "one\n" })
    run(repo)
    for (const [lock, found] of [["two\n", "one"], ["three\n", "one\ntwo"]] as const) {
      age(repo)
      forget(repo)
      writeFileSync(join(repo.root, "lock.txt"), lock)
      const outputs = run(repo)
      // `other-` comes first and matches nothing; `build-` matches every entry, and the newest is taken.
      expect(outputs[0]).toMatch(/\nCache restored from key: build-[0-9a-f]{64}$/)
      expect(outputs[1]).toBe(`hit=[false]\n${found}\ntool\ndownload`)
      expect(outputs[2]).toMatch(/\nCache saved with key: build-[0-9a-f]{64}$/)
    }
    expect(saved(repo)).toHaveLength(3)
  })

  it("looks only at entries saved for the same paths", () => {
    const fewer = building.replace("            ~/tools\n", "").replace("  build:", "  fewer:")
    const repo = withWorkflow(`${building}${fewer.slice(fewer.indexOf("  fewer:"))}`, { "lock.txt": "one\n" })
    run(repo)
    forget(repo)
    const outputs = run(repo, "ci.yml:fewer")
    expect(outputs[0]).toMatch(/^Cache not found for input keys: /)
    expect(outputs[1]).toBe("hit=[]\nnothing")
  })

  it("saves nothing when a step of the job failed", () => {
    const repo = withWorkflow(building.replace("echo download >", "exit 1; echo download >"), { "lock.txt": "one\n" })
    expect(runJob(repo, jobOf(repo))).toHaveLength(2)
    expect(saved(repo)).toEqual([])
  })

  it("saves nothing when none of its paths is there, and can save at a later run", () => {
    const repo = withWorkflow(
      steps(
        `      - uses: actions/cache@v4
        with: { path: "out\\n\${{ github.workspace }}/more", key: fixed }`,
        `      - run: test -f skip || { mkdir out more; echo x > more/file; }`
      ),
      { skip: "" }
    )
    expect(run(repo)[2]).toBe(
      "Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved."
    )
    expect(saved(repo)).toEqual([])
    rmSync(join(repo.root, "skip"))
    expect(run(repo)[2]).toMatch(/\nCache saved with key: fixed$/)
    rmSync(join(repo.root, "more"), { recursive: true })
    run(repo)
    expect(readFileSync(join(repo.root, "more", "file"), "utf8")).toBe("x\n")
  })

  it("leaves alone an entry another job is still writing", () => {
    const repo = withWorkflow(building, { "lock.txt": "one\n" })
    run(repo)
    const store = join(repo.temp, ".cache", "smithers-ci", "actions-cache")
    const [paths] = readdirSync(store) as [string]
    const [entry] = readdirSync(join(store, paths)) as [string]
    // An entry is saved once its key is written. Without it the entry is another job's, mid-way.
    rmSync(join(store, paths, entry, "key"))
    forget(repo)
    const outputs = run(repo)
    expect(outputs[0]).toMatch(/^Cache not found for input keys: /)
    expect(outputs[2]).toMatch(
      /^Failed to save: Unable to reserve cache with key build-[0-9a-f]{64}, another job may be/
    )
  })

  it.each<[string, string, string]>([
    ["a pattern", "dist/**", "the cache path dist/** is a pattern, which a replay does not keep"],
    ["a path left out", "!dist/tmp", "the cache path !dist/tmp is a pattern, which a replay does not keep"],
    ["a path above the checkout", "../shared", "the cache path ../shared leaves its directory"],
    ["a path elsewhere on the machine", "/var/cache/tool", "the cache path /var/cache/tool is outside the checkout"],
    ["the whole home", "~", "the cache path ~ is outside the checkout"]
  ])("restores and saves nothing for %s", (_name, path, why) => {
    const repo = withWorkflow(steps(
      `      - id: cache
        uses: actions/cache@v4
        with: { path: "${path}", key: fixed }`,
      `      - run: echo "hit=[\${{ steps.cache.outputs.cache-hit }}]"`
    ))
    const outputs = run(repo)
    expect(outputs[0]).toBe(
      `smithers-ci: ${outputs[0]?.slice("smithers-ci: ".length).split("\n")[0]}\nCache not found for input keys: fixed`
    )
    expect(outputs[0]).toContain(why)
    expect(outputs[1]).toBe("hit=[]")
    expect(outputs[2]).toContain("smithers-ci: no cache is saved")
    expect(saved(repo)).toEqual([])
  })

  // actions/cache, "Inputs": `fail-on-cache-miss` fails the workflow when no entry is found, and `lookup-only`
  // checks that one exists without downloading it.
  it("fails on a miss when told to, and only looks when told to", () => {
    const job = (id: string, more: string) => `
  ${id}:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with: { path: kept, key: fixed, ${more} }
      - run: echo "hit=[\${{ steps.cache.outputs.cache-hit }}] $(cat kept 2>/dev/null)"; echo yes > kept
`
    const repo = withWorkflow(
      `on: pull_request\njobs:${job("strict", "fail-on-cache-miss: true")}${
        job("lenient", "fail-on-cache-miss: false")
      }${job("look", "lookup-only: true")}`
    )
    const missed = runJob(repo, jobOf(repo, "ci.yml:strict"))
    expect(missed).toHaveLength(1)
    expect(missed[0]?.status).toBe(1)
    expect(missed[0]?.output).toContain(
      "Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: fixed"
    )
    expect(run(repo, "ci.yml:lenient")[1]).toBe("hit=[]")
    rmSync(join(repo.root, "kept"))
    const looked = run(repo, "ci.yml:look")
    expect(looked[0]).toBe("Lookup only - skipping download\nCache restored from key: fixed")
    expect(looked[1]).toBe("hit=[true]")
    // The entry is there, so the job that fails on a miss now passes, and gets the file.
    rmSync(join(repo.root, "kept"))
    expect(run(repo, "ci.yml:strict")[1]).toBe("hit=[true] yes")
  })

  // actions/cache: "Key Validation Error: … cannot contain commas" and "cannot be larger than 512 characters".
  it.each<[string, string, string]>([
    ["with a comma", "a,b", "Key Validation Error: a,b cannot contain commas."],
    ["longer than 512 characters", "k".repeat(513), "cannot be larger than 512 characters."],
    ["that is empty when the step runs", "${{ steps.none.outputs.key }}", "Input required and not supplied: key"]
  ])("stops for a key %s", (_name, key, said) => {
    const repo = withWorkflow(steps(
      `      - id: none
        run: "true"
      - uses: actions/cache@v4
        with: { path: kept, key: "${key}" }`,
      ""
    ))
    const ran = runJob(repo, jobOf(repo))
    expect(ran.at(-1)?.status).toBe(1)
    expect(ran.at(-1)?.output).toContain(said)
  })

  it("stops for a path that is empty when the step runs", () => {
    const repo = withWorkflow(steps(
      `      - id: none
        run: "true"
      - uses: actions/cache@v4
        with: { path: "\${{ steps.none.outputs.path }}", key: fixed }`,
      ""
    ))
    expect(runJob(repo, jobOf(repo)).at(-1)?.output).toContain("Input required and not supplied: path")
  })

  it("is given a key and a path decided while the job runs, in a local action too", () => {
    const repo = withWorkflow(
      steps(
        `      - id: pick
        run: echo "name=deps-v2" >> "$GITHUB_OUTPUT"; echo "where=vendor" >> "$GITHUB_OUTPUT"
      - id: setup
        uses: ./.github/actions/setup
        with: { name: "\${{ steps.pick.outputs.name }}", where: "\${{ steps.pick.outputs.where }}" }`,
        `      - run: echo "action said [\${{ steps.setup.outputs.hit }}]"; mkdir -p vendor; echo lib > vendor/lib`
      ),
      {
        ".github/actions/setup/action.yml": `
inputs:
  name: { required: true }
  where: { required: true }
outputs:
  hit: { value: "\${{ steps.cache.outputs.cache-hit }}" }
runs:
  using: composite
  steps:
    - id: cache
      if: inputs.name != ''
      uses: actions/cache@v4
      with:
        path: \${{ inputs.where }}
        key: \${{ runner.os }}-\${{ inputs.name }}
    - run: echo "inside [\${{ steps.cache.outputs.cache-hit }}] $(cat vendor/lib 2>/dev/null)"
      shell: bash
`
      }
    )
    expect(jobOf(repo).unsupported).toEqual([])
    const first = run(repo)
    expect(first.slice(1)).toEqual([
      expect.stringMatching(/^Cache not found for input keys: (Linux|macOS)-deps-v2$/),
      "inside []",
      "action said []",
      expect.stringMatching(/\nCache saved with key: (Linux|macOS)-deps-v2$/)
    ])
    rmSync(join(repo.root, "vendor"), { recursive: true })
    expect(run(repo).slice(2, 4)).toEqual(["inside [true] lib", "action said [true]"])
  })

  it("saves nothing when its condition was false while the job ran", () => {
    const repo = withWorkflow(steps(
      `      - id: pick
        run: echo "use=no" >> "$GITHUB_OUTPUT"
      - if: steps.pick.outputs.use == 'yes'
        uses: actions/cache@v4
        with: { path: kept, key: fixed }`,
      `      - run: echo yes > kept`
    ))
    const outputs = run(repo)
    expect(outputs[1]).toBe("smithers-ci: not run, its condition is false")
    // The saving command runs whatever the condition is by then, and finds that nothing was restored.
    expect(outputs[3]).toBe("smithers-ci: no cache is saved, the step that restores it did not run")
    expect(saved(repo)).toEqual([])
  })

  it("saves the caches of a job in the order its actions end: the last step's first", () => {
    const repo = withWorkflow(steps(
      `      - uses: actions/cache@v4
        with: { path: one, key: first }
      - uses: actions/cache@v4
        with: { path: two, key: second }`,
      `      - run: echo 1 > one; echo 2 > two`
    ))
    expect(run(repo).slice(3).map((output) => output.split("\n").at(-1))).toEqual([
      "Cache saved with key: second",
      "Cache saved with key: first"
    ])
  })
})

// actions/cache/restore and actions/cache/save: "the restore action restores a cache" and has the outputs
// `cache-hit`, `cache-primary-key` and `cache-matched-key`; "the save action saves a cache".
describe("a step that only restores, and one that only saves", () => {
  const split = steps(
    `      - id: restore
        uses: actions/cache/restore@v4
        with:
          path: kept
          key: kept-\${{ hashFiles('lock.txt') }}
          restore-keys: kept-`,
    `      - run: |
          echo "[\${{ steps.restore.outputs.cache-hit }}] [\${{ steps.restore.outputs.cache-primary-key }}] [\${{ steps.restore.outputs.cache-matched-key }}] $(cat kept 2>/dev/null)"
          cat lock.txt >> kept
      - uses: actions/cache/save@v4
        with:
          path: kept
          key: \${{ steps.restore.outputs.cache-primary-key }}
      - run: echo after`
  )

  it("restore where the one stands and save where the other stands", () => {
    const repo = withWorkflow(split, { "lock.txt": "one\n" })
    const job = jobOf(repo)
    expect(job.unsupported).toEqual([])
    expect(job.steps).toHaveLength(4)
    const first = run(repo)
    expect(first[1]).toMatch(/^\[\] \[kept-[0-9a-f]{64}\] \[\]$/)
    expect(first[2]).toMatch(/\nCache saved with key: kept-[0-9a-f]{64}$/)
    expect(first[3]).toBe("after")
    rmSync(join(repo.root, "kept"))
    writeFileSync(join(repo.root, "lock.txt"), "two\n")
    const second = run(repo)
    expect(second[1]).toMatch(/^\[false\] \[kept-([0-9a-f]{64})\] \[kept-(?!\1)[0-9a-f]{64}\] one$/)
    rmSync(join(repo.root, "kept"))
    const third = run(repo)
    expect(third[1]).toMatch(/^\[true\] \[(kept-[0-9a-f]{64})\] \[\1\] one\ntwo$/)
    // The key is taken: the save step says so and passes.
    expect(third[2]).toMatch(/^Failed to save: Unable to reserve cache with key /)
    expect(saved(repo)).toHaveLength(2)
  })
})

// "hashFiles" over a pattern has a value only GitHub knows, because its runner decides the order. A cache key need
// not be GitHub's: it has to be the same from one run here to the next, and another when a named file changes.
describe("a cache key that hashes the files a pattern names", () => {
  const workflow = steps(
    `      - id: cache
        uses: actions/cache@v4
        with:
          path: node_modules
          key: deps-\${{ hashFiles('**/package-lock.json', '!vendor/**') }}`,
    `      - run: echo "hit=[\${{ steps.cache.outputs.cache-hit }}]"; mkdir -p node_modules; echo x > node_modules/x`
  )
  const files = {
    "package-lock.json": "root\n",
    "packages/a/package-lock.json": "a\n",
    "vendor/b/package-lock.json": "vendored\n"
  }

  it("is the same from one run to the next, and another when one of the files changes", () => {
    const repo = withWorkflow(workflow, files)
    expect(jobOf(repo).unsupported).toEqual([])
    const first = run(repo)
    expect(first[0]).toMatch(/^Cache not found for input keys: deps-[0-9a-f]{64}$/)
    expect(first[2]).toMatch(/\nCache saved with key: deps-[0-9a-f]{64}$/)
    rmSync(join(repo.root, "node_modules"), { recursive: true })
    expect(run(repo)[1]).toBe("hit=[true]")
    // A file the pattern leaves out, and one it does not name, change nothing.
    writeFileSync(join(repo.root, "vendor/b/package-lock.json"), "changed\n")
    writeFileSync(join(repo.root, "packages/a/package.json"), "{}\n")
    expect(run(repo)[1]).toBe("hit=[true]")
    writeFileSync(join(repo.root, "packages/a/package-lock.json"), "changed\n")
    const changed = run(repo)
    expect(changed[1]).toBe("hit=[]")
    expect(changed[2]).toMatch(/\nCache saved with key: deps-[0-9a-f]{64}$/)
    expect(saved(repo)).toHaveLength(2)
  })

  it("is a key with nothing hashed when the pattern names no file, as on GitHub", () => {
    const repo = withWorkflow(workflow)
    expect(run(repo)[0]).toBe("Cache not found for input keys: deps-")
  })
})

describe("a cache step a replay cannot keep", () => {
  // A file outside the repository is hashed only on GitHub, and a secret is never given: the step restores
  // nothing and runs nothing, as after a miss, and its job is replayed.
  it("restores nothing when its key or its path cannot be worked out here", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  outside:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with: { path: node_modules, key: "deps-\${{ hashFiles('~/.npmrc', '**/package-lock.json') }}" }
      - if: steps.cache.outputs.cache-hit != 'true'
        run: echo install
  secret:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with: { path: node_modules, key: "deps-\${{ secrets.CACHE_VERSION }}" }
      - run: echo build
  bare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with: { path: node_modules }
      - uses: actions/cache@v4
        with: { key: fixed }
      - uses: actions/cache/save@v4
      - run: echo build
`)
    for (const id of ["outside", "secret", "bare"]) {
      const job = jobOf(repo, `ci.yml:${id}`)
      expect(job.steps).toHaveLength(1)
      expect(job.unsupported.map((entry) => entry.feature)).toEqual(job.unsupported.map(() => "host-action"))
    }
    expect(run(repo, "ci.yml:outside")).toEqual(["install"])
  })
})

describe("an output of a cache step", () => {
  // Outputs are kept under names made of letters, digits, dashes and underscores, as every output of the action is.
  it("leaves the job out when it is read under any other name", () => {
    const repo = withWorkflow(steps(
      `      - id: cache
        uses: actions/cache@v4
        with: { path: kept, key: fixed }`,
      `      - run: echo "\${{ steps.cache.outputs['hit count'] }}"`
    ))
    const job = jobOf(repo)
    expect(job.unsupported.map((entry) => entry.feature)).toEqual(["expression"])
    expect(job.unsupported[0]?.detail).toContain("with a name a replay does not keep")
  })
})

describe("cacheUse", () => {
  it("reads the inputs of each cache action as the variables its script reads", () => {
    const inputs = {
      path: "a\nb",
      key: "k-${{ hashFiles('lock') }}",
      "restore-keys": "k-",
      "fail-on-cache-miss": true,
      "lookup-only": false,
      "upload-chunk-size": 1000
    }
    expect(cacheUse("actions/cache", inputs)).toEqual({
      kind: "cache",
      env: {
        [variables.path]: "a\nb",
        [variables.key]: "k-${{ hashFiles('lock') }}",
        [variables.restoreKeys]: "k-",
        [variables.failOnMiss]: "true",
        [variables.lookupOnly]: "false"
      }
    })
    expect(cacheUse("actions/cache/restore", { path: "a", key: "k" })).toEqual({
      kind: "restore",
      env: { [variables.path]: "a", [variables.key]: "k" }
    })
    // A save step has no keys to fall back on and nothing to look up.
    expect(cacheUse("actions/cache/save", inputs)).toEqual({
      kind: "save",
      env: { [variables.path]: "a\nb", [variables.key]: "k-${{ hashFiles('lock') }}" }
    })
  })

  it("reads nothing for another action, and for a step with no path or no key", () => {
    expect(cacheUse("actions/checkout", { path: "a", key: "k" })).toBeUndefined()
    expect(cacheUse("actions/cache", { key: "k" })).toBeUndefined()
    expect(cacheUse("actions/cache", { path: "a" })).toBeUndefined()
    expect(cacheUse("actions/cache", { path: ["a"], key: "k" })).toBeUndefined()
    expect(cacheUse("actions/cache", undefined)).toBeUndefined()
    expect(cacheUse("actions/cache", "path")).toBeUndefined()
  })

  it("hands the saving script what the restoring one worked out", () => {
    expect(handedOn.map(([name]) => name)).toEqual([variables.key, variables.matched, variables.path])
    for (const [, output] of handedOn) expect(restoreScript).toContain(`${output}`)
    expect(saveScript).toContain(variables.matched)
    expect(shell[0]).toBe("bash")
  })
})

// The store is the step's home, which this test's steps share with nothing else.
describe("the store", () => {
  it("is under the cache directory of the step's home", () => {
    const repo = withWorkflow(steps(
      `      - uses: actions/cache@v4
        with: { path: kept, key: fixed }`,
      `      - run: echo yes > kept`
    ))
    run(repo)
    const store = join(repo.temp, ".cache", "smithers-ci", "actions-cache")
    const [paths] = readdirSync(store) as [string]
    const [entry] = readdirSync(join(store, paths)) as [string]
    expect(readdirSync(join(store, paths, entry)).sort()).toEqual(["key", "work.tar"])
  })
})

describe("what a cache step restores", () => {
  const places: Array<string> = []
  afterEach(() => {
    for (const place of places.splice(0)) {
      spawnSync("chmod", ["-R", "u+rwX", place])
      rmSync(place, { recursive: true, force: true })
    }
  })
  const place = (): string => {
    const made = mkdtempSync(join(tmpdir(), "smithers-ci-cache-"))
    places.push(made)
    return made
  }

  /** Runs one of the two scripts as a job whose home is `home`, with the store `store`. */
  const script = (text: string, home: string, store: string, outputs: Readonly<Record<string, string>> = {}) => {
    const temp = place()
    const ran = spawnSync(shell[0] as string, [...shell.slice(1), "-c", `umask 022\n${text}`], {
      cwd: temp,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        GITHUB_WORKSPACE: temp,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: join(temp, "output"),
        SMITHERS_CI_CACHE_STORE: store,
        [variables.path]: "~/.cache/tool",
        [variables.key]: "tool-1",
        ...outputs
      }
    })
    return { status: ran.status, output: `${ran.stdout}${ran.stderr}`.trim() }
  }

  /** Every entry under `root`, as a person compares two directories: kind, mode, size, time, link and content. */
  const entries = (root: string): ReadonlyArray<string> => {
    const found: Array<string> = []
    const walk = (relative: string): void => {
      const full = join(root, relative)
      const stat = lstatSync(full, { bigint: true })
      const kind = stat.isSymbolicLink() ? `link ${readlinkSync(full)}` : stat.isDirectory() ? "directory" : "file"
      const content = stat.isFile() ? createHash("sha256").update(readFileSync(full)).digest("hex") : ""
      found.push(`${relative} ${kind} ${(stat.mode & 0o7777n).toString(8)} ${stat.size} ${stat.mtimeNs} ${content}`)
      if (stat.isDirectory()) { for (const name of readdirSync(full).sort()) walk(join(relative, name)) }
    }
    walk(".")
    return found
  }

  it("is every entry it saved as it was: nested repositories, dot-files, modes, links, empty directories, times", () => {
    const first = place()
    const kept = join(first, ".cache", "tool")
    const repo = join(kept, "repo")
    mkdirSync(repo, { recursive: true })
    mkdirSync(join(kept, "empty"))
    const git = (...args: ReadonlyArray<string>) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args])
    git("init", "--quiet")
    writeFileSync(join(repo, ".pre-commit-hooks.yaml"), "hooks: []\n")
    git("add", "--all")
    git("commit", "--quiet", "-m", "hooks")
    writeFileSync(join(kept, "read-only"), "fixed\n")
    chmodSync(join(kept, "read-only"), 0o444)
    // A mode no umask of a job would give, as a tool sets one itself.
    writeFileSync(join(kept, "shared"), "shared\n")
    chmodSync(join(kept, "shared"), 0o666)
    symlinkSync(join(first, "outside"), join(kept, "out"))
    // Times a second apart would hide a restore that keeps whole seconds only.
    for (const [index, name] of ["read-only", "shared", "empty", "repo", "."].entries()) {
      const at = new Date(1_700_000_000_123 + index)
      utimesSync(join(kept, name), at, at)
    }
    const store = place()
    const saved = script(saveScript, first, store)
    expect(saved.status).toBe(0)
    const second = place()
    const restored = script(restoreScript, second, store)
    expect(restored.status).toBe(0)
    expect(entries(join(second, ".cache", "tool"))).toEqual(entries(kept))
    const count = entries(kept).length
    expect(saved.output).toMatch(
      new RegExp(
        `^Cache Size: ~\\d+ MB \\((\\d+) B\\)\\nsmithers-ci: saved ${count} entries, \\1 bytes, key tool-1, at ${kept}\\n` +
          "Cache saved with key: tool-1$"
      )
    )

    expect(restored.output).toMatch(
      new RegExp(
        `^Cache Size: ~\\d+ MB \\(\\d+ B\\)\\nsmithers-ci: restored ${count} entries, \\d+ bytes, key tool-1, ` +
          `at ${join(second, ".cache", "tool")}\\nCache restored from key: tool-1$`
      )
    )
  })

  it.skipIf(process.getuid?.() === 0)("is nothing when a file could not be read, and the job still passes", () => {
    const home = place()
    const kept = join(home, ".cache", "tool")
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, "secret"), "x\n")
    chmodSync(join(kept, "secret"), 0o200)
    const store = place()
    const saved = script(saveScript, home, store)
    expect(saved.status).toBe(0)
    expect(saved.output).toContain("::warning::Failed to save: the cache tool-1 could not be packed")
    expect(readdirSync(store).flatMap((paths) => readdirSync(join(store, paths)))).toEqual([])
    expect(script(restoreScript, place(), store).output).toBe("Cache not found for input keys: tool-1")
  })
})
