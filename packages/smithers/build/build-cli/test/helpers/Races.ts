/**
 * Runs a case of `test/fixtures/races/races.py` under a recorder and holds the record against what the run did.
 *
 * Each case is a program whose threads, and in some cases a second process, make, remove, rename and replace the
 * same names at once. The program logs the answer each of its own calls got. A run is wrong when its record is
 * stored and:
 *
 * - a line's answer differs from the one the call got (`lines`: per call, name and answer, how many ran and how many
 *   lines say so). A lookup or an open to read is written once while it says the same, and left out where another
 *   call changed the name while it was under way, so only a lookup answer no call got is wrong. A connection that
 *   found nothing to talk to is one answer, whichever refusal the kernel gave: when a server binds at the same
 *   moment, which one cannot be known, and a reader reads both alike;
 * - the record says something changed at the same commit, checked out fresh (`rerunFresh`) or as the run left it
 *   (`rerunLeft`);
 * - the record holds after a commit that changed what every run of the case read (`stale`);
 * - the record misses the file the run says it read (`missed`).
 *
 * A run whose record is not stored says why (`refusal`); its lines are never read.
 */
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Path from "node:path"
import * as ObservedReads from "../../src/internal/ObservedReads.ts"

/** The program of every case. */
export const program = Path.join(import.meta.dirname, "..", "fixtures", "races", "races.py")

/** The cases, with whether a record of the case holds at a fresh checkout of the commit it ran at. */
export const cases: ReadonlyArray<readonly [name: string, fresh: boolean]> = [
  ["parent", true],
  ["exclusive", true],
  // A file of the commit that the run removes and makes again is held as the run left it (both recorders).
  ["exclusive-tracked", false],
  ["atomic", true],
  ["rename-source", true],
  ["remove-full", true],
  ["cwd", true],
  ["look", true],
  ["connect", true],
  ["exec", true]
]

export interface RaceRun {
  readonly status: number | null
  readonly stderr?: string
  readonly refusal?: string
  readonly lines?: ReadonlyArray<string>
  readonly rerunFresh?: string
  readonly rerunLeft?: string
  readonly stale?: string
  readonly missed?: string
}

const kinds: Readonly<Record<string, string>> = {
  mkdir: "mkdir",
  mkdirat: "mkdir",
  unlink: "remove",
  rmdir: "remove",
  unlinkat: "remove",
  rename: "rename",
  renameat: "rename",
  renameat2: "rename",
  link: "link",
  linkat: "link",
  symlink: "symlink",
  symlinkat: "symlink",
  stat: "look",
  lstat: "look",
  newfstatat: "look",
  statx: "look",
  access: "look",
  faccessat: "look",
  faccessat2: "look",
  readlink: "look",
  readlinkat: "look",
  chmod: "change",
  fchmodat: "change",
  fchmodat2: "change",
  utimensat: "change",
  utimes: "change",
  truncate: "change",
  execve: "exec",
  connect: "connect",
  open: "open",
  openat: "open",
  creat: "open"
}

