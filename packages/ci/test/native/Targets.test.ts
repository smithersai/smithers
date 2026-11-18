import { describe, expect, it } from "vitest"
import type { Inventory, Job } from "../../src/contract/Inventory.ts"
import { chosenFor, covers, everything, notSelected, notTargets, patternsIn } from "../../src/native/index.ts"

const job = (id: string, commands: ReadonlyArray<string>, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps: commands.map((command, index) => ({ id: `${id}:${index + 1}`, command, cwd: "", env: {}, secrets: [] })),
  unsupported: [],
  ...extra
})

const inventory = (jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "test/own",
  commit: "0000000",
  toolchains: [],
  jobs
})

describe("patternsIn", () => {
  it("reads the patterns of smthrs ci, test, lint and build, quoted or not", () => {
    expect(patternsIn(`pnpm exec smthrs ci '//packages/a:*' "//packages/b/..." //:c --known-red x.json --verbose`))
      .toEqual(["//packages/a:*", "//packages/b/...", "//:c"])
    expect(patternsIn("node_modules/.bin/smthrs test //a:test")).toEqual(["//a:test"])
    expect(patternsIn("npx smithers-build lint //a/...")).toEqual(["//a/..."])
    expect(patternsIn(".smithers/node_modules/.bin/smthrs build --jobs 2 //a:lib")).toEqual(["//a:lib"])
  })

  it("reads every command of a script, and stops at what ends a command", () => {
    const script = "smthrs ci //a:x && echo //not:this\nsmthrs test //b:y | tee log; smthrs lint \\\n  //c:z"
    expect(patternsIn(script)).toEqual(["//a:x", "//b:y", "//c:z"])
    expect(patternsIn("(cd tools && smthrs ci //a/...)")).toEqual(["//a/..."])
    expect(patternsIn("smthrs ci //a/...>log.txt 2>&1")).toEqual(["//a/..."])
    expect(patternsIn("if smthrs lint //a/...; then echo ok; fi")).toEqual(["//a/..."])
  })

  it("reads the script a step is wrapped in, as the importer writes a workflow step", () => {
    const wrapped =
      `bash --noprofile --norc -eo pipefail -c 'pnpm exec smthrs ci '\\''//packages/ci:*'\\'' '\\''//packages/rpc:*'\\'' --known-red '\\''.github/ci-known-red.json'\\'' --verbose'`
    expect(patternsIn(wrapped)).toEqual(["//packages/ci:*", "//packages/rpc:*"])
    expect(patternsIn(`sh -c "cd x && smthrs test //a:test"`)).toEqual(["//a:test"])
    expect(patternsIn(`bash -c 'bash -c "smthrs lint //deep/..."'`)).toEqual(["//deep/..."])
    expect(patternsIn(`bash -c "smthrs ci \\"//a/...\\" \\"//b/...\\""`)).toEqual(["//a/...", "//b/..."])
    expect(patternsIn("sh -c")).toEqual([])
    expect(patternsIn("bash scripts/ci.sh //...")).toEqual([])
  })

  it("finds smthrs behind a package manager, a variable and its own options", () => {
    expect(patternsIn("CI=1 env FOO=2 npx smthrs test //a:test")).toEqual(["//a:test"])
    expect(patternsIn("pnpm exec -- smthrs lint //a/...")).toEqual(["//a/..."])
    expect(patternsIn("smthrs --silent ci //a/...")).toEqual(["//a/..."])
    expect(patternsIn("pnpm exec smthrs --ui plain ci //a/...")).toEqual(["//a/..."])
  })

  it("unquotes as a shell does", () => {
    expect(patternsIn(`smthrs ci //a'/b':c "//d"/... \\/\\/e:f`)).toEqual(["//a/b:c", "//d/...", "//e:f"])
    expect(patternsIn(`smthrs ci '//unclosed:quote`)).toEqual(["//unclosed:quote"])
    expect(patternsIn(`smthrs ci "//unclosed:double`)).toEqual(["//unclosed:double"])
    expect(patternsIn(`smthrs ci "//a\\b:c" "//d\\`)).toEqual(["//a\\b:c", "//d\\"])
    expect(patternsIn("smthrs ci\t//tab:separated")).toEqual(["//tab:separated"])
    expect(patternsIn("smthrs ci //a:x \\")).toEqual(["//a:x"])
    expect(patternsIn("smthrs ci //a#b:c")).toEqual(["//a#b:c"])
  })

  it("reads nothing from a comment or from the arguments of another program", () => {
    expect(patternsIn("# was: smthrs ci //legacy/...\nsmthrs ci //packages/...")).toEqual(["//packages/..."])
    expect(patternsIn("smthrs ci //a/... # TODO add //b/... once green")).toEqual(["//a/..."])
    expect(patternsIn("# smthrs ci //only/a/comment")).toEqual([])
    expect(patternsIn(`echo "reproduce with: smthrs ci //docs/..."`)).toEqual([])
    expect(patternsIn("echo smthrs test //x:y")).toEqual([])
    expect(patternsIn("mysmthrs ci //a:x")).toEqual([])
  })

  it("reads no pattern without a verb that runs targets, or from a variable", () => {
    expect(patternsIn("smthrs")).toEqual([])
    expect(patternsIn("smthrs --silent")).toEqual([])
    expect(patternsIn("smthrs && ci //a:x")).toEqual([])
    expect(patternsIn("smthrs explain //a:x")).toEqual([])
    expect(patternsIn("FOO=1")).toEqual([])
    expect(patternsIn("pnpm exec")).toEqual([])
    expect(patternsIn("")).toEqual([])
    expect(patternsIn("smthrs ci $TARGETS //$PACKAGE:test '//${{ matrix.package }}:test'")).toEqual([])
  })
})

