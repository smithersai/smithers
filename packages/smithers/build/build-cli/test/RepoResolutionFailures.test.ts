/** Child-repository failures and cancellation against real processes. */
import { Smithers } from "@smthrs/targets"
import * as LocalRepository from "@smthrs/targets/LocalRepository"
import * as RepoTarget from "@smthrs/targets/RepoTarget"
import * as Shell from "@smthrs/targets/Shell"
import { Effect } from "effect"
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import * as RepositoryProcess from "../src/internal/RepositoryProcess.ts"
import * as RepoResolution from "../src/RepoResolution.ts"
import { fixture } from "./helpers/RepositoryProcess.ts"

/** Coverage adds this worker's directory; every other environment key remains exact. */
const coverageEnvironment = (): Readonly<Record<string, string>> => {
  const directory = process.env["NODE_V8_COVERAGE"]
  return directory === undefined ? {} : { NODE_V8_COVERAGE: directory }
}

let host = fixture()
afterEach(async () => {
  await host.cleanup()
  host = fixture()
})

const index = {
  root: "/parent",
  workspace: { repos: { child: LocalRepository.make("repos/child") } }
} as unknown as RepoResolution.Resolver["index"]
const makeResolver = () => RepoResolution.Resolver.make(index, { KEEP: "1" }, host.services)
const resolution: RepoResolution.Resolution = {
  repoName: "child",
  repoPath: "repos/child",
  absolutePath: NodePath.join("/parent", "repos", "child"),
  label: "//:test",
  args: ["--flag"],
  kinds: ["test"],
  refusal: undefined,
  externalLabel: "@child//:test"
}

const queried = async (output: { stdout?: string; stderr?: string }, exit: number | null = 0) => {
  const childIndex = host.requests.length
  const pending = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"))
  if (output.stdout !== undefined) await host.write("stdout", output.stdout, childIndex)
  if (output.stderr !== undefined) await host.write("stderr", output.stderr, childIndex)
  await host.finish(exit, childIndex)
  return pending
}