/** Each call line of a trace as [kind, path in the workspace, answer]; strace's split lines joined. */
export const callsOf = (text: string, workspace: string): ReadonlyArray<readonly [string, string, string]> => {
  const pending = new Map<string, string>()
  const calls: Array<readonly [string, string, string]> = []
  for (const line of text.split("\n")) {
    const numbered = /^(\d+)\s+(.*)$/.exec(line)
    if (numbered === null) continue
    const pid = numbered[1]!
    let rest = numbered[2]!
    if (rest.endsWith("<unfinished ...>")) {
      pending.set(pid, rest.slice(0, -"<unfinished ...>".length))
      continue
    }
    const resumed = /^<\.\.\. \w+ resumed>(.*)$/.exec(rest)
    if (resumed !== null) {
      rest = (pending.get(pid) ?? "") + resumed[1]
      pending.delete(pid)
    }
    const call = /^(\w+)\((.*)\)\s+= (.*)$/.exec(rest)
    if (call === null) continue
    const [, name, args, answered] = call as unknown as [string, string, string, string]
    let kind = kinds[name]
    if (kind === undefined) continue
    const strings = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((found) => found[1]!)
    if (strings.length === 0 || (kind === "symlink" && strings.length === 1)) continue
    let path = kind === "rename" || kind === "link" || kind === "symlink" ? strings.at(-1)! : strings[0]!
    if (kind === "open" && /O_CREAT/.test(args)) kind = /O_EXCL/.test(args) ? "excl" : "create"
    path = path.replaceAll("/./", "/")
    if (path.startsWith("./")) path = path.slice(2)
    if (path.startsWith(`${workspace}/`)) path = path.slice(workspace.length + 1)
    else if (path.startsWith("/")) continue
    const failure = /^-1 (\w+)/.exec(answered)
    calls.push([kind, path, answered.startsWith("?") ? "?" : failure === null ? "0" : failure[1]!])
  }
  return calls
}

const errnos: Readonly<Record<number, string>> = {
  0: "0",
  2: "ENOENT",
  8: "ENOEXEC",
  13: "EACCES",
  17: "EEXIST",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  26: "ETXTBSY",
  39: "ENOTEMPTY",
  111: "ECONNREFUSED"
}

/** Where the lines' answers differ from the ones the run's own calls got. */
export const differences = (
  ran: ReadonlyArray<readonly [string, string, string]>,
  written: ReadonlyArray<readonly [string, string, string]>
): ReadonlyArray<string> => {
  let logged = ran
  let traced = written
  const count = (rows: ReadonlyArray<readonly [string, string, string]>) => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.join(" "), (counts.get(row.join(" ")) ?? 0) + 1)
    return counts
  }
  const refusal = ([kind, path, answer]: readonly [string, string, string]): readonly [string, string, string] => [
    kind,
    path,
    kind === "connect" && (answer === "ENOENT" || answer === "ECONNREFUSED") ? "refused" : answer
  ]
  logged = logged.map(refusal)
  traced = traced.map(refusal)
  const names = new Set(logged.map(([kind, path]) => `${kind} ${path}`))
  // An exec is written `= ?` when it goes on, and `= 0` once a later stop shows its program: `= 0` says it started.
  const ranCounts = count(logged)
  const writtenCounts = count(
    traced.filter(([kind, path, answer]) => names.has(`${kind} ${path}`) && !(kind === "exec" && answer === "?"))
  )
  const wrong: Array<string> = []
  for (const key of new Set([...ranCounts.keys(), ...writtenCounts.keys()])) {
    const a = ranCounts.get(key) ?? 0
    const b = writtenCounts.get(key) ?? 0
    const kind = key.split(" ")[0]!
    // A failed exec whose process ended at once is left `= ?`: no answer, which no count holds against it.
    if (kind === "exec" && !key.endsWith(" 0") && b <= a) continue
    if (kind === "look" || kind === "open" ? b > 0 && a === 0 : a !== b) wrong.push(`${key}: ran ${a}, written ${b}`)
  }
  return wrong.sort()
}

const python = (args: ReadonlyArray<string>, cwd?: string, env: NodeJS.ProcessEnv = {}): string => {
  const run = spawnSync("python3", ["-I", "-B", program, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  })
  if (run.status !== 0) throw new Error(`races.py ${args.join(" ")}: ${run.status} ${run.stderr}`)
  return run.stdout.trim()
}

/** Whether this host can run the cases. */
export const runnable = (): boolean => spawnSync("python3", ["--version"]).status === 0