describe("chosenFor", () => {
  const targets = job("ci.yml:targets", [
    "pnpm install",
    "pnpm exec smthrs ci '//a/...' '//b:*'",
    "smthrs test //a/..."
  ])
  const docs = job("ci.yml:docs", ["sh docs.sh"])
  const nightly = job("nightly.yml:all", ["smthrs ci //nightly/..."], { triggers: ["schedule"] })
  const grouping = job("ci.yml:done", [])

  it("replays what the jobs a change triggers give smthrs, each pattern once", () => {
    const chosen = chosenFor(inventory([targets, docs, nightly, grouping]))
    expect(chosen.patterns).toEqual(["//a/...", "//b:*"])
    expect(chosen.from).toBe("ci")
  })

  it("lists a CI job that runs no target as left out", () => {
    expect(chosenFor(inventory([targets, docs, nightly, grouping])).left).toEqual([{
      job: "ci.yml:docs",
      reasons: [{ feature: notTargets, detail: ".github/workflows/ci.yml: no step runs Smithers build targets" }]
    }])
  })

  it("fills a matrix into the patterns", () => {
    const matrix = job("ci.yml:each", ["smthrs ci //${{ matrix.package }}:test"], {
      matrix: [{ package: "a" }, { package: "b" }]
    })
    expect(chosenFor(inventory([matrix])).patterns).toEqual(["//a:test", "//b:test"])
  })

  it("replays every target when the CI names no pattern", () => {
    const wrapped = job("ci.yml:gate", ["sh scripts/ci.sh"])
    for (const jobs of [[], [nightly], [wrapped]]) {
      const chosen = chosenFor(inventory(jobs))
      expect(chosen.patterns).toEqual([everything])
      expect(chosen.from).toBe("default")
    }
    expect(everything).toBe("//...")
    expect(chosenFor(inventory([wrapped])).left.map((entry) => entry.job)).toEqual(["ci.yml:gate"])
  })

  it("replays the patterns asked for, and lists the jobs they do not cover", () => {
    const other = job("ci.yml:other", ["smthrs ci //b:*"])
    const chosen = chosenFor(inventory([targets, other, docs]), ["//b:*", "//b:*"])
    expect(chosen.patterns).toEqual(["//b:*"])
    expect(chosen.from).toBe("request")
    expect(chosen.left).toEqual([
      {
        job: "ci.yml:targets",
        reasons: [{
          feature: notSelected,
          detail: ".github/workflows/ci.yml: 1 of its 2 patterns are not among those asked for"
        }]
      },
      {
        job: "ci.yml:docs",
        reasons: [{ feature: notTargets, detail: ".github/workflows/ci.yml: no step runs Smithers build targets" }]
      }
    ])
  })

  it("covers every job with a pattern when everything is asked for, and takes no patterns as not asked", () => {
    expect(chosenFor(inventory([targets]), [everything]).left).toEqual([])
    expect(chosenFor(inventory([targets]), ["//a/...", "//b/..."]).left).toEqual([])
    expect(chosenFor(inventory([targets]), []).from).toBe("ci")
  })

  it("knows which patterns a pattern covers", () => {
    expect(covers("//a:test", "//a:test")).toBe(true)
    expect(covers("//...", "//a/b:test")).toBe(true)
    expect(covers("//a/...", "//a:*")).toBe(true)
    expect(covers("//a/...", "//a/b:test")).toBe(true)
    expect(covers("//a/...", "//a/b/...")).toBe(true)
    expect(covers("//a/...", "//ab:test")).toBe(false)
    expect(covers("//a:*", "//a:test")).toBe(true)
    expect(covers("//a:*", "//a/b:test")).toBe(false)
    expect(covers("//a:test", "//a:lint")).toBe(false)
  })
})
