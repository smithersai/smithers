import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as Audience from "../src/Audience.ts"
import * as Cli from "../src/Cli.ts"
import * as Diagnostic from "../src/Diagnostic.ts"
import type * as Executor from "../src/Executor.ts"
import * as GraphOutput from "../src/GraphOutput.ts"
import * as Label from "../src/Label.ts"
import * as Query from "../src/Query.ts"
import * as Reporter from "../src/Reporter.ts"
import * as Workspace from "../src/Workspace.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const fsExecutions = Math.min(executions, 8)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/build-cli core CLI, labels, reporters, diagnostics, workspace & end-to-end command fuzz invariants", () => {
  it("Label, Cli.normalizeArgv, Audience, Ansi, Diagnostic, Reporter, GraphOutput, Query & Workspace pure invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pkg: Schema.Literals(["", "packages/a", "apps/mvp", "packages/sub/dir"]),
        targetName: Schema.Literals(["build", "test", "lint", "run-1"]),
        labelInput: Schema.Literals([
          "//...",
          "//packages/...",
          "//packages/a:build",
          "//packages/a",
          ":test",
          "...",
          "//:all",
          "//packages/a:*",
          "//bad space:x",
          "///triple",
          ""
        ]),
        uiMode: Schema.Literals(["auto", "tty", "stream", "plain"]),
        isTTY: Schema.Boolean,
        noColor: Schema.Boolean,
        forceColor: Schema.Literals(["", "0", "1", "true"]),
        columns: Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 120 })),
        durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 300_000 })),
        verbose: Schema.Boolean,
        remoteUrl: Schema.Literals([
          "https://smithers.sh/smithersai/smithers.git",
          "git@jjhub.tech:smithersai/smithers.git",
          "ssh://git@smithers.sh/org/repo",
          "https://evil.example.com/org/repo.git",
          "not-a-url"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (
          { pkg, targetName, labelInput, uiMode, isTTY, noColor, forceColor, columns, durationMs, verbose, remoteUrl }
        ) =>
          Effect.sync(() => {
            const formatted = Label.format(pkg, targetName)
            const parsedFmt = Label.parse(formatted, pkg)
            if (parsedFmt._tag !== "Exact" || parsedFmt.packagePath !== pkg || parsedFmt.target !== targetName) {
              throw new Error("label roundtrip")
            }
            if (Label.isWildcard(parsedFmt)) throw new Error("exact label wildcard")

            try {
              const pat = Label.parse(labelInput, pkg)
              const wc = Label.isWildcard(pat)
              if (pat._tag === "Subtree" && pat.target === undefined && !wc) throw new Error("subtree not wc")
              if (pat._tag === "Exact" && pat.target === "*" && !wc) throw new Error("star not wc")
            } catch (e) {
              if (e instanceof Error && (e.message === "subtree not wc" || e.message === "star not wc")) throw e
            }

            const cp = Label.currentPackageOrUndefined("/work/ws", pkg === "" ? "/work/ws" : `/work/ws/${pkg}`)
            if (cp !== pkg) throw new Error("currentPackage mismatch")
            if (Label.currentPackageOrUndefined("/work/ws", "/other/dir") !== undefined) {
              throw new Error("outside package")
            }

            const norm1 = Cli.normalizeArgv(["build", labelInput, "--jobs", "4"])
            const norm2 = Cli.normalizeArgv(norm1)
            if (JSON.stringify(norm1) !== JSON.stringify(norm2)) throw new Error("normalizeArgv idempotence")

            const env: Record<string, string | undefined> = {
              ...(noColor ? { NO_COLOR: "1" } : {}),
              ...(forceColor ? { FORCE_COLOR: forceColor } : {}),
              TERM: isTTY ? "xterm-256color" : "dumb"
            }
            const policy = Audience.fromArguments(["build", "//..."], {
              env,
              stdout: isTTY,
              stderr: isTTY,
              verbose
            })
            const incurArgs = Audience.incurArguments(["build", "//..."], policy)
            if (!Array.isArray(incurArgs)) throw new Error("incurArgs")

            const pal = Ansi.palette(env, isTTY)
            const colored = `${pal.green("PASS")} ${pal.red("FAIL")} ${pal.dim(targetName)}`
            const stripped = Ansi.strip(colored)
            if (stripped.includes("\u001b[")) throw new Error("ansi strip")
            if (Ansi.visibleWidth(colored) !== [...stripped].length) throw new Error("ansi width")
            const trunc = Ansi.truncate(colored, columns)
            if (Ansi.visibleWidth(trunc) > columns) throw new Error("ansi truncate")
            if (Ansi.cursorUp(0) !== "" || !Ansi.cursorUp(3).includes("3A")) throw new Error("ansi cursorUp")

            const err = Diagnostic.error(new Error(`boom:${targetName}`))
            if (!err.message.includes(targetName)) throw new Error("diag error")
            if (Diagnostic.message("plain error").length === 0) throw new Error("diag message")
            if (Diagnostic.describe(err).length === 0) throw new Error("diag describe")
            if (Diagnostic.present(err, { verbose }).length === 0) throw new Error("diag present")
            if (Diagnostic.report(err, { verbose }).length === 0) throw new Error("diag report")

            const written: Array<string> = []
            const term: Reporter.Terminal = {
              write: (s) => {
                written.push(s)
              },
              isTTY,
              columns
            }
            const renderer = Reporter.resolveRenderer(uiMode, env, { stdout: isTTY, stderr: isTTY })
            if (!["tty", "stream", "plain"].includes(renderer)) throw new Error("renderer")
            if (Reporter.formatDuration(durationMs).length === 0) throw new Error("formatDuration")

            const sampleReport: Executor.TargetReport = {
              label: formatted,
              target: "Shell.Build",
              key: "a".repeat(64),
              status: "ran",
              durationMs,
              error: undefined
            }
            const line = Reporter.plainLine(sampleReport)
            if (!line.includes(formatted)) throw new Error("plainLine")

            const summary: Executor.Summary = {
              verb: "build",
              pattern: "//...",
              jobs: 2,
              ok: true,
              results: [sampleReport],
              counts: { hit: 1, ran: 1, failed: 0, skipped: 0 },
              durationMs,
              notStored: [{ reason: "cache: false", count: 1 }]
            }
            if (Reporter.plainSummary(summary).length === 0) throw new Error("plainSummary")
            Reporter.notStoredSummary(summary)
            Reporter.recorderSummary(summary)

            const rep = Reporter.make({ renderer, terminal: term, env, presentation: policy })
            rep.begin({
              verb: "build",
              pattern: "//...",
              jobs: 2,
              targets: [{ label: formatted, target: "Shell.Build" }]
            })
            rep.targetStarted(formatted)
            rep.toolOutput(formatted, "stdout", "compiling...\n")
            rep.note("note line")
            rep.warn("warn line")
            rep.targetFinished(sampleReport)
            rep.summary(summary)
            rep.close()

            const silentRep = Reporter.silent(term)
            silentRep.begin({
              verb: "test",
              pattern: "//...",
              jobs: 1,
              targets: [{ label: formatted, target: "Shell.Test" }]
            })
            silentRep.targetFinished(sampleReport)
            silentRep.summary(summary)
            silentRep.close()

            const graphRows: ReadonlyArray<GraphOutput.PackageRow> = [
              { label: "//:build", target: "Shell.Build" },
              { label: "//packages/a:build", target: "Shell.Build" }
            ]
            const graphEdges: ReadonlyArray<GraphOutput.PackageEdge> = [
              { from: "//:build", to: "//packages/a:build", kind: "data" }
            ]
            if (!GraphOutput.packageText(graphRows, graphEdges).includes("//:build")) throw new Error("graphText")
            if (!GraphOutput.packageMermaid(graphRows, graphEdges).includes("flowchart")) {
              throw new Error("graphMermaid")
            }
            const qText = Query.text({
              query: "//...",
              targets: [
                { label: "//:build", target: "Shell.Build", kinds: ["build"], summary: "Build root" },
                { label: "//packages/a:build", target: "Shell.Build", kinds: ["build"] }
              ]
            })
            if (!qText.includes("//:build")) throw new Error("queryText")

            const parsedRemote = Workspace.parseSmithersCloudRemote(remoteUrl)
            if (remoteUrl.includes("smithersai/smithers") && parsedRemote?.repo !== "smithersai/smithers") {
              throw new Error("parseSmithersCloudRemote")
            }
            if (remoteUrl === "not-a-url" && parsedRemote !== undefined) throw new Error("bad remote")
            const ep = Workspace.smithersCloudCacheEndpoint("smithersai/smithers", env)
            if (!ep.startsWith("https://")) throw new Error("smithersCloudCacheEndpoint")
            const withheld = Workspace.withheldEnvironment(
              { PATH: "/usr/bin", SMITHERS_CACHE_TOKEN: "secret" },
              undefined
            )
            if (withheld["SMITHERS_CACHE_TOKEN"] !== undefined) throw new Error("withheldEnvironment")
            return true
          }),
        { executions, seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("Real CLI serve() end-to-end across query, targets, index, graph, show, explain, build, test, run, ci, owners, git-hooks, cache, clean, info & doctor", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-buildcli-core-")))
    try {
      await write(
        tmpRoot,
        "WORKSPACE.ts",
        `import { Smithers as S } from "@smthrs/targets"
import { Package as Root } from "./PACKAGE.ts"
export const Workspace = S.Workspace("fuzzws", {
  repository: "git+https://example.invalid/fuzzws.git",
  cache: S.Cache({ directory: ".flows" }),
  teams: S.Teams({ core: ["alice", "bob"] }),
  gitHooks: { preCommit: Root.lint }
})
`
      )
      await write(
        tmpRoot,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const lib = S.Filegroup({ srcs: [S.glob("src/**/*.txt")] })
const build = S.Shell.Build({
  shell: "mkdir -p dist && cp src/hello.txt dist/hello.txt",
  data: [lib],
  outFiles: ["dist/hello.txt"],
  sandbox: "none"
})
const test = S.Shell.Test({
  shell: "test -f dist/hello.txt",
  data: [build],
  sandbox: "none"
})
const lint = S.Shell.Test({
  shell: "echo lint-ok",
  sandbox: "none"
})
const run = S.Shell.Run({
  shell: "echo run-ok",
  sandbox: "none"
})
const failTest = S.Shell.Test({
  shell: "exit 1",
  sandbox: "none"
})
const suite = S.Suite({ tests: [test] })
const alias = S.Alias(build)
const gen = S.Generate({ emit: { "dist/gen.txt": "generated\\n" }, mode: "write" })
const clean = S.Clean({ targets: [build], paths: ["dist"] })
const codeowners = S.Owners.Codeowners({ org: "acme" })
const ownersTree = S.Owners.Tree({})
const targetIndex = S.TargetIndex({})
const closure = S.ImportClosure({ entries: [S.file("src/entry.ts")] })
const docsCheck = S.Docs.Check({
  stamp: S.file("docs/guide.stamp.json"),
  output: S.file("docs/guide.md"),
  inputs: [S.file("src/hello.txt")],
  authored: true
})
export const Package = S.Package({
  owners: { owners: ["team:core"] },
  targets: { lib, build, test, lint, run, failTest, suite, alias, gen, clean, codeowners, ownersTree, targetIndex, closure, docsCheck }
})
`
      )
      await write(
        tmpRoot,
        "packages/sub/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const subBuild = S.Shell.Build({
  shell: "mkdir -p packages/sub/out && echo sub > packages/sub/out/sub.txt",
  data: [S.file("input.txt")],
  outFiles: ["out/sub.txt"],
  sandbox: "none"
})
const subTest = S.Shell.Test({
  shell: "test -f packages/sub/out/sub.txt",
  data: [subBuild],
  sandbox: "none"
})
export const Package = S.Package({
  owners: { owners: ["alice"] },
  targets: { build: subBuild, test: subTest }
})
`
      )
      await write(tmpRoot, "src/hello.txt", "hello world\n")
      await write(tmpRoot, "src/entry.ts", "export const x = 1\n")
      await write(tmpRoot, "docs/guide.md", "# Guide\n")
      await write(tmpRoot, "docs/guide.stamp.json", "{}\n")
      await write(tmpRoot, "packages/sub/input.txt", "sub input\n")
      execFileSync("jj", ["git", "init"], { cwd: tmpRoot, stdio: "ignore" })

      const commands: ReadonlyArray<{ readonly args: ReadonlyArray<string>; readonly expectOk: boolean }> = [
        { args: ["query", "//..."], expectOk: true },
        { args: ["query", "deps(//:test)"], expectOk: true },
        { args: ["query", "rdeps(//:build)"], expectOk: true },
        { args: ["query", "owners(//packages/sub:build)"], expectOk: true },
        { args: ["targets", "//..."], expectOk: true },
        { args: ["index", "//..."], expectOk: true },
        { args: ["graph", "//..."], expectOk: true },
        { args: ["graph", "//...", "--mermaid"], expectOk: true },
        { args: ["show", "target", "//:build"], expectOk: true },
        { args: ["show", "workspace"], expectOk: true },
        { args: ["explain", "//:build"], expectOk: true },
        { args: ["build", "//:build"], expectOk: true },
        { args: ["build", "//:build"], expectOk: true },
        { args: ["build", "//packages/sub:build"], expectOk: true },
        { args: ["target", "//:build"], expectOk: true },
        { args: ["test", "//:test"], expectOk: true },
        { args: ["test", "//:failTest"], expectOk: false },
        { args: ["run", "//:run"], expectOk: true },
        { args: ["target", "//:gen", "--write"], expectOk: true },
        { args: ["target", "//:gen"], expectOk: true },
        { args: ["target", "//:codeowners", "--write"], expectOk: true },
        { args: ["lint", "//:codeowners"], expectOk: true },
        { args: ["target", "//:ownersTree", "--write"], expectOk: true },
        { args: ["target", "//:targetIndex", "--write"], expectOk: true },
        { args: ["lint", "//:targetIndex"], expectOk: true },
        { args: ["build", "//:closure"], expectOk: true },
        { args: ["docs", "//:docsCheck"], expectOk: false },
        { args: ["ci", "//:build"], expectOk: true },
        { args: ["owners", "packages/sub/input.txt"], expectOk: true },
        { args: ["git-hooks"], expectOk: false },
        { args: ["git-hooks", "--write"], expectOk: true },
        { args: ["git-hooks"], expectOk: true },
        { args: ["cache", "status"], expectOk: true },
        { args: ["cache", "prune", "--dry-run"], expectOk: true },
        { args: ["info"], expectOk: true },
        { args: ["clean", "//:clean"], expectOk: true },
        { args: ["query", "//nonexistent:target"], expectOk: false }
      ]

      for (const { args, expectOk } of commands) {
        const res = await serve(tmpRoot, args)
        if (expectOk && res.exitCode !== 0) {
          throw new Error(`Command ${args.join(" ")} failed (exit ${res.exitCode}):\n${res.output}\n${res.logs}`)
        }
        if (!expectOk && res.exitCode === 0) {
          throw new Error(`Command ${args.join(" ")} unexpectedly succeeded:\n${res.output}`)
        }
      }

      const arb = Arbitrary.schema(
        Schema.Struct({
          verb: Schema.Literals(["query", "targets", "index", "graph", "explain", "build", "test"]),
          pattern: Schema.Literals(["//...", "//:build", "//:test", "//packages/sub:build", "//packages/..."]),
          json: Schema.Boolean,
          jobs: Schema.Literals([1, 2])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ verb, pattern, json, jobs }) =>
            Effect.gen(function*() {
              const args: Array<string> = [verb, pattern]
              if (verb === "build" || verb === "test") {
                args.push("--jobs", String(jobs))
              }
              if (json && (verb === "query" || verb === "targets" || verb === "index" || verb === "explain")) {
                args.push("--format", "json")
              }
              const res = yield* Effect.promise(() => serve(tmpRoot, args))
              if (!Number.isInteger(res.exitCode)) return false
              return true
            }),
          { executions: fsExecutions, seed: seed + 2 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
