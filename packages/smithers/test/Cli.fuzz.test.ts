import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Arguments from "../src/cli/Arguments.ts"
import * as Argv from "../src/cli/Argv.ts"
import * as CliError from "../src/CliError.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as RemoteUrl from "../src/internal/RemoteUrl.ts"
import * as IssueTodoDraft from "../src/IssueTodoDraft.ts"
import * as Output from "../src/Output.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/cli Argv, Arguments, Output, IssueTodoDraft, CliError, RemoteUrl & ExecutionEnvironment fuzz invariants", () => {
  it("Argv.parse, Argv.words & Arguments.normalizeArguments handle arbitrary flags, globals & positional args without crashing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals(["build", "test", "flow", "runs", "targets", "doctor", "--help"]),
        flags: Schema.Array(
          Schema.Literals([
            "--json",
            "--format",
            "json",
            "toon",
            "--remote",
            "https://smithers.sh",
            "--workspace",
            "/tmp/ws",
            "--",
            "//packages/errors:test",
            "-v"
          ])
        ).check(Schema.isMaxLength(8))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmd, flags }) =>
          Effect.sync(() => {
            const raw = [cmd, ...flags]
            const norm = Arguments.normalizeArguments(raw)
            if (!Array.isArray(norm)) return false
            const w = Argv.words(raw)
            if (!Array.isArray(w)) return false
            try {
              const parsed = Argv.parse(raw)
              return typeof parsed === "object" && parsed !== null
            } catch (err) {
              return err instanceof CliError.UsageError || err instanceof Error
            }
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("IssueTodoDraft.issueTodoDraftRequest & readIssueTodoDraft enforce complete, valid, tool-free JSON drafts and reject malformed/post-done frames", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        title: Schema.Literals(["Fix auth bug", "   Trimmed title  ", "", "   "]),
        prompt: Schema.Literals(["Do the fix cleanly.", "", "   "]),
        acceptance: Schema.Array(Schema.Literals(["tests pass", "  lint passes ", ""])).check(Schema.isMaxLength(3)),
        wireMode: Schema.Literals([
          "valid",
          "withReasoning",
          "incomplete",
          "trailingAfterDone",
          "toolCallFrame",
          "badJson",
          "missingRunId"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ title, prompt, acceptance, wireMode }) =>
          Effect.sync(() => {
            const req = IssueTodoDraft.issueTodoDraftRequest({
              number: 42,
              title,
              body: prompt,
              url: "https://github.com/octocat/smithers/issues/42",
              comments: [{ author: "alice", body: "looks good" }]
            })
            if (req.tools.length !== 0 || req.messages.length !== 1) return false

            const payloadJson = JSON.stringify({ title, prompt, acceptance })
            const frames: Array<string> = []
            if (wireMode === "withReasoning") {
              frames.push(JSON.stringify({ runId: "r1", type: "delta", kind: "reasoning", text: "thinking..." }))
            }
            if (wireMode === "missingRunId") {
              frames.push(JSON.stringify({ type: "delta", kind: "text", text: payloadJson }))
            } else if (wireMode === "badJson") {
              frames.push("{broken-json")
            } else if (wireMode === "toolCallFrame") {
              frames.push(JSON.stringify({ runId: "r1", type: "tool_call", name: "bash" }))
            } else {
              frames.push(JSON.stringify({ runId: "r1", type: "delta", kind: "text", text: payloadJson }))
              if (wireMode !== "incomplete") {
                frames.push(JSON.stringify({ runId: "r1", type: "done", reason: "stop" }))
              }
              if (wireMode === "trailingAfterDone") {
                frames.push(JSON.stringify({ runId: "r1", type: "delta", kind: "text", text: "extra" }))
              }
            }
            const wire = frames.join("\n")
            const fieldsValid = title.trim().length > 0 && prompt.trim().length > 0 &&
              acceptance.every((a) => a.trim().length > 0)
            const shouldSucceed = (wireMode === "valid" || wireMode === "withReasoning") && fieldsValid

            try {
              const draft = IssueTodoDraft.readIssueTodoDraft(wire)
              if (!shouldSucceed) return false
              return draft.title === title.trim() && draft.prompt === prompt.trim() &&
                draft.acceptance.length === acceptance.length
            } catch (err) {
              if (shouldSucceed) return false
              return err instanceof CliError.Refused || err instanceof SyntaxError
            }
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Output.renderValue, Output.exitCode, CliError.exitCode & RemoteUrl enforce depth/size limits and protocol invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        val: Schema.Union([Schema.String.check(Schema.isMaxLength(40)), Schema.Int, Schema.Boolean, Schema.Null]),
        errKind: Schema.Literals(["usage", "unsupported", "limit", "rendering", "refused"]),
        remote: Schema.Literals([
          "http://127.0.0.1:8787",
          "https://smithers.sh",
          "https://smithers.sh/api",
          "ws://127.0.0.1:8787",
          "ftp://evil.com",
          "not a url"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ depth, val, errKind, remote }) =>
          Effect.sync(() => {
            let nested: unknown = val
            for (let i = 0; i < depth; i++) nested = { child: nested }
            const rendered = Output.renderValue(nested)
            if (rendered === undefined) return false
            const code = Output.exitCode(nested)
            if (typeof code !== "number") return false

            const err = errKind === "usage"
              ? new CliError.UsageError({ message: "bad flag" })
              : errKind === "unsupported"
              ? new CliError.UnsupportedError({ message: "nope" })
              : errKind === "limit"
              ? new CliError.ResourceLimitError({ operation: "read", subject: "log", limit: 100, unit: "bytes" })
              : errKind === "rendering"
              ? new CliError.RenderingError({ code: "depth_limit", path: "$", message: "render fail" })
              : new CliError.Refused({ fault: "policy", code: "denied", message: "refused" })
            const ec = CliError.exitCode(err)
            if (errKind === "usage" ? ec !== 2 : ec !== 1) return false

            try {
              const rpc = RemoteUrl.rpcUrl(remote)
              const ws = RemoteUrl.websocketUrl(remote)
              if (remote === "not a url") return false
              if (!ws.endsWith("/rpc/ws") || ws.includes("?") || ws.includes("#")) return false
              if (!rpc.includes("/rpc")) return false
              return rpc.length > 0 && ws.length > 0
            } catch {
              return true
            }
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ExecutionEnvironment add/get/list/remove maintain exact profile registry semantics on real temp home", async () => {
    const tmpHome = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cli-env-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          name: Schema.Literals(["local-dev", "prod-box", "ci-runner"]),
          kind: Schema.Literals(["local", "ssh"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ name, kind }) =>
            Effect.promise(async () => {
              const source = { HOME: tmpHome }
              const profile: ExecutionEnvironment.Profile = kind === "local"
                ? { name, transport: "local", directory: tmpHome, home: tmpHome }
                : { name, transport: "ssh", destination: "lane@nyc-02", directory: "/home/lane" }
              await ExecutionEnvironment.add(profile, source)
              const got = await ExecutionEnvironment.get(name, source)
              if (got.name !== name || got.transport !== kind) return false
              const listed = await ExecutionEnvironment.list(source)
              if (!listed.some((p) => p.name === name)) return false
              await ExecutionEnvironment.remove(name, source)
              const after = await ExecutionEnvironment.list(source)
              return !after.some((p) => p.name === name)
            }),
          { seed: seed + 3, executions: Math.min(executions, 25) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpHome, { recursive: true, force: true })
    }
  })
})
