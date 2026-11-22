/**
 * A name a run makes where its commit holds nothing, and a commit that puts
 * something there.
 *
 * `mkdir out` passes where nothing is and fails where the commit holds `out`.
 * A record holds what the run read, and the run read nothing at `out`: it
 * made it. Each way below makes `out` with one call, under strace and under
 * `smthrs-observe`, in a real repository. At the commit that adds `out` as a
 * file, as a directory with a file below, and as a link, the record says the
 * run happens again; in the checkout the run left `out` in, which git does
 * not track, it is reused.
 */
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const base = NodeFs.realpathSync(NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-made-names-")))
afterAll(() => NodeFs.rmSync(base, { recursive: true, force: true }))

/** Each way, by its name: the Python that makes `out` and exits 0 where nothing is there. */
const ways: Readonly<Record<string, string>> = {
  mkdir: "os.mkdir('out')",
  "mkdir -p": "os.makedirs('out/sub', exist_ok=True)\nsys.exit(0 if os.listdir('out') == ['sub'] else 1)",
  "O_CREAT with O_EXCL": "os.open('out', os.O_WRONLY | os.O_CREAT | os.O_EXCL)",
  "O_CREAT without O_EXCL":
    "fd = os.open('out', os.O_WRONLY | os.O_CREAT)\nsys.exit(0 if os.fstat(fd).st_size == 0 else 1)",
  "O_CREAT with O_TRUNC": "os.close(os.open('out', os.O_WRONLY | os.O_CREAT | os.O_TRUNC))",
  symlink: "os.symlink('src.txt', 'out')",
  link: "os.link('src.txt', 'out')",
  "rename onto a new name": "open('made.txt', 'x').close()\nos.rename('made.txt', 'out')",
  mknod: "os.mkfifo('out')",
  "bind of a socket path": "socket.socket(socket.AF_UNIX).bind('out')"
}

/** What the commit adds at `out`. */
const added: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "a file": { out: "committed\n" },
  "a directory with a file below": { "out/x.txt": "committed\n" },
  "a link": { out: "-> src.txt" }
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const ran = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com"
    }
  })
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
  return ran.stdout
}

const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [name, text] of Object.entries(files)) {
    const file = Path.join(root, name)
    NodeFs.mkdirSync(Path.dirname(file), { recursive: true })
    if (text.startsWith("-> ")) NodeFs.symlinkSync(text.slice(3), file)
    else NodeFs.writeFileSync(file, text)
  }
}

let count = 0
/** A repository whose first commit holds the step and whose second adds `out` as `kind`. */
const repository = (
  way: string,
  kind: string
): { readonly source: string; readonly first: string; readonly second: string } => {
  count += 1
  const source = Path.join(base, `source-${count}`)
  NodeFs.mkdirSync(source)
  git(source, "init", "--quiet", "--initial-branch=main")
  write(source, {
    "src.txt": "source\n",
    "step.py": `import os, socket, sys\n${ways[way]}\n`
  })
  git(source, "add", "-A")
  git(source, "commit", "--quiet", "-m", "step")
  const first = git(source, "rev-parse", "HEAD").trim()
  write(source, added[kind]!)
  git(source, "add", "-A")
  git(source, "commit", "--quiet", "-m", "adds out")
  return { source, first, second: git(source, "rev-parse", "HEAD").trim() }
}

/** A fresh clone of `source` at `commit`, always at the same path, as a runner's checkout is. */
const checkout = (source: string, commit: string): string => {
  const root = Path.join(base, `run-${count}`)
  NodeFs.rmSync(root, { recursive: true, force: true })
  git(base, "clone", "--quiet", source, root)
  git(root, "checkout", "--quiet", commit)
  return root
}

const step = ["python3", "-I", "-B", "step.py"]

const plain = (root: string): number => spawnSync(step[0]!, step.slice(1), { cwd: root, stdio: "ignore" }).status ?? -1

type Recorder = { readonly tracer: string; readonly supervisor?: true | undefined; readonly guard?: string | undefined }

/** The recorders this host has: strace, through the guard where this package holds one, and smthrs-observe. */
const recorders = (): ReadonlyArray<readonly [string, Recorder]> => {
  const host = ObservedReads.observer(ExecSandbox.host())
  const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
    SMTHRS_OBSERVE_WITH: "smthrs-observe"
  })
  const found: Array<readonly [string, Recorder]> = []
  if ("tracer" in host && host.supervisor !== true) found.push(["strace", host])
  if (supervisor !== undefined) found.push(["smthrs-observe", { tracer: supervisor, supervisor: true }])
  return found
}

