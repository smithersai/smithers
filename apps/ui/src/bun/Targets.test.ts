import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { TargetRunFrame } from "@smthrs/rpc/LocalApp"
import type { SandboxHost } from "./Sandbox"
import {
  buildCliEnvironment,
  buildCliNodePath,
  createTargetRunner,
  mapTargets,
  queryTargets,
  resolveBuildCli,
  runTopic,
  sandboxPathsFor
} from "./Targets"

/*
 * Target JSON mapping and the loader/run seams (LOCAL-APP.md "Targets: load
 * and run") over a fake build-cli script, so no workspace and no sandbox
 * are needed: the mapping is pure, the query turns loader failures into
 * warnings, and the runner streams stdout/stderr/exit to the run's topic.
 */

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
})

const scratch = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-targets-")))
  directories.push(dir)
  return dir
}

/** Bun runs the fake CLI in place of node; the sandbox is off so the host does not matter. */
const bunSidecar = { path: process.execPath, version: "v22.19.0" }
const noSandbox: SandboxHost = { platform: "linux", disabled: true, log: () => {} }

const LISTING = JSON.stringify({
  query: "//...",
  targets: [
    { label: "//src:lint", target: "Shell.Test", kinds: ["test", "lint"], summary: "Lint the sources.", featured: true },
    { label: "//:detectSecrets", target: "Shell.Test", kinds: ["test"] },
    { label: "//src/Apps/Auction:srcs", target: "Filegroup", kinds: ["build"] }
  ]
})

describe("mapTargets", () => {
  test("maps the loader listing 1:1, splits labels into package and name, tags the workspace, and keeps the declared presentation", () => {
    const mapped = mapTargets(LISTING, ".")
    expect("targets" in mapped && mapped.targets).toEqual([
      { label: "//src:lint", target: "Shell.Test", kinds: ["test", "lint"], package: "//src", name: "lint", workspace: ".", summary: "Lint the sources.", featured: true },
      { label: "//:detectSecrets", target: "Shell.Test", kinds: ["test"], package: "//", name: "detectSecrets", workspace: "." },
      { label: "//src/Apps/Auction:srcs", target: "Filegroup", kinds: ["build"], package: "//src/Apps/Auction", name: "srcs", workspace: "." }
    ])
    const nested = mapTargets(LISTING, "aomi-sdk")
    expect("targets" in nested && nested.targets.every((target) => target.workspace === "aomi-sdk")).toBe(true)
  })

  test("a loader error envelope and non-JSON both become messages", () => {
    expect(mapTargets(JSON.stringify({ code: "query_failed", message: "boom" }), ".")).toEqual({
      error: "query_failed: boom"
    })
    const bad = mapTargets("not json", ".")
    expect("error" in bad && bad.error).toContain("did not answer JSON")
    expect(mapTargets(JSON.stringify({ targets: [{ nope: 1 }, { label: "//a:b" }] }), ".")).toEqual({
      targets: [{ label: "//a:b", target: "", kinds: [], package: "//a", name: "b", workspace: "." }]
    })
  })
})