/** Waits until a trace stops growing, as strace may still write after the command ended. */
const settled = async (trace: string, supervised: boolean): Promise<void> => {
  for (let waited = 0, size = -1; waited < 20_000; waited += 100) {
    const now = NodeFs.statSync(trace).size
    if (supervised ? ObservedReads.whole(trace) : now === size) return
    size = now
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Runs `name` once in a new directory under `base` with `recorder`, and holds its record against the run. */
export const raceOnce = async (
  name: string,
  fresh: boolean,
  recorder: { readonly tracer: string; readonly supervisor?: true | undefined },
  base: string,
  env: NodeJS.ProcessEnv = {}
): Promise<RaceRun> => {
  const root = NodeFs.mkdtempSync(Path.join(base, `${name}-`))
  const workspace = Path.join(root, "ws")
  NodeFs.mkdirSync(workspace)
  python(["setup", name, workspace])
  // The run begins a tick of the file system's clock after the commit's files were written.
  await new Promise((resolve) => setTimeout(resolve, 30))
  const trace = Path.join(root, "trace")
  NodeFs.writeFileSync(trace, "")
  const startedMs = NodeFs.statSync(trace).ctimeMs
  const argv = ObservedReads.commandFor(recorder, trace, ["python3", "-I", "-B", program, "run", name])
  const run = spawnSync(argv[0]!, argv.slice(1), {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 300_000
  })
  if (run.status !== 0) return { status: run.status, stderr: `${run.stderr}`.slice(-2000) }
  const printed = run.stdout.trim().split("\n")
  const facts = JSON.parse(printed.at(-1) ?? "{}") as { readonly read?: string }
  const logged = printed
    .filter((line) => line.startsWith("LOG "))
    .flatMap((line) => JSON.parse(line.slice(4)) as ReadonlyArray<readonly [string, string, number]>)
    .map(([kind, path, error]): readonly [string, string, string] => [
      kind,
      path,
      // Python's open() of a directory succeeds in the kernel and fails after; an exec that ran exits below 100.
      (kind === "open" && error === 21) || (kind === "exec" && error < 0) ? "0" : errnos[error] ?? `E${error}`
    ])
  await settled(trace, recorder.supervisor === true)
  const again = Path.join(root, "fresh")
  NodeFs.mkdirSync(again)
  python(["setup", name, again])
  const preFound = new Map<string, string>()
  if (name === "exclusive-tracked") {
    preFound.set(Path.join(workspace, "t", "x"), ObservedReads.measure(Path.join(again, "t", "x")))
  }
  const observed = ObservedReads.observe(ObservedReads.read(ObservedReads.linesOf(trace), workspace), {
    root: workspace,
    ignore: [],
    startedMs,
    ...(preFound.size === 0 ? {} : { found: preFound })
  })
  if ("refusal" in observed) return { status: 0, refusal: observed.refusal }
  const wrong = differences(logged, callsOf(NodeFs.readFileSync(trace, "utf8"), workspace))
  const record = observed.record
  const rewrittenTracked = name === "exclusive-tracked" &&
    record.reads.some(([path, , before]) => path === "t/x" && before !== undefined && before !== "-")
  const left = rewrittenTracked ? undefined : ObservedReads.changed(record, workspace)
  const same = (fresh || rewrittenTracked) ? ObservedReads.changed(record, again) : undefined
  const after = Path.join(root, "after")
  NodeFs.mkdirSync(after)
  python(["setup", name, after])
  const changedPath = python(
    ["change", name, after],
    undefined,
    facts.read === undefined ? {} : { RACE_READ: facts.read }
  )
  const stale = ObservedReads.changed(record, after) === undefined ? changedPath : undefined
  const missed = facts.read !== undefined && !record.reads.some(([path]) => path === facts.read)
    ? facts.read
    : undefined
  return {
    status: 0,
    ...(wrong.length > 0 ? { lines: wrong } : {}),
    ...(left === undefined ? {} : { rerunLeft: left }),
    ...(same === undefined ? {} : { rerunFresh: same }),
    ...(stale === undefined ? {} : { stale }),
    ...(missed === undefined ? {} : { missed })
  }
}
