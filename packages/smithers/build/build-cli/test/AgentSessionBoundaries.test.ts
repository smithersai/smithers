import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as EffectNodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Input from "@smthrs/targets/Input"
import * as Reference from "@smthrs/targets/Reference"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"
import { FilePublicationHost, filePublicationHostLive } from "../src/internal/FilePublicationHost.ts"
import { writeExecutable } from "./helpers/Executable.ts"

let root: string
let bin: string

const git = (...args: ReadonlyArray<string>): void => {
  execFileSync("git", ["-c", "user.email=test@test", "-c", "user.name=test", ...args], {
    cwd: root,
    stdio: "pipe"
  })
}

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const read = (relative: string): Promise<string> => Fs.readFile(NodePath.join(root, relative), "utf8")

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-bounds-")))
  bin = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-bin-")))
  await write("prompt.md", "Reject any added TODO comment.\n")
  await write("src/a.ts", "export const a = 1\n")
  await write("docs/readme.md", "readme\n")
  git("init", "-q")
  git("config", "core.autocrlf", "false")
  git("add", "-A")
  git("commit", "-q", "-m", "initial")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(bin, { recursive: true, force: true })
})

const scripted = (responses: ReadonlyArray<AgentFake.ScriptedResponse>): AgentFake.ScriptedSessionFactory =>
  AgentFake.makeScriptedSessionFactory({ responses })

const runtimeOf = (
  overrides: Partial<AgentSession.AgentRuntime> & { readonly sessions: AgentSession.SessionFactory }
): AgentSession.AgentRuntime => ({
  workspaceRoot: root,
  writeSets: AgentSession.makeLocalWriteSetApplier(root),
  gates: AgentSession.unavailableGateRunner,
  verdicts: AgentSession.makeMemoryVerdictStore(),
  ...overrides
})

const lintPayload = (over: Partial<AgentTarget.LintPayload> = {}): AgentTarget.LintPayload => ({
  promptPath: "prompt.md",
  diffs: [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })],
  fixes: ["src/**"],
  mode: "check",
  ...over
})

const diffPayload = (over: Partial<AgentTarget.DiffPayload> = {}): AgentTarget.DiffPayload => ({
  promptPath: "prompt.md",
  payloadSpec: {},
  mcp: [],
  diffs: [],
  changes: ["src/**"],
  gateIdentities: ["Vitest#gate"],
  maxRounds: 3,
  ...over
})

const red: AgentTarget.GateReportEntry = { gate: "Vitest#gate", status: "red" }
const green: AgentTarget.GateReportEntry = { gate: "Vitest#gate", status: "green" }

const claudeOnly = AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) })
const codexOnly = AgentTarget.Agents({ default: AgentTarget.Codex({ model: "m" }) })

/** A shell CLI fixture outside the workspace. */
const fakeCli = (name: string, script: string): Promise<string> =>
  writeExecutable(NodePath.join(bin, name), `#!/bin/sh\n${script}\n`)

const sessionFailure = async (
  agents: AgentTarget.AgentsDeclaration,
  executables: { readonly claude?: string; readonly codex?: string }
): Promise<AgentTarget.AgentSessionError> => {
  const session = await Effect.runPromise(
    AgentSession.makeCliSessionFactory({ workspaceRoot: root, agents, executables, timeoutMs: 10_000 }).open(undefined)
  )
  return Effect.runPromise(Effect.flip(session.run({ purpose: "lint", prompt: "p" })))
}

describe("agent resolution of inline selectors", () => {
  it("resolves an inline claude or codex agent without any workspace declaration", () => {
    expect(AgentSession.resolveAgents(undefined, AgentTarget.ClaudeCode({ model: "c-1" }))).toEqual([
      { name: "inline:c-1", engine: "claude", model: "c-1" }
    ])
    expect(AgentSession.resolveAgents(undefined, AgentTarget.Codex({ model: "x-1" }))).toEqual([
      { name: "inline:x-1", engine: "codex", model: "x-1" }
    ])
  })

  it("expands an inline pool against workspace siblings in its own order", () => {
    const agents = AgentTarget.Agents({
      luna: AgentTarget.ClaudeCode({ model: "claude-luna" }),
      sol: AgentTarget.Codex({ model: "codex-sol" })
    })
    expect(AgentSession.resolveAgents(agents, AgentTarget.Pool(["sol", "luna", "sol"]))).toEqual([
      { name: "sol", engine: "codex", model: "codex-sol" },
      { name: "luna", engine: "claude", model: "claude-luna" }
    ])
  })

  it("names the inline pool, not a workspace agent, when it resolves to nothing", () => {
    const agents = AgentTarget.Agents({ loop: AgentTarget.Pool(["loop"]) })
    expect(() => AgentSession.resolveAgents(agents, AgentTarget.Pool(["loop"]))).toThrow(
      "the inline agent pool [loop] resolves to no concrete agent"
    )
  })
})

