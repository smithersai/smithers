/** A real git repository for the replay tests, with real commits and real scripts. */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository's own `smthrs`, and the targets package a generated workspace imports. */
export const smthrs = fileURLToPath(new URL("../../../../node_modules/.bin/smthrs", import.meta.url))
const targetsPackage = fileURLToPath(new URL("../../../../node_modules/@smthrs/targets", import.meta.url))

/** Lets a generated workspace in `directory` import the targets package. */
export const linkTargets = (directory: string): void => {
  const scope = join(directory, "node_modules", "@smthrs")
  mkdirSync(scope, { recursive: true })
  symlinkSync(targetsPackage, join(scope, "targets"))
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  })

const job = (
  id: string,
  command: string,
  extra: {
    readonly needs?: ReadonlyArray<string>
    readonly more?: ReadonlyArray<string>
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string>>
  } = {}
) => ({
  id,
  // A GitHub Actions job gets a checkout of its own; the jobs of a Justfile would share one and run in order.
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: extra.needs ?? [],
  triggers: ["push"],
  matrix: [],
  steps: [command, ...(extra.more ?? [])].map((text, index) => ({
    id: `${id}${index}`,
    command: text,
    cwd: extra.cwd ?? "",
    env: extra.env ?? {},
    secrets: []
  })),
  unsupported: []
})

/** What the test repository's CI does. `counter` is where the baseline counts runs of the flaky step. */
export const inventoryWith = (counter: string) => ({
  version: 1,
  repository: "test/replay",
  commit: "0000000000000000000000000000000000000000",
  toolchains: [],
  jobs: [
    job("a", "sh a.sh"),
    job("b", "sh b.sh", { needs: ["a"] }),
    job("c", "sh c.sh", { env: { COUNTER: counter } }),
    job("d", "sh d.sh", { more: ["sh d2.sh"] }),
    job("f", "sh f.sh", { needs: ["c"] }),
    job("h", "sh h.sh", { needs: ["f"] }),
    job("k", "sh k.sh"),
    { ...job("m", "test ${{ matrix.size }} -gt 0"), matrix: [{ size: "1" }, { size: "2" }] },
    { ...job("nightly", "exit 1"), triggers: ["schedule"] }
  ]
})

const pass = "exit 0\n"
const fail = "exit 1\n"

export interface Repository {
  readonly root: string
  readonly commits: ReadonlyArray<string>
  readonly remove: () => void
}

/**
 * A script that fails on every odd run and passes on every even one. A target
 * can write only under `.flows`, which the replay keeps between commits, so
 * the count lives there unless `COUNTER` names a place, as the baseline does.
 */
const flaky = `f=\${COUNTER:-.flows/c-runs}
n=$(cat "$f" 2>/dev/null || echo 0)
echo $((n + 1)) > "$f"
test $((n % 2)) -eq 1
`

/**
 * Five commits: all green; a change to `b` alone; `a`, `d` and `k` broken; all
 * fixed; `c` flaky with `f` broken behind it.
 */
export const makeRepository = (): Repository => {
  const root = mkdtempSync(join(tmpdir(), "replay-repository-"))
  const counter = join(mkdtempSync(join(tmpdir(), "replay-counter-")), "runs")
  const commit = (message: string, files: Readonly<Record<string, string>>): string => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", message)
    return git(root, "rev-parse", "HEAD").trim()
  }
  git(root, "init", "--quiet", "--initial-branch=main")
  const commits = [
    commit("all green", {
      ".gitignore": "node_modules\n.flows\n",
      "ci.json": JSON.stringify(inventoryWith(counter)),
      "a.sh": pass,
      "b.sh": pass,
      "c.sh": pass,
      "d.sh": pass,
      "d2.sh": pass,
      "f.sh": pass,
      "h.sh": pass,
      "k.sh": pass
    }),
    commit("change b", { "b.sh": `# changed\n${pass}` }),
    commit("break a, d and k", { "a.sh": fail, "d.sh": fail, "k.sh": fail }),
    commit("fix a, d and k", { "a.sh": pass, "d.sh": pass, "k.sh": pass }),
    commit("c turns flaky, f breaks", { "c.sh": flaky, "f.sh": fail })
  ]
  return {
    root,
    commits,
    remove: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(join(counter, ".."), { recursive: true, force: true })
    }
  }
}

/** A directory that is not a git repository. */
export const makeEmptyDirectory = (): string => mkdtempSync(join(tmpdir(), "replay-empty-"))

/** A git repository with no commits. */
export const makeEmptyRepository = (): string => {
  const root = makeEmptyDirectory()
  git(root, "init", "--quiet")
  return root
}

/** A one-commit repository whose CI is `jobs`. */
export const makeSmallRepository = (jobs: ReadonlyArray<unknown>): string => {
  const root = makeEmptyDirectory()
  git(root, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(root, ".gitignore"), "node_modules\n.flows\n")
  writeFileSync(join(root, "ci.json"), JSON.stringify({ ...inventoryWith(join(root, "unused")), jobs }))
  writeFileSync(join(root, "a.sh"), pass)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "one")
  return root
}

export { job }

/**
 * A real `smthrs` behind a script that records every command line. With
 * `brokenPlan`, `--plan` prints no plan.
 */
export const recordingSmthrs = (brokenPlan: boolean, prints = "") => {
  const directory = makeEmptyDirectory()
  const log = join(directory, "commands")
  const command = join(directory, "smthrs")
  const planCase = brokenPlan ? `case "$*" in *--plan*) echo "no plan here"; exit 0;; esac\n` : ""
  const printed = prints === "" ? "" : `echo '${prints}'\n`
  writeFileSync(command, `#!/bin/sh\necho "$*" >> ${log}\n${printed}${planCase}exec ${smthrs} "$@"\n`)
  chmodSync(command, 0o755)
  return { directory, command, commands: () => readFileSync(log, "utf8").split("\n") }
}