describe("child repository queries", () => {
  it("memoizes a declaration and passes query arguments and the scrubbed environment", async () => {
    const resolver = makeResolver()
    const target = RepoTarget.Target(LocalRepository.make("repos/child"), "//:test", { args: ["--x"] })
    const pending = RepoResolution.resolve(resolver, target)
    expect(RepoResolution.resolve(resolver, target)).toBe(pending)
    await host.write(
      "stdout",
      JSON.stringify({ targets: [{ label: "//:other" }, { label: "//:test", kinds: ["test"] }] })
    )
    await host.finish()
    expect(await pending).toEqual({ ...resolution, args: ["--x"] })
    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]).toEqual({
      command: process.execPath,
      args: [
        RepoResolution.buildCliPath,
        "query",
        "//:test",
        "--workspace",
        resolution.absolutePath,
        "--format",
        "json"
      ],
      options: { cwd: resolution.absolutePath, env: { KEEP: "1", ...coverageEnvironment() } }
    })
  })

  it("refuses undeclared names and declarations without starting a child", async () => {
    expect(
      await RepoResolution.resolve(
        makeResolver(),
        RepoTarget.Target(LocalRepository.make("repos/elsewhere"), "//:test")
      )
    )
      .toMatchObject({
        repoName: "unknown",
        repoPath: "repos/elsewhere",
        kinds: [],
        refusal: "Repo.Target repository \"repos/elsewhere\" is not declared in Workspace repos",
        externalLabel: "@unknown//:test"
      })
    const bare = RepoResolution.Resolver.make(
      { root: "/parent", workspace: {} } as RepoResolution.Resolver["index"],
      {},
      host.services
    )
    for (const repo of ["child", LocalRepository.make("repos/child")]) {
      expect((await RepoResolution.resolve(bare, RepoTarget.Target(repo, "//:test"))).refusal)
        .toMatch(/is not declared in Workspace repos$/)
    }
    expect(host.requests).toHaveLength(0)
  })

  it.each([
    ["stderr", { stderr: "  no such target\n", stdout: "ignored" }, "no such target"],
    ["stdout", { stderr: "  \n", stdout: "from stdout\n" }, "from stdout"],
    ["empty pipes", {}, "exit 3"]
  ])("reports a nonzero query with %s", async (_name, output, detail) => {
    expect(await queried(output, 3)).toMatchObject({
      kinds: [],
      refusal: "child repository @child refused //:test: " + detail
    })
  })

  it("reports signal termination and bounds diagnostics to their tail", async () => {
    expect((await queried({ stderr: "a".repeat(9000) + "END" }, null)).refusal)
      .toBe("child repository @child refused //:test: " + "a".repeat(8189) + "END")
    expect((await queried({}, null)).refusal).toBe("child repository @child refused //:test: exit -1")
  })

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["no targets", "{}"],
    ["non-array targets", JSON.stringify({ targets: {} })],
    ["missing row", JSON.stringify({ targets: [null, 1, { label: "//:other" }] })],
    ["no kinds", JSON.stringify({ targets: [{ label: "//:test" }] })],
    ["unknown kind", JSON.stringify({ targets: [{ label: "//:test", kinds: ["test", "deploy"] }] })],
    ["non-string kind", JSON.stringify({ targets: [{ label: "//:test", kinds: [1] }] })]
  ])("refuses a query with %s", async (_name, stdout) => {
    expect(await queried({ stdout })).toMatchObject({
      kinds: [],
      refusal: "child repository @child query returned no valid target row for //:test"
    })
  })

  it("reports invalid JSON", async () => {
    expect((await queried({ stdout: "not json" })).refusal).toMatch(/could not query.*JSON/)
  })

  it("retains a spawn failure and a non-Error fault", async () => {
    for (const cause of [new Error("spawn node ENOENT"), "spawn refused"]) {
      const resolver = RepoResolution.Resolver.make(index, {}, { ...host.services, spawn: () => Effect.fail(cause) })
      expect((await RepoResolution.resolve(resolver, RepoTarget.Target("child", "//:test"))).refusal)
        .toBe(
          "child repository @child could not query //:test: " + String(cause instanceof Error ? cause.message : cause)
        )
    }
  })

  it("accepts a query exactly at the 1 MiB output boundary", async () => {
    const json = JSON.stringify({ targets: [{ label: "//:test", kinds: ["test"] }] })
    expect((await queried({ stdout: json + " ".repeat(1024 * 1024 - Buffer.byteLength(json)) })).kinds).toEqual([
      "test"
    ])
  })

  it("kills a real child whose combined output exceeds 1 MiB", async () => {
    const pending = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"))
    const child = await host.ready()
    await host.write("stdout", "a".repeat(1024 * 1024))
    child.send!({ stream: "stderr", text: "x" })
    expect((await pending).refusal).toBe(
      "child repository @child could not query //:test: child CLI output exceeds 1048576 bytes"
    )
    await host.closes[0]
    expect(child.signalCode).toBe("SIGKILL")
  })

  it("ignores remaining buffered output after killing an over-limit query", async () => {
    const pending = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"))
    const child = await host.ready()
    child.send!({ stream: "stdout", text: "a".repeat(3 * 1024 * 1024) })
    expect((await pending).refusal).toContain("output exceeds 1048576 bytes")
    await host.closes[0]
    expect(child.signalCode).toBe("SIGKILL")
  })

  it("reports the real host's asynchronous query spawn failure", async () => {
    const resolver = RepoResolution.Resolver.make(index, {}, RepositoryProcess.live)
    expect((await RepoResolution.resolve(resolver, RepoTarget.Target("child", "//:test"))).refusal)
      .toMatch(/could not query.*ENOENT/)
  })

  it("kills a real query on abort", async () => {
    const controller = new AbortController()
    const pending = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"), controller.signal)
    const child = await host.ready()
    controller.abort("stop")
    expect((await pending).refusal).toBe("child repository @child could not query //:test: stop")
    await host.closes[0]
    expect(child.signalCode).toBe("SIGKILL")
  })

  it("uses the default reason for an already-aborted query", async () => {
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {}
    } as unknown as AbortSignal
    expect((await RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"), signal)).refusal)
      .toBe("child repository @child could not query //:test: child process aborted")
    await host.closes[0]
    expect(host.children[0]!.signalCode).toBe("SIGKILL")
  })

  it("reads effective kinds through repository aliases and ordinary targets", async () => {
    const target = RepoTarget.Target("child", "//:test")
    const pending = RepoResolution.effectiveKinds(makeResolver(), Smithers.Alias(target))
    await host.write("stdout", JSON.stringify({ targets: [{ label: "//:test", kinds: ["test"] }] }))
    await host.finish()
    expect(await pending).toEqual(["test"])
    expect(await RepoResolution.effectiveKinds(makeResolver(), Shell.Test({ shell: "true" }))).toEqual(["test"])
  })
})

describe("child repository git state", () => {
  const checkout = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(Os.tmpdir(), "smithers-repository-git-")))
  const child = NodePath.join(checkout, "child")
  NodeFs.mkdirSync(NodePath.join(child, ".git"), { recursive: true })
  const local: RepoResolution.Resolution = { ...resolution, absolutePath: child }
  afterAll(() => NodeFs.rmSync(checkout, { recursive: true, force: true }))

  it.each([" M file\n", ""])("uses the real pipes for HEAD and status %j", async (status) => {
    const pending = RepoResolution.gitState(makeResolver(), local)
    await host.write("stdout", "abc123\n")
    await host.finish()
    await host.write("stdout", status, 1)
    await host.finish(0, 1)
    expect(await pending).toEqual({ head: "abc123", dirty: status !== "", status })
    expect(host.requests.map((row) => row.args)).toEqual([
      ["-C", local.absolutePath, "rev-parse", "HEAD"],
      ["-C", local.absolutePath, "status", "--porcelain"]
    ])
    for (const row of host.requests) {
      expect(row.options.env).toEqual({ KEEP: "1", GIT_CEILING_DIRECTORIES: checkout, ...coverageEnvironment() })
    }
  })

  it.each(["HEAD", "status"] as const)("reports a failed %s read", async (phase) => {
    for (const stream of ["stdout", "stderr"] as const) {
      const offset = host.requests.length
      const pending = RepoResolution.gitState(makeResolver(), local)
      const rejected = expect(pending).rejects.toThrow("could not read child repository " + phase + ": refused")
      if (phase === "status") {
        await host.write("stdout", "abc\n", offset)
        await host.finish(0, offset)
      }
      const failedIndex = offset + (phase === "status" ? 1 : 0)
      await host.write(stream, "refused", failedIndex)
      await host.finish(1, failedIndex)
      await rejected
    }
  })
  it("does not inspect the parent checkout when the child has no marker", async () => {
    expect(await RepoResolution.gitState(makeResolver(), resolution)).toEqual({ head: "", dirty: true, status: "" })
    expect(host.requests).toEqual([])
  })
})

