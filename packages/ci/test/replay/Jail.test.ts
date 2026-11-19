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
import * as Redacted from "effect/Redacted"
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
  readlinkSync,
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
  elsewhere,
  installOf,
  jailed,
  keyringFilter,
  type Probe,
  probe,
  scopeProgram,
  scopes,
  temporaryOf,
  temporaryRoots,
  toolsOn,
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
  // A credential file that is a link to another disk.
  const vault = directory("vault")
  writeFileSync(join(vault, "netrc"), "machine example login me password secret\n")
  symlinkSync(join(vault, "netrc"), join(home, ".netrc"))
  // A file no list of credentials could name: a directory of settings with a name of its own.
  const unlisted = `.${basename(directory("name"))}`
  mkdirSync(join(home, unlisted))
  writeFileSync(join(home, unlisted, "token"), "a token of a program nobody heard of\n")
  // A tool installed under the home, and a link a program is reached through.
  mkdirSync(join(home, ".local", "tool", "bin"), { recursive: true })
  writeFileSync(join(home, ".local", "tool", "bin", "tool"), "#!/bin/sh\necho a tool ran\n", { mode: 0o755 })
  symlinkSync("/usr/bin", join(home, "system"))
  // Where a session's key agent listens.
  const runtime = directory("runtime")
  writeFileSync(join(runtime, "agent"), "a socket\n")
  return { home, cloud, runtime, vault, unlisted, tool: join(home, ".local", "tool") }
}

/** The tools of a person: the one installed under the home, a link to reach programs through, and a home to link. */
const toolsOf = (owner: ReturnType<typeof person>) => ({
  reads: [owner.tool],
  links: [{ path: join(owner.home, "system"), target: "/usr/bin" }],
  homes: [{ path: ".versions/tool", target: owner.tool }]
})

describe.skipIf(!jailable)("a step in the jail", () => {
  it("has a home of its own, and cannot read a credential, write outside, or push", async () => {
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
          // The temporary directory is the job's own, and `/tmp` holds nothing of the machine's.
          `: > "\${TMPDIR:-/tmp}/mine"`,
          `test ! -e ${marker}`,
          `: > made-here`
        ].join(" && ")
      ),
      // What is put back of the person's home: a tool installed there, read and run, and the link it is reached through.
      job("tool", `test "$(${owner.tool}/bin/tool)" = "a tool ran" && test -x ${owner.home}/system/env`),
      // A version manager finds its versions under the step's own home.
      job("versions", `test "$(readlink "$HOME/.versions/tool")" = ${owner.tool}`),
      job("npm", `test "$(npm config get cache)" = "$HOME/.npm"`),
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
      job("linkedfile", `grep -q password ${owner.vault}/netrc`),
      // No list names these: a plain file of the home, and a file in a directory with a name of its own.
      job("plain", `cat ${owner.home}/notes.txt`),
      job("unlisted", `cat ${owner.home}/${owner.unlisted}/token`),
      job("listing", `test -n "$(ls -A ${owner.home} | grep -v -e '^.local$' -e '^system$')"`),
      // A tool is read, never written.
      job("tooledit", `: > ${owner.tool}/bin/other`),
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
    const root = repository([...passing, ...failing], [{ "notes.md": "one\n" }, { "notes.md": "two\n" }], origin)
    const refs = [git(other, "for-each-ref"), git(origin, "for-each-ref")]

    process.env["SSH_AUTH_SOCK"] = join(outside, "agent")
    const asked = () => ({ ...found, home: owner.home, hidden: [owner.runtime], tools: toolsOf(owner) })
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
    // The baseline's step and the target's saw one home: the home of the job's machine, where Smithers build keeps
    // it, which the replay made and which is gone with the replay.
    const homes = [...new Set(readFileSync(join(out, "home"), "utf8").trim().split("\n"))]
    expect(homes).toHaveLength(1)
    const work = /^(.*\/smithers-ci-replay-[^/]+)\/machines\//.exec(homes[0] as string)?.[1] as string
    expect(basename(homes[0] as string)).toBe("home")
    expect(existsSync(work)).toBe(false)
    expect(existsSync(join(out, "written"))).toBe(true)
    expect(said.filter((line) => line.includes("jail"))).toEqual([unjailed(refusal)])
  }, 1_200_000)
})