describe("resolveBuildCli and sandbox paths", () => {
  test("SMITHERS_BUILD_CLI wins, else packages/smithers/build/build-cli/src/main.js from the checkout", () => {
    expect(resolveBuildCli({ SMITHERS_BUILD_CLI: "/x/main.js" }, "/ignored")).toBe("/x/main.js")
    const packaged = "/Applications/Smithers.app/Contents/Resources/app/build-cli/launcher.mjs"
    expect(resolveBuildCli({}, "/Applications/Smithers.app/Contents/Resources/app/bun", (path) => path === packaged))
      .toBe(packaged)
    expect(resolveBuildCli({}, "/repo/apps/ui/src/bun", () => false)).toBe("/repo/packages/smithers/build/build-cli/src/main.js")
  })

  test("from inside an Electrobun bundle the loader is the nearest one above the bundle", () => {
    const checkout = "/repo/packages/smithers/build/build-cli/src/main.js"
    const bundled = "/repo/apps/ui/build/dev-macos-arm64/Smithers-dev.app/Contents/Resources/app/bun"
    expect(resolveBuildCli({}, bundled, (path) => path === checkout)).toBe(checkout)
    expect(resolveBuildCli({}, "/repo/apps/ui/src/bun", (path) => path === checkout)).toBe(checkout)
  })

  test("the loader policy gets the repository, home, and a real temp dir", () => {
    const paths = sandboxPathsFor("/work/force")
    expect(paths.repo).toBe("/work/force")
    expect(paths.home).not.toBe("")
    expect(paths.tmpdir.startsWith("/")).toBe(true)
  })

  test("a packaged CLI exposes its shipped authoring packages as a final Node fallback", () => {
    const cli = "/Applications/Smithers.app/Contents/Resources/app/build-cli/launcher.mjs"
    const nodeModules = "/Applications/Smithers.app/Contents/Resources/app/build-cli/node_modules"
    const manifest = `${nodeModules}/@smthrs/targets/package.json`
    expect(buildCliNodePath(cli, undefined, (path) => path === manifest)).toBe(nodeModules)
    expect(buildCliNodePath(cli, "/workspace/node_modules", (path) => path === manifest))
      .toBe(`${nodeModules}${delimiter}/workspace/node_modules`)
    expect(buildCliNodePath(cli, "/workspace/node_modules", () => false)).toBe("/workspace/node_modules")
  })

  test("the build-cli env is an allowlist with or without a colocated authoring manifest", () => {
    /* ui-bun-host/security/4: undefined (inherit everything) or { ...process.env, NODE_PATH } before. */
    const source = {
      HOME: "/home/u",
      PATH: "/usr/bin",
      NODE_PATH: "/workspace/node_modules",
      SMITHERS_CLOUD_TOKEN: "smithers_pat_SECRET",
      GITHUB_TOKEN: "ghp_SECRET",
      AWS_SECRET_ACCESS_KEY: "aws-SECRET",
      ANTHROPIC_API_KEY: "sk-ant-SECRET"
    }
    const cli = "/Applications/Smithers.app/Contents/Resources/app/build-cli/launcher.mjs"
    const manifest = "/Applications/Smithers.app/Contents/Resources/app/build-cli/node_modules/@smthrs/targets/package.json"
    expect(buildCliEnvironment(cli, source, () => false)).toEqual({ HOME: "/home/u", PATH: "/usr/bin", NODE_PATH: "/workspace/node_modules" })
    expect(buildCliEnvironment(cli, source, (path) => path === manifest)).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin",
      NODE_PATH: `/Applications/Smithers.app/Contents/Resources/app/build-cli/node_modules${delimiter}/workspace/node_modules`
    })
  })
})

