import { describe, expect, it } from "vitest"
import { addStep, assemble, draft, fileProblem, note } from "../../src/inventory/Draft.vibe"
import {
  chooseRunner,
  readGlobs,
  readPackage,
  readWorkspacePatterns,
  type Runner,
  segmentMatcher
} from "../../src/inventory/PackageJson.vibe"
import { repositoryName } from "../../src/inventory/Repository.vibe"
import { hasSecretValue, isLiteralSecret, scrub } from "../../src/inventory/Secrets.vibe"
import { readToolFile, toolFiles } from "../../src/inventory/Toolchains.vibe"
import { readTurbo } from "../../src/inventory/Turbo.vibe"
import {
  asScalar,
  asStrings,
  isRecord,
  normalizeDirectory,
  shellQuote,
  shellWord
} from "../../src/inventory/Values.vibe"

const bun: Runner = chooseRunner(`{"packageManager":"bun@1.3.0"}`, [])
const token = `ghp_${"a".repeat(30)}`

describe("readPackage", () => {
  it("makes a job of each script, run by the package manager", () => {
    const { jobs, toolchains } = readPackage(
      "package.json",
      JSON.stringify({
        packageManager: "bun@1.3.0+sha256.abc",
        engines: { node: ">=22", bun: 1 },
        devDependencies: { turbo: "2.5.0" },
        scripts: { test: "vitest run", "test:unit it": "vitest" }
      }),
      bun
    )
    expect(jobs[0]).toEqual({
      id: "package.json:test",
      source: "package-json",
      file: "package.json",
      name: "test",
      needs: [],
      triggers: [],
      matrix: [],
      steps: [{ id: "package.json:test:1", command: "bun run test", cwd: "", env: {}, secrets: [] }],
      unsupported: []
    })
    expect(jobs[1]?.steps[0]?.command).toBe("bun run 'test:unit it'")
    expect(toolchains).toEqual([
      { name: "bun", source: "package.json", version: "1.3.0" },
      { name: "node", source: "package.json", version: ">=22" },
      { name: "turbo", source: "package.json", version: "2.5.0" }
    ])
  })

  it("runs a workspace package's script in its directory and records no tools from it", () => {
    const { jobs, toolchains } = readPackage(
      "packages/a/package.json",
      `{"engines":{"node":"22"},"scripts":{"build":"tsc"}}`,
      bun
    )
    expect(jobs[0]?.id).toBe("packages/a/package.json:build")
    expect(jobs[0]?.steps[0]?.cwd).toBe("packages/a")
    expect(toolchains).toEqual([])
  })

  it("reads a package manager with no version and a package with no scripts", () => {
    expect(readPackage("package.json", `{"packageManager":"npm"}`, bun)).toEqual({
      jobs: [],
      toolchains: [{ name: "npm", source: "package.json" }],
      unsupported: []
    })
  })

  it("flags scripts that keep running", () => {
    const { jobs } = readPackage(
      "package.json",
      JSON.stringify({
        scripts: { dev: "vite", "start:api": "node .", check: "tsc --watch", build: "tsc --watchFile x" }
      }),
      bun
    )
    expect(jobs.map((job) => job.unsupported.map((entry) => entry.feature))).toEqual([
      ["long-running"],
      ["long-running"],
      ["long-running"],
      []
    ])
  })

  it("reports a script that is not text", () => {
    const job = readPackage("package.json", `{"scripts":{"odd":1}}`, bun).jobs[0]
    expect(job?.steps).toEqual([])
    expect(job?.unsupported[0]?.feature).toBe("malformed-script")
  })

  it.each([["{ not json"], ["[1]"]])("reports a malformed file: %s", (text) => {
    const { jobs, unsupported } = readPackage("package.json", text, bun)
    expect(jobs).toEqual([])
    expect(unsupported[0]?.feature).toBe("malformed-file")
  })
})