describe("a step no runner starts", () => {
  it(
    "is given the commit and the run's number when its script names them, in the baseline and as a target",
    async () => {
      const origin = neighbour("origin")
      const names =
        "GITHUB_SHA GITHUB_WORKFLOW_SHA GITHUB_RUN_ID GITHUB_RUN_NUMBER GITHUB_RUN_ATTEMPT SMITHERS_CI_EVENTS"
      const jobs: Jobs = [
        // It names no variable, so it is given none: a program it starts finds none in its environment.
        job("unnamed", `test -z "$(printenv ${names})"`),
        // It names two, and finds the commit it runs at and the number of commits up to it, and no third.
        job(
          "named",
          `test "$GITHUB_SHA" = "$(git rev-parse HEAD)" && test "\${GITHUB_RUN_NUMBER}" = "$(git rev-list --count HEAD)"` +
            ` && test -z "$(printenv GITHUB_RUN_ID)"`
        )
      ]
      const root = repository(jobs, [{ "one.txt": "one\n" }, { "two.txt": "two\n" }], origin)

      const { report } = await replay(root, 2, () => ({ refusal: "no bubblewrap" }))

      const passed = { hit: 0, ran: 2, failed: 0, skipped: 0 }
      expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([passed, passed])
      expect(report.commits.map((commit) => commit.normal.counts.failed)).toEqual([0, 0])
      expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
      // The step that names the commit has it in its key: it ran at the second commit too.
      expect(report.commits[1]?.normal.counts.ran).toBeGreaterThanOrEqual(1)
    },
    600_000
  )
})