describe("queryTargets", () => {
  test("no Node sidecar is a warning and an empty list", async () => {
    const result = await queryTargets({ repo: "/tmp", node: null, cli: "/nope/main.js" })
    expect(result.targets).toEqual([])
    expect(result.warnings[0]).toContain("No Node.js")
  })

  test("a missing loader is a warning, never a throw", async () => {
    const result = await queryTargets({ repo: "/tmp", node: bunSidecar, cli: "/nope/main.js", sandboxHost: noSandbox })
    expect(result.targets).toEqual([])
    expect(result.warnings[0]).toContain("missing at /nope/main.js")
  })

  test("the loader's listing maps to targets with the repo as cwd", async () => {
    const dir = await scratch()
    const cli = join(dir, "fake-cli.js")
    await writeFile(
      cli,
      `if (process.argv[2] !== "query") { console.log("not a query"); process.exit(2) }\nconsole.log(${
        JSON.stringify(LISTING)
      }.replace("//...", process.cwd()))`
    )
    const result = await queryTargets({ repo: dir, node: bunSidecar, cli, sandboxHost: noSandbox })
    expect(result.warnings).toEqual([])
    expect(result.targets.map((target) => target.label)).toEqual(["//src:lint", "//:detectSecrets", "//src/Apps/Auction:srcs"])
    expect(result.targets.every((target) => target.workspace === ".")).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("fans out once per workspace: each loader runs at its own cwd, one failure cannot block the others", async () => {
    const dir = await scratch()
    await mkdir(join(dir, "ok"))
    await mkdir(join(dir, "broken"))
    const cli = join(dir, "fanout-cli.js")
    await writeFile(
      cli,
      [
        "const cwd = process.cwd()",
        "if (cwd.endsWith(\"broken\")) {",
        "  console.log(JSON.stringify({ code: \"query_failed\", message: \"WORKSPACE.ts: boom\" }))",
        "  process.exit(1)",
        "}",
        "const name = cwd.endsWith(\"ok\") ? \"ok\" : \"root\"",
        "console.log(JSON.stringify({ query: \"//...\", targets: [{ label: `//:${name}`, target: \"Shell.Test\", kinds: [\"test\"] }] }))"
      ].join("\n")
    )
    const result = await queryTargets({
      repo: dir,
      workspaces: [
        { path: ".", title: "root" },
        { path: "ok", title: "ok" },
        { path: "broken", title: "broken" }
      ],
      node: bunSidecar,
      cli,
      sandboxHost: noSandbox
    })
    expect(result.targets.map((target) => [target.workspace, target.label])).toEqual([
      [".", "//:root"],
      ["ok", "//:ok"]
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("broken")
    expect(result.warnings[0]).toContain("query_failed: WORKSPACE.ts: boom")
  })

  test("a loader failure is warnings and an empty list", async () => {
    const dir = await scratch()
    const cli = join(dir, "failing-cli.js")
    await writeFile(
      cli,
      "console.log(JSON.stringify({ code: \"query_failed\", message: \"WORKSPACE.ts: boom\" }))\nconsole.error(\"loader stderr\")\nprocess.exit(1)"
    )
    const result = await queryTargets({ repo: dir, node: bunSidecar, cli, sandboxHost: noSandbox })
    expect(result.targets).toEqual([])
    expect(result.warnings[0]).toBe("The loader exited 1: query_failed: WORKSPACE.ts: boom")
    expect(result.warnings[1]).toBe("loader stderr")
  })
})

describe("createTargetRunner", () => {
  const collect = (): {
    readonly frames: Array<{ topic: string; runId: string; frame: TargetRunFrame }>
    readonly publish: (topic: string, message: unknown) => void
    readonly exited: (runId: string) => Promise<void>
  } => {
    const frames: Array<{ topic: string; runId: string; frame: TargetRunFrame }> = []
    const waiters = new Map<string, () => void>()
    return {
      frames,
      publish: (topic, message) => {
        const envelope = message as { runId: string; frame: TargetRunFrame }
        frames.push({ topic, runId: envelope.runId, frame: envelope.frame })
        if (envelope.frame.type === "exit") waiters.get(envelope.runId)?.()
      },
      exited: (runId) =>
        new Promise((resolve) => {
          if (frames.some((entry) => entry.runId === runId && entry.frame.type === "exit")) resolve()
          else waiters.set(runId, resolve)
        })
    }
  }

  test("a target run child never sees the app's credentials, even beside a colocated authoring manifest", async () => {
    const dir = await scratch()
    await mkdir(join(dir, "node_modules", "@smthrs", "targets"), { recursive: true })
    await writeFile(join(dir, "node_modules", "@smthrs", "targets", "package.json"), "{}")
    const cli = join(dir, "env-cli.js")
    const names = ["SMITHERS_CLOUD_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "HOME", "NODE_PATH"]
    await writeFile(cli, `console.log(${JSON.stringify(names)}.map((name) => name + "=" + (name in process.env)).join(" "))`)
    const seeded = { SMITHERS_CLOUD_TOKEN: "smithers_pat_SECRET", GITHUB_TOKEN: "ghp_SECRET", AWS_SECRET_ACCESS_KEY: "aws-SECRET" }
    const previous = Object.fromEntries(Object.keys(seeded).map((key) => [key, process.env[key]]))
    Object.assign(process.env, seeded)
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000 })
    try {
      const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
      runner.attach(run.runId)
      await sink.exited(run.runId)
      const stdout = sink.frames
        .filter((entry) => entry.runId === run.runId && entry.frame.type === "stdout")
        .map((entry) => (entry.frame as { data: string }).data)
        .join("")
      expect(stdout).toBe("SMITHERS_CLOUD_TOKEN=false GITHUB_TOKEN=false AWS_SECRET_ACCESS_KEY=false HOME=true NODE_PATH=true\n")
    } finally {
      await runner.stop()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test("an unarmed reservation never spawns, even on attach; arming enables auto-start once", async () => {
    const dir = await scratch()
    const cli = join(dir, "reserved-cli.js")
    await writeFile(cli, "console.log(\"reserved\")")
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 10 })
    try {
      const run = runner.reserve({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
      expect(runner.attach(run.runId)).toBe(false)
      await Bun.sleep(50)
      expect(run.status).toBe("pending")
      expect(sink.frames).toEqual([])
      expect(runner.arm(run.runId)).toBe(true)
      expect(runner.arm(run.runId)).toBe(false)
      await sink.exited(run.runId)
      expect(run.status).toBe("done")
      expect(sink.frames.filter((entry) => entry.frame.type === "started")).toHaveLength(1)
      expect(runner.arm(run.runId)).toBe(false)
      expect(runner.arm("nope")).toBe(false)
    } finally {
      await runner.stop()
    }
  })

  test("cancelling an unarmed reservation releases capacity without publishing frames", async () => {
    const dir = await scratch()
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli: join(dir, "never.js"), autoStartMs: 10, maxActiveRuns: 1, maxRetainedRuns: 1 })
    const input = { repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar }
    try {
      const run = runner.reserve(input)
      expect(() => runner.reserve(input)).toThrow("At most 1 target runs")
      expect(await runner.cancel(run.runId)).toBe(true)
      expect(runner.get(run.runId)).toBeUndefined()
      expect(runner.arm(run.runId)).toBe(false)
      expect(runner.attach(run.runId)).toBe(false)
      expect(await runner.cancel(run.runId)).toBe(false)
      const next = runner.reserve(input)
      expect(await runner.cancel(next.runId)).toBe(true)
      await Bun.sleep(50)
      expect(sink.frames).toEqual([])
    } finally {
      await runner.stop()
    }
  })

  test("attach starts the child; stdout, stderr and the exit code stream to the topic", async () => {
    const dir = await scratch()
    // A build-system workspace: the runner uses the bare-label form here (see runArgv).
    await writeFile(join(dir, "WORKSPACE.ts"), "export const Workspace = {}\n")
    const cli = join(dir, "run-cli.js")
    await writeFile(
      cli,
      "console.log(`ran ${process.argv[2]} in ${process.cwd()}`)\nconsole.error(\"progress line\")\nprocess.exit(3)"
    )
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//src:lint", node: bunSidecar })
    expect(run.status).toBe("pending")
    expect(runner.attach(run.runId)).toBe(true)
    await sink.exited(run.runId)
    const own = sink.frames.filter((entry) => entry.runId === run.runId)
    expect(own.every((entry) => entry.topic === runTopic(run.runId))).toBe(true)
    const stdout = own.filter((entry) => entry.frame.type === "stdout").map((entry) => (entry.frame as { data: string }).data).join("")
    const stderr = own.filter((entry) => entry.frame.type === "stderr").map((entry) => (entry.frame as { data: string }).data).join("")
    expect(stdout).toBe(`ran //src:lint in ${dir}\n`)
    expect(stderr).toBe("progress line\n")
    /* Every published frame carries the run-local seq replay orders by. */
    expect(own.map((entry) => (entry.frame as { seq?: number }).seq)).toEqual(own.map((_entry, index) => index))
    expect(own[own.length - 1]?.frame).toMatchObject({ type: "exit", code: 3, seq: own.length - 1 })
    expect(own.map((entry) => entry.frame.seq)).toEqual(own.map((_, index) => index))
    expect(runner.get(run.runId)).toMatchObject({ status: "failed", exitCode: 3 })
    expect(runner.attach("nope")).toBe(false)
    await runner.stop()
  })

  test("a run in a child workspace runs at the joined cwd", async () => {
    const dir = await scratch()
    await mkdir(join(dir, "aomi-sdk"))
    const cli = join(dir, "ws-cli.js")
    await writeFile(cli, "console.log(process.cwd())")
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: "aomi-sdk", label: "//:clippyFix", node: bunSidecar })
    expect(run.workspace).toBe("aomi-sdk")
    runner.attach(run.runId)
    await sink.exited(run.runId)
    const stdout = sink.frames
      .filter((entry) => entry.runId === run.runId && entry.frame.type === "stdout")
      .map((entry) => (entry.frame as { data: string }).data)
      .join("")
    expect(stdout).toBe(`${join(dir, "aomi-sdk")}\n`)
    await runner.stop()
  })

  test("a run nobody attaches to starts on its own", async () => {
    const dir = await scratch()
    const cli = join(dir, "auto-cli.js")
    await writeFile(cli, "console.log(\"auto\")")
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 10 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
    await sink.exited(run.runId)
    expect(runner.get(run.runId)).toMatchObject({ status: "done", exitCode: 0 })
    await runner.stop()
  })

  test("cancelling a pending run reports it without spawning", async () => {
    const dir = await scratch()
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli: join(dir, "never.js"), autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
    expect(await runner.cancel(run.runId)).toBe(true)
    expect(sink.frames.map((entry) => entry.frame)).toEqual([
      { type: "error", message: "Cancelled before it started.", seq: 0 },
      { type: "exit", code: null, seq: 1 }
    ])
    expect(await runner.cancel(run.runId)).toBe(false)
    expect(await runner.cancel("nope")).toBe(false)
    await runner.stop()
  })

  for (const mode of ["cancel", "stop-open-pipe"] as const) {
    test(`${mode} waits for escalation and reaping even when output pipes stay open`, async () => {
      const dir = await scratch()
      const cli = join(dir, "double-cli.js")
      await writeFile(cli, "")
      const sink = collect()
      const exited = Promise.withResolvers<number>()
      const signals: Array<string> = []
      let cancelledReaders = 0
      const pipe = () => new ReadableStream<Uint8Array>({ cancel: () => { cancelledReaders += 1; return new Promise<void>(() => {}) } })
      const child = { pid: 2147483647, stdout: pipe(), stderr: pipe(), exited: exited.promise,
        kill: (signal: string) => { signals.push(signal) } }
      const spawn = spyOn(Bun, "spawn").mockImplementation(() => child as unknown as ReturnType<typeof Bun.spawn>)
      const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(-child.pid)
        if (signal === 0 && signals.includes("SIGKILL")) throw Object.assign(new Error("gone"), { code: "ESRCH" })
        if (signal !== 0) signals.push(String(signal))
        if (mode === "stop-open-pipe" && signal === "SIGTERM") exited.resolve(143)
        return true
      })
      const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000, killGraceMs: 25 })
      const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
      try {
        runner.attach(run.runId)
        let resolved = false
        const closing = Promise.resolve(mode === "cancel" ? runner.cancel(run.runId) : runner.stop()).then(() => { resolved = true })
        const concurrent = mode === "cancel" ? runner.cancel(run.runId) : runner.stop()
        await Bun.sleep(10)
        expect(resolved).toBe(false)
        expect(signals).toEqual(["SIGTERM"])
        for (let i = 0; i < 100 && !signals.includes("SIGKILL"); i++) await Bun.sleep(10)
        expect(signals).toEqual(["SIGTERM", "SIGKILL"])
        if (mode === "cancel") {
          expect(resolved).toBe(false)
          expect(run.status).toBe("running")
          exited.resolve(137)
        }
        await closing
        await concurrent
        expect(run.status).toBe("failed")
        expect(cancelledReaders).toBe(2)
        expect(sink.frames.at(-1)?.frame.type).toBe("exit")
        expect(spawn.mock.calls[0]?.[1]).toMatchObject({ detached: true })
      } finally {
        exited.resolve(137)
        void child.stdout.cancel().catch(() => {})
        void child.stderr.cancel().catch(() => {})
        await runner.stop()
        spawn.mockRestore()
        kill.mockRestore()
      }
    })
  }

  /*
   * A loader that swallows SIGTERM and a grandchild that inherits the stdout
   * pipe: the default signal alone leaves both alive and the pumps waiting
   * on a pipe nobody closes. The stubborn child prints "<pid> <grandchild pid>".
   */
  const STUBBORN_CLI = `
    process.on("SIGTERM", () => {})
    const { spawn } = require("node:child_process")
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); process.disconnect(); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit", "ipc"] })
    child.on("message", () => process.stdout.write(process.pid + " " + child.pid + "\\n"))
    setInterval(() => {}, 1000)
  `
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const stubbornPids = async (sink: ReturnType<typeof collect>, runId: string): Promise<[number, number]> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const line = sink.frames.filter((entry) => entry.runId === runId && entry.frame.type === "stdout").map((entry) => (entry.frame as { data: string }).data).join("")
      const match = /^(\d+) (\d+)\n/.exec(line)
      if (match !== null) return [Number(match[1]), Number(match[2])]
      await Bun.sleep(25)
    }
    throw new Error("the stubborn child never announced its pids")
  }

  test("cancelling a running child that ignores SIGTERM escalates, reaps the whole tree, and resolves once the run is settled", async () => {
    const dir = await scratch()
    const cli = join(dir, "stubborn-cli.js")
    await writeFile(cli, STUBBORN_CLI)
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 10, killGraceMs: 200 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
    try {
      const [pid, grandchild] = await stubbornPids(sink, run.runId)
      expect(alive(pid)).toBe(true)
      expect(alive(grandchild)).toBe(true)
      const startedAt = Date.now()
      expect(await runner.cancel(run.runId)).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect(run.status).toBe("failed")
      expect(sink.frames.some((entry) => entry.runId === run.runId && entry.frame.type === "exit")).toBe(true)
      expect(alive(pid)).toBe(false)
      expect(alive(grandchild)).toBe(false)
      expect(await runner.cancel(run.runId)).toBe(false)
    } finally {
      await runner.stop()
    }
  })

  test("cancellation kills a silent descendant even when its parent exits during the grace", async () => {
    const dir = await scratch()
    const cli = join(dir, "silent-descendant.js")
    await writeFile(cli, STUBBORN_CLI
      .replace('process.on("SIGTERM", () => {})', 'process.on("SIGTERM", () => process.exit(0))')
      .replace('["ignore", "inherit", "inherit", "ipc"]', '["ignore", "ignore", "ignore", "ipc"]'))
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000, killGraceMs: 200 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
    let grandchild: number | undefined
    try {
      runner.attach(run.runId)
      const pids = await stubbornPids(sink, run.runId)
      grandchild = pids[1]
      expect(await runner.cancel(run.runId)).toBe(true)
      expect(run.status).not.toBe("running")
      expect(alive(pids[0])).toBe(false)
      // The host reaps its direct child; the OS reaps the orphan after SIGKILL.
      for (let i = 0; i < 100 && alive(grandchild); i++) await Bun.sleep(10)
      expect(alive(grandchild)).toBe(false)
    } finally {
      if (grandchild !== undefined && alive(grandchild)) process.kill(grandchild, "SIGKILL")
      await runner.stop()
    }
  })

  test("stop closes admission, reaps stubborn trees within the deadline, and fails runs that never started", async () => {
    const dir = await scratch()
    const cli = join(dir, "stubborn-cli.js")
    await writeFile(cli, STUBBORN_CLI)
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 10, killGraceMs: 200 })
    const input = { repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar }
    const run = runner.start(input)
    const [pid, grandchild] = await stubbornPids(sink, run.runId)
    const unarmed = runner.reserve(input)
    const pending = runner.reserve(input)
    runner.arm(pending.runId)
    const startedAt = Date.now()
    const stopped = runner.stop()
    expect(() => runner.reserve(input)).toThrow("stopped")
    expect(runner.attach(pending.runId)).toBe(false)
    expect(runner.arm(unarmed.runId)).toBe(false)
    expect(runner.get(unarmed.runId)).toBeUndefined()
    expect(runner.stop()).toBe(stopped)
    await stopped
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(run.status).toBe("failed")
    expect(alive(pid)).toBe(false)
    expect(alive(grandchild)).toBe(false)
    expect(pending.status).toBe("failed")
    expect(sink.frames.filter((entry) => entry.runId === pending.runId).map((entry) => entry.frame)).toEqual([
      { type: "error", message: "Cancelled: the app is shutting down.", seq: 0 },
      { type: "exit", code: null, seq: 1 }
    ])
    await runner.stop()
  })
})