/** Runs the step in `root` under a recorder, and what it stored. */
const recorded = (root: string, observer: Recorder): ObservedReads.Record => {
  const trace = Path.join(base, `trace-${count}`)
  const startedMs = ObservedReads.markStart(Path.join(base, `mark-${count}`))
  const [program, ...rest] = ObservedReads.commandFor(observer, trace, step)
  const ran = spawnSync(program!, rest, { cwd: root, stdio: "ignore" })
  expect(ran.status).toBe(0)
  const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
  const stored = ObservedReads.record(ObservedReads.read(() => lines, root), { root, ignore: [], startedMs })
  if ("refusal" in stored) throw new Error(stored.refusal)
  return stored
}

const linuxIt = it.skipIf(process.platform !== "linux" || recorders().length === 0)

describe("a name the run made where its commit held nothing", () => {
  for (const way of Object.keys(ways)) {
    linuxIt(`${way}: runs again at the commit that puts something there, and is reused over its own leftover`, () => {
      for (const kind of Object.keys(added)) {
        const { source, first, second } = repository(way, kind)
        // The known answer: the step passes at the first commit.
        expect([way, kind, plain(checkout(source, first))]).toEqual([way, kind, 0])
        for (const [name, observer] of recorders()) {
          const root = checkout(source, first)
          const stored = recorded(root, observer)
          // What the run left at `out`, which git does not track, is its own.
          expect([way, kind, name, ObservedReads.changed(stored, root)]).toEqual([way, kind, name, undefined])
          const after = checkout(source, second)
          const why = ObservedReads.changed(stored, after)
          // `mkdir -p` then lists `out`, and its listing says so first.
          const wanted = way === "mkdir -p" ? why : "out, which the run made, is in the commit now"
          expect([way, kind, name, why ?? "reused"]).toEqual([way, kind, name, wanted])
          expect([way, kind, name, stored.made?.includes("out")]).toEqual([way, kind, name, true])
        }
      }
    }, 300_000)
  }

  it("fails plain at the commit for each way, as a file, a directory or a link does", () => {
    const failing = (way: string, kind: string): boolean => {
      const { source, first, second } = repository(way, kind)
      return plain(checkout(source, first)) === 0 && plain(checkout(source, second)) !== 0
    }
    for (const way of Object.keys(ways)) {
      expect([way, Object.keys(added).some((kind) => failing(way, kind))]).toEqual([way, true])
    }
  }, 300_000)
})