describe("CLI session failures", () => {
  it("reports a CLI killed by a signal with its stderr and the signal name", async () => {
    const claude = await fakeCli("killed-claude", "cat > /dev/null\necho 'about to die' >&2\nkill -9 $$")
    const error = await sessionFailure(claudeOnly, { claude })
    expect(error.phase).toBe("spawn")
    expect(error.message).toContain(`${claude} exited -1: about to die`)
    expect(error.message).toContain("subprocess terminated by SIGKILL")
  })

  it("refuses a claude envelope whose result is not text", async () => {
    const claude = await fakeCli("numeric-claude", "cat > /dev/null\necho '{\"result\": 5}'")
    const error = await sessionFailure(claudeOnly, { claude })
    expect(error.message).toContain("unexpected claude CLI output: {\"result\": 5}")
  })

  const codexLines = [
    { type: "item.completed", item: null },
    { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
    { type: "item.completed", item: { type: "agent_message", text: 7 } },
    { type: "item.completed", item: { type: "agent_message" } }
  ].map((line) => JSON.stringify(line))

  it("ignores codex items that are not agent_message text", async () => {
    const answer = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ note: "kept" }) }
    })
    await Fs.writeFile(NodePath.join(bin, "stream.jsonl"), [...codexLines, answer, ...codexLines].join("\n"))
    const codex = await fakeCli(
      "mixed-codex",
      `cat > /dev/null\ncat ${JSON.stringify(NodePath.join(bin, "stream.jsonl"))}`
    )
    const session = await Effect.runPromise(
      AgentSession.makeCliSessionFactory({ workspaceRoot: root, agents: codexOnly, executables: { codex } }).open(
        undefined
      )
    )
    expect((await Effect.runPromise(session.run({ purpose: "lint", prompt: "p" }))).note).toBe("kept")
  })

  it("refuses a codex stream that carries no agent_message text", async () => {
    await Fs.writeFile(NodePath.join(bin, "stream.jsonl"), codexLines.join("\n"))
    const codex = await fakeCli(
      "silent-codex",
      `cat > /dev/null\ncat ${JSON.stringify(NodePath.join(bin, "stream.jsonl"))}`
    )
    const error = await sessionFailure(codexOnly, { codex })
    expect(error.message).toContain("unexpected codex CLI output: {\"type\":\"item.completed\",\"item\":null}")
  })

  it("prefers codex stderr over stdout events on a non-zero exit", async () => {
    const codex = await fakeCli(
      "stderr-codex",
      "cat > /dev/null\necho '{\"type\":\"error\",\"message\":\"stdout event\"}'\necho 'model refused' >&2\nexit 2"
    )
    const error = await sessionFailure(codexOnly, { codex })
    expect(error.message).toContain(`${codex} exited 2: model refused`)
    expect(error.message).not.toContain("stdout event")
  })

  it("falls back to the last 1024 stdout characters when codex reports no error event", async () => {
    const codex = await fakeCli(
      "noisy-codex",
      "cat > /dev/null\nprintf 'HEAD'\nhead -c 3000 /dev/zero | tr '\\0' z\nexit 3"
    )
    const error = await sessionFailure(codexOnly, { codex })
    expect(error.message).toContain(`${codex} exited 3: …${"z".repeat(1024)}`)
    expect(error.message).not.toContain("HEAD")
  })

  it("collects codex error events once each, skipping non-object and unparseable lines", () => {
    const stdout = [
      "42",
      "null",
      "not json",
      JSON.stringify({ type: "error", message: "rate limited" }),
      JSON.stringify({ type: "error", message: "rate limited" }),
      JSON.stringify({ type: "turn.failed", error: { message: "turn aborted" } }),
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "bad model" } }),
      JSON.stringify({ type: "error", message: "" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", message: "ignored" } })
    ].join("\n")
    expect(AgentSession.codexErrorMessages(stdout)).toEqual(["rate limited", "turn aborted", "bad model"])
  })

  it("runs the engine's default executable from the injected PATH under the default deadline", async () => {
    await writeExecutable(
      NodePath.join(bin, "claude"),
      "#!/bin/sh\ncat > /dev/null\necho '{\"result\": \"{\\\\\"note\\\\\": \\\\\"default claude\\\\\"}\"}'\n"
    )
    const session = await Effect.runPromise(
      AgentSession.makeCliSessionFactory({
        workspaceRoot: root,
        agents: claudeOnly,
        environment: { PATH: [bin, "/usr/bin", "/bin"].join(NodePath.delimiter) }
      }).open(undefined)
    )
    expect((await Effect.runPromise(session.run({ purpose: "lint", prompt: "p" }))).note).toBe("default claude")
  })
})