describe("runArgv picks the CLI form the workspace's authoring surface accepts", () => {
  const { runArgv } = require("./Targets") as typeof import("./Targets")
  test("a WORKSPACE.ts workspace runs the bare-label form, still with --ui plain so FORCE_COLOR cannot hide the status lines", () => {
    const exists = (path: string) => path.endsWith("/WORKSPACE.ts")
    expect(runArgv("/w", "//src:lint", ["lint"], exists)).toEqual(["//src:lint", "--audience", "human", "--ui", "plain"])
  })
  test("a legacy declaration-rooted workspace runs `<verb> <label> --ui plain` with the verb from the first kind", () => {
    const exists = () => false
    expect(runArgv("/w", "//packages/smithers/flows/canonical:check", ["build"], exists)).toEqual(["build", "//packages/smithers/flows/canonical:check", "--audience", "human", "--ui", "plain"])
    expect(runArgv("/w", "//:tsconfig", ["run", "lint"], exists)).toEqual(["run", "//:tsconfig", "--audience", "human", "--ui", "plain"])
    expect(runArgv("/w", "//x:y", [], exists)).toEqual(["build", "//x:y", "--audience", "human", "--ui", "plain"])
  })
})

/*
 * Pattern runs (LOCAL-APP.md "Targets: load and run"): `<verb> <pattern>`
 * is how CI runs everything (`smithers-build ci '//packages/...'`), and the
 * executor's trailing results block is the one place each target's RULE is
 * printed. The fixture is the real output of
 * `smithers-build ci '//packages/smithers/flows/canonical/...' --ui plain` on this checkout.
 */
