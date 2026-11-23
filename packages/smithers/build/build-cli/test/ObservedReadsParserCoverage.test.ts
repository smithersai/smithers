import * as Fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const root = "/workspace"
const read = (lines: ReadonlyArray<string>, quiet: ReadonlyArray<string> = []) =>
  ObservedReads.read(() => lines, root, quiet)
const header = "100 +++ smthrs-observe 1 +++"
const seal = "100 +++ complete +++"
const temporary: Array<string> = []
const directory = () => {
  const path = Fs.mkdtempSync(join(tmpdir(), "observed-parser-"))
  temporary.push(path)
  return path
}
afterEach(() => {
  for (const path of temporary.splice(0)) Fs.rmSync(path, { recursive: true, force: true })
})

it("tracks symlinks moved with their parent or exchanged with another name", () => {
  const trace = read([
    "100 mkdir(\"old\", 0777) = 0",
    "100 symlink(\"input\", \"old/link\") = 0",
    "100 rename(\"old\", \"new\") = 0",
    "100 symlink(\"other\", \"right\") = 0",
    "100 renameat2(AT_FDCWD, \"new/link\", AT_FDCWD, \"right\", RENAME_EXCHANGE) = 0",
    "100 rename(\"right\", \"final\") = 0"
  ])
  expect(trace.refusals).toEqual([])
  expect(trace.exchanged).toEqual([["/workspace/new/link", "/workspace/right"]])
  expect(trace.plainMade?.has("/workspace/final")).toBe(false)
  expect(trace.changed).toEqual(
    new Set([
      "/workspace/old",
      "/workspace/old/link",
      "/workspace/new",
      "/workspace/new/link",
      "/workspace/right",
      "/workspace/final"
    ])
  )
})

it("refuses foreign process paths in a sealed trace", () => {
  const trace = read([
    header,
    "100 newfstatat(AT_FDCWD, \"/proc/99999/cwd/data\", 0x1, 0) = 0",
    "100 newfstatat(AT_FDCWD, \"/proc/100/task/99998/cwd/data\", 0x1, 0) = 0",
    "100 newfstatat(AT_FDCWD, \"/proc/100/cwd/data\", 0x1, 0) = 0",
    seal
  ])
  expect(trace.refusals).toEqual([
    "it named /proc/99999/cwd/data, a file of a process outside the run",
    "it named /proc/100/task/99998/cwd/data, a file of a process outside the run"
  ])
  expect([...trace.found.keys()]).toEqual(["/proc/100/cwd/data"])
})

it("refuses an overlapping directory change and a relative read by threads that share cwd", () => {
  const trace = read([
    "100 clone(child_stack=NULL, flags=CLONE_FS|CLONE_THREAD|CLONE_SIGHAND|CLONE_VM) = 101",
    "100 chdir(\"/other\" <unfinished ...>",
    "101 openat(AT_FDCWD, \"input\", O_RDONLY) = 3</workspace/input>",
    "100 <... chdir resumed>) = 0"
  ])
  expect(trace.refusals).toEqual([
    "a thread changed its process's working directory while another thread named a path from it, so which " +
    "directory that path was in cannot be known"
  ])
})

it("requires the preimage for a resolved truncate of a file the step did not create", () => {
  const trace = read([
    "100 openat2(AT_FDCWD, \"existing\", {flags=O_WRONLY|O_TRUNC, resolve=RESOLVE_BENEATH}, 24) = 3</workspace/existing>",
    "100 openat(AT_FDCWD, \"created\", O_WRONLY|O_CREAT|O_EXCL, 0666) = 4</workspace/created>",
    "100 openat2(AT_FDCWD, \"created\", {flags=O_WRONLY|O_TRUNC, resolve=RESOLVE_BENEATH}, 24) = 5</workspace/created>"
  ])
  expect(trace.refusals).toEqual([])
  expect([...trace.required ?? []]).toEqual([["/workspace/existing", 1]])
  expect([...trace.made.keys()]).toEqual(["/workspace/created"])
})

it("omits quiet reads and does not claim an interrupted bind", () => {
  const trace = read([
    "100 execve(\"/bin/probe\", [\"probe\", \"--quiet-probe\"], 0x1) = 0",
    "100 openat(AT_FDCWD, \"probe-input\", O_RDONLY) = 3</workspace/probe-input>",
    "100 bind(4, {sa_family=AF_UNIX, sun_path=\"/workspace/socket\"}, 32) = ?"
  ], ["--quiet-probe"])
  expect(trace.refusals).toEqual([])
  expect(trace.found.size).toBe(0)
  expect(trace.bound?.size).toBe(0)
  expect(trace.made.size).toBe(0)
})