describe("chooseRunner", () => {
  it.each([
    [`{"packageManager":"pnpm@10.0.0"}`, ["bun.lock"], "pnpm run", "pnpm exec"],
    [`{"packageManager":"yarn@4.0.0"}`, [], "yarn run", "yarn"],
    [`{"packageManager":"unknown@1"}`, ["bun.lockb"], "bun run", "bunx"],
    [`{}`, ["pnpm-lock.yaml"], "pnpm run", "pnpm exec"],
    [`{}`, ["yarn.lock"], "yarn run", "yarn"],
    [`{}`, ["package-lock.json"], "npm run", "npx"],
    [undefined, [], "npm run", "npx"],
    ["{ not json", ["bun.lock"], "bun run", "bunx"]
  ])("for %s with %j", (manifest, files, run, exec) => {
    expect(chooseRunner(manifest, files)).toEqual({ run, exec })
  })
})

describe("workspace patterns", () => {
  it("reads them from either file, pnpm's first", () => {
    expect(readWorkspacePatterns(`{"workspaces":["a/*"]}`, undefined)).toEqual(["a/*"])
    expect(readWorkspacePatterns(`{"workspaces":{"packages":["b/*"]}}`, undefined)).toEqual(["b/*"])
    expect(readWorkspacePatterns(`{"workspaces":["a/*"]}`, "packages:\n  - c/*\n")).toEqual(["c/*"])
  })

  it.each([
    [undefined, undefined],
    ["[1]", undefined],
    [`{"workspaces":7}`, undefined],
    [undefined, "- a list"],
    [undefined, "other: 1"],
    [undefined, "a: [unclosed"]
  ])("finds none in %s and %s", (manifest, pnpm) => {
    expect(readWorkspacePatterns(manifest, pnpm)).toEqual([])
  })

  it("splits patterns into walks, exclusions and ones it cannot read", () => {
    const globs = readGlobs([
      "packages/*",
      "./apps/**",
      "!packages/private-*",
      "!apps/**/old",
      "x/{a,b}",
      "y/?",
      "../z"
    ])
    expect(globs.include).toEqual([["packages", "*"], ["apps", "**"]])
    expect(globs.unreadable).toEqual(["x/{a,b}", "y/?", "../z"])
    expect(globs.exclude[0]?.test("packages/private-a")).toBe(true)
    expect(globs.exclude[0]?.test("packages/public")).toBe(false)
    expect(globs.exclude[1]?.test("apps/a/b/old")).toBe(true)
  })

  it("lets ** in an exclusion match no directories", () => {
    const [both, leading, all] = readGlobs(["!**/test/**", "!**/old", "!**"]).exclude
    for (const path of ["test", "components/test", "components/test/unit"]) expect(both?.test(path)).toBe(true)
    expect(both?.test("components/testing")).toBe(false)
    expect(leading?.test("old")).toBe(true)
    expect(all?.test("any/path")).toBe(true)
  })

  it("matches one path segment", () => {
    expect(segmentMatcher("plugin-*.x").test("plugin-a.x")).toBe(true)
    expect(segmentMatcher("plugin-*.x").test("plugin-aax")).toBe(false)
  })
})

describe("readTurbo", () => {
  it("makes a job of each task, reading comments and trailing commas", () => {
    const { jobs, toolchains } = readTurbo(
      "turbo.json",
      `{
      // the tasks
      "tasks": {
        "build": { "dependsOn": ["^build", "gen", "@a/b#gen", "constructor"] },
        "gen": {},
        "dev": { "persistent": true, "cache": false },
        "@a/b#test": null,
      },
    }`,
      bun
    )
    expect(toolchains).toEqual([{ name: "turbo", source: "turbo.json" }])
    expect(jobs[0]).toEqual({
      id: "turbo.json:build",
      source: "turbo",
      file: "turbo.json",
      name: "build",
      needs: ["turbo.json:gen"],
      triggers: [],
      matrix: [],
      steps: [{ id: "turbo.json:build:1", command: "bunx turbo run build", cwd: "", env: {}, secrets: [] }],
      unsupported: []
    })
    expect(jobs[2]?.unsupported[0]?.feature).toBe("long-running")
    expect(jobs[3]?.steps[0]?.command).toBe("bunx turbo run @a/b#test")
  })

  it("reads a task whose dependsOn is not a list as needing nothing", () => {
    expect(readTurbo("turbo.json", `{"tasks":{"a":{"dependsOn":7}}}`, bun).jobs[0]?.needs).toEqual([])
  })

  it("reads the older pipeline key", () => {
    expect(readTurbo("turbo.json", `{"pipeline":{"lint":{}}}`, bun).jobs[0]?.name).toBe("lint")
  })

  it.each([
    ["{ broken", "it is not a JSON object"],
    ["[]", "it is not a JSON object"],
    ["{}", "it has no tasks"]
  ])("reports %s", (text, reason) => {
    const { jobs, unsupported } = readTurbo("turbo.json", text, bun)
    expect(jobs).toEqual([])
    expect(unsupported).toEqual([{ feature: "malformed-file", detail: `turbo.json: ${reason}` }])
  })
})

