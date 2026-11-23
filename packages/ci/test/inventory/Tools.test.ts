import { describe, expect, it } from "vitest"
import {
  type Inventory,
  type Job,
  missingTool,
  otherSystem,
  selfHosted,
  type Toolchain
} from "../../src/contract/Inventory.vibe"
import {
  differs,
  type Found,
  neededTools,
  onMachine,
  programsOf,
  systemName,
  thisMachine,
  versionIn
} from "../../src/inventory/Tools.ts"

const file = ".github/workflows/ci.yml"

const job = (key: string, fields: Partial<Job> = {}): Job => ({
  id: `ci.yml:${key}`,
  source: "github-actions",
  file,
  name: key,
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps: [{ id: `ci.yml:${key}:1`, command: "true", cwd: "", env: {}, secrets: [] }],
  unsupported: [],
  ...fields
})

const tool = (name: string, key: string, version?: string): Toolchain => ({
  name,
  source: file,
  job: `ci.yml:${key}`,
  action: `acme/setup-${name}@v1`,
  ...(version === undefined ? {} : { version })
})

const inventory = (jobs: ReadonlyArray<Job>, toolchains: ReadonlyArray<Toolchain> = []): Inventory => ({
  version: 1,
  repository: "r",
  commit: "c",
  toolchains,
  jobs
})

const have = (tools: Readonly<Record<string, string | undefined>>): ReadonlyMap<string, Found> =>
  new Map(Object.entries(tools).map(([name, version]) => [name, { program: name, version }]))

describe("what answers for a tool", () => {
  it("is the tool's own name unless its program has another", () => {
    expect(programsOf("ruby")).toEqual(["ruby"])
    expect(programsOf("python")).toEqual(["python3", "python"])
    expect(programsOf("rust")).toEqual(["cargo"])
    expect(programsOf("nextest")).toEqual(["cargo-nextest"])
  })

  it("reads the version out of what a program prints", () => {
    expect(versionIn("v26.5.0\n")).toBe("26.5.0")
    expect(versionIn("go version go1.25.4 linux/amd64")).toBe("1.25.4")
    expect(versionIn("ruby 3.4.6 (2025-09-16 revision dbd83256b1) +PRISM [x86_64-linux]")).toBe("3.4.6")
    expect(versionIn("openjdk 21.0.4 2024-07-16")).toBe("21.0.4")
    expect(versionIn("uv 0.9")).toBe("0.9")
    expect(versionIn("usage: tool [flags]")).toBeUndefined()
    expect(versionIn("")).toBeUndefined()
  })

  it("names this machine by its operating system", () => {
    expect(thisMachine()).toEqual({ host: process.platform })
    expect(systemName("linux")).toBe("Linux")
    expect(systemName("darwin")).toBe("macOS")
    expect(systemName("win32")).toBe("Windows")
    expect(systemName("freebsd")).toBe("freebsd")
  })
})

describe("differs", () => {
  it("compares the numbers a version asks for, and no more", () => {
    expect(differs("22", "26.5.0")).toBe(true)
    expect(differs("26", "26.5.0")).toBe(false)
    expect(differs("22.x", "22.11.0")).toBe(false)
    expect(differs("22.x", "26.5.0")).toBe(true)
    expect(differs("1.23", "1.23.4")).toBe(false)
    expect(differs("1.23", "1.25.4")).toBe(true)
    expect(differs("3.4.6", "3.4.6")).toBe(false)
    expect(differs("3.4.6", "3.4")).toBe(true)
    expect(differs("v20.1", "20.1.0")).toBe(false)
    expect(differs("3.15t", "3.12.3")).toBe(true)
  })

  it("reads a caret as that first number from the version on, and a tilde as the first two", () => {
    expect(differs("^1.22", "1.25.4")).toBe(false)
    expect(differs("^1.22", "1.22")).toBe(false)
    expect(differs("^1.22", "2.0.0")).toBe(true)
    expect(differs("^1.22", "1.18.0")).toBe(true)
    expect(differs("^1.22.3", "1.22")).toBe(true)
    expect(differs("~3.4.1", "3.4.6")).toBe(false)
    expect(differs("~3.4.1", "3.4.1")).toBe(false)
    expect(differs("~3.4.1", "3.5.0")).toBe(true)
    expect(differs("~3.4.1", "3.4.0")).toBe(true)
    expect(differs("~3", "3.9.1")).toBe(false)
    expect(differs("~3", "4.0.0")).toBe(true)
  })

  it("never differs from a name or a range, which give no number to compare", () => {
    for (const asked of ["latest", "stable", "lts/*", "nightly", ">=3.9", "pypy-3.11", "", "${{ matrix.node }}"]) {
      expect(differs(asked, "1.2.3")).toBe(false)
    }
  })
})

