/**
 * What a step of a past commit can reach when the replay runs it: a home of
 * its own, a `git` that refuses to push, and, in the jail, nothing to write
 * but what it is given. Real repositories, real `git`, real `smthrs`, and the
 * targets the generator writes.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import type { Mode } from "../../src/contract/RunRecord.ts"
import { files } from "../../src/generate/index.ts"
import { confine, held, reading } from "../../src/replay/Confine.vibe"
import {
  containerPrograms,
  gitConfig,
  guardedPrograms,
  hooksDirectory,
  prePush,
  pushRefused
} from "../../src/replay/Environment.ts"
import { Options, Progress, run } from "../../src/replay/index.ts"
import {
  credentials,
  daemonSockets,
  jailed,
  keyringFilter,
  type Probe,
  probe,
  temporaryOf,
  temporaryRoots,
  unjailed
} from "../../src/replay/Jail.ts"
import { inventoryWith, job, linkTargets, smthrs } from "./fixture.ts"
import { placeIn } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
// A jailed step has a `/tmp` of its own, so what a test wants a step to find is kept beside it. The name is the
// directory's real one: the jail hides a credential by it.
const directory = (name: string): string => {
  const made = realpathSync(mkdtempSync(join("/var/tmp", `replay-jail-${name}-`)))
  created.push(made)
  return made
}
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

/** A bare repository beside the one replayed, as a fork or a mirror on the same disk is. */
const neighbour = (name: string): string => {
  const root = directory(name)
  execFileSync("git", ["init", "--quiet", "--bare", root])
  return root
}

type Jobs = ReadonlyArray<ReturnType<typeof job>>

/** A repository with one commit per entry: its CI is `jobs`, and each commit writes its `files`. */
const repository = (jobs: Jobs, commits: ReadonlyArray<Readonly<Record<string, string>>>, origin: string): string => {
  const root = directory("repository")
  git(root, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(root, ".gitignore"), "node_modules\n.flows\n")
  writeFileSync(join(root, "ci.json"), JSON.stringify({ ...inventoryWith(join(root, "unused")), jobs }))
  for (const [index, written] of commits.entries()) {
    for (const [name, content] of Object.entries(written)) writeFileSync(join(root, name), content)
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", `commit ${index + 1}`)
  }
  git(root, "remote", "add", "origin", `file://${origin}`)
  git(root, "push", "--quiet", "origin", "main")
  return root
}

/** The real generator in place of the test one: its targets are the ones `smithers-ci` runs. */
const generating = { ...parts("none"), files } as unknown as ReplayParts<never>

/** Fast mode judges every target worth running, so fast mode runs each step too. */
const runningAll: ReplayParts<never> = {
  ...generating,
  score: (rows) => Effect.succeed(rows.map((row) => ({ commit: row.commit, target: row.target, score: 1 })))
}

