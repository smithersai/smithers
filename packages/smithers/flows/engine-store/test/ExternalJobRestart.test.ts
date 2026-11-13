import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import * as ChildProcesses from "./ChildProcesses.ts"

const fixture = fileURLToPath(new URL("./fixtures/external-job-child.ts", import.meta.url))
const root = fileURLToPath(new URL("../../../../../", import.meta.url))
const launch = (directory: string, mode: string) =>
  ChildProcesses.spawn(process.execPath, [ChildProcesses.vibeImport, fixture, directory, mode], {
    cwd: root,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }
  })
const receipt = (child: ChildProcessWithoutNullStreams, status: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let output = ""
    let errors = ""
    const timeout = setTimeout(() => {
      ChildProcesses.killGroup(child)
      reject(new Error(`missing ${status}: ${output}\n${errors}`))
    }, 20_000)
    child.stderr.on("data", (chunk) => {
      errors += String(chunk)
    })
    child.stdout.on("data", (chunk) => {
      output += String(chunk)
      for (const line of output.split("\n").slice(0, -1)) {
        if (!line.startsWith("{")) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.status === status) {
          clearTimeout(timeout)
          resolve(parsed)
          return
        }
      }
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", () => {
      clearTimeout(timeout)
      reject(new Error(`closed before ${status}: ${output}\n${errors}`))
    })
  })

// A timed-out case stops awaiting its children; teardown still kills their process groups.
afterEach(ChildProcesses.reap)

it("receives a receipt split across stdout chunks", async () => {
  const child = ChildProcesses.spawn(process.execPath, [
    "-e",
    `
    process.stdout.write('engine log\\n{"status":"com');
    process.stdin.once("data", () => {
      process.stdout.write('pleted","value":"split"}\\n');
    });
  `
  ])
  try {
    const firstChunk = once(child.stdout, "data")
    const completed = receipt(child, "completed")
    await firstChunk
    child.stdin.end("continue")
    expect(await completed).toEqual({ status: "completed", value: "split" })
  } finally {
    await ChildProcesses.kill(child)
  }
})

it(
  "SIGKILL during a durable probe wait reattaches, starts once, and returns the result to its original caller",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "external-job-restart-"))
    const children: Array<ChildProcessWithoutNullStreams> = []
    try {
      const first = launch(directory, "start")
      children.push(first)
      await receipt(first, "parked")
      const closed = once(first, "close")
      ChildProcesses.killGroup(first)
      await closed
      expect(await readFile(join(directory, "calls"), "utf8")).not.toContain("cancel")
      await writeFile(join(directory, "exited"), "0")
      const second = launch(directory, "restart")
      children.push(second)
      const result = await receipt(second, "completed")
      expect(result.value).toBe("captured")
      const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n")
      const starts = calls.filter((call) => call.startsWith("start:"))
      expect(starts).toHaveLength(1)
      expect(starts[0]).toMatch(/^start:.+#g1$/)
      const key = starts[0]!.slice("start:".length)
      expect(calls.filter((call) => call.startsWith("cancel:"))).toEqual([])
      expect(calls.filter((call) => call.startsWith("status:"))).toHaveLength(2)
      expect(calls.filter((call) => call.startsWith("collect:"))).toEqual([`collect:${key}`])
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close")
          ChildProcesses.killGroup(child)
          await closed
        }
      }))
      await rm(directory, { recursive: true, force: true })
    }
  },
  50_000
)

for (const mode of ["compose-before", "compose-after"] as const) {
  it(`parent call composes in ${mode} order and identical children get distinct keys`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "external-job-compose-"))
    const child = launch(directory, mode)
    try {
      const result = await receipt(child, "completed")
      expect(result.value).toEqual({ first: "captured", second: "captured" })
      const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n")
      const starts = calls.filter((call) => call.startsWith("start:"))
      expect(starts).toHaveLength(2)
      expect(new Set(starts).size).toBe(2)
      expect(starts.every((call) => call.endsWith("#g1"))).toBe(true)
      expect(calls.filter((call) => call.startsWith("cancel:"))).toEqual([])
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close")
        ChildProcesses.killGroup(child)
        await closed
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}

it("cancelling the original caller while its external job is parked runs Cancel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "external-job-cancel-"))
  const child = launch(directory, "cancel")
  try {
    await receipt(child, "cancelled")
    const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n")
    const start = calls.find((call) => call.startsWith("start:"))!
    expect(calls).toContain(`cancel:${start.slice("start:".length)}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      ChildProcesses.killGroup(child)
      await closed
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

it(
  "a process that never held the parked job cancels its caller, and the job's Cancel runs as cancel:<key>",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "external-job-cancel-restart-"))
    const children: Array<ChildProcessWithoutNullStreams> = []
    try {
      const first = launch(directory, "start")
      children.push(first)
      await receipt(first, "parked")
      const closed = once(first, "close")
      ChildProcesses.killGroup(first)
      await closed
      const second = launch(directory, "cancel-restart")
      children.push(second)
      const result = await receipt(second, "cancelled")
      const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n")
      const starts = calls.filter((call) => call.startsWith("start:"))
      expect(starts).toEqual([`start:${String(result.key)}`])
      // Once, by the durable cancellation run: the parked scope's rollback died with the first process.
      expect(calls.filter((call) => call.startsWith("cancel:"))).toEqual([`cancel:${String(result.key)}`])
      expect(calls.filter((call) => call.startsWith("collect:"))).toEqual([])
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close")
          ChildProcesses.killGroup(child)
          await closed
        }
      }))
      await rm(directory, { recursive: true, force: true })
    }
  },
  50_000
)
