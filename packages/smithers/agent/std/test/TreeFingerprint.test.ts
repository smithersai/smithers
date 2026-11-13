/**
 * The in-container tree measurement: what the script skips, what its output
 * means, and the three answers two measurements can give.
 *
 * The script itself is exercised against a real shell once here, because
 * every guarantee it makes is about POSIX tools and not about TypeScript: a
 * change to `find`'s prune group or `stat`'s format is invisible to a unit
 * test of the string.
 */
import * as Effect from "effect/Effect"
import { spawn, spawnSync } from "node:child_process"
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"
import * as WorkspaceLists from "../src/TreeFingerprint.ts"

/** Runs the measurement script in `cwd` with the host's `sh`, the way a container would. */
const measure = (
  cwd: string,
  options: Parameters<typeof TreeFingerprint.script>[0] = {}
): TreeFingerprint.Measurement | undefined => {
  const result = spawnSync("sh", ["-c", TreeFingerprint.script(options)], { cwd, encoding: "utf8" })
  return result.status === 0 ? TreeFingerprint.parse(result.stdout) : undefined
}

const write = (root: string, path: string, text: string, at?: number): void => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
  if (at !== undefined) utimesSync(join(root, path), at, at)
}

/** `stat -c` is GNU and busybox; BSD `stat` on this host has no `-c`, so the live cases run where `find`+`stat -c` do. */
const hostCanMeasure = spawnSync("sh", ["-c", "stat -c '%s %Y %n' . >/dev/null 2>&1"]).status === 0