describe("child repository execution", () => {
  it("passes write, plan, target arguments and the child environment", async () => {
    const seen: Array<string> = []
    const pending = RepoResolution.execute(makeResolver(), resolution, {
      write: true,
      plan: true,
      environment: { BRIDGE: "1" },
      output: (stream, text) => seen.push(stream + ":" + text)
    })
    await host.write("stdout", "ok\n")
    await host.finish()
    await pending
    expect(seen).toEqual(["stdout:ok\n"])
    expect(host.requests[0]).toEqual({
      command: process.execPath,
      args: [
        RepoResolution.buildCliPath,
        "//:test",
        "--workspace",
        resolution.absolutePath,
        "--write",
        "--plan",
        "--flag"
      ],
      options: {
        cwd: resolution.absolutePath,
        detached: true,
        env: { KEEP: "1", BRIDGE: "1", SMTHRS_REPO_CHILD: "1", ...coverageEnvironment() },
        stdio: ["ignore", "pipe", "pipe"]
      }
    })
  })

  it("streams through the host output service and preserves a failure tail", async () => {
    const pending = RepoResolution.execute(makeResolver(), resolution)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "repo_target_failed",
      exitCode: 2,
      stderrTail: "boom\npartial",
      message: "child target @child//:test failed with exit 2\nboom\npartial"
    })
    await host.write("stdout", "out\n")
    await host.write("stderr", "boom\npartial")
    await host.finish(2)
    await rejected
    expect(host.output).toContain("stdout:out\n")
    expect(host.output).toContain("stderr:boom\n")
  })

  it("reports real signal termination as exit -1 without inventing a tail", async () => {
    const pending = RepoResolution.execute(makeResolver(), resolution)
    const rejected = expect(pending).rejects.toMatchObject({
      exitCode: -1,
      stderrTail: "",
      message: "child target @child//:test failed with exit -1"
    })
    await host.finish(null)
    await rejected
  })

  it("retains a refused spawn", async () => {
    const cause = new Error("spawn EACCES")
    const resolver = RepoResolution.Resolver.make(index, {}, { ...host.services, spawn: () => Effect.fail(cause) })
    await expect(RepoResolution.execute(resolver, resolution)).rejects.toBe(cause)
  })

  it.skipIf(process.platform === "win32")(
    "kills descendants that keep the output pipes open on cancellation",
    async () => {
      const controller = new AbortController()
      const pending = RepoResolution.execute(makeResolver(), resolution, { signal: controller.signal })
      const rejected = expect(pending).rejects.toThrow("cancel tree")
      const child = await host.ready()
      await host.tree()
      controller.abort(new Error("cancel tree"))
      await rejected
      // close cannot fire while the descendant keeps its inherited stdout/stderr open.
      await host.closes[0]
      expect(child.signalCode).toBe("SIGKILL")
    }
  )

  it.each([false, true])("kills a real child on abort, with group signal refusal %s", async (refused) => {
    const resolver = RepoResolution.Resolver.make(
      index,
      {},
      refused
        ? { ...host.services, killGroup: () => Effect.fail(new Error("group unavailable")) }
        : host.services
    )
    const controller = new AbortController()
    const pending = RepoResolution.execute(resolver, resolution, { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    const child = await host.ready()
    controller.abort()
    await rejected
    await host.closes[0]
    expect(child.signalCode).toBe("SIGKILL")
  })

  it("aborts a native spawn with no pid and ignores its later error and close", async () => {
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {}
    } as unknown as AbortSignal
    const resolver = RepoResolution.Resolver.make(index, {}, RepositoryProcess.live)
    await expect(
      RepoResolution.execute(resolver, { ...resolution, absolutePath: "missing-child-directory" }, { signal })
    )
      .rejects.toThrow("child target aborted")
  })

  it("reports native spawn errors through the execution boundary", async () => {
    const resolver = RepoResolution.Resolver.make(index, {}, RepositoryProcess.live)
    await expect(RepoResolution.execute(resolver, { ...resolution, absolutePath: "missing-child-directory" }))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a pre-aborted execution with the default reason", async () => {
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {}
    } as unknown as AbortSignal
    await expect(RepoResolution.execute(makeResolver(), resolution, { signal })).rejects.toThrow("child target aborted")
    await host.closes[0]
    expect(host.children[0]!.signalCode).toBe("SIGKILL")
  })
})
