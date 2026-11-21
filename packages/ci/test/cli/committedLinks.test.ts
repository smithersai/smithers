/**
 * A repository that commits links, some of them pointing out of it, replays
 * and gets a working CI from `apply`, under each recorder this machine has.
 *
 * The sixth ship review's blocker 3: a committed `docs/link -> /etc/hostname`
 * or `-> ../../outside.txt`, read by no job, made Smithers build refuse every
 * target, so the replay ended with exit 4 and the workflow `apply` writes
 * failed at every commit. A link is an input by its text; a read through it
 * counts where it lands.
 *
 * Each job reads through one kind of link and fails only at `c2 bad`, as a
 * runner gives it:
 *
 * | Job         | The link                                                                    | At `c2 bad`                        |
 * | ----------- | --------------------------------------------------------------------------- | ---------------------------------- |
 * | `noread`    | `docs/link -> /etc/hostname`, read by no job                                | `data/x.txt` breaks                |
 * | `abs`       | `data/host -> /etc/hostname`, a file of the machine                         | the link's text leads nowhere      |
 * | `sibling`   | `side -> ../sci-link-side`, a directory step 1 makes beside the checkout    | what step 1 copies there breaks    |
 * | `dirlink`   | `lnk -> datadir`, a directory                                               | `datadir/x.txt` breaks             |
 * | `chain`     | `data/hop1 -> hop2 -> ../../run/data/real.txt`, out and back by its name    | `data/real.txt` breaks             |
 * | `retext`    | `data/pick -> a.txt`                                                        | its text changes to `b.txt`        |
 * | `recontent` | `data/fixed -> c.txt`                                                       | `c.txt` breaks, the text stays     |
 * | `listed`    | `data/list` holds a file and `l1 -> /etc/hostname`; the job lists it        | a link `l2 -> ../../outside` joins |
 *
 * The real program replays the repository, and the real `smthrs` runs the
 * generated workflow's command as a runner does.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { compiledCode } from "../../src/generate/Render.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, head, observes, remove, spawnWith } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))
const supervisor = fileURLToPath(
  new URL(`../../../smithers/build/build-cli/native/out/linux-${process.arch}/smthrs-observe`, import.meta.url)
)

/** A machine that can give a step a `/tmp` of its own: Linux with a bubblewrap that starts. */
const mounts = !("refusal" in probe())

/** The recorders this machine has, each as the variable that picks it. */
const recorders = [
  ...(process.platform === "linux" && process.arch === "x64" && existsSync(supervisor) ? ["smthrs-observe"] : []),
  ...(observes ? ["strace"] : [])
]