describe("diff slice expansion", () => {
  it("fails typed with git's diagnostic for an unknown base", async () => {
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "no-such-ref", paths: ["src/**"] })]))
    )
    expect(error.phase).toBe("diff")
    expect(error.message).toMatch(/^git exited 128: /)
    expect(error.message).toContain("no-such-ref")
  })

  it("fails typed when git cannot be spawned", async () => {
    const error = await Effect.runPromise(Effect.flip(AgentSession.expandDiffSlice(
      root,
      [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })],
      10_000,
      { environment: { PATH: bin } }
    )))
    expect(error.phase).toBe("diff")
    expect(error.message).toContain("ENOENT")
  })

  it("refuses an addedLines pattern that is not a regular expression", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const error = await Effect.runPromise(Effect.flip(
      AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD", paths: ["src/**"], addedLines: "(" })])
    ))
    expect(error.phase).toBe("diff")
    expect(error.message).toMatch(/^addedLines is not a usable pattern: Invalid regular expression/)
  })

  it("matches //-prefixed globs from the workspace root and takes every change without globs", async () => {
    await write("src/a.ts", "export const a = 2\n")
    await write("docs/readme.md", "changed\n")
    const rooted = await Effect.runPromise(
      AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD", paths: ["//docs/**"] })])
    )
    expect(rooted.files).toEqual(["docs/readme.md"])
    const everything = await Effect.runPromise(AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD" })]))
    expect(everything.files).toEqual(["docs/readme.md", "src/a.ts"])
  })

  it("never matches addedLines in a deleted file", async () => {
    await write("src/b.ts", "// TODO stays\n")
    git("add", "-A")
    git("commit", "-q", "-m", "b")
    await Fs.rm(NodePath.join(root, "src/b.ts"))
    const slice = await Effect.runPromise(
      AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD", paths: ["src/**"], addedLines: "TODO" })])
    )
    expect(slice.files).toEqual([])
    expect(slice.patch).toBe("")
  })

  it.each([false, true])(
    "renders bases in name order whatever the declaration order (reversed=%s)",
    async (reversed) => {
      await write("docs/readme.md", "second\n")
      git("commit", "-qam", "second")
      await write("src/a.ts", "export const a = 3\n")
      await write("docs/readme.md", "third\n")
      const diffs = [
        Input.gitDiff({ base: "HEAD~1", paths: ["docs/**"] }),
        Input.gitDiff({ base: "HEAD", paths: ["src/**"] })
      ]
      const slice = await Effect.runPromise(AgentSession.expandDiffSlice(root, reversed ? diffs.reverse() : diffs))
      expect(slice.files).toEqual(["docs/readme.md", "src/a.ts"])
      // "HEAD" sorts before "HEAD~1", so the src patch against HEAD comes first.
      expect(slice.patch.indexOf("+export const a = 3")).toBeLessThan(slice.patch.indexOf("-readme"))
    }
  )
})

describe("diff slice against a scripted git", () => {
  /**
   * A git stand-in on the injected PATH: `--name-only` lists FAKE_LIST, other
   * diffs sleep FAKE_SLEEP_MS and then print FAKE_PATCH or FAKE_BYTES bytes.
   * Every call appends its mode to FAKE_TRACE.
   */
  const scriptedGit = async (env: Record<string, string>): Promise<Record<string, string>> => {
    await writeExecutable(
      NodePath.join(bin, "git"),
      "#!/usr/bin/env node\n" +
        "const fs = require(\"node:fs\")\n" +
        "const env = process.env\n" +
        "const listing = process.argv.includes(\"--name-only\")\n" +
        "fs.appendFileSync(env.FAKE_TRACE, (listing ? \"list\" : process.argv.includes(\"-U0\") ? \"U0\" : \"patch\") + \"\\n\")\n" +
        "if (listing) {\n" +
        "  process.stdout.write(JSON.parse(fs.readFileSync(env.FAKE_LIST, \"utf8\")).join(\"\\0\"))\n" +
        "} else {\n" +
        "  setTimeout(() => {\n" +
        "    if (env.FAKE_BYTES) process.stdout.write(Buffer.alloc(Number(env.FAKE_BYTES), 120))\n" +
        "    else process.stdout.write(fs.readFileSync(env.FAKE_PATCH))\n" +
        "  }, Number(env.FAKE_SLEEP_MS ?? 0))\n" +
        "}\n"
    )
    return {
      PATH: [bin, NodePath.dirname(process.execPath)].join(NodePath.delimiter),
      FAKE_TRACE: NodePath.join(bin, "trace"),
      FAKE_LIST: NodePath.join(bin, "list.json"),
      FAKE_PATCH: NodePath.join(bin, "patch.diff"),
      ...env
    }
  }

  const trace = async (): Promise<ReadonlyArray<string>> =>
    (await Fs.readFile(NodePath.join(bin, "trace"), "utf8")).trim().split("\n")

  /** Enough long paths that their pathspecs need two batches. */
  const manyPaths = Array.from(
    { length: 1200 },
    (_, index) => `src/${String(index).padStart(4, "0")}-${"p".repeat(40)}.ts`
  )

  it.each([
    ["\"b/src/a.ts", "unterminated quoted Git patch path"],
    ["\"b/src/a.ts\\\"", "incomplete Git patch path escape"],
    ["\"b/src/\\18.ts\"", "invalid Git patch path octal escape"],
    ["\"b/src/\\q.ts\"", "invalid Git patch path escape"],
    ["a/src/a.ts", "invalid Git patch path prefix"],
    ["b/src/other.ts", "Git patch path is not a listed file: src/other.ts"]
  ])("refuses the -U0 header +++ %s", async (header, reason) => {
    const environment = await scriptedGit({})
    await Fs.writeFile(environment["FAKE_LIST"]!, JSON.stringify(["src/a.ts"]))
    await Fs.writeFile(
      environment["FAKE_PATCH"]!,
      `diff --git a/src/a.ts b/src/a.ts\n+++ ${header}\n@@ -0,0 +1 @@\n+TODO\n`
    )
    const error = await Effect.runPromise(Effect.flip(AgentSession.expandDiffSlice(
      root,
      [Input.gitDiff({ base: "HEAD", paths: ["src/**"], addedLines: "TODO" })],
      10_000,
      { environment }
    )))
    expect(error.phase).toBe("diff")
    expect(error.message).toBe(`cannot parse Git patch path: ${reason}`)
  })

  it("bounds the concatenated output of every path batch, not each batch alone", async () => {
    const perBatch = 40 * 1024 * 1024
    const environment = await scriptedGit({ FAKE_BYTES: String(perBatch) })
    await Fs.writeFile(environment["FAKE_LIST"]!, JSON.stringify(manyPaths))
    const error = await Effect.runPromise(Effect.flip(AgentSession.expandDiffSlice(
      root,
      [Input.gitDiff({ base: "HEAD", paths: ["src/**"], addedLines: "TODO" })],
      60_000,
      { environment }
    )))
    expect(error.phase).toBe("diff")
    expect(error.message).toBe(`agent subprocess stdout exceeded ${64 * 1024 * 1024} bytes`)
    // Each batch fit under the per-process ceiling; only their sum tripped it.
    expect(await trace()).toEqual(["list", "U0", "U0"])
  }, 60_000)

  it("applies the git deadline to the sum of path batches", async () => {
    const environment = await scriptedGit({ FAKE_SLEEP_MS: "700" })
    await Fs.writeFile(environment["FAKE_LIST"]!, JSON.stringify(manyPaths))
    await Fs.writeFile(environment["FAKE_PATCH"]!, "")
    const started = Date.now()
    const error = await Effect.runPromise(Effect.flip(AgentSession.expandDiffSlice(
      root,
      [Input.gitDiff({ base: "HEAD", paths: ["src/**"], addedLines: "TODO" })],
      1_000,
      { environment }
    )))
    expect(error.phase).toBe("diff")
    expect(error.message).toBe("agent subprocess timed out after 1000ms")
    // Two 700 ms batches each fit the 1000 ms bound; the second was cut short.
    expect(await trace()).toEqual(["list", "U0", "U0"])
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  /** Git reads no user config: Windows names its null device `NUL`, POSIX `/dev/null`. */
  it.each([["win32", "NUL"], ["linux", "/dev/null"]] as const)(
    "on %s points Git's global config at %s",
    async (platform, device) => {
      await writeExecutable(
        NodePath.join(bin, "git"),
        "#!/usr/bin/env node\n" +
          "if (process.argv.includes(\"--name-only\")) process.stdout.write(process.env.GIT_CONFIG_GLOBAL + \"\\0\")\n"
      )
      const slice = await Effect.runPromise(AgentSession.expandDiffSlice(
        root,
        [Input.gitDiff({ base: "HEAD" })],
        10_000,
        { environment: { PATH: [bin, NodePath.dirname(process.execPath)].join(NodePath.delimiter) }, platform }
      ))
      expect(slice.files).toEqual([device])
    }
  )
})

describe("write-set applier boundaries", () => {
  it("rejects control characters and absolute paths as write escapes", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    for (
      const [path, reason] of [
        ["src/a\u0001.ts", "contains control characters"],
        ["/src/a.ts", "is absolute"],
        ["src/./a.ts", "is not normalized"]
      ] as const
    ) {
      const error = await Effect.runPromise(Effect.flip(applier.apply([{ path, contents: "x" }], ["**"])))
      expect(error).toMatchObject({
        _tag: "smithers-build/AgentWriteEscape",
        path,
        message: `candidate edit path ${JSON.stringify(path)} ${reason}`
      })
    }
  })

  it("reads candidate contents over the worktree and renders deletions", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const overlay = await Effect.runPromise(applier.apply([
      { path: "src/z.ts", contents: "zed" },
      { path: "src/a.ts", contents: null },
      { path: "src/m.ts", contents: "em" }
    ], ["src/**"]))
    expect(await overlay.read("src/z.ts")).toBe("zed")
    expect(await overlay.read("src/a.ts")).toBeUndefined()
    expect(await overlay.read("docs/readme.md")).toBe("readme\n")
    expect(await overlay.read("docs/missing.md")).toBeUndefined()
    expect(overlay.render()).toBe(
      "=== src/a.ts (deleted) ===\n\n=== src/m.ts (candidate) ===\nem\n\n=== src/z.ts (candidate) ===\nzed\n"
    )
  })

  it("rejects a base overlay file that the narrower write-set no longer admits", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const base = await Effect.runPromise(applier.apply([{ path: "docs/new.md", contents: "x" }], ["docs/**"]))
    const error = await Effect.runPromise(Effect.flip(applier.apply([], ["src/**"], base)))
    expect(error).toMatchObject({
      _tag: "smithers-build/AgentWriteEscape",
      path: "docs/new.md",
      message: "candidate edit \"docs/new.md\" is outside the declared write-set"
    })
  })

  it("reports an unusable write-set glob as an apply failure, not a write escape", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const error = await Effect.runPromise(
      Effect.flip(applier.apply([{ path: "src/a.ts", contents: "x" }], ["*".repeat(64 * 1024 + 1)]))
    )
    expect(error).toMatchObject({ _tag: "smithers-build/AgentSessionError", phase: "apply" })
    expect(error.message).toBe("pattern is too long")
    expect(await read("src/a.ts")).toBe("export const a = 1\n")
  })

  it("refuses a file used as a directory component", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const error = await Effect.runPromise(
      Effect.flip(applier.apply([{ path: "src/a.ts/inner.ts", contents: "x" }], ["src/**"]))
    )
    expect(error).toMatchObject({
      _tag: "smithers-build/AgentWriteEscape",
      message: `candidate edit "src/a.ts/inner.ts" has a non-regular path component at ${
        NodePath.join(root, "src/a.ts")
      }`
    })
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "surfaces an unreadable component as a write escape instead of treating it as absent",
    async () => {
      await Fs.mkdir(NodePath.join(root, "src/locked"))
      await Fs.chmod(NodePath.join(root, "src/locked"), 0o000)
      try {
        const error = await Effect.runPromise(Effect.flip(
          AgentSession.makeLocalWriteSetApplier(root).apply([{ path: "src/locked/x.ts", contents: "x" }], ["src/**"])
        ))
        expect(error._tag).toBe("smithers-build/AgentWriteEscape")
        expect(error.message).toContain("EACCES")
      } finally {
        await Fs.chmod(NodePath.join(root, "src/locked"), 0o755)
      }
      expect(await Fs.readdir(NodePath.join(root, "src/locked"))).toEqual([])
    }
  )

  const foreignOverlay = (entries: ReadonlyArray<readonly [string, string | null]>): AgentSession.CandidateOverlay => ({
    files: new Map(entries),
    read: async () => undefined,
    render: () => ""
  })

  it("commits an overlay it did not produce, in path order, after validating every path", async () => {
    const written = await Effect.runPromise(
      AgentSession.makeLocalWriteSetApplier(root).commit(foreignOverlay([
        ["src/m.ts", "m"],
        ["src/z.ts", "z"],
        ["src/a.ts", null],
        ["src/b.ts", "b"]
      ]))
    )
    expect(written).toEqual(["src/a.ts", "src/b.ts", "src/m.ts", "src/z.ts"])
    expect((await Fs.readdir(NodePath.join(root, "src"))).sort()).toEqual(["b.ts", "m.ts", "z.ts"])
  })

  it("refuses to commit a foreign overlay naming a path outside the workspace", async () => {
    const error = await Effect.runPromise(Effect.flip(
      AgentSession.makeLocalWriteSetApplier(root).commit(foreignOverlay([["src/ok.ts", "ok"], ["../escape.ts", "x"]]))
    ))
    expect(error.phase).toBe("apply")
    expect(error.message).toBe("candidate edit path \"../escape.ts\" leaves the workspace")
    expect(existsSync(NodePath.join(root, "src/ok.ts"))).toBe(false)
    expect(existsSync(NodePath.join(root, "../escape.ts"))).toBe(false)
  })
})