it("finds set-ID files by stat when there is no rights helper", () => {
  const dir = directory()
  const plain = join(dir, "plain")
  const elevated = join(dir, "elevated")
  Fs.writeFileSync(plain, "")
  Fs.writeFileSync(elevated, "")
  Fs.chmodSync(elevated, 0o2755)
  expect(ObservedReads.askingRights([plain, elevated, dir, join(dir, "missing")], false)).toEqual([elevated])
  expect(ObservedReads.askingRights([elevated], join(dir, "missing-supervisor"))).toEqual([elevated])
  expect(ObservedReads.observer({ platform: "linux", supervisor: join(dir, "missing"), executable: () => undefined }))
    .toEqual({ reason: "smthrs-observe cannot run here, and strace is not installed" })
})

it("marks a run on the filesystem clock and only recognizes a complete trace", () => {
  const file = join(directory(), "trace")
  expect(ObservedReads.whole(file)).toBe(false)
  const before = ObservedReads.markStart(file, 0)
  expect(ObservedReads.markStart(file)).toBeGreaterThanOrEqual(before)
  expect(ObservedReads.whole(file)).toBe(false)
  Fs.writeFileSync(file, `${seal}\n`)
  expect(ObservedReads.whole(file)).toBe(true)
})

it("uses strace's unversioned recorder key when strace is explicitly selected", async () => {
  vi.resetModules()
  vi.stubEnv(ObservedReads.recorderVariable, "strace")
  try {
    const fresh = await import("../src/internal/ObservedReads.ts")
    expect(fresh.recorder()).toBe("strace")
    expect(fresh.recorderKey()).toEqual({})
  } finally {
    vi.unstubAllEnvs()
  }
})

it("rejects a kept checkpoint when the recorder never acknowledges its flush", async () => {
  const path = join(directory(), "trace")
  Fs.writeFileSync(`${path}.kept`, "")
  const kept = ObservedReads.keptStep("//:server", undefined, root, path, true)
  expect(await kept.flush()).toBe(false)
})

it("reports an unreadable step trace with its filesystem diagnostic", () => {
  const path = join(directory(), "trace")
  const kept = ObservedReads.keptStep("//:server", undefined, root, path, false)
  const missing = ObservedReads.servedBy(kept.step, () => [], root)
  expect(missing.refusals).toContain("the recorder's step trace could not be read (ENOENT)")
  Fs.writeFileSync(path, "partial")
  const sealed = ObservedReads.keptStep("//:server", undefined, root, path, true)
  const truncated = ObservedReads.servedBy(sealed.step, () => [], root)
  expect(truncated.refusals).toContain("the recorder's step trace could not be read (trace ends inside a line)")
})

it("carries only newly seen rights and outside connections after a kept checkpoint", () => {
  const connect = (port: number) =>
    `100 connect(3, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`
  const step = () => [header, "100 +++ rights: /bin/first +++", connect(12340), seal]
  const after = () => [
    "100 +++ rights: /bin/first +++",
    "100 +++ rights: /bin/second +++",
    connect(12341),
    "100 chmod(\"/workspace/file\", 0644) = 0",
    "100 utimensat(AT_FDCWD, \"/workspace/file\", NULL, 0) = 0",
    "100 renameat2(AT_FDCWD, \"left\", AT_FDCWD, \"right\", RENAME_EXCHANGE) = 0"
  ]
  const served = ObservedReads.servedBy(step, after, root)
  expect(served.outside).toEqual(["it reached a program outside the run on local port 12341"])
  expect(served.rights).toEqual(["/bin/second"])
  expect(served.meta).toEqual(new Set(["/workspace/file"]))
  expect(served.exchanged).toEqual([["/workspace/left", "/workspace/right"]])
  const merged = ObservedReads.withServed(read(step()), [served])
  expect(merged.rights).toEqual(["/bin/first", "/bin/second"])
  expect(merged.exchanged).toEqual(served.exchanged)
  expect(merged.meta).toEqual(served.meta)
})