const replay = async (
  root: string,
  commits: number,
  confined: () => Probe,
  modes: ReadonlyArray<Mode> = ["normal"],
  chosen: ReplayParts<never> = generating
) => {
  const said: Array<string> = []
  const host = Layer.mergeAll(
    Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 1,
      prepare: (checkout) => Effect.sync(() => linkTargets(checkout)),
      confine: confined
    }),
    Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
  )
  const report = await Effect.runPromise(
    run({ root, commits, modes }, chosen).pipe(
      Effect.provide(Layer.provideMerge(host as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )
  return { report, said }
}

const found = probe()
const jailable = !("refusal" in found)

/** A home directory with what a person's holds: a key, a token, a linked cloud credential, and a plain file. */
const person = () => {
  const home = directory("person")
  const cloud = directory("cloud")
  mkdirSync(join(home, ".ssh"))
  writeFileSync(join(home, ".ssh", "id_test"), "a private key\n")
  writeFileSync(join(home, ".npmrc"), "//registry.example/:_authToken=a-token\n")
  writeFileSync(join(cloud, "credentials"), "a cloud credential\n")
  symlinkSync(cloud, join(home, ".aws"))
  writeFileSync(join(home, "notes.txt"), "hello\n")
  // Where a session's key agent listens.
  const runtime = directory("runtime")
  writeFileSync(join(runtime, "agent"), "a socket\n")
  return { home, cloud, runtime }
}

describe.skipIf(!jailable)("a step in the jail", () => {
  it("has a home of its own, kept between commits, and cannot read a credential, write outside, or push", async () => {
    const owner = person()
    const other = neighbour("other")
    const origin = neighbour("origin")
    const outside = directory("outside")
    const marker = join(mkdtempSync("/tmp/replay-jail-marker-"), "seen")
    created.push(dirname(marker))
    writeFileSync(marker, "")
    const passing: Jobs = [
      job(
        "home",
        [
          `test "$HOME" != ${homedir()}`,
          `test "$HOME" != ${owner.home}`,
          `test "$XDG_CACHE_HOME" = "$HOME/.cache"`,
          `: > "$HOME/mine"`,
          // The temporary directory and `/tmp` are one directory of the step's own, with nothing of the machine's.
          `: > "\${TMPDIR:-/tmp}/mine"`,
          `test -f /tmp/mine`,
          `test ! -e ${marker}`,
          `: > made-here`
        ].join(" && ")
      ),
      job("rest", `grep -q hello ${owner.home}/notes.txt`),
      job("npm", `test "$(npm config get cache)" = "$HOME/.npm"`),
      // The first commit leaves a file in the cache, and the second finds it.
      job("cache", "sh cache.sh"),
      job(
        "quiet",
        `test "$GIT_TERMINAL_PROMPT" = 0 && test -z "\${SSH_AUTH_SOCK+set}" && test -z "$(git config --get credential.helper)"`
      ),
      job("reaches", `git ls-remote file://${other} && git ls-remote file://${origin}`)
    ]
    const failing: Jobs = [
      job("key", `cat ${owner.home}/.ssh/id_test`),
      job("token", `grep -q authToken ${owner.home}/.npmrc`),
      job("linked", `cat ${owner.cloud}/credentials`),
      job("agent", `cat ${owner.runtime}/agent`),
      job("outside", `: > ${outside}/written`),
      job("persons", `: > ${owner.home}/written`),
      // `--no-verify` skips the hook, so only the jail is left to stop these.
      job("explicit", `git push --no-verify file://${other} HEAD:refs/heads/pushed`),
      job(
        "added",
        `git remote add up file://${other} 2>/dev/null || true; git push --no-verify up HEAD:refs/heads/pushed2`
      ),
      job(
        "pushurl",
        `git remote set-url --push origin file://${origin} && git push --no-verify origin HEAD:refs/heads/pushed3`
      )
    ]
    const root = repository([...passing, ...failing], [
      { "cache.sh": `mkdir -p "$XDG_CACHE_HOME/pm" && : > "$XDG_CACHE_HOME/pm/one"\n` },
      { "cache.sh": `test -f "$XDG_CACHE_HOME/pm/one"\n` }
    ], origin)
    const refs = [git(other, "for-each-ref"), git(origin, "for-each-ref")]

    process.env["SSH_AUTH_SOCK"] = join(outside, "agent")
    const asked = () => ({ ...found, home: owner.home, hidden: [owner.runtime] })
    const { report, said } = await replay(root, 2, asked).finally(() => {
      delete process.env["SSH_AUTH_SOCK"]
    })

    const counts = { hit: 0, ran: passing.length, failed: failing.length, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts, counts])
    // Every target runs at the first commit. At the second, one whose step read nothing that changed may be
    // answered from the cache, which is a pass too.
    expect(report.commits[0]?.normal.counts).toEqual(counts)
    const second = report.commits[1]?.normal.counts
    expect([(second?.hit ?? 0) + (second?.ran ?? 0), second?.failed, second?.skipped]).toEqual([
      passing.length,
      failing.length,
      0
    ])
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
    expect([git(other, "for-each-ref"), git(origin, "for-each-ref")]).toEqual(refs)
    expect(existsSync(join(outside, "written"))).toBe(false)
    expect(existsSync(join(owner.home, "written"))).toBe(false)
    expect(readFileSync(join(owner.home, ".ssh", "id_test"), "utf8")).toBe("a private key\n")
    expect(said.filter((line) => line.includes("jail"))).toEqual([])
  }, 1_200_000)
})

describe("a step on a machine with no jail", () => {
  it("still has a home of its own and a git that refuses to push, and the program says there is no jail", async () => {
    const other = neighbour("other")
    const origin = neighbour("origin")
    const out = directory("out")
    const passing: Jobs = [
      job("home", `echo "$HOME" >> ${out}/home && test "$HOME" != ${homedir()}`),
      // What Go leaves in a home: a directory nothing can be removed from.
      job("locked", `mkdir -p "$HOME/go/pkg/mod/x" && chmod -R a-w "$HOME/go"`),
      job("outside", `: > ${out}/written`)
    ]
    const failing: Jobs = [
      job("explicit", `git push file://${other} HEAD:refs/heads/pushed 2>> ${out}/explicit`),
      // A rerun finds the remote it added the first time.
      job(
        "added",
        `git remote add up file://${other} 2>/dev/null || true; git push up HEAD:refs/heads/pushed2 2>> ${out}/added`
      ),
      job(
        "pushurl",
        `git remote set-url --push origin file://${origin} && git push origin HEAD:refs/heads/pushed3 2>> ${out}/pushurl`
      ),
      // A repository's own hooks directory, as husky sets one, does not undo the refusal.
      job(
        "husky",
        `git config core.hooksPath .husky && git push file://${other} HEAD:refs/heads/pushed4 2>> ${out}/husky`
      )
    ]
    const root = repository([...passing, ...failing], [{}], origin)
    const refs = [git(other, "for-each-ref"), git(origin, "for-each-ref")]
    const refusal = "bwrap is not on PATH (install the bubblewrap package)"

    const { report, said } = await replay(root, 1, () => ({ refusal }))

    const counts = { hit: 0, ran: passing.length, failed: failing.length, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts])
    expect(report.commits.map((commit) => commit.normal.counts)).toEqual([counts])
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
    expect([git(other, "for-each-ref"), git(origin, "for-each-ref")]).toEqual(refs)
    for (const name of ["explicit", "added", "pushurl", "husky"]) {
      // The baseline's step and the target's each said so, at first and as a rerun. Smithers build runs a failed
      // target once more when it traced the first run, so there can be more.
      const lines = readFileSync(join(out, name), "utf8").split("\n").filter((line) => line === pushRefused)
      expect(lines.length).toBeGreaterThanOrEqual(4)
      expect(readFileSync(join(out, name), "utf8")).not.toContain("Everything up-to-date")
    }
    // The baseline's step saw the baseline's home and the target's saw normal mode's: two homes the replay made
    // side by side, both gone with the replay.
    const homes = [...new Set(readFileSync(join(out, "home"), "utf8").trim().split("\n"))].sort()
    expect(homes.map((home) => basename(home))).toEqual(["baseline", "normal"])
    expect(new Set(homes.map((home) => dirname(home))).size).toBe(1)
    expect(existsSync(dirname(dirname(homes[0] as string)))).toBe(false)
    expect(existsSync(join(out, "written"))).toBe(true)
    expect(said.filter((line) => line.includes("jail"))).toEqual([unjailed(refusal)])
  }, 1_200_000)
})