describe("pattern runs and the results block", () => {
  const { createRunStdoutParser, patternRunArgv } = require("./Targets") as typeof import("./Targets")
  const REAL_CI_OUTPUT = [
    "//packages/smithers/flows/canonical:docs  ran  13ms",
    "//packages/smithers/flows/canonical:fmt  ran  394ms",
    "//packages/smithers/flows/canonical:check  ran  836ms",
    "3 targets: 0 hit, 3 ran, 0 failed, 0 skipped (2.6s)",
    "verb: ci",
    "pattern: //packages/smithers/flows/canonical/...",
    "jobs: 16",
    "durationMs: 2551.275042",
    "counts:",
    "  hit: 0",
    "  ran: 3",
    "  failed: 0",
    "  skipped: 0",
    "ok: true",
    "results[3]{label,target,status,durationMs,key}:",
    "  \"//packages/smithers/flows/canonical:fmt\",Dprint,ran,393.87254099999996,ce06981499a592588e6fcb4c617f00351198489566c0d07eec3b1db441f5d1b6",
    "  \"//packages/smithers/flows/canonical:check\",Typecheck,ran,835.5130409999997,d88ca8e8c34b996daad7b47c8bd24046963f957e141c3649facc216d875b56d9",
    "  \"//packages/smithers/flows/canonical:docs\",DocsParity,ran,12.953042000000096,9c99919d39ddfd9e1cc850480c9913756eb82ce6cd51f3d7e70666ce5800951c",
    ""
  ].join("\n")

  test("patternRunArgv is the verb over the pattern with the plain renderer, on either authoring surface", () => {
    expect(patternRunArgv("ci", "//packages/...")).toEqual(["ci", "//packages/...", "--audience", "human", "--ui", "plain"])
  })

  test("the status lines fill the rows, the summary lands, and the results block names each target's rule", () => {
    const parser = createRunStdoutParser({ startedAt: 1_000 })
    const events = parser.push("stdout", REAL_CI_OUTPUT, 4_000)
    const nodes = events.filter((event) => event.type === "node")
    expect(nodes.map((event) => event.type === "node" ? `${event.node.label} ${event.node.status}` : "")).toEqual([
      "//packages/smithers/flows/canonical:docs ran",
      "//packages/smithers/flows/canonical:fmt ran",
      "//packages/smithers/flows/canonical:check ran",
      "//packages/smithers/flows/canonical:fmt ran",
      "//packages/smithers/flows/canonical:check ran",
      "//packages/smithers/flows/canonical:docs ran"
    ])
    const summary = events.find((event) => event.type === "summary")
    expect(summary?.type === "summary" ? summary.summary : undefined).toMatchObject({ total: 3, hit: 0, ran: 3, failed: 0, skipped: 0, durationMs: 2600, ok: true })
    const timings = parser.timings()
    expect(timings.map((node) => [node.label, node.rule, node.key?.slice(0, 8)])).toEqual([
      ["//packages/smithers/flows/canonical:docs", "DocsParity", "9c99919d"],
      ["//packages/smithers/flows/canonical:fmt", "Dprint", "ce069814"],
      ["//packages/smithers/flows/canonical:check", "Typecheck", "d88ca8e8"]
    ])
    // The `verb:` / `counts:` envelope lines are not targets and never become rows.
    expect(timings).toHaveLength(3)
  })

  test("a results row for a target the status lines never named still becomes a row with its rule", () => {
    const parser = createRunStdoutParser({ startedAt: 0 })
    parser.push("stdout", "results[1]{label,target,status,durationMs,key}:\n  \"//x:y\",Vitest,failed,12.5,abc\nok: false\n", 50)
    expect(parser.timings()).toEqual([{ label: "//x:y", status: "failed", rule: "Vitest", key: "abc", startedAt: 37, endedAt: 50, durationMs: 13 }])
  })
})
