/**
 * Local lanes for the runner's tests: a `runner.json` with no `origin` over a real jj mirror whose `main` is its one
 * commit, the deterministic ACP test agent as profile `test-agent`, and the real `smthrs` executable for `runner
 * start`, `runner serve` and `runs` on the lanes root (the runner's state directory).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as LaneIntake from "../../../src/runner/LaneIntake.ts"
import * as LocalJobs from "../../../src/runner/LocalJobs.ts"
import type * as Workstreams from "../../../src/runner/Workstreams.ts"
import * as Host from "./host.ts"

const AGENT = fileURLToPath(new URL("../../../agent/test/fixtures/acp-test-agent.mjs", import.meta.url))
const BIN = fileURLToPath(new URL("../../../bin/smithers.mjs", import.meta.url))

/** The repository id `runner.json` names. */
export const REPOSITORY = "github/acme/app"

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Waits until `condition` holds, for at most `timeoutMs`, naming `what` when it never does. */
export const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 60_000, what = "condition") => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`)
    await sleep(100)
  }
}

/** Whether a process with `pid` is alive. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One test's runner: its directories, its mirror, and the processes it started. */
export const make = () => {
  const root = mkdtempSync(join(tmpdir(), "runner-lane-"))
  const agentState = join(root, "agent-state")
  const stateDir = join(root, "state")
  const configPath = join(root, "runner.json")
  mkdirSync(agentState)
  const mirror = Host.mirror(root)
  const jjEnv = { ...process.env, JJ_CONFIG: join(root, "jj-config") }
  execFileSync("jj", ["-R", mirror.path, "bookmark", "create", "main", "-r", "@-", ...Host.jjFlags], {
    stdio: "ignore",
    env: jjEnv
  })
  const children: Array<ChildProcess> = []
  const config = {
    name: "test-runner",
    capacity: 2,
    stateDir,
    heartbeatSeconds: 1,
    pollSeconds: 1,
    admission: { loadPerCpu: 1000, diskFloorGb: 0 },
    repositories: { [REPOSITORY]: { mirror: mirror.path } },
    profiles: {
      "test-agent": { argv: [process.execPath, AGENT], env: { ACP_TEST_AGENT_STATE: agentState } }
    }
  }
  writeFileSync(configPath, JSON.stringify(config))

  /** Runs `smthrs args` to its end: its exit code and output. */
  const smthrs = (args: ReadonlyArray<string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env: { ...process.env, SMITHERS_REMOTE: "" } })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000)
      child.once("error", reject)
      child.once("close", (code) => {
        clearTimeout(timeout)
        resolve({ code, stdout, stderr })
      })
    })

  /** `smthrs runs <args>` on the lanes root, decoded; it must succeed. */
  const runs = async (args: ReadonlyArray<string>) => {
    const read = await smthrs(["runs", ...args, "--root", stateDir, "--json"])
    if (read.code !== 0) throw new Error(`runs ${args.join(" ")}: ${read.stdout}${read.stderr}`)
    return JSON.parse(read.stdout) as unknown
  }

  const agentPids = () =>
    readdirSync(agentState).filter((name) => name.startsWith("agent-")).map((name) => Number(name.slice(6, -4)))

  return {
    root,
    agentState,
    stateDir,
    configPath,
    mirror,
    smthrs,
    runs,
    agentPids,
    /** The checkout directories under the runner's `work/`. */
    checkouts: () => existsSync(join(stateDir, "work")) ? readdirSync(join(stateDir, "work")) : [],
    /** The mirror's jj workspaces, by name. */
    workspaces: () =>
      execFileSync("jj", ["-R", mirror.path, "workspace", "list", ...Host.jjFlags], { encoding: "utf8", env: jjEnv })
        .split("\n").filter((line) => line !== "").map((line) => line.slice(0, line.indexOf(":"))),
    /** Moves the mirror's `main` to a new commit on top of it: that commit. */
    advanceMain: () => {
      const jj = (args: ReadonlyArray<string>) =>
        execFileSync("jj", ["-R", mirror.path, ...args, ...Host.jjFlags], { encoding: "utf8", env: jjEnv }).trim()
      jj(["new", "main", "--no-edit", "-m", "moved"])
      const moved = jj(["log", "--no-graph", "-r", "children(main) & description(substring:moved)", "-T", "commit_id"])
      jj(["bookmark", "set", "main", "-r", moved])
      return moved
    },
    /** Rewrites `runner.json` with `changes`. */
    configure: (changes: Record<string, unknown>) =>
      writeFileSync(configPath, JSON.stringify({ ...config, ...changes })),
    /** Writes a brief file holding `text`: its path. */
    brief: (text: string) => {
      const file = join(root, `brief-${readdirSync(root).length}.md`)
      writeFileSync(file, text)
      return file
    },
    /** The run status `runs list` shows for `runId`. */
    /** What `smthrs runner status` reads now. */
    workstreams: async () => {
      const read = await smthrs(["runner", "status", "--config", configPath, "--format", "json"])
      if (read.code !== 0) throw new Error(`runner status: ${read.stdout}${read.stderr}`)
      return (JSON.parse(read.stdout) as { readonly workstreams: ReadonlyArray<Workstreams.Workstream> }).workstreams
    },
    statusOf: async (runId: string) =>
      ((await runs(["list"])) as { readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }> })
        .items.find((item) => item.runId === runId)?.status,
    /** The run the daemon admitted request `id` as, once it has. */
    admitted: async (id: string) => {
      const file = LaneIntake.paths(stateDir).admitted(id)
      await until(() => existsSync(file), 120_000, `request ${id} admitted`)
      return (JSON.parse(readFileSync(file, "utf8")) as { readonly runId: string }).runId
    },
    /** Every job the store holds. */
    jobs: () =>
      existsSync(join(stateDir, "jobs"))
        ? readdirSync(join(stateDir, "jobs")).filter((name) => !name.startsWith(".")).map((name) =>
          JSON.parse(readFileSync(join(stateDir, "jobs", name), "utf8")) as LocalJobs.Row
        )
        : [],
    /** The transcript events kept for `key`. */
    transcript: (key: string) =>
      readFileSync(join(stateDir, "transcripts", `${LocalJobs.fileOf(key)}.jsonl`), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { readonly seq: number; readonly kind: string; readonly update: any }),
    /** Starts `smthrs runner serve` in a process group of its own. */
    daemon: () => {
      const child = spawn(process.execPath, [BIN, "runner", "serve", "--config", configPath], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      })
      let log = ""
      child.stdout!.on("data", (chunk) => (log += chunk))
      child.stderr!.on("data", (chunk) => (log += chunk))
      children.push(child)
      return { child, log: () => log }
    },
    /** Stops every process this runner started, and every agent, then deletes its directories. */
    close: async () => {
      for (const child of children.splice(0)) {
        try {
          process.kill(-child.pid!, "SIGKILL")
        } catch {
          // Gone already.
        }
        await until(
          () => {
            try {
              process.kill(-child.pid!, 0)
              return false
            } catch {
              return true
            }
          },
          10_000,
          "process group gone"
        )
      }
      for (const pid of agentPids()) if (alive(pid)) process.kill(pid, "SIGKILL")
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** One test's runner. */
export type Lanes = ReturnType<typeof make>