describe.each(
  [
    { where: "in the jail", asked: () => found, runs: jailable },
    { where: "with no jail", asked: () => ({ refusal: "no bubblewrap" }), runs: true }
  ] as const
)("a tool that keeps a cache for its user, $where", ({ asked, runs }) => {
  it.skipIf(!runs)("is cold once in the baseline, once in normal mode and once in fast mode", async () => {
    // A tool as Zig or Go is: its first run in a home takes two seconds to fill a cache there, and every later run
    // finds it. The first commit's step passes only in a home with no cache, and the second's only in one with it.
    const cold = `test ! -e "$HOME/.cache/tool" && sleep 2 && mkdir -p "$HOME/.cache/tool"\n`
    const warm = `test -d "$HOME/.cache/tool"\n`
    const root = repository(
      [job("tool", "sh tool.sh")],
      [{ "tool.sh": cold }, { "tool.sh": warm }],
      neighbour("origin")
    )

    const { report } = await replay(root, 2, asked, ["normal", "fast"], runningAll)

    const once = { hit: 0, ran: 1, failed: 0, skipped: 0 }
    const [first, second] = report.commits
    // At the first commit each way found its home empty and paid the two seconds itself.
    for (const totals of [first?.baseline, first?.normal, first?.fast]) {
      expect(totals?.counts).toEqual(once)
      expect(totals?.workMs).toBeGreaterThanOrEqual(2000)
    }
    // At the second commit each way found the cache it filled at the first.
    for (const totals of [second?.baseline, second?.normal, second?.fast]) expect(totals?.counts).toEqual(once)
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
  }, 1_200_000)
})