describe("readToolFile", () => {
  it.each([
    [".nvmrc", "v22.1.0\n", "node", "v22.1.0"],
    [".bun-version", "1.3.0", "bun", "1.3.0"],
    ["rust-toolchain", "1.80.0\n", "rust", "1.80.0"],
    ["rust-toolchain.toml", `[toolchain]\nchannel = "1.81.0"\n`, "rust", "1.81.0"],
    ["go.mod", "module x\n\ngo 1.23.0\n", "go", "1.23.0"],
    ["build.zig.zon", `.{ .minimum_zig_version = "0.15.1" }`, "zig", "0.15.1"]
  ])("reads %s", (file, text, name, version) => {
    expect(toolFiles).toContain(file)
    expect(readToolFile(file, text)).toEqual([{ name, source: file, version }])
  })

  it("reads a rust-toolchain file written as TOML", () => {
    expect(readToolFile("rust-toolchain", `[toolchain]\nchannel = "1.82.0"\n`)[0]?.version).toBe("1.82.0")
    expect(readToolFile("rust-toolchain", `[toolchain]\nprofile = "minimal"\n`)[0]?.version).toBeUndefined()
  })

  it("records a tool with no readable version by name", () => {
    expect(readToolFile("flake.nix", "{}")).toEqual([{ name: "nix", source: "flake.nix" }])
    expect(readToolFile(".nvmrc", "\n")).toEqual([{ name: "node", source: ".nvmrc" }])
  })

  it("reads every tool in .tool-versions", () => {
    expect(readToolFile(".tool-versions", "# pins\nnodejs 22.1.0 # lts\n\nzig\nbun 1.3.0\n")).toEqual([
      { name: "nodejs", source: ".tool-versions", version: "22.1.0" },
      { name: "bun", source: ".tool-versions", version: "1.3.0" }
    ])
  })
})

describe("repositoryName", () => {
  it.each([
    ["https://github.com/owner/name.git", "owner/name"],
    ["https://x-access-token:SECRET@github.com/owner/name", "owner/name"],
    ["git@github.com:owner/name.git", "owner/name"],
    ["ssh://git@host:22/group/owner/name.git", "owner/name"]
  ])("reads %s", (remote, name) => {
    expect(repositoryName(remote, "fallback")).toBe(name)
  })

  it.each([[""], ["/local/path"], ["https://host/one"]])("falls back for %j", (remote) => {
    expect(repositoryName(remote, "fallback")).toBe("fallback")
  })
})