describe("publication through a faulty host", () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename refused`), { code })

  /** A host whose first renames fail with the given causes, then renames for real. */
  const hostFailing = (platform: NodeJS.Platform, causes: ReadonlyArray<unknown>) => {
    let calls = 0
    const host: typeof filePublicationHostLive = {
      platform,
      rename: async (from, to) => {
        const cause = causes[calls]
        calls += 1
        if (cause !== undefined) throw cause
        await Fs.rename(from, to)
      }
    }
    return { host, calls: () => calls }
  }

  const commitThrough = async (host: typeof filePublicationHostLive) => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const overlay = await Effect.runPromise(applier.apply([{ path: "src/a.ts", contents: "next\n" }], ["src/**"]))
    return Effect.runPromise(
      Effect.result(applier.commit(overlay).pipe(Effect.provideService(FilePublicationHost, host)))
    )
  }

  it("retries transient Windows sharing violations on the same temporary file", async () => {
    const fault = hostFailing("win32", [errno("EPERM"), errno("EACCES"), errno("EBUSY")])
    const result = await commitThrough(fault.host)
    expect(result).toMatchObject({ _tag: "Success", success: ["src/a.ts"] })
    expect(fault.calls()).toBe(4)
    expect(await read("src/a.ts")).toBe("next\n")
    expect(await Fs.readdir(NodePath.join(root, "src"))).toEqual(["a.ts"])
  })

  it("does not retry a Windows failure that is not a sharing violation", async () => {
    const fault = hostFailing("win32", [errno("EINVAL")])
    const result = await commitThrough(fault.host)
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "apply", message: "EINVAL: rename refused" } })
    expect(fault.calls()).toBe(1)
    expect(await read("src/a.ts")).toBe("export const a = 1\n")
  })

  it("gives up after the retry budget and removes its temporary file", async () => {
    const fault = hostFailing("win32", Array.from({ length: 20 }, () => errno("EBUSY")))
    const result = await commitThrough(fault.host)
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "apply" } })
    expect(fault.calls()).toBe(7)
    expect(await Fs.readdir(NodePath.join(root, "src"))).toEqual(["a.ts"])
  })

  it.each([
    ["a non-Error throw", "volume gone", "volume gone"],
    ["an empty message", new Error(""), "unknown failure"],
    ["an oversized message", new Error("x".repeat(5000)), `${"x".repeat(4093)}...`]
  ])("renders %s from a failed verdict publication as one bounded line", async (_name, cause, message) => {
    const fault = hostFailing("linux", [cause])
    const directory = NodePath.join(root, "verdicts")
    const result = await Effect.runPromise(Effect.result(
      AgentSession.makeFileVerdictStore(directory).put("key", "{}").pipe(
        Effect.provideService(FilePublicationHost, fault.host)
      )
    ))
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "cache", message } })
    expect(await Fs.readdir(directory)).toEqual([])
  })
})

describe("payload and MCP prechecks", () => {
  it("names the literal set a missing required input expects", async () => {
    const error = await Effect.runPromise(Effect.flip(
      AgentSession.decodePayloadValues({ mode: Reference.inputLiterals(["fast", "slow"]) }, {})
    ))
    expect(error).toMatchObject({ field: "mode", expected: "fast | slow" })
  })

  it("refuses a malformed declared spec as a payload input failure", async () => {
    const malformed = { mode: { _tag: "InputLiterals" } } as unknown as Readonly<Record<string, Reference.InputSpec>>
    const error = await Effect.runPromise(Effect.flip(AgentSession.decodePayloadValues(malformed, { mode: "fast" })))
    expect(error).toMatchObject({
      _tag: "smithers-build/AgentNeedsInput",
      field: "payload",
      expected: "declared inputs"
    })
  })

  it("still fails typed when the unreachable server cannot be named in the error", async () => {
    const server = { _tag: "McpHttp", name: "", url: "http://127.0.0.1:1/mcp" } as Reference.McpHttp
    const error = await Effect.runPromise(Effect.flip(AgentSession.precheckMcp([server], 500)))
    expect(error).toMatchObject({ _tag: "smithers-build/AgentMcpUnreachable", name: "mcp", url: "unknown" })
  })
})

describe("prompt and data file reads", () => {
  it("refuses a directory prompt once the slice is non-empty", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const factory = scripted([])
    const error = await Effect.runPromise(Effect.flip(
      AgentSession.runAgentLint(runtimeOf({ sessions: factory }), lintPayload({ promptPath: "src" }))
    ))
    expect(error).toMatchObject({ phase: "read", message: "prompt file src is not a regular file" })
    expect(factory.opens()).toBe(0)
  })

  it("refuses a data file outside the workspace before any session runs", async () => {
    const factory = scripted([{ purpose: "diff" }])
    const error = await Effect.runPromise(Effect.flip(AgentSession.runAgentDiff(
      runtimeOf({ sessions: factory, dataFiles: ["../outside.txt"] }),
      diffPayload()
    )))
    expect(error).toMatchObject({ phase: "read", message: "data file ../outside.txt resolves outside the workspace" })
    expect(factory.spawns()).toBe(0)
  })

  const sysfs = "/sys/kernel/mm/transparent_hugepage"
  it.skipIf(!existsSync(NodePath.join(sysfs, "enabled")))(
    "renders the bytes actually readable when a file's size overstates them",
    async () => {
      const declared = (await Fs.stat(NodePath.join(sysfs, "enabled"))).size
      const actual = readFileSync(NodePath.join(sysfs, "enabled"), "utf8")
      expect(Buffer.byteLength(actual)).toBeLessThan(declared)
      const section = await Effect.runPromise(AgentSession.renderDataFiles(sysfs, ["enabled"]))
      expect(section).toBe(`\n\n=== FILES ===\n\n--- enabled ---\n${actual}`)
    }
  )

  it.skipIf(process.platform === "win32")(
    "refuses a data file whose name is replaced while it is being read",
    async () => {
      await write("src/hot.txt", "A")
      const swapper = spawn("python3", [
        "-c",
        "import os,sys\nd=sys.argv[1]\ni=0\nwhile True:\n" +
        "  t=os.path.join(d,'next'+str(i%2))\n  open(t,'w').write('B')\n  os.rename(t,os.path.join(d,'hot.txt'))\n  i+=1\n",
        NodePath.join(root, "src")
      ], { stdio: "ignore" })
      const outcomes = new Set<string>()
      try {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline && !outcomes.has("replaced")) {
          const result = await Effect.runPromise(Effect.result(AgentSession.renderDataFiles(root, ["src/hot.txt"])))
          if (result._tag === "Success") {
            expect(result.success).toMatch(/--- src\/hot\.txt ---\n[AB]?$/)
            outcomes.add("read")
          } else {
            expect(result.failure.message).toBe("data file src/hot.txt was replaced while it was being read")
            outcomes.add("replaced")
          }
        }
      } finally {
        swapper.kill("SIGKILL")
      }
      expect(outcomes.has("replaced")).toBe(true)
    },
    30_000
  )
})

describe("candidate loop boundaries", () => {
  it("settles vacuous with zero spawns when declared diffs expand to nothing", async () => {
    const factory = scripted([])
    const result = await Effect.runPromise(AgentSession.runAgentDiff(
      runtimeOf({ sessions: factory }),
      diffPayload({ diffs: [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })] })
    ))
    expect(result).toEqual({ vacuous: true, rounds: 0, diff: "", edits: [], gateReport: [] })
    expect(factory.opens()).toBe(0)
  })

  it("renders payload inputs sorted by name and the diff slice into the prompt", async () => {
    await write("src/a.ts", "export const a = 5\n")
    const factory = scripted([{ purpose: "diff", edits: [{ path: "src/a.ts", contents: "x" }] }])
    await Effect.runPromise(AgentSession.runAgentDiff(
      runtimeOf({
        sessions: factory,
        gates: AgentFake.makeScriptedGateRunner([[green]]),
        payloadValues: { zeta: "last", alpha: "fast", mid: "m" }
      }),
      diffPayload({
        payloadSpec: {
          alpha: Reference.inputLiterals(["fast", "slow"]),
          zeta: Reference.inputString("z"),
          mid: Reference.inputString("m")
        },
        diffs: [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })]
      })
    ))
    const prompt = factory.requests()[0]!.prompt
    expect(prompt).toContain(
      `=== PAYLOAD INPUTS ===\n\n${JSON.stringify({ alpha: "fast", mid: "m", zeta: "last" }, null, 2)}`
    )
    expect(prompt).toContain("=== DIFF SLICE ===")
    expect(prompt).toContain("+export const a = 5")
  })

  it("feeds back a red gate without detail as its bare status", async () => {
    const factory = scripted([
      { purpose: "diff", edits: [{ path: "src/a.ts", contents: "v1" }] },
      { purpose: "diff", edits: [{ path: "src/a.ts", contents: "v2" }] }
    ])
    await Effect.runPromise(AgentSession.runAgentDiff(
      runtimeOf({ sessions: factory, gates: AgentFake.makeScriptedGateRunner([[red], [green]]) }),
      diffPayload()
    ))
    expect(factory.requests()[1]!.prompt).toContain("=== ROUND 1 GATE REPORT (red) ===\n\n- Vitest#gate: red\n\n")
  })

  it("fails typed when a round's feedback would overflow the prompt ceiling", async () => {
    const factory = scripted([{ purpose: "diff", edits: [{ path: "src/a.ts", contents: "v1" }] }])
    const gates: AgentSession.GateRunner = {
      run: () => Effect.succeed([{ ...red, detail: "x".repeat(AgentSession.maximumSessionPromptBytes) }])
    }
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentDiff(runtimeOf({ sessions: factory, gates }), diffPayload()))
    )
    expect(error).toMatchObject({
      phase: "read",
      message: `the rendered session prompt exceeds ${AgentSession.maximumSessionPromptBytes} bytes`
    })
    expect(factory.spawns()).toBe(1)
  })

  it("returns a vacuous Agent.Pr result without consulting the opener", async () => {
    let opened = 0
    const result = await Effect.runPromise(AgentSession.runAgentPr(
      runtimeOf({
        sessions: scripted([]),
        prOpener: { open: () => Effect.sync(() => String(opened++)) }
      }),
      diffPayload({ diffs: [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })] })
    ))
    expect(result).toEqual({ vacuous: true, rounds: 0, diff: "", edits: [], gateReport: [] })
    expect(opened).toBe(0)
  })

  it("passes an opener failure outside the settle phase through unchanged", async () => {
    const failure = new AgentTarget.AgentSessionError({ phase: "gate", message: "opener lost its gate report" })
    const error = await Effect.runPromise(Effect.flip(AgentSession.runAgentPr(
      runtimeOf({
        sessions: scripted([{ purpose: "diff", edits: [{ path: "src/a.ts", contents: "v1" }] }]),
        gates: AgentFake.makeScriptedGateRunner([[green]]),
        prOpener: { open: () => Effect.fail(failure) }
      }),
      diffPayload()
    )))
    expect(error).toBe(failure)
  })
})

describe("agent action layers", () => {
  const platform = Layer.mergeAll(NodeFileSystem.layer, EffectNodePath.layer, NodeCrypto.layer)

  it("runs Agent.Lint through its action layer", async () => {
    const runtime = runtimeOf({ sessions: scripted([]) })
    const flow = Flow.make("agent-lint-layer-test", {
      payload: {},
      success: AgentTarget.LintReport,
      error: AgentTarget.LintError,
      body: () => AgentTarget.AgentLint.call(lintPayload())
    })
    const layer = Layer.mergeAll(AgentSession.AgentLintLive(runtime), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(platform)
    )
    const result = await Effect.runPromise(
      flow.execute({}, { executionId: "agent-lint-layer" }).pipe(Effect.provide(layer))
    )
    expect(result).toEqual({ vacuous: true, note: "vacuous: agent not invoked", files: [], findings: [], fixed: [] })
  })

  it("runs Agent.Diff through its action layer", async () => {
    const factory = scripted([{ purpose: "diff", edits: [{ path: "src/gen.ts", contents: "generated\n" }] }])
    const runtime = runtimeOf({ sessions: factory })
    const flow = Flow.make("agent-diff-layer-test", {
      payload: {},
      success: AgentTarget.DiffResult,
      error: AgentTarget.DiffError,
      body: () => AgentTarget.AgentDiff.call(diffPayload({ gateIdentities: [], maxRounds: 1 }))
    })
    const layer = Layer.mergeAll(AgentSession.AgentDiffLive(runtime), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(platform)
    )
    const result = await Effect.runPromise(
      flow.execute({}, { executionId: "agent-diff-layer" }).pipe(Effect.provide(layer))
    )
    expect(result.rounds).toBe(1)
    expect(result.edits).toEqual([{ path: "src/gen.ts", contents: "generated\n" }])
    expect(factory.spawns()).toBe(1)
  })

  it("runs Agent.Pr through its action layer", async () => {
    const runtime = runtimeOf({ sessions: scripted([]) })
    const flow = Flow.make("agent-pr-layer-test", {
      payload: {},
      success: AgentTarget.PrResult,
      error: AgentTarget.PrError,
      body: () => AgentTarget.AgentPr.call(diffPayload({ diffs: [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })] }))
    })
    const layer = Layer.mergeAll(AgentSession.AgentPrLive(runtime), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(platform)
    )
    const result = await Effect.runPromise(
      flow.execute({}, { executionId: "agent-pr-layer" }).pipe(Effect.provide(layer))
    )
    expect(result).toEqual({ vacuous: true, rounds: 0, diff: "", edits: [], gateReport: [] })
  })
})