describe("what a record holds of the names a run made", () => {
  /** A repository holding `files`, committed, and the step `script` run in it under the first recorder. */
  const ran = (files: Readonly<Record<string, string>>, script: string, init = true) => {
    count += 1
    const root = Path.join(base, `held-${count}`)
    NodeFs.mkdirSync(root)
    write(root, { ...files, "step.py": `import os, socket, sys\n${script}\n` })
    if (init) {
      git(root, "init", "--quiet", "--initial-branch=main")
      git(root, "add", "-A")
      git(root, "commit", "--quiet", "-m", "base")
    }
    return { root, stored: recorded(root, recorders()[0]![1]) }
  }

  linuxIt("holds a tracked file the run wrote again as nothing it made, and reuses the run when it changes", () => {
    const { root, stored } = ran({ "gen.txt": "old\n" }, "open('gen.txt', 'w').write('new\\n')")
    expect(stored.made).toBeUndefined()
    write(root, { "gen.txt": "other\n" })
    git(root, "commit", "--quiet", "-am", "other")
    expect(ObservedReads.changed(stored, root)).toBeUndefined()
  })

  linuxIt("holds the highest new directory on the way, below one the commit holds", () => {
    const { root, stored } = ran(
      { "gen/keep.txt": "kept\n" },
      "os.makedirs('gen/a/b')\nopen('gen/a/b/c.txt', 'w').write('c')\nopen('top.txt', 'w').write('t')"
    )
    expect(stored.made).toEqual(["gen/a", "top.txt"])
    write(root, { "gen/a/other.txt": "committed\n" })
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", "adds below")
    expect(ObservedReads.changed(stored, root)).toBe("gen/a, which the run made, is in the commit now")
  })

  linuxIt("holds nothing it made where the workspace is no checkout, and there is no commit to add a name", () => {
    const { root, stored } = ran({}, "os.mkdir('out')", false)
    expect(stored.made).toBeUndefined()
    // A record made in a checkout, held where git cannot say: anything at the name may be the commit's.
    const made = { reads: [], lists: [], made: ["out"] }
    expect(ObservedReads.changed(made, root)).toBe("out, which the run made, is there now")
    NodeFs.rmSync(Path.join(root, "out"), { recursive: true })
    expect(ObservedReads.changed(made, root)).toBeUndefined()
  })

  linuxIt(
    "runs no command the repository's configuration names when it asks git, as a step may have planted one",
    () => {
      const planted = Path.join(base, `planted-${count + 1}`)
      const { root, stored } = ran(
        {},
        `import subprocess\nsubprocess.run(["git", "config", "core.fsmonitor", "touch ${planted}"], check=True)\nos.mkdir("out")`
      )
      expect(stored.made).toEqual(["out"])
      expect(ObservedReads.changed(stored, root)).toBeUndefined()
      expect([...ObservedReads.heldByGitOnce(root)(["step.py"])!]).toEqual(["step.py"])
      expect(NodeFs.existsSync(planted)).toBe(false)
    }
  )

  it("asks a build's own answer, given one, and not the repository the run may have changed", () => {
    count += 1
    const root = Path.join(base, `given-${count}`)
    write(root, { "kept.txt": "k\n" })
    const trace: ObservedReads.Trace = ObservedReads.read(() => [`1 mkdir("${root}/out", 0777) = 0`], root)
    const asked: Array<ReadonlyArray<string>> = []
    const stored = ObservedReads.record(trace, {
      root,
      ignore: [],
      startedMs: 0,
      held: (names) => {
        asked.push(names)
        return new Set()
      }
    })
    expect(stored).toMatchObject({ made: ["out"] })
    expect(asked).toEqual([["out"]])
  })

  it("keeps them when the record moves to a step's new run, and its id holds them", () => {
    const body = { reads: [], lists: [], from: [["//:a", "i1"] as const], given: [], made: ["out"] }
    const moved = ObservedReads.anchored({ ...body, id: ObservedReads.idOf(body) }, () => "i2")!
    expect(moved.made).toEqual(["out"])
    expect(moved.id).toBe(ObservedReads.idOf({ ...body, from: [["//:a", "i2"]] }))
    expect(ObservedReads.idOf(body)).not.toBe(ObservedReads.idOf({ ...body, made: ["out", "x"] }))
    expect(ObservedReads.asRecord(moved)).toEqual(moved)
    expect(ObservedReads.asRecord({ ...moved, made: [1] })).toBeUndefined()
    expect(ObservedReads.asRecord({ ...moved, made: "out" })).toBeUndefined()
  })

  it("asks git about many names at once without a command line too long for them", () => {
    count += 1
    const root = Path.join(base, `many-${count}`)
    write(root, { "a/b.txt": "b\n", "c.txt": "c\n" })
    git(root, "init", "--quiet", "--initial-branch=main")
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", "base")
    const many = Array.from({ length: 6000 }, (_, index) => `not-there-${index}`)
    expect([...ObservedReads.heldByGit(root)([...many, "a"])!]).toEqual(["a"])
    expect([...ObservedReads.heldByGit(root)(["a/b.txt", "c.txt/d", "x"])!]).toEqual(["a/b.txt"])
    expect(ObservedReads.heldByGit(root)([])).toEqual(new Set())
    expect(ObservedReads.heldByGit(base)(["a"])).toBeUndefined()
    // Asked once in a build: what git said first is the answer after.
    const once = ObservedReads.heldByGitOnce(root)
    expect([...once(["a", "a/b.txt", "x"])!]).toEqual(["a", "a/b.txt"])
    NodeFs.rmSync(Path.join(root, ".git"), { recursive: true })
    expect([...once(["c.txt", "x"])!]).toEqual(["c.txt"])
    const nowhere = ObservedReads.heldByGitOnce(root)
    expect(nowhere(["a"])).toBeUndefined()
    expect(nowhere(["c.txt"])).toBeUndefined()
  })
})