describe("secrets", () => {
  it.each([
    [token],
    [`github_pat_${"a".repeat(30)}`],
    [`sk-${"a".repeat(30)}`],
    ["xoxb-1234567890-abc"],
    ["AKIAABCDEFGHIJKLMNOP"],
    [`npm_${"a".repeat(36)}`],
    ["-----BEGIN RSA PRIVATE KEY-----"],
    ["postgres://user:hunter2@db.test/app"],
    ["postgres://user:pa$$word@db.test/app"],
    ["API_TOKEN=abc123"],
    [`MY_SECRET_VALUE="abc123"`],
    ["MYSQL_PWD=hunter2"],
    ["DB_PASS=hunter3"],
    ["SIGNING_KEY=abc"],
    ["export api_token=abc123"],
    [`curl -H "X-Api-Key: abc123" x.test`],
    ["curl -u admin:hunter2 x.test"],
    [`sk_live_${"a".repeat(20)}`],
    ["--password=abc123"],
    ["--token abc123"],
    ["Authorization: Bearer abc123def"],
    ["mysql -u root -phunter2"]
  ])("recognises %s", (value) => {
    expect(hasSecretValue(`before ${value} after`)).toBe(true)
    expect(scrub(`before ${value} after`)).toContain("[withheld]")
    expect(scrub(`before ${value} after`)).not.toContain(value)
  })

  it.each([
    ["task-with-a-very-long-name-that-goes-on"],
    ["postgres://user:$PASSWORD@db.test/app"],
    ["https://example.test/a:b@c"],
    ["API_TOKEN=$FROM_SHELL"],
    [`API_TOKEN="$FROM_SHELL"`],
    [`API_TOKEN=""`],
    ["MAX_TOKENS=100"],
    ["--token $TOKEN"],
    ["--password-stdin"],
    ["Authorization: Bearer $TOKEN"],
    ["mysql -u root -p$PASSWORD"],
    ["PASSWORD_FILE=/run/secrets/db"],
    ["TOKEN_LIMIT=100"],
    ["SECRET_NAME=app"],
    ["API_KEY_FILE=key.txt"],
    ["pass=0"],
    ["curl -u $USER:$PASS x.test"]
  ])("leaves %s alone", (value) => {
    expect(hasSecretValue(value)).toBe(false)
  })

  it("decides by name only for a written-out value", () => {
    expect(isLiteralSecret("API_KEY", "abc")).toBe(true)
    expect(isLiteralSecret("NODE_AUTH_TOKEN", "abc")).toBe(true)
    expect(isLiteralSecret("API_KEY", "")).toBe(false)
    expect(isLiteralSecret("API_KEY", "$ecret1")).toBe(true)
    expect(isLiteralSecret("API_KEY", "\${hunter2}")).toBe(true)
    expect(isLiteralSecret("GPG_PASSPHRASE", "abc")).toBe(true)
    expect(isLiteralSecret("NPMTOKEN", "abc")).toBe(true)
    expect(isLiteralSecret("auth", "none")).toBe(false)
    expect(isLiteralSecret("pass", "1")).toBe(false)
    expect(isLiteralSecret("TOKEN_FILE", "/run/token")).toBe(false)
    expect(isLiteralSecret("API_KEY", "\${{ matrix.key }}")).toBe(false)
    expect(isLiteralSecret("API_KEY", "pa$$word")).toBe(true)
    expect(isLiteralSecret("PGPASSWORD", "abc")).toBe(true)
    expect(isLiteralSecret("DB_PASS", "abc")).toBe(true)
    expect(isLiteralSecret("SIGNING_KEY", "abc")).toBe(true)
    expect(isLiteralSecret("MYSQL_PWD", "abc")).toBe(true)
    expect(isLiteralSecret("PWD", "/work")).toBe(false)
    expect(isLiteralSecret("MAX_TOKENS", "100")).toBe(false)
    expect(isLiteralSecret("TOKENIZERS_PARALLELISM", "false")).toBe(false)
    expect(isLiteralSecret("PLAIN", token)).toBe(true)
  })

  it("withholds the whole body of a private key", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----"
    expect(scrub(`a ${key} b`)).toBe("a [withheld] b")
    expect(scrub("-----BEGIN PRIVATE KEY-----\nMIIEabc")).toBe("[withheld]")
  })

  it("scrubs every string and key of a document and leaves other values", () => {
    expect(scrub({ a: [token, 1, null, true], [token]: { b: token } })).toEqual({
      a: ["[withheld]", 1, null, true],
      "[withheld]": { b: "[withheld]" }
    })
  })
})

