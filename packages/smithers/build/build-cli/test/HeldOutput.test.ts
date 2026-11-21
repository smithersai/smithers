/**
 * What holds a command's output, read from a `/proc` laid out in a real
 * directory: each process a directory with its descriptors as links.
 */
import { spawn } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as HeldOutput from "../src/internal/HeldOutput.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

/** A `/proc` whose processes hold the given descriptors, by pid. */
const proc = async (processes: Readonly<Record<string, Readonly<Record<string, string>>>>): Promise<string> => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-held-output-"))
  temporary.push(root)
  for (const [pid, fds] of Object.entries(processes)) {
    await Fs.mkdir(Path.join(root, pid, "fd"), { recursive: true })
    for (const [fd, link] of Object.entries(fds)) await Fs.symlink(link, Path.join(root, pid, "fd", fd))
  }
  return root
}

describe("what holds a command's output", () => {
  it("is its output's links, and every other process that holds one of them", async () => {
    const root = await proc({
      "10": { "0": "/dev/null", "1": "socket:[7]", "2": "socket:[8]" },
      "11": { "1": "socket:[7]" },
      "12": { "2": "socket:[8]", "5": "pipe:[9]" },
      "13": { "1": "/dev/null" },
      [String(process.pid)]: { "1": "socket:[7]" },
      self: { "1": "socket:[7]" }
    })
    await Fs.mkdir(Path.join(root, "14"))
    const killed: Array<number> = []
    const held = HeldOutput.make(root, (pid) => void killed.push(pid))
    const links = held.links(10)
    expect(links).toEqual(["socket:[7]", "socket:[8]"])
    // This process, a name that is no pid, and one whose descriptors cannot be read hold nothing.
    expect([...held.holders(links)!].sort()).toEqual([10, 11, 12])
    held.kill(11)
    expect(killed).toEqual([11])
    // A command gone before its links were read has none, and output to a file is held by nobody's command alone.
    expect(held.links(99)).toEqual([])
    expect(held.links(13)).toEqual([])
  })

  it("cannot say who holds it where there is no /proc, and a process it cannot end is passed over", async () => {
    const held = HeldOutput.make(Path.join(Os.tmpdir(), "smithers-no-proc-here"), () => {
      throw new Error("not this user's")
    })
    expect(held.holders(["socket:[7]"])).toBeUndefined()
    expect(() => held.kill(1)).not.toThrow()
  })

  it.skipIf(process.platform !== "linux")("reads this host's /proc and ends a process with SIGKILL", async () => {
    const child = spawn("sleep", ["300"], { stdio: ["ignore", "pipe", "ignore"] })
    const pid = child.pid!
    const links = HeldOutput.live.links(pid)
    // Its standard error is /dev/null, which every process may hold: only the pipe it writes to counts.
    expect(links).toEqual([expect.stringMatching(/^(pipe|socket):\[\d+\]$/)])
    expect(HeldOutput.live.holders(links)).toEqual([pid])
    const ended = new Promise((done) => child.on("exit", (_code, signal) => done(signal)))
    HeldOutput.live.kill(pid)
    expect(await ended).toBe("SIGKILL")
    expect(NodeFs.existsSync(`/proc/${pid}`)).toBe(false)
  })
})