it("does not record a failed quiet probe's write as an input", () => {
  const trace = read([
    "100 execve(\"/bin/probe\", [\"probe\", \"--quiet-probe\"], 0x1) = 0",
    "100 unlink(\"input\") = -1 EACCES (Permission denied)"
  ], ["--quiet-probe"])
  expect(trace.refusals).toEqual([])
  expect(trace.unfollowed).toBeUndefined()
  expect(trace.found.size).toBe(0)
})

it("defaults omitted path flags when a tracer ended before printing the full call", () => {
  const trace = read([
    "100 utimensat(AT_FDCWD, \"times\", NULL <detached ...>",
    "100 fchmodat2(AT_FDCWD, \"mode\", 0644 <detached ...>",
    "101 unlinkat(AT_FDCWD, \"/workspace/old\" <detached ...>"
  ])
  expect(trace.refusals).toEqual([])
  expect(trace.meta).toBeUndefined()
  expect(trace.unlinked).toBeUndefined()
  expect(trace.changed).toEqual(new Set(["/workspace/mode", "/workspace/old"]))
})

it("preserves descriptor-directory evidence from a kept strace continuation", () => {
  const step = () => ["100 openat(AT_FDCWD, \"data\", O_RDONLY|O_DIRECTORY) = 3</workspace/data>"]
  const after = () => ["100 openat(AT_FDCWD, \"/proc/self/fd/3/x\", O_RDONLY) = 4</workspace/data/x>"]
  const served = ObservedReads.servedBy(step, after, root)
  const reached = [["/proc/self/fd/3/x", "/workspace/data/x", "/workspace/data/x"]]
  expect(served.refusals).toEqual([])
  expect(served.reached).toEqual(reached)
  const { exclusive, required, outside, ...ordinary } = read(step())
  expect([exclusive?.size, required?.size, outside]).toEqual([0, 0, []])
  const merged = ObservedReads.withServed(ordinary, [served, ordinary])
  expect(merged.reached).toEqual(reached)
  expect(merged.outside).toEqual([])
  expect(merged.exclusive?.size).toBe(0)
  expect(merged.required?.size).toBe(0)
})

it("reports the real paths written by an observed step", () => {
  const dir = directory()
  const startedMs = ObservedReads.markStart(join(dir, "start"))
  const output = join(dir, "output")
  Fs.writeFileSync(output, "created\n")
  const trace = ObservedReads.read(() => [
    `100 openat(AT_FDCWD, "${output}", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3<${output}>`
  ], dir)
  const observed = ObservedReads.observe(trace, { root: dir, ignore: [], startedMs })
  expect(observed).not.toHaveProperty("refusal")
  expect(ObservedReads.wrote(observed)).toEqual({ made: new Set([output]), touched: new Set([output]) })
})

it("recognizes frozen lockfile installs through manager aliases", () => {
  expect(ObservedReads.lockedInstall([])).toBe(false)
  expect(ObservedReads.lockedInstall(["yarnpkg", "install", "--immutable"])).toBe(true)
  expect(ObservedReads.lockedInstall(["yarnpkg", "install"])).toBe(false)
  expect(ObservedReads.lockedInstall(["pip3", "install", "--require-hashes"])).toBe(true)
  expect(ObservedReads.lockedInstall(["pip3", "install"])).toBe(false)
})

it("keeps empty-directory evidence only for the trace that removed it without listing it", () => {
  const trace = read([
    "100 unlink(\"file\") = 0",
    "100 rmdir(\"empty\") = 0",
    "100 openat(AT_FDCWD, \"listed\", O_RDONLY|O_DIRECTORY) = 3</workspace/listed>",
    "100 getdents64(3</workspace/listed>, [], 32768) = 0",
    "100 unlinkat(AT_FDCWD, \"listed\", AT_REMOVEDIR) = 0"
  ])
  expect(trace.refusals).toEqual([])
  expect(trace.unlinked).toEqual(new Set(["/workspace/file"]))
  expect(trace.removedEmpty).toEqual(new Set(["/workspace/empty"]))
  expect([...trace.listed.keys()]).toEqual(["/workspace/listed"])
  expect(ObservedReads.withServed(trace, []).removedEmpty).toEqual(trace.removedEmpty)
  const continuation = ObservedReads.servedBy(
    () => ["100 openat(AT_FDCWD, \"input\", O_RDONLY) = 3</workspace/input>"],
    () => ["100 mkdir(\"empty\", 0777) = 0"],
    root
  )
  expect(ObservedReads.withServed(trace, [continuation]).removedEmpty).toBeUndefined()
})