describe("drafts", () => {
  const job = () => draft({ id: "x", source: "justfile", file: "f", name: "x" })

  it("keeps a repeated note once", () => {
    const value = job()
    note(value, "a", "b")
    note(value, "a", "b")
    note(value, "a", "c")
    expect(value.unsupported).toEqual([{ feature: "a", detail: "f: b" }, { feature: "a", detail: "f: c" }])
  })

  it("trims commands, numbers steps and defaults cwd", () => {
    const value = job()
    addStep(value, { where: "w", command: "  one \n" })
    addStep(value, { where: "w", command: "two", name: "Two", env: new Map([["A", "1"]]), secrets: ["S"], cwd: "d" })
    expect(value.steps).toEqual([
      { id: "x:1", command: "one", cwd: "", env: {}, secrets: [] },
      { id: "x:2", command: "two", cwd: "d", env: { A: "1" }, secrets: ["S"], name: "Two" }
    ])
  })

  it("records a problem with a whole file outside any job", () => {
    expect(fileProblem("f", "x", "why")).toEqual({
      jobs: [],
      toolchains: [],
      unsupported: [{ feature: "x", detail: "f: why" }]
    })
  })

  it("keeps a literal secret by the variable that receives it", () => {
    const value = job()
    addStep(value, { where: "w", command: "go", env: new Map([["API_KEY", "abc"]]) })
    expect(value.steps[0]).toMatchObject({ env: {}, secrets: ["API_KEY"], secretEnv: { API_KEY: "API_KEY" } })
  })

  it("assembles parts, keeping each tool once in a stable order and no credential anywhere", () => {
    const named = { ...job(), name: `deploy ${token}` }
    const inventory = assemble("o/r", "abc", [
      {
        jobs: [named],
        toolchains: [{ name: "zig", source: "b" }, { name: "bun", source: "a", version: "1" }],
        unsupported: []
      },
      {
        jobs: [],
        toolchains: [{ name: "bun", source: "a", version: "1" }],
        unsupported: [{ feature: "x", detail: `f: ${token}` }]
      }
    ])
    expect(inventory.unsupported).toEqual([{ feature: "x", detail: "f: [withheld]" }])
    expect(assemble("o/r", "abc", []).unsupported).toBeUndefined()
    expect(inventory.toolchains).toEqual([{ name: "bun", source: "a", version: "1" }, { name: "zig", source: "b" }])
    expect(inventory.jobs[0]?.name).toBe("deploy [withheld]")
    // Two jobs of one workflow that set up one version are two entries: each job has its version.
    const setups = [{ name: "node", source: "w", version: "20", job: "w:a" }, {
      name: "node",
      source: "w",
      version: "20",
      job: "w:b"
    }]
    expect(assemble("o/r", "abc", [{ jobs: [], toolchains: setups, unsupported: [] }]).toolchains).toEqual(setups)
    expect(inventory).toMatchObject({ version: 1, repository: "o/r", commit: "abc" })
  })
})

describe("values", () => {
  it("reads scalars", () => {
    expect([asScalar("a"), asScalar(1), asScalar(false), asScalar(null)]).toEqual(["a", "1", "false", ""])
    expect(asScalar([])).toBeUndefined()
    expect(asScalar(undefined)).toBeUndefined()
  })

  it("reads string lists", () => {
    expect(asStrings("a")).toEqual(["a"])
    expect(asStrings(["a", "b"])).toEqual(["a", "b"])
    expect(asStrings(["a", 1])).toBeUndefined()
    expect(asStrings({})).toBeUndefined()
  })

  it("tells mappings from other values", () => {
    expect([isRecord({}), isRecord([]), isRecord(null), isRecord("a")]).toEqual([true, false, false, false])
  })

  it("quotes only what a shell would read differently", () => {
    expect(shellQuote("a/b:c")).toBe("a/b:c")
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`)
    expect(shellQuote("#x")).toBe("'#x'")
    expect(shellQuote("-x")).toBe("'-x'")
    expect(shellWord("-x")).toBe("-x")
    expect(shellWord("a b")).toBe("'a b'")
    expect(shellQuote("a#x")).toBe("a#x")
  })

  it("normalizes directories inside the repository", () => {
    expect(normalizeDirectory("./a//b/../c/")).toBe("a/c")
    expect(normalizeDirectory(".")).toBe("")
    expect(normalizeDirectory("/tmp")).toBeUndefined()
    expect(normalizeDirectory("a/../..")).toBeUndefined()
  })
})
