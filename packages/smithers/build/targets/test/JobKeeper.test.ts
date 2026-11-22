/**
 * A job's process namespace, with a real bubblewrap, a real keeper and real steps: what a step leaves running lives
 * until the job ends, a later step reaches it and sees it, a program that detaches stays in the job, and the job's end
 * ends everything in it.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as JobKeeper from "../src/JobKeeper.ts"

const made: Array<string> = []
const keepers: Array<ChildProcess> = []
afterAll(() => {
  for (const keeper of keepers) keeper.kill("SIGKILL")
  for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

/** The bubblewrap on `PATH` that gives a command a process namespace of its own here, if any. */
const bwrap = ((): string | undefined => {
  if (process.platform !== "linux") return undefined
  const found = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim()
  if (found === "") return undefined
  const tried = spawnSync(found, ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"])
  return tried.status === 0 ? found : undefined
})()

/** A keeper in a namespace of its own, listening in a new directory; with `held`, its owner holds its input open. */
const job = async (held = false): Promise<{ readonly directory: string; readonly keeper: ChildProcess }> => {
  const directory = mkdtempSync(join(tmpdir(), "job-keeper-"))
  made.push(directory)
  const argv = JobKeeper.namespaced(bwrap!, [], JobKeeper.keeper(process.execPath))
  const keeper = spawn(argv[0], argv.slice(1), {
    cwd: directory,
    stdio: [held ? "pipe" : "ignore", "ignore", "ignore"],
    env: { PATH: process.env["PATH"] }
  })
  keepers.push(keeper)
  for (let waited = 0; !existsSync(join(directory, JobKeeper.socketName)); waited += 20) {
    if (waited > 10_000) throw new Error("the keeper did not listen")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { directory, keeper }
}

interface Ran {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly left: ReadonlyArray<JobKeeper.Left>
  readonly cpuMs: number | undefined
}

let steps = 0
/** Runs `script` as a step of the job in `directory`, as a runner runs a step: `bash -e -c`. */
const step = (
  directory: string,
  script: string,
  env: Readonly<Record<string, string>> = {},
  done?: string
): Promise<Ran> =>
  new Promise((resolve) => {
    const left = join(directory, `left-${++steps}.json`)
    const argv = JobKeeper.client(process.execPath, directory, ["bash", "-e", "-c", script], { left, done })
    const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("close", async (status, signal) =>
      resolve({
        status,
        signal,
        stdout,
        stderr,
        left: JobKeeper.leftIn(existsSync(left) ? readFileSync(left, "utf8") : undefined),
        cpuMs: await JobKeeper.cpuAt(left)
      }))
  })

/** The processes of this user whose whole command line is `line`. */
const running = (line: string): ReadonlyArray<string> =>
  spawnSync("pgrep", ["-u", String(process.getuid?.()), "-x", "-f", line], { encoding: "utf8" }).stdout
    .split("\n")
    .filter((pid) => pid !== "")

const ended = (keeper: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (keeper.exitCode !== null || keeper.signalCode !== null) return resolve()
    keeper.once("exit", () => resolve())
    keeper.kill("SIGKILL")
  })

describe.runIf(bwrap !== undefined)("a job's steps in one namespace", () => {
  it("passes on what a step prints, its exit code and its environment, and the step's own NODE_OPTIONS", async () => {
    const { directory, keeper } = await job()
    const ran = await step(directory, "echo out $GIVEN; echo \"$NODE_OPTIONS\"; echo err >&2; exit 3", {
      GIVEN: "given",
      NODE_OPTIONS: "--require ./no-such-file.js"
    })
    expect(ran).toEqual({
      status: 3,
      signal: null,
      stdout: "out given\n--require ./no-such-file.js\n",
      stderr: "err\n",
      left: [],
      cpuMs: expect.any(Number)
    })
    const empty = await step(directory, "echo \"[${NODE_OPTIONS-unset}]\"", { NODE_OPTIONS: "" })
    expect(empty.stdout).toBe("[]\n")
    await ended(keeper)
  }, 60_000)

  it("keeps a server one step starts for the next step, which reaches it and sees it, until the job ends", async () => {
    const { directory, keeper } = await job()
    writeFileSync(join(directory, "x.txt"), "ok\n")
    const port = 20_000 + (process.pid % 20_000)
    const server = `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${directory}`
    const started = await step(directory, `${server} > /dev/null 2>&1 &`)
    expect(started.status).toBe(0)
    expect(started.left.map((each) => each.command)).toEqual([server])
    const asked = await step(
      directory,
      `for i in $(seq 1 50); do curl -sf http://127.0.0.1:${port}/x.txt && break; sleep 0.1; done; ` +
        `ps -e -o args= | grep -c '^python3 -m http.server'`
    )
    expect(asked).toEqual({
      status: 0,
      signal: null,
      stdout: "ok\n1\n",
      stderr: "",
      left: [],
      cpuMs: expect.any(Number)
    })
    expect(running(server)).toHaveLength(1)
    await ended(keeper)
    for (let waited = 0; running(server).length > 0 && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(running(server)).toEqual([])
  }, 60_000)

  it(
    "keeps a program that detaches into a session of its own, as a daemon does, and ends it with the job",
    async () => {
      const { directory, keeper } = await job()
      const seconds = 70_000 + (process.pid % 9_000)
      const daemon = await step(directory, `setsid sh -c 'sleep ${seconds} > /dev/null 2>&1 &' && echo detached`)
      expect(daemon.stdout).toBe("detached\n")
      expect(daemon.left.map((each) => each.command)).toEqual([`sleep ${seconds}`])
      // A later step finds it by name, as a step that stops a server does.
      const found = await step(directory, `pgrep -x -f 'sleep ${seconds}' > /dev/null && echo found`)
      expect(found.stdout).toBe("found\n")
      expect(running(`sleep ${seconds}`)).toHaveLength(1)
      await ended(keeper)
      for (let waited = 0; running(`sleep ${seconds}`).length > 0 && waited < 5_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(running(`sleep ${seconds}`)).toEqual([])
    },
    60_000
  )

  it("counts a worker a kept program starts while a later step runs for no step", async () => {
    const { directory, keeper } = await job()
    const fifo = join(directory, "start")
    // The server starts a worker each time it is asked, through a named pipe.
    const started = await step(
      directory,
      `mkfifo ${fifo}; (while read -r line < ${fifo}; do sleep 600 & done) > /dev/null 2>&1 &`
    )
    expect(started.left).toHaveLength(1)
    const asked = await step(directory, `echo go > ${fifo}; sleep 0.3`)
    expect(asked.left).toEqual([])
    await ended(keeper)
  }, 60_000)

  it("ends a step by a signal as the signal ended it, and a step whose program is missing with 127", async () => {
    const { directory, keeper } = await job()
    expect((await step(directory, "kill -TERM $$")).signal).toBe("SIGTERM")
    const missing = await step(directory, "no-such-program-here")
    expect(missing.status).toBe(127)
    expect(missing.stderr).toContain("no-such-program-here: command not found")
    await ended(keeper)
  }, 60_000)

  it("passes a signal sent to the step on, and ends a step whose client went away", async () => {
    const { directory, keeper } = await job()
    const seconds = 80_000 + (process.pid % 9_000)
    const argv = JobKeeper.client(process.execPath, directory, ["sleep", String(seconds)])
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" })
    for (let waited = 0; running(`sleep ${seconds}`).length === 0 && waited < 10_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    child.kill("SIGTERM")
    const signal = await new Promise((resolve) => child.on("close", (_status, signal) => resolve(signal)))
    expect(signal).toBe("SIGTERM")
    expect(running(`sleep ${seconds}`)).toEqual([])
    const gone = spawn(argv[0], argv.slice(1), { stdio: "ignore" })
    for (let waited = 0; running(`sleep ${seconds}`).length === 0 && waited < 10_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    gone.kill("SIGKILL")
    for (let waited = 0; running(`sleep ${seconds}`).length > 0 && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(running(`sleep ${seconds}`)).toEqual([])
    await ended(keeper)
  }, 60_000)

  it("ends a step once a recorder that keeps following it writes the step's exit status", async () => {
    const { directory, keeper } = await job()
    const done = join(directory, "done")
    // A stand-in for a recorder: it writes the command's status and stays, as smthrs-observe --keep does.
    const ran = await step(directory, `echo 5 > ${done}; sleep 600`, {}, done)
    expect(ran.status).toBe(5)
    expect(ran.left.map((each) => each.command)).toEqual(["sleep 600"])
    await ended(keeper)
  }, 60_000)

  // The process that started a job can die before bubblewrap has asked to die with it: the keeper's input, which only
  // that process holds open, closes however it died.
  it("ends the job with what a step left once its owner lets go of its input, as a killed owner does", async () => {
    const { directory, keeper } = await job(true)
    const seconds = 80_000 + (process.pid % 9_000)
    const left = await step(directory, `sleep ${seconds} > /dev/null 2>&1 &`)
    expect(left.left.map((each) => each.command)).toEqual([`sleep ${seconds}`])
    const exited = new Promise((resolve) => keeper.once("exit", resolve))
    keeper.stdin!.end()
    await exited
    for (let waited = 0; running(`sleep ${seconds}`).length > 0 && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(running(`sleep ${seconds}`)).toEqual([])
  }, 60_000)

  it("ends at once where its owner is gone before it starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "job-keeper-"))
    made.push(directory)
    const argv = JobKeeper.namespaced(bwrap!, [], JobKeeper.keeper(process.execPath))
    const keeper = spawn(argv[0], argv.slice(1), { cwd: directory, stdio: ["pipe", "ignore", "ignore"] })
    keepers.push(keeper)
    keeper.stdin.end()
    const code = await new Promise((resolve) => keeper.once("exit", resolve))
    expect(code).toBe(0)
  }, 60_000)

  it("says the keeper ended before the step did", async () => {
    const { directory, keeper } = await job()
    const pending = step(directory, "sleep 600")
    await new Promise((resolve) => setTimeout(resolve, 500))
    await ended(keeper)
    const ran = await pending
    expect(ran.status).toBe(125)
    expect(ran.stderr).toBe("smthrs: the job's keeper ended before the step did\n")
  }, 60_000)
})

describe.runIf(bwrap !== undefined)("a step's CPU time, as its keeper counts it", () => {
  it("counts a child of a child's, and what a program the step left used until the step ended", async () => {
    const { directory } = await job()
    // Burns CPU, not wall time, so a loaded machine gives the same count.
    const burn = (ms: number): string => `${process.execPath} -e 'while (process.cpuUsage().user < ${ms * 1000}) {}'`
    const deep = await step(directory, `sh -c "sh -c \\"${burn(2000)}\\""`)
    expect([deep.status, deep.left]).toEqual([0, []])
    expect(deep.cpuMs).toBeGreaterThanOrEqual(1800)
    const seconds = 81_000 + (process.pid % 900)
    const leaving = await step(directory, `${burn(300)}; (${burn(700)}; exec sleep ${seconds}) > /dev/null 2>&1 &`)
    expect(leaving.left.length).toBeGreaterThan(0)
    expect(leaving.cpuMs).toBeGreaterThanOrEqual(800)
    // What it left runs on: none of it counts for a later step.
    const later = await step(directory, "true")
    expect(later.cpuMs).toBeLessThan(500)
    expect(await JobKeeper.cpuAt(join(directory, "never-written.json"))).toBeUndefined()
    writeFileSync(join(directory, "garbled.json.cpu"), "many")
    expect(await JobKeeper.cpuAt(join(directory, "garbled.json"))).toBeUndefined()
  }, 60_000)
})

describe("what a step left, as the client wrote it", () => {
  it("reads the processes, and nothing from a missing file or anything else", () => {
    expect(JobKeeper.leftIn("[{\"pid\":11,\"command\":\"python3 -m http.server\"}]")).toEqual([
      { pid: 11, command: "python3 -m http.server" }
    ])
    expect(JobKeeper.leftIn(undefined)).toEqual([])
    expect(JobKeeper.leftIn("not json")).toEqual([])
    expect(JobKeeper.leftIn("{\"pid\":1}")).toEqual([])
    expect(JobKeeper.leftIn("[1, null, {\"pid\":\"2\",\"command\":\"x\"}, {\"pid\":3}]")).toEqual([])
  })

  it("starts a step through the shell that keeps NODE_OPTIONS for the step, and a keeper in its namespace", () => {
    const client = JobKeeper.client("/usr/bin/node", "/j", ["make", "test"])
    expect(client.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(client.slice(4)).toEqual(["/usr/bin/node", "/j", "", "", "--", "make", "test"])
    expect(JobKeeper.keeper("/usr/bin/node").slice(0, 2)).toEqual(["/usr/bin/node", "-e"])
    expect(JobKeeper.namespaced("/usr/bin/bwrap", ["--bind", "/a", "/tmp"], ["k"])).toEqual([
      "/usr/bin/bwrap",
      "--dev-bind",
      "/",
      "/",
      "--bind",
      "/a",
      "/tmp",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
      "--",
      "k"
    ])
  })
})

describe.runIf(bwrap !== undefined)("a job's keeper, asked by its owner", () => {
  it("ends what a step left running when asked, and the job goes on", async () => {
    const { directory, keeper } = await job()
    const seconds = 75_000 + (process.pid % 9_000)
    const started = await step(directory, `sleep ${seconds} > /dev/null 2>&1 &`)
    expect(started.left).toHaveLength(1)
    await JobKeeper.end(process.execPath, directory, started.left)
    expect(running(`sleep ${seconds}`)).toEqual([])
    expect((await step(directory, "echo still")).stdout).toBe("still\n")
    await ended(keeper)
  }, 60_000)
})

describe("the file a client writes what a step left to", () => {
  it("is read and removed, and a missing one is none", async () => {
    const directory = mkdtempSync(join(tmpdir(), "job-keeper-left-"))
    made.push(directory)
    const file = join(directory, "left.json")
    writeFileSync(file, "[{\"pid\":7,\"command\":\"sleep 9\"}]")
    expect(await JobKeeper.leftAt(file)).toEqual([{ pid: 7, command: "sleep 9" }])
    expect(existsSync(file)).toBe(false)
    expect(await JobKeeper.leftAt(file)).toEqual([])
  })
})

describe("what a step left in its directory where nothing keeps it", () => {
  const directory = (): string => {
    const made_ = mkdtempSync(join(tmpdir(), "orphans-"))
    made.push(made_)
    return made_
  }
  const sleeping = (line: string): ReadonlyArray<number> =>
    spawnSync("pgrep", ["-u", String(process.getuid?.()), "-x", "-f", line], { encoding: "utf8" }).stdout
      .split("\n").filter((pid) => pid !== "").map(Number)
  const until = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; !done() && waited < 10_000; waited += 50) await new Promise((r) => setTimeout(r, 50))
  }

  it("lists this user's processes with their parents, and none where ps cannot run", async () => {
    const listed = await JobKeeper.processes()
    expect(listed.get(process.pid)).toBe(process.ppid)
    expect((await JobKeeper.processes(join(directory(), "no-ps"))).size).toBe(0)
    // No process is new: nothing is looked at.
    expect(await JobKeeper.orphansIn(new Map(), directory(), "linux", process.pid, async () => new Map())).toEqual([])
    // A process that is new but works nowhere under a directory that is gone is not found.
    const listing = async (): Promise<ReadonlyMap<number, number>> => new Map([[process.pid, 1]])
    expect(await JobKeeper.orphansIn(new Map(), join(tmpdir(), "no-such-directory"), "linux", -1, listing)).toEqual([])
  })

  it("reads lsof's lines, and each process's directory on Linux", async () => {
    expect([...JobKeeper.cwdsFromLsof("nstray\np163\nfcwd\nn/\np164\nfcwd\nn/Users/me/w\n")]).toEqual([
      [163, "/"],
      [164, "/Users/me/w"]
    ])
    if (process.platform === "linux") {
      expect([...await JobKeeper.cwds([process.pid, 2 ** 22 + 1])]).toEqual([[process.pid, process.cwd()]])
    }
    // Where lsof cannot run, nothing is read.
    const lsof = spawnSync("lsof", ["-v"]).error === undefined
    if (!lsof) expect((await JobKeeper.cwds([process.pid], "darwin")).size).toBe(0)
  })

  it.runIf(process.platform === "linux")(
    "ends a program that left the step's process tree and works in its directory, and nothing else",
    async () => {
      const seconds = 71_000 + (process.pid % 900)
      const there = directory()
      const elsewhere = directory()
      const before = await JobKeeper.processes()
      // A step that left a program in a session of its own, and one that left it in another directory.
      spawnSync("/bin/sh", ["-c", `setsid -f sleep ${seconds} > /dev/null 2>&1 < /dev/null`], { cwd: there })
      spawnSync("/bin/sh", ["-c", `setsid -f sleep ${seconds + 1} > /dev/null 2>&1 < /dev/null`], { cwd: elsewhere })
      // A process of this one in the same directory, as a step still running is.
      const running = spawn("sleep", [String(seconds + 2)], { cwd: there, stdio: "ignore" })
      await until(() => sleeping(`sleep ${seconds}`).length === 1 && sleeping(`sleep ${seconds + 1}`).length === 1)
      try {
        // While steps may run: only what the system adopted, not a child of this process.
        const adopted = await JobKeeper.orphansIn(before, there)
        expect(adopted.map((each) => each.command)).toEqual([`sleep ${seconds}`])
        // Once none runs: everything new that works there.
        const found = await JobKeeper.endOrphans(before, there)
        expect(found.map((each) => each.command).toSorted()).toEqual([`sleep ${seconds}`, `sleep ${seconds + 2}`])
        expect(sleeping(`sleep ${seconds}`)).toEqual([])
        expect(sleeping(`sleep ${seconds + 2}`)).toEqual([])
        expect(sleeping(`sleep ${seconds + 1}`)).toHaveLength(1)
        // Nothing left: nothing found, nothing ended.
        expect(await JobKeeper.endOrphans(before, there)).toEqual([])
      } finally {
        running.kill("SIGKILL")
        for (const pid of sleeping(`sleep ${seconds + 1}`)) process.kill(pid, "SIGKILL")
      }
    },
    60_000
  )
})

describe.runIf(process.platform === "linux")("the processes a namespace's holder started, and their end", () => {
  it("lists a process's children, and waits for processes to end, ended ones and zombies at once", async () => {
    const seconds = 82_000 + (process.pid % 900)
    // A shell that leaves a child it never waits for, a zombie once it ends, and runs on as a sleep.
    const holder = spawn("/bin/sh", ["-c", `sleep 0.2 & exec sleep ${seconds}`], { stdio: "ignore" })
    try {
      let children: ReadonlyArray<number> = []
      for (let waited = 0; children.length === 0 && waited < 5_000; waited += 20) {
        children = JobKeeper.childrenOf(holder.pid!)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(children).toHaveLength(1)
      expect(await JobKeeper.allEnded(children, 5_000)).toBe(true)
      expect(await JobKeeper.allEnded([holder.pid!], 50)).toBe(false)
      expect(JobKeeper.childrenOf(2 ** 22 + 1)).toEqual([])
      expect(await JobKeeper.allEnded([])).toBe(true)
      // A process that is gone altogether has ended.
      expect(await JobKeeper.allEnded([2 ** 22 + 1])).toBe(true)
      // Where there is no /proc, as on macOS: asked with signal 0.
      expect(await JobKeeper.allEnded([2 ** 22 + 1], 50, "darwin")).toBe(true)
      expect(await JobKeeper.allEnded([holder.pid!], 50, "darwin")).toBe(false)
      // The first process of the system is another user's: it is there.
      expect(await JobKeeper.allEnded([1], 50, "darwin")).toBe(false)
    } finally {
      holder.kill("SIGKILL")
    }
  })
})

describe.runIf(process.platform === "linux")("what still runs when a job's end is not reached", () => {
  it("names a process of this namespace, and nothing for one that has ended", async () => {
    const seconds = 83_000 + (process.pid % 900)
    const sleeper = spawn("sleep", [String(seconds)], { stdio: "ignore" })
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(JobKeeper.stillIn([sleeper.pid!])).toEqual([{ pid: sleeper.pid, command: `sleep ${seconds}` }])
      expect(JobKeeper.stillIn([2 ** 22 + 1])).toEqual([])
      expect(JobKeeper.commandLineOf(2 ** 22 + 1)).toBe("")
      expect(await JobKeeper.endedOrNamed([], 50)).toBeUndefined()
      expect(await JobKeeper.endedOrNamed([sleeper.pid!], 50)).toBe(
        `what a step left running did not end within 0.05 seconds and still runs: ${sleeper.pid} sleep ${seconds}`
      )
      const lines: Array<string> = []
      await JobKeeper.endsOrSays([], (line) => lines.push(line), "smthrs: ", 50)
      expect(lines).toEqual([])
      await JobKeeper.endsOrSays([sleeper.pid!], (line) => lines.push(line), "smthrs: machine one: ", 50)
      expect(lines).toEqual([
        `smthrs: machine one: what a step left running did not end within 0.05 seconds and still runs: ${sleeper.pid} sleep ${seconds}`
      ])
    } finally {
      sleeper.kill("SIGKILL")
    }
  })

  it.runIf(bwrap !== undefined)("names every process of a namespace whose first process still runs", async () => {
    const seconds = 84_000 + (process.pid % 900)
    const holder = spawn(bwrap!, [
      "--dev-bind",
      "/",
      "/",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
      "--",
      "sh",
      "-c",
      `sleep ${seconds} & exec sleep ${seconds + 1}`
    ], { stdio: "ignore" })
    try {
      let first: ReadonlyArray<number> = []
      for (let waited = 0; waited < 5_000; waited += 20) {
        first = JobKeeper.childrenOf(holder.pid!)
        if (first.length > 0 && JobKeeper.stillIn(first).length >= 3) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const commands = JobKeeper.stillIn(first).map((each) => each.command)
      expect(commands).toEqual(expect.arrayContaining([`sleep ${seconds}`, `sleep ${seconds + 1}`]))
    } finally {
      holder.kill("SIGKILL")
    }
  })
})