describe("TreeFingerprint.script", () => {
  it("prunes every directory and suffix the host walk prunes", () => {
    const script = TreeFingerprint.script()
    for (const name of WorkspaceLists.defaultPrune) expect(script).toContain(`-name '${name}'`)
    for (const suffix of WorkspaceLists.defaultIgnoreSuffixes) expect(script).toContain(`-name '*${suffix}'`)
    expect(script).toContain(`head -n ${TreeFingerprint.maxPaths + 1}`)
    expect(script).toContain("cksum")
  })

  it.skipIf(!hostCanMeasure)("ignores suffix directories at every depth while measuring source neighbours", () => {
    const root = mkdtempSync(join(tmpdir(), "tree-fingerprint-"))
    try {
      write(root, "src/source.py", "source", 1_700_000_000)
      write(root, "src/target", "ignored name")
      const before = measure(root)
      for (const suffix of TreeFingerprint.defaultIgnoreSuffixes) {
        write(root, `pkg${suffix}/SOURCES.txt`, "generated")
        write(root, `src/pkg${suffix}/nested/metadata`, "generated")
        write(root, `src/artifact${suffix}`, "generated")
      }
      expect(measure(root)).toEqual(before)
      write(root, "src/pkg.egg-info/SOURCES.txt", "rewritten metadata")
      expect(TreeFingerprint.moved(before, measure(root))).toBe(false)
      write(root, "src/pkg.egg-info.py", "source", 1_700_000_000)
      const after = measure(root)
      expect(after?.paths).toBe(2)
      expect(TreeFingerprint.moved(before, after)).toBe(true)
      expect(measure(root, { ignoreSuffixes: [] })?.paths).toBe(30)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!hostCanMeasure)("applies custom suffixes to directories and files", () => {
    const root = mkdtempSync(join(tmpdir(), "tree-fingerprint-"))
    try {
      write(root, "src/kept", "source")
      write(root, "cache.generated/nested/file", "derived")
      write(root, "src/file.generated", "derived")
      expect(measure(root, { ignoreSuffixes: [".generated"] })?.paths).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(hostCanMeasure)("exits non-zero on a host whose stat cannot list, never an empty measurement", () => {
    const result = spawnSync("sh", ["-c", TreeFingerprint.script()], { cwd: tmpdir(), encoding: "utf8" })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
  })

  it("names the prune list under a custom set, single-quoted", () => {
    expect(TreeFingerprint.script({ prune: ["it's"], ignoreSuffixes: [] })).toContain(`-name 'it'\\''s'`)
  })

  it.skipIf(!hostCanMeasure)("moves for a write, holds still for a re-read, and ignores derived output", () => {
    const root = mkdtempSync(join(tmpdir(), "tree-fingerprint-"))
    try {
      // A tree with no file in it is measured, so its first write is a move.
      const empty = measure(root)
      expect(empty).toMatchObject({ paths: 0, complete: true })
      write(root, "src/a.py", "one", 1_700_000_000)
      const first = measure(root)
      expect(first).toMatchObject({ paths: 1, complete: true })
      expect(TreeFingerprint.moved(empty, first)).toBe(true)
      expect(measure(root)).toEqual(first)

      write(root, "__pycache__/a.cpython-39.pyc", "bytecode")
      write(root, "src/a.so", "compiled")
      write(root, ".git/index", "index")
      expect(measure(root)).toEqual(first)

      write(root, "src/a.py", "one, changed", 1_700_000_000)
      const changed = measure(root)
      expect(changed?.digest).not.toBe(first?.digest)
      expect(TreeFingerprint.moved(first, changed)).toBe(true)
      expect(TreeFingerprint.moved(first, first)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** Whether this host's shell can bound a measurement, which `around` needs before it takes one. */
const hostCanBound = spawnSync("sh", ["-c", "command -v timeout >/dev/null 2>&1"]).status === 0

/** The nonce every case here frames its trailer with, as `bash` frames each call with its own. */
const nonce = "0123456789abcdef"

/** Runs `program` under `around` in `cwd`, the way `bash` runs a containerised command. */
const bracketed = (
  cwd: string,
  program: ReadonlyArray<string>,
  input?: string,
  options: { readonly shell?: string; readonly deadline?: number; readonly path?: string } = {}
) => {
  const result = spawnSync(
    options.shell ?? "/bin/sh",
    ["-c", TreeFingerprint.around(), "sh", nonce, String(options.deadline ?? 60), ...program],
    {
      cwd,
      encoding: "utf8",
      input,
      ...(options.path === undefined ? {} : { env: { ...process.env, PATH: options.path } })
    }
  )
  return {
    status: result.status,
    stdout: result.stdout,
    raw: result.stderr,
    ...TreeFingerprint.split(result.stderr, nonce)
  }
}

/** The file `name` runs from on this host's PATH, or nothing; a shell builtin is not one. */
const which = (name: string): string | undefined =>
  (process.env["PATH"] ?? "").split(delimiter).map((directory) => join(directory, name)).find((file) => {
    try {
      accessSync(file, constants.X_OK)
      return statSync(file).isFile()
    } catch {
      return false
    }
  })

/** A GNU-compatible `timeout`, the kind `around` prefers to start the command with. */
const gnuTimeout = spawnSync("sh", ["-c", "timeout --preserve-status -k 1 1 true"]).status === 0

/** Whether this host's `env` is GNU's, which can reset a signal ignored by a background job. */
const gnuEnv = spawnSync("sh", ["-c", "env --default-signal=INT true"]).status === 0

/**
 * A directory to be a container's whole PATH: the host's own `name` for each
 * tool, so a case decides which of `timeout` and `setsid` the container has.
 * `stat` is a GNU one where the host has it under another name, and `setsid`
 * is a real one where the host has none (macOS): the same `setsid(2)` call
 * util-linux and busybox make, through Python.
 */
const toolbox = (tools: ReadonlyArray<string>): string => {
  const bin = mkdtempSync(join(tmpdir(), "tree-toolbox-"))
  for (const tool of tools) {
    const host = tool === "stat" && !hostCanMeasure
      ? which("gstat")
      : tool === "env" && !gnuEnv
      ? which("genv") ?? which("env")
      : which(tool)
    if (host !== undefined) symlinkSync(host, join(bin, tool))
    else if (tool === "setsid") {
      writeFileSync(
        join(bin, tool),
        `#!${which("python3")}\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`,
        { mode: 0o755 }
      )
    }
  }
  return bin
}

/** What every case's container has besides the two tools a case chooses between. */
const base = [
  "sh",
  "true",
  "sleep",
  "cat",
  "find",
  "stat",
  "sort",
  "head",
  "cksum",
  "grep",
  "tr",
  "env",
  "python3",
  "ps"
]

/** Whether `pid` is gone, allowing an orphan a moment to be reaped by init. */
const gone = (pid: number): boolean => {
  for (let tries = 0; tries < 50; tries++) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    spawnSync("sleep", ["0.1"])
  }
  return false
}

/** The shells `around` runs under here: the host's `sh`, and `dash` where the host has one. */
const shells = [which("sh")!, ...[which("dash")].filter((shell) => shell !== undefined)]

describe("TreeFingerprint.around", () => {
  const launchers = [
    ...(gnuTimeout ? [{ name: "timeout", tools: ["timeout", "setsid"] }] : []),
    { name: "setsid", tools: ["setsid"] },
    { name: "the shell alone", tools: [] }
  ]

  describe.each(shells.flatMap((shell) => launchers.map((launcher) => ({ shell, ...launcher }))))(
    "under $shell, started by $name",
    ({ shell, tools }) => {
      const run = (program: ReadonlyArray<string>, input?: string, deadline?: number) => {
        const root = mkdtempSync(join(tmpdir(), "tree-around-"))
        const bin = toolbox([...base, ...tools])
        try {
          return {
            root,
            ...bracketed(root, program, input, { shell, path: bin, ...(deadline === undefined ? {} : { deadline }) })
          }
        } finally {
          rmSync(bin, { recursive: true, force: true })
        }
      }

      it("starts the command with the launcher the container offers", () => {
        // `ps` names the command's parent: the launcher when it stays one, the
        // script's own shell when the launcher exec'd the command.
        const ran = run(["sh", "-c", `ps -o comm= -p "$PPID"`])
        rmSync(ran.root, { recursive: true, force: true })
        expect(ran.stdout.trim().split("/").at(-1)).toBe(
          tools.includes("timeout") ? "timeout" : shell.split("/").at(-1)
        )
      })

      it("runs the command as given: its arguments, standard input, both streams and exit status", () => {
        // True on every host, measured or not: the script never changes what
        // the command it brackets reads, writes or exits with.
        const ran = run(
          ["sh", "-c", `cat; printf '%s|' "$@"; echo problem >&2; exit 3`, "sh", "a b", "$HOME", "it's"],
          "from stdin\n"
        )
        rmSync(ran.root, { recursive: true, force: true })
        expect(ran.status).toBe(3)
        expect(ran.stdout).toBe("from stdin\na b|$HOME|it's|")
        expect(ran.stderr).toBe("problem\n")
        expect(ran.timedOut).toBe(false)
      })

      it("stops a command at its deadline, says so, and leaves nothing it started running", () => {
        // The command prints, then hangs with a child of its own: the shape of
        // a test runner stuck on one case. A process group takes the child too.
        const started = Date.now()
        const ran = run(
          [
            "sh",
            "-c",
            `echo "case 1 ok"; sleep 30 </dev/null >/dev/null 2>&1 & echo "$! $$" > pids; echo "case 2 hangs" >&2; wait`
          ],
          undefined,
          1
        )
        const [child, command] = readFileSync(join(ran.root, "pids"), "utf8").trim().split(" ").map(Number)
        rmSync(ran.root, { recursive: true, force: true })
        expect(Date.now() - started).toBeLessThan(15_000)
        expect(ran.timedOut).toBe(true)
        expect(ran.stdout).toBe("case 1 ok\n")
        expect(ran.stderr).toBe("case 2 hangs\n")
        expect(ran.status).not.toBe(0)
        expect(gone(command!)).toBe(true)
        // Only a process group reaches a child the command started; the shell
        // alone reaches the command it ran.
        if (tools.length > 0) expect(gone(child!)).toBe(true)
        else process.kill(child!, "SIGKILL")
        // The tree is measured after the stop exactly as after an exit, where
        // the container can measure at all.
        if (tools.includes("timeout") && (hostCanMeasure || which("gstat") !== undefined)) {
          expect(ran.before).toMatchObject({ complete: true })
          expect(ran.after).toMatchObject({ complete: true })
        }
      })

      it("kills a command that ignores the polite signal once its grace is spent", () => {
        const started = Date.now()
        const ran = run(["sh", "-c", `trap '' TERM; echo "$$" > pid; while :; do sleep 1; done`], undefined, 1)
        const pid = Number(readFileSync(join(ran.root, "pid"), "utf8"))
        rmSync(ran.root, { recursive: true, force: true })
        expect(ran.timedOut).toBe(true)
        expect(gone(pid)).toBe(true)
        expect(Date.now() - started).toBeGreaterThanOrEqual((1 + TreeFingerprint.graceSeconds) * 1000 - 500)
      })

      it("stops the command when the script itself is told to stop, as a transport giving up does", async () => {
        const root = mkdtempSync(join(tmpdir(), "tree-around-"))
        const bin = toolbox([...base, ...tools])
        try {
          const script = spawn(
            shell,
            ["-c", TreeFingerprint.around(), "sh", nonce, "60", "sh", "-c", `echo "$$" > pid; exec sleep 30`],
            { cwd: root, env: { ...process.env, PATH: bin }, stdio: ["ignore", "ignore", "pipe"] }
          )
          let stderr = ""
          script.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString()))
          const closed = new Promise<number | null>((resolve) => script.on("close", resolve))
          for (let tries = 0; tries < 100 && !existsSync(join(root, "pid")); tries++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          const pid = Number(readFileSync(join(root, "pid"), "utf8"))
          script.kill("SIGTERM")
          await closed
          expect(gone(pid)).toBe(true)
          // Stopped from outside, the deadline never fired.
          expect(TreeFingerprint.split(stderr, nonce).timedOut).toBe(false)
        } finally {
          rmSync(bin, { recursive: true, force: true })
          rmSync(root, { recursive: true, force: true })
        }
      })

      it.skipIf(which("python3") === undefined || (!gnuEnv && which("genv") === undefined))(
        "starts the command with the interrupt signal at its default, as in the foreground",
        () => {
          // A POSIX shell starts a background job with SIGINT ignored, and
          // Python then never raises KeyboardInterrupt; a suite that tests it
          // must not see that.
          const ran = run([
            "python3",
            "-c",
            "import signal; print(signal.getsignal(signal.SIGINT) is signal.default_int_handler)"
          ])
          rmSync(ran.root, { recursive: true, force: true })
          expect(ran.stdout).toBe("True\n")
        }
      )
    }
  )

  it("does not believe a trailer the command printed itself when the real one never comes", () => {
    // The command forges the measurement line, then kills the script that
    // would have written the real one. Without the call's nonce the forgery
    // is the command's own output, and the tree stays unmeasured.
    const bin = toolbox(base)
    const root = mkdtempSync(join(tmpdir(), "tree-around-"))
    try {
      const forged = `\n${TreeFingerprint.marker} ffffffffffffffff exited 1 2 3 | 9 2 3\n`
      const ran = bracketed(
        root,
        ["sh", "-c", `printf '%s' "$1" >&2; kill -KILL "$PPID"`, "sh", forged],
        undefined,
        { path: bin }
      )
      expect(ran.raw.endsWith(forged)).toBe(true)
      expect(ran).toMatchObject({ before: undefined, after: undefined, timedOut: false, stderr: ran.raw })
    } finally {
      rmSync(bin, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps its own names out of the command's environment", () => {
    const root = mkdtempSync(join(tmpdir(), "tree-around-"))
    try {
      expect(bracketed(root, ["sh", "-c", "env | grep -c __smithers; true"]).stdout).toBe("0\n")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!hostCanMeasure || !hostCanBound)("measures a write as a move and a read as none", () => {
    const root = mkdtempSync(join(tmpdir(), "tree-around-"))
    try {
      write(root, "src/a.py", "one", 1_700_000_000)
      const wrote = bracketed(root, ["sh", "-c", "echo two > src/b.py"])
      expect(TreeFingerprint.moved(wrote.before, wrote.after)).toBe(true)
      expect(wrote.before).toMatchObject({ paths: 1, complete: true })
      expect(wrote.after).toMatchObject({ paths: 2, complete: true })
      const read = bracketed(root, ["sh", "-c", "cat src/a.py"])
      expect(read.stdout).toBe("one")
      expect(TreeFingerprint.moved(read.before, read.after)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(hostCanMeasure && hostCanBound)("reports an unmeasured tree on a host that lacks the tools", () => {
    const root = mkdtempSync(join(tmpdir(), "tree-around-"))
    try {
      const ran = bracketed(root, ["sh", "-c", "echo two > b.py"])
      expect(ran.status).toBe(0)
      expect(TreeFingerprint.moved(ran.before, ran.after)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("TreeFingerprint.split", () => {
  const line = (before: string, after: string, ended = "exited", framed = nonce) =>
    `\n${TreeFingerprint.marker} ${framed} ${ended} ${before}| ${after}\n`
  const unmeasured = (stderr: string) => ({ stderr, before: undefined, after: undefined, timedOut: false })

  it("takes the measurements off the end and returns what the command wrote", () => {
    expect(TreeFingerprint.split(`warning\n${line("11 20 2 ", "99 24 3 ")}`, nonce)).toEqual({
      stderr: "warning\n",
      before: { digest: "11:20", paths: 2, complete: true },
      after: { digest: "99:24", paths: 3, complete: true },
      timedOut: false
    })
    // A command that ended its last line without a newline keeps it that way.
    expect(TreeFingerprint.split(`partial${line("11 20 2 ", "11 20 2 ")}`, nonce).stderr).toBe("partial")
  })

  it("says the deadline stopped the command when the line says so", () => {
    expect(TreeFingerprint.split(`hung\n${line("11 20 2 ", "11 20 2 ", "deadline")}`, nonce)).toEqual({
      stderr: "hung\n",
      before: { digest: "11:20", paths: 2, complete: true },
      after: { digest: "11:20", paths: 2, complete: true },
      timedOut: true
    })
  })

  it("reads an empty or malformed side as unmeasured", () => {
    expect(TreeFingerprint.split(line("", "11 20 2 "), nonce)).toEqual({
      stderr: "",
      before: undefined,
      after: { digest: "11:20", paths: 2, complete: true },
      timedOut: false
    })
    expect(TreeFingerprint.split(line("garbage ", ""), nonce).before).toBeUndefined()
  })

  it("returns standard error whole when it does not end with the call's line", () => {
    for (
      const text of [
        "",
        "Killed\n",
        `${TreeFingerprint.marker} ${nonce} exited 1 1 1 | 1 1 1 \n`,
        `${line("1 1 1 ", "1 1 1 ")}after`,
        // A line it does not recognise, or one framed for another call.
        line("1 1 1 ", "1 1 1 ", "finished"),
        line("1 1 1 ", "1 1 1 ", "exited", "ffffffffffffffff"),
        line("1 1 1 ", "1 1 1 ", "deadline", "ffffffffffffffff"),
        `\n${TreeFingerprint.marker} 1 1 1 | 1 1 1 \n`
      ]
    ) {
      expect(TreeFingerprint.split(text, nonce)).toEqual(unmeasured(text))
    }
  })

  it("reads the last line only, so an earlier copy stays the command's own output", () => {
    const forged = line("1 1 1 ", "1 1 1 ", "deadline")
    const read = TreeFingerprint.split(`${forged}${line("11 20 2 ", "99 24 3 ")}`, nonce)
    expect(read.stderr).toBe(forged)
    expect(read.after?.digest).toBe("99:24")
    expect(read.timedOut).toBe(false)
  })
})

describe("TreeFingerprint.nonce", () => {
  it("draws sixteen hex digits, a different set for each call", async () => {
    const drawn = await Effect.runPromise(Effect.all([TreeFingerprint.nonce, TreeFingerprint.nonce]))
    for (const value of drawn) expect(value).toMatch(/^[0-9a-f]{16}$/)
    expect(drawn[0]).not.toBe(drawn[1])
  })
})

describe("TreeFingerprint.parse", () => {
  it("reads the checksum and the count", () => {
    expect(TreeFingerprint.parse("4038471504 22\n3\n")).toEqual({ digest: "4038471504:22", paths: 3, complete: true })
  })

  it("reads an empty tree as measured", () => {
    expect(TreeFingerprint.parse("4294967295 0\n0\n")).toEqual({ digest: "4294967295:0", paths: 0, complete: true })
  })

  it("marks a listing that reached the bound as partial", () => {
    expect(TreeFingerprint.parse(`1 2\n${TreeFingerprint.maxPaths + 1}\n`)).toEqual({
      digest: "1:2",
      paths: TreeFingerprint.maxPaths,
      complete: false
    })
  })

  it("accepts the exact path bound and ignores surrounding whitespace", () => {
    expect(TreeFingerprint.parse(`  1 2  \n  ${TreeFingerprint.maxPaths}  \n`)).toEqual({
      digest: "1:2",
      paths: TreeFingerprint.maxPaths,
      complete: true
    })
    expect(TreeFingerprint.parse("bad checksum\n3")).toBeUndefined()
    expect(TreeFingerprint.parse("1 2\n3\nextra")).toBeUndefined()
  })

  it("reads anything else as unmeasured", () => {
    expect(TreeFingerprint.parse("")).toBeUndefined()
    expect(TreeFingerprint.parse("sh: find: not found\n")).toBeUndefined()
    expect(TreeFingerprint.parse("1 2\n")).toBeUndefined()
    expect(TreeFingerprint.parse("1 2\nthree\n")).toBeUndefined()
  })
})

describe("TreeFingerprint.moved", () => {
  const whole = (digest: string): TreeFingerprint.Measurement => ({ digest, paths: 2, complete: true })
  const partial = (digest: string): TreeFingerprint.Measurement => ({ digest, paths: 2, complete: false })

  it("answers only from two complete measurements", () => {
    expect(TreeFingerprint.moved(whole("a"), whole("b"))).toBe(true)
    expect(TreeFingerprint.moved(whole("a"), whole("a"))).toBe(false)
    // A prefix that held still, or that moved, says nothing about the tree.
    expect(TreeFingerprint.moved(partial("a"), whole("a"))).toBeUndefined()
    expect(TreeFingerprint.moved(whole("a"), partial("b"))).toBeUndefined()
    expect(TreeFingerprint.moved(undefined, whole("a"))).toBeUndefined()
    expect(TreeFingerprint.moved(whole("a"), undefined)).toBeUndefined()
  })
})