describe.each(
  [
    { where: "in the jail", asked: () => found, runs: jailable },
    { where: "with no jail", asked: () => ({ refusal: "no bubblewrap" }), runs: true }
  ] as const
)("a tool that keeps a cache for its user, $where", ({ asked, runs }) => {
  it.skipIf(!runs)("is cold at every commit in the baseline, in normal mode and in fast mode", async () => {
    // A tool as Zig or Go is: its first run in a home takes two seconds to fill a cache there. A CI runner starts
    // every job with an empty home, so the step passes only in a home with no cache, at the second commit too.
    const cold = `test ! -e "$HOME/.cache/tool" && sleep 2 && mkdir -p "$HOME/.cache/tool"\n`
    const root = repository(
      [job("tool", "sh tool.sh")],
      [{ "tool.sh": cold }, { "tool.sh": `${cold}# again\n` }],
      neighbour("origin")
    )

    const { report } = await replay(root, 2, asked, ["normal", "fast"], runningAll)

    const once = { hit: 0, ran: 1, failed: 0, skipped: 0 }
    expect(report.commits).toHaveLength(2)
    // At each commit each way found its home empty and paid the two seconds itself.
    for (const commit of report.commits) {
      for (const totals of [commit.baseline, commit.normal, commit.fast]) {
        expect(totals?.counts).toEqual(once)
        expect(totals?.workMs).toBeGreaterThanOrEqual(2000)
      }
    }
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

  it("starts every other command as a step too, each side of a pipe, with the variables the part gives it", async () => {
    const copy = directory("copy")
    const work = directory("work")
    const seen = await live(Effect.gen(function*() {
      const real = yield* ChildProcessSpawner
      const places = yield* confine(work, () => ({ refusal: "no bubblewrap" }), () => Effect.void, [], false)
      const held = reading(real, places.normal, copy)
      // What a part runs to read a commit, as `zig build` runs the commit's own build.zig: it sees a step's home,
      // the copy as its directory, the variable it was given, and no variable of the person's.
      // A part may give a value it keeps from its logs, and may name a variable it leaves out.
      const shows =
        "echo $HOME; pwd; echo ${GIVEN-none}; echo ${PERSONS-none}; echo ${KEPT-none}; echo ${LEFT_OUT-none}"
      const given = { GIVEN: "by the part", KEPT: Redacted.make("kept from logs"), LEFT_OUT: undefined }
      process.env["PERSONS"] = "a variable of the person"
      try {
        const plain = yield* held.string(ChildProcess.make("sh", ["-c", shows], { env: given }))
        const piped = yield* held.string(
          ChildProcess.make("sh", ["-c", shows]).pipe(
            ChildProcess.pipeTo(ChildProcess.make("sh", ["-c", "cat; echo $HOME"]))
          )
        )
        return { plain: plain.trim().split("\n"), piped: piped.trim().split("\n"), home: places.normal.home }
      } finally {
        delete process.env["PERSONS"]
      }
    }))
    expect(seen.plain).toEqual([seen.home, copy, "by the part", "none", "kept from logs", "none"])
    expect(seen.piped).toEqual([seen.home, copy, "none", "none", "none", "none", seen.home])
  })
})

describe("confine", () => {
  const scoped = <A>(work: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(Effect.scoped(work).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A>)

  it("makes each way a home with the hook, hides the person's home, and puts back only what a step has a use for", async () => {
    const owner = person()
    const work = directory("work")
    // The replay's own programs: one in a project under the home, one in a checkout of its source there, one the
    // machine does not have, one named without a directory, and a directory of `PATH`.
    const project = join(owner.home, "project")
    const installed = join(project, "node_modules", "@smthrs", "cli", "bin", "smithers.mjs")
    const source = join(owner.home, "source")
    const built = join(source, "packages", "tool", "bin", "starter.mjs")
    for (const file of [installed, built]) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, "")
    }
    writeFileSync(join(source, "pnpm-workspace.yaml"), "packages: []\n")
    const alone = join(owner.home, "alone.mjs")
    writeFileSync(alone, "")
    // The machine's temporary directory, with a bunx install in it, and the `node_modules/.bin` that npx puts on
    // `PATH` for a directory above the one it starts in, which is not there.
    const machine = directory("machine")
    const bunx = join(machine, "bunx-1000-smithers-ci@latest", "node_modules", "@smthrs", "cli", "bin", "smithers.mjs")
    mkdirSync(dirname(bunx), { recursive: true })
    writeFileSync(bunx, "")
    const programs = [
      "node",
      bunx,
      join(machine, "node_modules", ".bin"),
      installed,
      built,
      alone,
      join(owner.tool, "bin")
    ]
    const checkout = join(owner.home, "code", "repository")
    mkdirSync(checkout, { recursive: true })
    const cache = directory("cache")
    const asked = () => ({
      bwrap: "/usr/bin/bwrap",
      home: owner.home,
      hidden: [owner.runtime, "/run/user/none"],
      daemons: [],
      tmp: machine,
      caches: [cache, join(cache, "none")],
      tools: toolsOf(owner),
      // The kernel of this machine keeps what a perl starts from the abstract sockets outside it.
      scope: "/usr/bin/perl"
    })
    const places = await scoped(confine(work, asked, () => Effect.void, programs, false, undefined, checkout))

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
      // Where a version manager looks for its versions, under the step's own home.
      expect(readdirSync(place.home).sort()).toEqual([".gitconfig", ".smithers-ci", ".versions"])
      expect(readlinkSync(join(place.home, ".versions", "tool"))).toBe(owner.tool)
      expect(readdirSync(place.tmp)).toEqual([])
      // What every job's home starts as: the hook, the configuration, and where the version manager looks.
      expect(place.template).toBe(join(work, "home", "template"))
      expect(readFileSync(join(place.template, hooksDirectory, "pre-push"), "utf8")).toBe(prePush)
      expect(readFileSync(join(place.template, ".gitconfig"), "utf8")).toBe(gitConfig)
      expect(readlinkSync(join(place.template, ".versions", "tool"))).toBe(owner.tool)
      expect(place.links).toEqual([{ path: ".versions/tool", target: owner.tool }])
      expect(place.jail).toEqual({
        bwrap: "/usr/bin/bwrap",
        masks: [
          // The whole home, with the tool, the installs of the replay's programs and the repository put back. A
          // program alone in the home is put back alone: its directory is the home.
          {
            path: owner.home,
            directory: true,
            readable: [owner.tool, project, source, alone, checkout],
            links: [{ path: join(owner.home, "system"), target: "/usr/bin" }]
          },
          // A credential that is a link out of the home is hidden where it leads: a directory, and a file.
          { path: owner.cloud, directory: true },
          { path: join(owner.vault, "netrc"), directory: false },
          { path: owner.runtime, directory: true }
        ],
        tmp: join(work, "tmp", way),
        temporary: ["/tmp", machine],
        visible: [join(machine, "bunx-1000-smithers-ci@latest"), cache, work],
        filter: join(work, "keyring-filter"),
        scope: "/usr/bin/perl"
      })
    }
    // The filter that refuses a step the keys of the person's session is written once, beside the homes.
    expect(new Uint8Array(readFileSync(join(work, "keyring-filter")))).toEqual(keyringFilter())
  })

  // `Inventory.runnerSoftware`: an SDK often lies in the home, and a JDK is often reached through a link there.
  it("puts back the software a person's variables name in the home, and a link to it as a link", async () => {
    const owner = person()
    const sdk = join(owner.home, "Android", "Sdk")
    const jdk = join(owner.home, ".jdks", "21")
    mkdirSync(sdk, { recursive: true })
    mkdirSync(jdk, { recursive: true })
    const current = join(owner.home, ".jdks", "current")
    symlinkSync(jdk, current)
    const asked = () => ({
      bwrap: "/usr/bin/bwrap",
      home: owner.home,
      hidden: [],
      daemons: [],
      tmp: "/tmp",
      caches: [],
      tools: { reads: [], links: [], homes: [] }
    })
    const places = await scoped(confine(directory("work"), asked, () => Effect.void, [], false, {
      ANDROID_HOME: sdk,
      JAVA_HOME: current,
      // Neither names a place on this machine, so neither puts anything back.
      CONDA: "relative/conda",
      VCPKG_INSTALLATION_ROOT: join(owner.home, "not-there"),
      // Not a variable of a runner's software.
      SOMETHING_ELSE: join(owner.home, ".ssh")
    }))
    expect(places.normal.jail?.masks[0]).toEqual({
      path: owner.home,
      directory: true,
      readable: [sdk, jdk],
      links: [{ path: current, target: jdk }]
    })
  })

  it("hides the home with nothing put back when no tool, program or repository is in it", async () => {
    const owner = person()
    const asked = () => ({
      bwrap: "/usr/bin/bwrap",
      home: owner.home,
      hidden: [],
      daemons: [],
      tmp: "/tmp",
      caches: [],
      tools: { reads: [], links: [], homes: [] }
    })
    const places = await scoped(confine(directory("work"), asked, () => Effect.void, [], false, undefined, "/nowhere"))
    expect(places.normal.jail?.masks).toEqual([
      { path: owner.home, directory: true },
      { path: owner.cloud, directory: true },
      { path: join(owner.vault, "netrc"), directory: false }
    ])
    expect(readdirSync(places.normal.home).sort()).toEqual([".gitconfig", ".smithers-ci"])
  })

  it("hides a home that lies in another hidden directory once, with that directory", async () => {
    // A home inside the home of another user, as a program started with its own `HOME` has.
    const others = directory("others")
    const home = join(others, "nested")
    const tool = join(home, ".local", "tool")
    mkdirSync(join(tool, "bin"), { recursive: true })
    const asked = () => ({
      bwrap: "/usr/bin/bwrap",
      home,
      hidden: [others],
      daemons: [],
      tmp: "/tmp",
      caches: [],
      tools: { reads: [tool], links: [], homes: [] }
    })
    const places = await scoped(confine(directory("work"), asked, () => Effect.void, [], false))
    expect(places.normal.jail?.masks).toEqual([{ path: others, directory: true, readable: [tool] }])
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

describe("what a step has no use for", () => {
  const facts = ExecSandbox.host()

  it("is every other home of the machine, and where it keeps mail, schedules, mounted secrets and containers", () => {
    const machine = { ...facts, home: "/home/me", entries: (path: string) => path === "/home" ? ["me", "you"] : [] }
    expect(elsewhere(machine)).toEqual([
      "/home/you",
      "/root",
      "/var/mail",
      "/var/spool/mail",
      "/var/spool/cron",
      "/run/secrets",
      "/var/run/secrets",
      "/var/lib/docker",
      "/var/lib/containers"
    ])
    // The person's own home is hidden as the home, with the tools put back, wherever it is.
    const root = { ...facts, home: "/root", entries: undefined }
    expect(elsewhere(root)).not.toContain("/root")
    expect(elsewhere(root)).toContain("/var/mail")
  })

  it("names the install a program's files are in", () => {
    const none = () => false
    // The directory that holds the first `node_modules` on the way to the program.
    expect(installOf("/home/me/.npm/_npx/1a2b/node_modules/@smthrs/cli/bin/smithers.mjs", none)).toBe(
      "/home/me/.npm/_npx/1a2b"
    )
    // A checkout of the program's source, where one is marked.
    const marked = (directory: string) => directory === "/home/me/code/smithers"
    expect(installOf("/home/me/code/smithers/packages/smithers/bin/smithers.mjs", marked)).toBe(
      "/home/me/code/smithers"
    )
    // Else the directory the program is in.
    expect(installOf("/home/me/bin/tool", none)).toBe("/home/me/bin")
  })
})

describe("the tools on a search path", () => {
  it("are the installs of its programs, with the home a version manager looks for under the step's own", () => {
    const home = directory("person")
    // A version manager: its shims on the search path, its versions beside them.
    const manager = join(home, ".local", "share", "mise")
    mkdirSync(join(manager, "shims"), { recursive: true })
    mkdirSync(join(manager, "installs"))
    writeFileSync(join(manager, "shims", "tool"), "#!/bin/sh\n", { mode: 0o755 })
    const tools = toolsOn(join(manager, "shims"), { ...ExecSandbox.host(), home })
    expect(tools.reads).toEqual([manager])
    expect(tools.links).toEqual([])
    // Smithers build also names where its own private directories would hold the manager; a step has a home only.
    expect(tools.homes).toEqual([{ path: ".local/share/mise", target: manager }])
    expect(toolsOn(undefined, { ...ExecSandbox.host(), home })).toEqual({ reads: [], links: [], homes: [] })
  })
})

describe("the jail", () => {
  const argv = ["bash", "-e", "-c", "true"] as const
  const place = { home: "/h", tmp: "/t", guard: "/g", template: "/h0", links: [], hooks: "/h/hooks", daemon: {} }

  it("is asked of the machine: Linux with a bubblewrap that starts, or the reason", () => {
    const facts = ExecSandbox.host()
    // A machine that cannot jail a step still says which links a step's own home needs.
    const mac = { ...facts, platform: "darwin" as const }
    expect(probe(mac)).toEqual({
      refusal: "write protection needs bubblewrap, which runs only on Linux; this host is darwin",
      homes: toolsOn(process.env["PATH"], mac).homes
    })
    const bare = { ...facts, platform: "linux" as const, executable: () => undefined }
    expect(probe(bare)).toEqual({
      refusal: "write protection needs bubblewrap, and bwrap is not on PATH (install the bubblewrap package)",
      homes: toolsOn(process.env["PATH"], bare).homes
    })
    // A machine whose bubblewrap starts, whatever machine the test runs on.
    const starts = {
      ...facts,
      executable: (name: string) => `/usr/bin/${name}`,
      home: "/home/person",
      uid: 1234
    }
    const jail = {
      bwrap: "/usr/bin/bwrap",
      home: "/home/person",
      hidden: ["/run/user/1234", ...elsewhere(starts)],
      daemons: daemonSockets(1234, process.env),
      tmp: tmpdir(),
      caches: [join(tmpdir(), "tsx-1234"), join(tmpdir(), "vibelang-cache-1234")],
      tools: toolsOn(process.env["PATH"], starts)
    }
    // Its kernel keeps what a perl starts from the abstract sockets outside it, or it does not.
    const asked: Array<string> = []
    const kernel = (answer: boolean) => (perl: string) => {
      asked.push(perl)
      return answer
    }
    expect(probe(starts, () => undefined, kernel(true))).toEqual({ ...jail, scope: "/usr/bin/perl" })
    expect(probe(starts, () => undefined, kernel(false))).toEqual(jail)
    expect(asked).toEqual(["/usr/bin/perl", "/usr/bin/perl"])
    // With no perl there is nothing to ask the kernel with.
    const perlless = { ...starts, executable: (name: string) => name === "perl" ? undefined : `/usr/bin/${name}` }
    expect(probe(perlless, () => undefined, kernel(true))).toEqual({
      ...jail,
      tools: toolsOn(process.env["PATH"], perlless)
    })
    expect(asked).toHaveLength(2)
    if (jailable) {
      const perl = facts.executable("perl")
      expect(found).toEqual({
        bwrap: facts.executable("bwrap"),
        home: homedir(),
        hidden: [`/run/user/${facts.uid}`, ...elsewhere(facts)],
        daemons: daemonSockets(facts.uid, process.env),
        tmp: tmpdir(),
        caches: [join(tmpdir(), `tsx-${facts.uid}`), join(tmpdir(), `vibelang-cache-${facts.uid}`)],
        tools: toolsOn(process.env["PATH"], facts),
        ...(perl !== undefined && scopes(perl) ? { scope: perl } : {})
      })
    }
  })

  it("asks the kernel by starting the program it is given, and takes no answer for no", () => {
    expect(scopes("/bin/true")).toBe(true)
    expect(scopes("/bin/false")).toBe(false)
    expect(scopes("/no/such/perl")).toBe(false)
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
      masks: [
        {
          path: "/person",
          directory: true,
          readable: ["/person/.local/tool"],
          links: [{ path: "/person/bin/system", target: "/usr/bin" }]
        },
        { path: "/vault/netrc", directory: false }
      ],
      tmp: "/work/tmp",
      // The machine's temporary directory lies in the directory the replay's program is installed in.
      temporary: ["/tmp", "/tmp/bunx/tmp"],
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
      // The home is empty, then the tool is put back to read and the link to follow, and the home is sealed.
      "--tmpfs",
      "/person",
      "--ro-bind",
      "/person/.local/tool",
      "/person/.local/tool",
      "--dir",
      "/person/bin",
      "--symlink",
      "/usr/bin",
      "/person/bin/system",
      "--remount-ro",
      "/person",
      "--ro-bind",
      "/dev/null",
      "/vault/netrc",
      // A directory before what lies in it: the temporary directory inside the program's is the replay's own
      // again, and can be written.
      "--bind",
      "/work/tmp",
      "/tmp",
      "--ro-bind",
      "/work",
      "/work",
      "--ro-bind",
      "/tmp/bunx",
      "/tmp/bunx",
      "--bind",
      "/work/tmp",
      "/tmp/bunx/tmp",
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

  it("has perl scope the step where the kernel can: it runs first in the jail and becomes the step's command", () => {
    const jail = {
      bwrap: "/usr/bin/bwrap",
      masks: [],
      tmp: "/work/tmp",
      temporary: ["/tmp"],
      visible: [],
      filter: "/work/keyring-filter"
    }
    const plain = held({ ...place, jail }, ["/copy"], argv)
    const scoped = held({ ...place, jail: { ...jail, scope: "/usr/bin/perl" } }, ["/copy"], argv)
    expect(plain.slice(-5)).toEqual(["--", ...argv])
    expect(scoped).toEqual([...plain.slice(0, -4), "/usr/bin/perl", "-e", scopeProgram, "--", ...argv])
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
