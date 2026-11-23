import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Result, Schema, Sink, Stream } from "effect"
import { isStandardCommand } from "effect/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"
import { Jj, Repository } from "../src/index.ts"
import { quoteGitPatchPaths } from "../src/internal/gitPatchPaths.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { makeRepository } from "./fixtures/repository.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const tokens = Arbitrary.schema(
  Schema.Literals(["a", "-", " ", "[", "]", "\"", "\\", "\t", "\r", "\n", "\0", "\x7f", "🦊", "e\u0301"])
)
const name = Arbitrary.array(tokens, { minLength: 1, maxLength: 9 }).pipe(Arbitrary.map((parts) => parts.join("")))
const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const check = async <A, E>(run: Effect.Effect<Fuzz.Report<A, E>, Fuzz.FuzzError>) => {
  const result = await Effect.runPromise(run)
  expect(result._tag, Fuzz.formatReport(result)).toBe("Passed")
}

// Decode the subset of Git's C-quoted tokens emitted for paths. Matching complete tokens
// makes unescaped control characters, ambiguous spaces, and extra fields observable.
const pathToken = /"(?:[^"\\\x00-\x1f\x7f]|\\(?:[nrt"\\]|[0-7]{3}))*"|[^\s"\\\x00-\x1f\x7f]+/gu
const namedEscapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\"": "\"", "\\": "\\" }
const decodeToken = (token: string) =>
  token.startsWith("\"")
    ? token.slice(1, -1).replace(/\\([nrt"\\]|[0-7]{3})/g, (_, escape: string) =>
      namedEscapes[escape] ?? String.fromCharCode(parseInt(escape, 8)))
    : token

it("normalizes multi-entry patch headers losslessly and rejects inconsistent path records", async () => {
  const changes = Arbitrary.array(
    Arbitrary.all({ from: name, to: name, op: Arbitrary.schema(Schema.Literals(["rename", "copy"])) }),
    { minLength: 1, maxLength: 4 }
  )
  await check(Fuzz.run(changes, (entries) =>
    Effect.gen(function*() {
      const metadata = entries.flatMap(({ from, to }) => [from, to]).map((path) => JSON.stringify(path)).join("\n") +
        "\n"
      const hunk = "@@ -1 +1 @@\n-diff --git a/x b/y\n++++ b/another\n"
      const raw = entries.map(({ from, to, op }) =>
        `diff --git a/${from} b/${to}\n${op} from ${from}\n${op} to ${to}\n--- a/${from}\n+++ b/${to}\n${hunk}`
      ).join("")
      const normalized = quoteGitPatchPaths(raw, metadata)
      expect(quoteGitPatchPaths(normalized, metadata)).toBe(normalized)
      const headers = normalized.split(hunk)
      expect(headers.pop()).toBe("")
      expect(headers).toHaveLength(entries.length)
      for (const [i, header] of headers.entries()) {
        const { from, to, op } = entries[i]!
        const lines = header.split("\n")
        const tokens = lines[0]!.slice("diff --git ".length).match(pathToken) ?? []
        expect(tokens.map(decodeToken)).toEqual([`a/${from}`, `b/${to}`])
        expect(lines[0]).toBe("diff --git " + tokens.join(" "))
        expect(lines.slice(3)).toEqual([`--- ${tokens[0]}`, `+++ ${tokens[1]}`, ""])
        expect(decodeToken(lines[1]!.slice(`${op} from `.length))).toBe(from)
        expect(decodeToken(lines[2]!.slice(`${op} to `.length))).toBe(to)
      }
      expect(() => quoteGitPatchPaths(raw, metadata + "\"extra\"\n")).toThrow(/Incomplete/)
      expect(() => quoteGitPatchPaths(raw, "\"wrong/path\"\n" + metadata.slice(metadata.indexOf("\n") + 1))).toThrow(
        /disagree/
      )
      yield* Fuzz.score("patch entries", entries.length)
      return true
    }), { seed, executions: pureExecutions, execution: FuzzSimulation.execution() }))
})

it("validates bookmark ref segments, byte boundaries and duplicate updates", async () => {
  await check(
    Fuzz.run(
      Arbitrary.all({
        length: int(1, 248),
        bad: Arbitrary.schema(Schema.Literals(["..", ".lock", ".", " ", "\0", "[", "🦊"]))
      }),
      ({ length, bad }) =>
        Effect.gen(function*() {
          const base = "refs/h/" + "a".repeat(length)
          expect(yield* Repository.requireRefs("readRefs", [base])).toEqual([base])
          for (const ref of [base + bad, base.replace("/h/", "//"), base.padEnd(256, "b")]) {
            expect(Repository.isRefName(ref)).toBe(false)
            expect((yield* Effect.flip(Repository.requireRefs("readRefs", [ref]))).code).toBe("invalid")
          }
          expect((yield* Effect.flip(Repository.requireRefs("readRefs", [base, base]))).code).toBe("invalid")
          return true
        }),
      { seed, executions: pureExecutions }
    )
  )
})

it("rejects the shrunk trailing-period ref while allowing a period inside the name", () => {
  expect(Repository.isRefName("refs/h/a.")).toBe(false)
  expect(Repository.isRefName("refs/h./a")).toBe(true)
})

let repo: string
const jj = (...args: Array<string>) =>
  execFileSync("jj", ["--color=never", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
beforeAll(() => {
  repo = makeRepository()
})
afterAll(() => {
  if (repo !== undefined) rmSync(repo, { recursive: true, force: true })
})

it("rejects invalid revision expressions in either diff endpoint before resolving them", async () => {
  const invalid = Arbitrary.all({
    suffix: name,
    lead: Arbitrary.schema(Schema.Literals(["book/", "(", "-", "@ | ", "::", "\0", "[", "\""]))
  })
  await check(
    Fuzz.run(invalid, ({ lead, suffix }) =>
      Effect.gen(function*() {
        const service = yield* Jj
        const revision = lead + suffix
        for (const pair of [["@", revision], [revision, "@-"]] as const) {
          const answer = yield* Effect.result(service.diff(pair[0], pair[1]))
          if (!Result.isFailure(answer)) return false
          expect(answer.failure).toMatchObject({ code: "invalid_ref", method: "diff" })
        }
        return true
      }), { seed, executions: pureExecutions }).pipe(Effect.provide(NodeJj.layerAt(repo)))
  )
})

// Feed a malformed log frame through the same spawner boundary that decodes real stdout.
const malformedLogLayer = (log: string) =>
  NodeJj.layerSpawnerAt(repo).pipe(Layer.provide(
    Layer.succeed(ChildProcessSpawner)(makeSpawner((command) =>
      Effect.sync(() => {
        if (!isStandardCommand(command)) throw new Error("unexpected pipeline")
        const [verb] = command.args
        const text = verb === "--version" ? "jj 0.39.0" : verb === "op" ? "abc" : verb === "log" ? log : undefined
        if (text === undefined) throw new Error("unexpected command")
        const stdout = Stream.make(new TextEncoder().encode(text))
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: Stream.empty,
          all: stdout,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    ))
  ))

const refusesLog = (log: string) =>
  Effect.gen(function*() {
    const service = yield* Jj
    const result = yield* Effect.result(service.snapshot())
    return Result.isFailure(result) && result.failure.code === "unknown" && result.failure.method === "snapshot"
  }).pipe(Effect.provide(malformedLogLayer(log)))

it("refuses missing, malformed and extra log records", async () => {
  expect(await Effect.runPromise(refusesLog("a\nz\n!"))).toBe(true)
  const output = Arbitrary.all({
    kind: Arbitrary.schema(Schema.Literals(["missing", "bad commit", "bad change", "extra"])),
    tail: Arbitrary.array(tokens, { maxLength: 8 }).pipe(Arbitrary.map((xs) => xs.join("")))
  })
  await check(Fuzz.run(output, ({ kind, tail }) =>
    Effect.gen(function*() {
      const frames = {
        missing: "a",
        "bad commit": "!" + tail + "\nz",
        "bad change": "a\n!" + tail,
        extra: "a\nz\n!" + tail
      }
      return yield* refusesLog(frames[kind])
    }), { seed, executions: pureExecutions }))
})

it("reads native status, snapshot log IDs and diffs for generated working copies", async () => {
  writeFileSync(join(repo, "base"), "parent tree\n")
  jj("new", "-m", "test working copy")
  const commit = jj("log", "--no-graph", "-r", "@-", "-T", "commit_id.short(12)")
  const change = jj("log", "--no-graph", "-r", "@-", "-T", "change_id.short(12)")
  // Bare symbols with these names now point to the working copy. Only an ID lookup selects its parent.
  jj("bookmark", "set", commit, change, "-r", "@")
  const sample = Arbitrary.all({
    path: name,
    value: int(0, 65535),
    operation: Arbitrary.schema(Schema.Literals(["status", "snapshot", "commit diff", "change diff"]))
  })
  await check(
    Fuzz.run(sample, ({ path, value, operation }) =>
      Effect.gen(function*() {
        const service = yield* Jj
        // Keep illegal filename characters in the in-memory patch tests.
        const illegal = process.platform === "win32" ? /[\x00-\x1f"\\]/g : /\0/g
        const filename = "-" + path.replace(illegal, "_") + ".txt"
        const file = join(repo, filename)
        const line = "line " + value
        writeFileSync(file, line + "\n")
        try {
          switch (operation) {
            case "status":
              expect(yield* service.status()).toEqual(jj("status"))
              break
            case "snapshot": {
              const snapshot = yield* service.snapshot()
              expect(snapshot.operationId).toEqual(jj("op", "log", "-n1", "--no-graph", "-T", "id"))
              const ids = jj(
                "log",
                "--at-op",
                snapshot.operationId!,
                "-r",
                "@",
                "--no-graph",
                "-T",
                "commit_id ++ \":\" ++ change_id.short()"
              )
              expect([snapshot.commitId, snapshot.changeId]).toEqual(ids.split(":"))
              break
            }
            default: {
              const patch = yield* service.diff(operation === "commit diff" ? commit : change, "@")
              expect(patch.split("\n")).toContain("+" + line)
              expect(patch.split("\n")).not.toContain("+parent tree")
            }
          }
          return true
        } finally {
          rmSync(file, { force: true })
        }
      }), { seed, executions: ioExecutions }).pipe(Effect.provide(NodeJj.layerAt(repo)))
  )
})