describe("neededTools", () => {
  it("lists each tool a CI job with a variant on this system sets up, once", () => {
    const read = inventory(
      [
        job("test"),
        job("lint"),
        job("mac", { runsOn: "macos-latest" }),
        job("both", { runsOn: "${{ matrix.os }}", matrix: [{ os: "macos-latest" }, { os: "ubuntu-latest" }] }),
        job("self", { runsOn: "self-hosted" }),
        job("nowhere", { runsOn: undefined as never }),
        job("nightly", { triggers: ["schedule"] }),
        job("scan", { unsupported: [{ feature: "uses", detail: "an action with no command" }] }),
        job("after-scan", { needs: ["ci.yml:scan"] })
      ],
      [
        tool("node", "test", "22"),
        tool("node", "lint", "24"),
        tool("swift", "mac"),
        tool("go", "both"),
        tool("zig", "self"),
        tool("just", "nowhere"),
        tool("ruby", "nightly"),
        tool("java", "scan"),
        tool("deno", "after-scan"),
        { name: "bun", source: ".bun-version", version: "1.3.0" }
      ]
    )
    // A job that is not CI, one something else stops, and one that needs it, are not asked about.
    // A job for a self-hosted runner is not run here, so its tools are not asked about either.
    expect(neededTools(read, "linux")).toEqual(["node", "go", "just"])
    expect(neededTools(read, "darwin")).toEqual(["swift", "go", "just"])
  })
})