describe("git a part starts in a copy a step wrote", () => {
  const live = <A>(work: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(Effect.scoped(work).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A>)

  /**
   * A repository whose `.git/config` names commands for git to run, as a step can leave it. The command says it ran
   * in the repository's `.git`, where a jailed git can write, and beside the repository, where one cannot.
   */
  const planted = () => {
    const outside = directory("outside")
    const copy = directory("copy")
    git(copy, "init", "--quiet", "--initial-branch=main")
    writeFileSync(join(copy, "a.txt"), "a\n")
    git(copy, "add", "-A")
    git(copy, "commit", "--quiet", "-m", "one")
    const script = join(outside, "planted.sh")
    const say = `echo "$1 home=$HOME"`
    writeFileSync(script, `#!/bin/sh\n${say} >> ${copy}/.git/ran\n(${say} >> ${outside}/ran) 2>/dev/null\nexit 0\n`)
    chmodSync(script, 0o755)
    git(copy, "config", "core.fsmonitor", `${script} fsmonitor`)
    git(copy, "config", "core.pager", `${script} pager`)
    git(copy, "config", "alias.status", `!${script} alias`)
    return { copy, inside: join(copy, ".git", "ran"), outside: join(outside, "ran") }
  }

  /** What the inventory reader, the splitter and fast mode ask git, as each asks it. */
  const asked = (copy: string) =>
    [
      ChildProcess.make("git", ["-C", copy, "--no-optional-locks", "status", "--porcelain"]),
      ChildProcess.make("git", ["-C", copy, "ls-files", "-z"]),
      ChildProcess.make("git", ["-c", "core.quotePath=false", "rev-parse", "--git-dir"], { cwd: copy })
    ] as const

  const linesOf = (file: string): ReadonlyArray<string> => [...new Set(readFileSync(file, "utf8").trim().split("\n"))]

  it.each(
    [
      { where: "in the jail", confined: () => found, runs: jailable },
      { where: "with no jail", confined: () => ({ refusal: "no bubblewrap" }), runs: true }
    ] as const
  )("runs as a step does $where, and a command planted in .git/config with it", async ({ confined, runs, where }) => {
    if (!runs) return
    const { copy, inside, outside } = planted()
    const work = directory("work")
    const seen = await live(Effect.gen(function*() {
      const real = yield* ChildProcessSpawner
      // Started as a program starts any git, the planted command runs as the person, anywhere the person can write.
      yield* real.string(asked(copy)[0])
      const unheld = { inside: linesOf(inside), outside: linesOf(outside) }
      rmSync(inside)
      rmSync(outside)
      const places = yield* confine(work, confined, () => Effect.void, [], false)
      const held = reading(real, places.normal, copy)
      const printed: Array<string> = []
      for (const command of asked(copy)) printed.push(yield* held.string(command))
      return { unheld, printed, home: places.normal.home }
    }))

    const person = `fsmonitor home=${process.env["HOME"]}`
    expect(seen.unheld).toEqual({ inside: [person], outside: [person] })
    // Each git answered: the tree is clean, it holds one file, and its repository is the copy's.
    expect(seen.printed).toEqual(["", "a.txt\0", ".git\n"])
    // The planted command ran again, this time with the step's home, and in the jail it wrote nothing outside.
    const step = `fsmonitor home=${seen.home}`
    expect(linesOf(inside)).toEqual([step])
    if (where === "in the jail") expect(existsSync(outside)).toBe(false)
    else expect(linesOf(outside)).toEqual([step])
  }, 120_000)

  it("starts any other command as it is", async () => {
    const copy = directory("copy")
    const work = directory("work")
    const printed = await live(Effect.gen(function*() {
      const real = yield* ChildProcessSpawner
      const places = yield* confine(work, () => ({ refusal: "no bubblewrap" }), () => Effect.void, [], false)
      const held = reading(real, places.normal, copy)
      const plain = yield* held.string(ChildProcess.make("sh", ["-c", "echo $HOME"]))
      const piped = yield* held.string(
        ChildProcess.make("echo", ["git"]).pipe(ChildProcess.pipeTo(ChildProcess.make("cat")))
      )
      return [plain.trim(), piped.trim()]
    }))
    expect(printed).toEqual([process.env["HOME"], "git"])
  })
})

describe("confine", () => {
  const scoped = <A>(work: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(Effect.scoped(work).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A>)

  it("makes each way a home with the hook, and hides each credential of the person's home where it really is", async () => {
    const owner = person()
    const work = directory("work")
    const programs = ["node", "/tmp/bunx-1000-smithers-ci@latest/node_modules/@smthrs/cli/bin/smithers.mjs"]
    const cache = directory("cache")
    const asked = () => ({
      bwrap: "/usr/bin/bwrap",
      home: owner.home,
      hidden: [owner.runtime, "/run/user/none"],
      daemons: [],
      tmp: "/tmp/of-the-machine",
      caches: [cache, join(cache, "none")]
    })
    const places = await scoped(confine(work, asked, () => Effect.void, programs, false))

    expect(Object.keys(places)).toEqual(["baseline", "normal", "fast", "trial"])
    for (const way of ["baseline", "normal", "fast", "trial"] as const) {
      const place = places[way]
      // Each way's home and temporary directory are its own.
      expect(place.home).toBe(join(work, "home", way))
      expect(place.tmp).toBe(join(work, "tmp", way))
      expect(place.hooks).toBe(join(work, "home", way, hooksDirectory))
      // The stand-ins a step finds first on its `PATH`, and nothing of a container daemon in its variables.
      expect(place.guard).toBe(join(work, "guard"))
      expect(readdirSync(place.guard).sort()).toEqual([...guardedPrograms, ...containerPrograms].sort())
      expect(place.daemon).toEqual({})
      expect(readFileSync(join(place.hooks, "pre-push"), "utf8")).toBe(prePush)
      accessSync(join(place.hooks, "pre-push"), constants.X_OK)
      expect(readFileSync(join(place.home, ".gitconfig"), "utf8")).toBe(gitConfig)
      expect(readdirSync(place.home).sort()).toEqual([".gitconfig", ".smithers-ci"])
      expect(readdirSync(place.tmp)).toEqual([])
      expect(place.jail).toEqual({
        bwrap: "/usr/bin/bwrap",
        masks: [
          { path: join(owner.home, ".ssh"), directory: true },
          { path: owner.cloud, directory: true },
          { path: join(owner.home, ".npmrc"), directory: false },
          { path: owner.runtime, directory: true }
        ],
        tmp: join(work, "tmp", way),
        temporary: ["/tmp", "/tmp/of-the-machine"],
        visible: ["/tmp/bunx-1000-smithers-ci@latest", cache, work],
        filter: join(work, "keyring-filter")
      })
    }
    // The filter that refuses a step the keys of the person's session is written once, beside the homes.
    expect(new Uint8Array(readFileSync(join(work, "keyring-filter")))).toEqual(keyringFilter())
  })

  it("says once why there is no jail", async () => {
    const said: Array<string> = []
    const say = (line: string) => Effect.sync(() => void said.push(line))
    const work = directory("work")
    const places = await scoped(confine(work, () => ({ refusal: "no bubblewrap" }), say, [], false))
    expect(places).toEqual({
      baseline: placeIn(work, "baseline"),
      normal: placeIn(work, "normal"),
      fast: placeIn(work, "fast"),
      trial: placeIn(work, "trial")
    })
    expect(said).toEqual([
      "steps run without a file-system jail: no bubblewrap. Each step still gets a home directory of its own and " +
      "cannot push with git or start docker or podman by name"
    ])
  })
})

describe("the jail", () => {
  const argv = ["bash", "-e", "-c", "true"] as const
  const place = { home: "/h", tmp: "/t", guard: "/g", hooks: "/h/hooks", daemon: {} }

  it("is asked of the machine: Linux with a bubblewrap that starts, or the reason", () => {
    const facts = ExecSandbox.host()
    expect(probe({ ...facts, platform: "darwin" })).toEqual({
      refusal: "write protection needs bubblewrap, which runs only on Linux; this host is darwin"
    })
    expect(probe({ ...facts, platform: "linux", executable: () => undefined })).toEqual({
      refusal: "write protection needs bubblewrap, and bwrap is not on PATH (install the bubblewrap package)"
    })
    // A machine whose bubblewrap starts, whatever machine the test runs on.
    const starts = { ...facts, executable: () => "/usr/bin/bwrap", home: "/home/person", uid: 1234 }
    expect(probe(starts, () => undefined)).toEqual({
      bwrap: "/usr/bin/bwrap",
      home: "/home/person",
      hidden: ["/run/user/1234"],
      daemons: daemonSockets(1234, process.env),
      tmp: tmpdir(),
      caches: [join(tmpdir(), "tsx-1234"), join(tmpdir(), "vibelang-cache-1234")]
    })
    if (jailable) {
      expect(found).toEqual({
        bwrap: facts.executable("bwrap"),
        home: homedir(),
        hidden: [`/run/user/${facts.uid}`],
        daemons: daemonSockets(facts.uid, process.env),
        tmp: tmpdir(),
        caches: [join(tmpdir(), `tsx-${facts.uid}`), join(tmpdir(), `vibelang-cache-${facts.uid}`)]
      })
    }
  })

  /** What closes every descriptor a step has no business with. */
  const closes = [
    "for d in /proc/self/fd/* /dev/fd/*; do",
    "  n=${d##*/}",
    "  case $n in *[!0-9]*|[012]) ;; *) eval \"exec $n<&-\" ;; esac",
    "done"
  ].join("\n")

  it("runs a command through a shell that closes every descriptor but its three, when there is none", () => {
    // The shell names a command that is not there before it tries to become it.
    const named = "command -v -- \"$1\" > /dev/null 2>&1 || { printf 'could not run %s\\n' \"$1\" >&2; exit 127; }"
    const started = ["bash", "-c", `${closes}\n${named}\nexec "$@"`, "smithers-ci", ...argv]
    expect(jailed(undefined, ["/copy"], ["/home/hooks"], argv)).toEqual(started)
    expect(held({ ...place, jail: undefined }, ["/copy"], argv)).toEqual(started)
  })

  it("leaves the machine read-only but the places given, hides the masks, and keeps the hook read-only", () => {
    const jail = {
      bwrap: "/usr/bin/bwrap",
      masks: [{ path: "/person/.ssh", directory: true }, { path: "/person/.npmrc", directory: false }],
      tmp: "/work/tmp",
      temporary: ["/tmp", "/var/tmp/mine"],
      visible: ["/tmp/bunx", "/work"],
      filter: "/work/keyring-filter"
    }
    expect(held({ ...place, jail }, ["/copy"], argv)).toEqual([
      // A shell closes every descriptor but its three, opens the filter as 9 and becomes bubblewrap, which loads it.
      "bash",
      "-c",
      `${closes}\nexec "$@" 9< "$0"`,
      "/work/keyring-filter",
      "/usr/bin/bwrap",
      "--seccomp",
      "9",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--tmpfs",
      "/person/.ssh",
      "--remount-ro",
      "/person/.ssh",
      "--ro-bind",
      "/dev/null",
      "/person/.npmrc",
      "--bind",
      "/work/tmp",
      "/tmp",
      "--bind",
      "/work/tmp",
      "/var/tmp/mine",
      "--ro-bind",
      "/tmp/bunx",
      "/tmp/bunx",
      "--ro-bind",
      "/work",
      "/work",
      "--bind",
      "/h",
      "/h",
      "--bind",
      "/copy",
      "/copy",
      "--ro-bind",
      "/h/hooks",
      "/h/hooks",
      "--new-session",
      "--die-with-parent",
      "--",
      ...argv
    ])
  })

  it("replaces /tmp and the machine's temporary directory, and keeps in sight what the replay runs from them", () => {
    expect(temporaryOf("/tmp")).toEqual(["/tmp"])
    expect(temporaryOf("/tmp/mine")).toEqual(["/tmp", "/tmp/mine"])
    const programs = [
      "node",
      "/usr/bin",
      "/tmp",
      "/tmp/",
      "/tmp/bunx-1000-x/node_modules/.bin",
      "/tmp/bunx-1000-x/node_modules/@smthrs/cli/bin/smithers.mjs",
      "/tmp/tools",
      // The machine's temporary directory itself is never kept: a step would find it read-only.
      "/tmp/mine",
      "/tmp/mine/tools/bin"
    ]
    expect(temporaryRoots(programs, ["/tmp"])).toEqual(["/tmp/bunx-1000-x", "/tmp/tools", "/tmp/mine"])
    expect(temporaryRoots(programs, ["/tmp", "/tmp/mine"])).toEqual([
      "/tmp/bunx-1000-x",
      "/tmp/tools",
      "/tmp/mine/tools"
    ])
  })

  it("names the credentials of a home", () => {
    for (
      const name of [
        ".ssh",
        ".aws",
        ".npmrc",
        ".netrc",
        ".git-credentials",
        ".config/gh",
        ".config/git",
        ".docker",
        ".kube",
        ".gnupg"
      ]
    ) expect(credentials).toContain(name)
  })
})