/** Each job and its steps. */
const jobs: ReadonlyArray<readonly [name: string, steps: ReadonlyArray<string>]> = [
  ["noread", ["test \"$(cat data/x.txt)\" = ok"]],
  ["abs", ["test -s data/host"]],
  ["sibling", [
    "mkdir -p ../sci-link-side && cp data/side.txt ../sci-link-side/x.txt",
    "test \"$(cat side/x.txt)\" = ok"
  ]],
  ["dirlink", ["test \"$(cat lnk/x.txt)\" = ok"]],
  ["chain", ["test \"$(cat data/hop1)\" = ok"]],
  ["retext", ["test \"$(cat data/pick)\" = ok"]],
  ["recontent", ["test \"$(cat data/fixed)\" = ok"]],
  ["listed", ["test \"$(ls data/list | wc -l)\" = 2"]]
]

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  ...jobs.flatMap(([name, steps]) => [
    `  ${name}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...steps.map((step) => `      - run: ${JSON.stringify(step)}`)
  ]),
  ""
].join("\n")

/** Makes `path` a link to `target`, in place of whatever was there. */
const link = (root: string, path: string, target: string): void => {
  rmSync(join(root, path), { force: true })
  mkdirSync(join(root, path, ".."), { recursive: true })
  symlinkSync(target, join(root, path))
}

/** The files every job reads, all right or all broken. */
const data = (value: string): Readonly<Record<string, string>> => ({
  "data/x.txt": `${value}\n`,
  "data/side.txt": `${value}\n`,
  "datadir/x.txt": `${value}\n`,
  "data/real.txt": `${value}\n`,
  "data/c.txt": `${value}\n`
})

/** The links of a right commit. */
const rightLinks = (root: string): void => {
  link(root, "data/host", "/etc/hostname")
  link(root, "data/pick", "a.txt")
  rmSync(join(root, "data/list/l2"), { force: true })
}

/**
 * The repository with its four commits, in a directory named `run` as the
 * runner's checkout below is, so a link that leaves the checkout and comes
 * back by its name resolves in both. Beside the temporary directory, as a
 * runner's work directory is.
 */
const repository = (prefix: string): { readonly base: string; readonly source: string } => {
  const base = mkdtempSync(`/var/tmp/smithers-ci-${prefix}-`)
  made.push(base)
  const source = join(base, "origin", "run")
  mkdirSync(source, { recursive: true })
  git(source, "init", "--quiet", "--initial-branch=main")
  link(source, "docs/link", "/etc/hostname")
  link(source, "side", "../sci-link-side")
  link(source, "lnk", "datadir")
  link(source, "data/hop1", "hop2")
  link(source, "data/hop2", "../../run/data/real.txt")
  link(source, "data/fixed", "c.txt")
  link(source, "data/list/l1", "/etc/hostname")
  rightLinks(source)
  commit(source, "c0 base", {
    ".github/workflows/ci.yml": workflow,
    "data/a.txt": "ok\n",
    "data/b.txt": "bad\n",
    "data/list/f1": "f\n",
    ...data("ok")
  })
  commit(source, "c1 readme", { "README.md": "# x\n" })
  link(source, "data/host", "/nonexistent/sci-link-inputs")
  link(source, "data/pick", "b.txt")
  link(source, "data/list/l2", "../../outside")
  commit(source, "c2 bad", data("bad"))
  rightLinks(source)
  commit(source, "c3 ok", data("ok"))
  return { base, source }
}

/** The jobs whose steps failed, by name. */
const failedJobs = (failures: ReadonlyArray<{ readonly step: string }> | undefined): ReadonlyArray<string> =>
  [...new Set((failures ?? []).map((failure) => failure.step.split(":")[1] ?? failure.step))].sort()

const all = jobs.map(([name]) => name).sort()

describe.skipIf(recorders.length === 0)("a repository that commits links, some leading out of it", () => {
  for (const recorder of recorders) {
    it(`replays every commit as a runner runs it, with ${recorder}`, async () => {
      const { source } = repository(`links-replay-${recorder}`)
      const outcome = await spawnWith(bin, ["--commits", "3", "--no-trial", "--no-apply-check", "--json"], source, {
        SMTHRS_OBSERVE_WITH: recorder
      })
      expect(outcome.code, outcome.stderr).toBe(0)
      const report = JSON.parse(outcome.stdout) as ReplayReport
      const bySubject = new Map(report.commits.map((replayed) => [
        git(source, "log", "-1", "--format=%s", replayed.commit).trim(),
        replayed
      ]))
      expect([...bySubject.keys()].sort()).toEqual(["c1 readme", "c2 bad", "c3 ok"])
      for (const [subject, replayed] of bySubject) {
        const wanted = subject === "c2 bad" ? all : []
        expect(failedJobs(replayed.baseline.failures), `${subject} baseline`).toEqual(wanted)
        expect(failedJobs(replayed.normal.failures), `${subject} normal`).toEqual(wanted)
      }
      expect(report.mismatches).toBe(0)
    }, 900_000)

    it(`passes and fails in the CI \`apply\` writes as a runner does, with ${recorder}`, async () => {
      const { base, source } = repository(`links-applied-${recorder}`)
      const subjects = new Map(
        git(source, "log", "--format=%s%x09%H").trim().split("\n").map((line) => line.split("\t") as [string, string])
      )
      const state = join(base, "state", "smithers-ci")
      const run = (subject: string, attempt: number) => {
        // The files apply writes, at the commit, then a fresh clone at the same path and an empty home.
        git(source, "checkout", "--quiet", "-B", "main", subjects.get(subject)!)
        const applied = spawnSync(process.execPath, [bin, "apply"], { cwd: source, encoding: "utf8" })
        expect(applied.status, applied.stderr).toBe(0)
        commit(source, `apply at ${subject}`)
        const sha = head(source)
        const checkout = join(base, "run")
        const home = join(base, "home")
        remove(checkout)
        remove(home)
        remove(join(base, "sci-link-side"))
        mkdirSync(home)
        git(base, "clone", "--quiet", source, checkout)
        git(checkout, "checkout", "--quiet", "-B", "main", sha)
        const results = join(base, `results-${attempt}.json`)
        const ran = spawnSync(
          process.execPath,
          [smthrs, "ci", "//...", "--ui", "plain", "--results-file", results, "--cache-dir", state],
          {
            cwd: checkout,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            env: {
              ...process.env,
              HOME: home,
              CI: "true",
              GITHUB_ACTIONS: "true",
              GITHUB_SHA: sha,
              GITHUB_REF: "refs/heads/main",
              GITHUB_EVENT_NAME: "push",
              GITHUB_RUN_ID: String(8_000 + attempt),
              GITHUB_RUN_NUMBER: String(attempt),
              GITHUB_RUN_ATTEMPT: "1",
              GITHUB_REPOSITORY: "example/links",
              GITHUB_WORKSPACE: checkout,
              RUNNER_TEMP: join(base, "runner-temp"),
              RUNNER_OS: "Linux",
              NODE_COMPILE_CACHE: join(state, compiledCode),
              SMTHRS_OBSERVE_WITH: recorder,
              ...(mounts ? { SMTHRS_MACHINE_OWN_TMP: "required" } : {})
            }
          }
        )
        const record = JSON.parse(readFileSync(results, "utf8")) as {
          readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
        }
        const failed = record.results.filter((result) => result.status === "failed").map((result) =>
          result.label.replace(/^\/\/:ci\.yml-(\w+)-\d+$/, "$1")
        )
        return { code: ran.status, failed: [...new Set(failed)].sort(), printed: `${ran.stdout}${ran.stderr}` }
      }
      const passing = run("c1 readme", 1)
      expect([passing.code, passing.failed], passing.printed).toEqual([0, []])
      // The next run restores what the first stored. Every job reads what c2 broke: each runs and fails.
      const failing = run("c2 bad", 2)
      expect(failing.failed, failing.printed).toEqual(all)
      expect(failing.code).not.toBe(0)
      const again = run("c3 ok", 3)
      expect([again.code, again.failed], again.printed).toEqual([0, []])
    }, 900_000)
  }
})