describe("onMachine", () => {
  it("leaves out a job for a self-hosted runner and says which runner", () => {
    const read = inventory([job("self", { runsOn: "self-hosted,gpu" }), job("test")], [])
    const [self, test] = onMachine(read, "linux", new Map()).jobs
    expect(self?.unsupported).toEqual([{
      feature: selfHosted,
      detail: `${self?.file}: ${self?.name} runs on the self-hosted runner self-hosted,gpu`
    }])
    expect(test?.unsupported).toEqual([])
  })

  it("keeps a job with a variant here and leaves its self-hosted variant to the replay", () => {
    const read = inventory([job("both", {
      runsOn: "${{ matrix.os }}",
      matrix: [{ os: "self-hosted" }, { os: "ubuntu-latest" }]
    })], [])
    expect(onMachine(read, "linux", new Map()).jobs[0]?.unsupported).toEqual([])
  })

  it("leaves an inventory as it is when the machine has every tool at the version asked for", () => {
    const read = inventory([job("test")], [tool("node", "test", "26.x"), tool("uv", "test")])
    expect(onMachine(read, "linux", have({ node: "26.5.0", uv: "0.9.7" }))).toEqual(read)
  })

  it("marks a job that sets up a tool the machine lacks with what to install", () => {
    const read = inventory(
      [job("build"), job("docs"), job("nightly", { triggers: ["schedule"] })],
      [
        tool("go", "build", "1.23"),
        tool("ruby", "build", "3.4.6"),
        tool("ruby", "build", "3.4.6"),
        tool("node", "build", "22"),
        tool("zig", "docs"),
        tool("ruby", "nightly", "3.3")
      ]
    )
    const marked = onMachine(read, "linux", have({ node: "22.11.0" }))
    expect(marked.jobs[0]?.unsupported).toEqual([
      { feature: missingTool, detail: "go 1.23" },
      { feature: missingTool, detail: "ruby 3.4.6" }
    ])
    expect(marked.jobs[1]?.unsupported).toEqual([{ feature: missingTool, detail: "zig" }])
    // A job that is not CI is never run, so it is not asked about.
    expect(marked.jobs[2]).toEqual(read.jobs[2])
    expect(marked.toolVersions).toBeUndefined()
  })

  it("asks nothing about a job something else stops: its tool would not make it run", () => {
    const read = inventory(
      [
        job("scan", { unsupported: [{ feature: "uses", detail: "an action with no command" }] }),
        job("after", {
          needs: ["ci.yml:scan"]
        })
      ],
      [tool("go", "scan", "1.23"), tool("node", "after", "22")]
    )
    expect(onMachine(read, "linux", have({ node: "26.5.0" }))).toEqual(read)
    expect(neededTools(read, "linux")).toEqual([])
  })

  it("names a missing tool without a version when the variants here ask for several", () => {
    const read = inventory(
      [job("test", { matrix: [{ node: "22" }, { node: "24" }] })],
      [tool("node", "test", "${{ matrix.node }}")]
    )
    expect(onMachine(read, "linux", have({})).jobs[0]?.unsupported).toEqual([{ feature: missingTool, detail: "node" }])
  })

  it("lists a tool the machine has at another version, once for each version asked for, and keeps the job", () => {
    const read = inventory(
      [
        job("test", {
          runsOn: "${{ matrix.os }}",
          matrix: [
            { os: "ubuntu-latest", node: "22.x" },
            { os: "ubuntu-latest", node: "26.x" },
            { os: "ubuntu-latest", node: "22.x", extra: "1" },
            { os: "macos-latest", node: "18.x" },
            { os: "ubuntu-latest" }
          ]
        }),
        job("lint")
      ],
      [tool("node", "test", "${{ matrix.node }}"), tool("go", "lint", "1.23"), tool("just", "lint", "1.40")]
    )
    const marked = onMachine(read, "linux", have({ node: "26.5.0", go: "1.25.4", just: undefined }))
    expect(marked.jobs).toEqual(read.jobs)
    // The macOS variant's version is not asked about here, and a variant that names no version asks for none.
    expect(marked.toolVersions).toEqual([
      { job: "ci.yml:test", tool: "node", asked: "22.x", found: "26.5.0" },
      { job: "ci.yml:lint", tool: "go", asked: "1.23", found: "1.25.4" }
    ])
  })

  it("marks a job no variant of which runs on this system, once for each system it runs on", () => {
    const read = inventory(
      [
        job("mac", { name: "Tests", runsOn: "macos-latest" }),
        job("others", {
          runsOn: "${{ matrix.os }}",
          matrix: [{ os: "macos-15" }, { os: "windows-latest" }, { os: "macos-14" }]
        }),
        job("both", { runsOn: "${{ matrix.os }}", matrix: [{ os: "macos-latest" }, { os: "ubuntu-latest" }] })
      ],
      [tool("swift", "mac"), tool("node", "both")]
    )
    const marked = onMachine(read, "linux", have({ node: "26.5.0" }))
    expect(marked.jobs[0]?.unsupported).toEqual([
      { feature: otherSystem, detail: `${file}: Tests runs on macOS; this machine is Linux` }
    ])
    expect(marked.jobs[1]?.unsupported).toEqual([
      { feature: otherSystem, detail: `${file}: others runs on macOS; this machine is Linux` },
      { feature: otherSystem, detail: `${file}: others runs on Windows; this machine is Linux` }
    ])
    // A job with a variant here is left as it is: the replay lists its other variants one by one.
    expect(marked.jobs[2]).toEqual(read.jobs[2])
    expect(onMachine(read, "darwin", have({ swift: "6.0", node: "26.5.0" })).jobs).toEqual(read.jobs)
  })
})
