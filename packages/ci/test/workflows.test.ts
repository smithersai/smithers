/**
 * This repository's own GitHub workflows, held to what a workflow `smithers-ci apply` writes is held to: no checkout
 * keeps the job's token, every Node is the pinned one, nothing installed for all users runs a package's scripts, and a
 * release builds and publishes only a commit that is on main. Each case names the Round 1 finding it closes.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

const root = join(import.meta.dirname, "..", "..", "..")
const names = [
  "ci",
  "distribution",
  "drift",
  "native-windows",
  "npm-dist-tag",
  "recorder",
  "release-auth",
  "release",
  "reliability",
  "windows-confinement"
] as const

interface Step {
  readonly name?: string
  readonly id?: string
  readonly if?: string
  readonly uses?: string
  readonly run?: string
  readonly shell?: string
  readonly env?: Readonly<Record<string, string>>
  readonly with?: Readonly<Record<string, unknown>>
}
interface Job {
  readonly needs?: string | ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
  readonly steps: ReadonlyArray<Step>
  readonly outputs?: Readonly<Record<string, string>>
}
interface Workflow {
  readonly on: Readonly<Record<string, { readonly paths?: ReadonlyArray<string> } | null>>
  readonly jobs: Readonly<Record<string, Job>>
}

const text = (name: string): string => readFileSync(join(root, ".github", "workflows", `${name}.yml`), "utf8")
const workflows = new Map<string, Workflow>(names.map((name) => [name, parseYaml(text(name)) as Workflow]))
const workflow = (name: typeof names[number]): Workflow => workflows.get(name) as Workflow
const steps = [...workflows].flatMap(([file, { jobs }]) =>
  Object.entries(jobs).flatMap(([job, { steps }]) => steps.map((step) => ({ file, job, step })))
)
const at = (entry: { file: string; job: string; step: Step }): string =>
  `${entry.file}.yml ${entry.job}: ${entry.step.name ?? entry.step.uses ?? entry.step.run?.split("\n")[0]}`
const stepOf = (job: Job, name: string): Step => {
  const found = job.steps.find((step) => step.name === name)
  if (found === undefined) throw new Error(`no step named ${name}`)
  return found
}

const created: Array<string> = []
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true })
})

/** Runs a step's script as GitHub does, with `env` and nothing else of this process but `PATH`. */
const run = (step: Step, env: Readonly<Record<string, string>>, cwd = tmpdir()) =>
  spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run as string], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] as string, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env }
  })

/** A repository with `main` at two commits on `origin`, a commit that is on no branch of it, and tags at each. */
const repository = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "release-source-")))
  created.push(directory)
  const git = (...args: ReadonlyArray<string>): string => {
    const ran = spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env["PATH"] as string, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
    })
    if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
    return ran.stdout.trim()
  }
  git("init", "--quiet", "-b", "main")
  const commit = (message: string) =>
    git("-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "--quiet", "--allow-empty", "-m", message)
  commit("first")
  const onMain = git("rev-parse", "HEAD")
  commit("second")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"))
  git("checkout", "--quiet", "--detach", onMain)
  commit("never reviewed")
  const offMain = git("rev-parse", "HEAD")
  git("tag", "v1.0.0", onMain)
  git("tag", "v6.6.6", offMain)
  return { directory, git, onMain, offMain }
}

describe("every workflow", () => {
  // R1-Neon-D3-014, R1-Fable-D3-048.
  it("checks out without leaving the job's token in .git/config", () => {
    const checkouts = steps.filter(({ step }) => step.uses?.startsWith("actions/checkout@"))
    expect(checkouts.length).toBeGreaterThanOrEqual(30)
    expect(checkouts.filter(({ step }) => String(step.with?.["persist-credentials"]) !== "false").map(at)).toEqual([])
  })

  // R1-Neon-D3-012: five workflows named 26.4.0, the supported floor, where they meant the repository's Node.
  it("runs on the repository's pinned Node, but for the release's two floor steps and the soak's own matrix", () => {
    const pinned = readFileSync(join(root, ".node-version"), "utf8").trim()
    const setups = steps.filter(({ step }) => step.uses?.startsWith("actions/setup-node@"))
    const other = setups.filter(({ step }) =>
      step.with?.["node-version-file"] !== ".node-version" && String(step.with?.["node-version"]) !== pinned
    )
    expect(other.map((entry) => `${at(entry)} = ${String(entry.step.with?.["node-version"])}`).sort()).toEqual([
      // The publish job starts its gates on the floor (pack-release.test.mjs) and packs and smokes on it.
      "release.yml publish: Install the supported Node floor = 26.4.0",
      "release.yml publish: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 = 26.4.0",
      "reliability.yml sync-long-soak: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 = ${{ matrix.node }}"
    ])
  })

  // R1-Neon-D3-003.
  it("installs nothing for all users with its lifecycle scripts on", () => {
    const installs = steps.flatMap((entry) =>
      (entry.step.run ?? "").split("\n").filter((line) => /\bnpm (install|i) (--global|-g)\b/.test(line)).map((
        line
      ) => ({ where: at(entry), line: line.trim() }))
    )
    expect(installs.length).toBeGreaterThanOrEqual(5)
    expect(installs.filter(({ line }) => !line.includes("--ignore-scripts"))).toEqual([])
  })

  // R1-Neon-D3-013: `cargo test | tee` ended as tee did, so an AddressSanitizer abort passed.
  it("fails a step when the left side of a pipe into tee fails", () => {
    const piped = steps.filter(({ step }) => /\|\s*tee\b/.test(step.run ?? ""))
    expect(piped.map(at)).toContain("reliability.yml jj-native-wasm-abi: Execute parser corpus under AddressSanitizer")
    for (const entry of piped) {
      const script = entry.step.run as string
      expect(script.slice(0, script.search(/\|\s*tee\b/)), at(entry)).toMatch(/set -(euo|o) pipefail/)
    }
    const asan = stepOf(
      workflow("reliability").jobs["jj-native-wasm-abi"] as Job,
      "Execute parser corpus under AddressSanitizer"
    )
    // The script's own first lines, with a command in place of cargo that fails as an aborted test binary does.
    const script = (asan.run as string).replace(
      /cargo \+[\s\S]*?-- --nocapture/,
      "sh -c 'echo ==ERROR: AddressSanitizer; exit 134'"
    )
      .replace(/^SMITHERS_ABI_SEED=.*$/m, "SMITHERS_ABI_SEED=1").replace(/^pnpm exec .*$/m, "echo reached-verify")
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "asan-step-")))
    created.push(directory)
    const ran = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] as string, SMITHERS_ABI_ARTIFACT_DIR: directory }
    })
    expect(ran.status).toBe(134)
    expect(ran.stdout).not.toContain("reached-verify")
    expect(readFileSync(join(directory, "asan.log"), "utf8")).toContain("AddressSanitizer")
  })

  // R1-Astra-D3-008, R1-Fable-D3-046: recorder.yml and windows-confinement.yml were linted by nothing.
  it("is linted by actionlint, in CI and before a release", () => {
    const expected = names.map((name) => `.github/workflows/${name}.yml`).sort()
    const lints = steps.filter(({ step }) => step.uses?.startsWith("docker://rhysd/actionlint@"))
    expect(lints.map(({ file }) => file).sort()).toEqual(["ci", "release"])
    for (const { step } of lints) expect(String(step.with?.["args"]).split(" ").sort()).toEqual(expected)
  })
})

describe("windows-confinement.yml", () => {
  // R1-Neon-D3-003: a pull request's package.json named what root installed in WSL.
  it("refuses a packageManager that is not an exact pnpm release before root installs it", () => {
    const setup = stepOf(
      workflow("windows-confinement").jobs["windows-wsl2"] as Job,
      "Install the WSL2 toolchain and checkout"
    )
    const script = setup.run as string
    const start = script.indexOf("if ! [[ \"$package_manager\" =~")
    const install = script.indexOf("npm install --global \"$package_manager\"")
    expect(start).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(start)
    const guard = script.slice(start, install).split("\n").map((line) => line.trim()).join("\n")
    const guarded = (value: string) =>
      spawnSync("bash", ["-c", `set -euo pipefail\n${guard}\necho installs`], {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] as string, package_manager: value }
      })
    for (const safe of ["pnpm@11.25.0", "pnpm@9.0.0"]) expect(guarded(safe).stdout).toBe("installs\n")
    for (
      const hostile of [
        "evil-package@1.0.0",
        "pnpm@11.25.0 evil-package",
        "https://example.invalid/evil.tgz",
        "git+https://example.invalid/evil.git",
        "pnpm@latest",
        "pnpm@11.25.0+sha512.abc",
        "pnpm@11.25.0\nevil",
        "--ignore-scripts=false",
        "undefined",
        ""
      ]
    ) {
      const ran = guarded(hostile)
      expect(ran.status, JSON.stringify(hostile)).toBe(1)
      expect(ran.stdout).toBe("")
      expect(ran.stderr).toContain("refusing to install it as root")
    }
  })
})

describe("recorder.yml", () => {
  // R1-Fable-D3-047: its suites import Machine.ts, PackageRunner.ts and more of build-cli/src than the two it named.
  it("starts for a change to any source of build-cli", () => {
    const { on } = workflow("recorder")
    for (const event of ["push", "pull_request"]) {
      expect(on[event]?.paths).toContain("packages/smithers/build/build-cli/src/**")
    }
    expect(on["push"]?.paths).toEqual(on["pull_request"]?.paths)
  })
})

describe("npm-dist-tag.yml", () => {
  const move = workflow("npm-dist-tag").jobs["move"] as Job
  /** A script of the checkout: the one thing in this job a branch's copy could have rewritten. */
  const runsRepositoryScript = (step: Step): boolean => /\.smithers\/|\.(mjs|js|ts|sh)\b/.test(step.run ?? "")
  const credential = /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/

  // R2-Neon-D3-003: a dispatch from any branch ran that branch's copy of the workflow in the npm-publish environment.
  it("runs only as the repository's own copy on main, checked before anything is checked out", () => {
    const guard = move.steps[0] as Step
    expect(guard.name).toBe("Require the reviewed workflow on main")
    expect(guard.if).toBeUndefined()
    expect(guard.env).toBeUndefined()
    expect(move.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"))).toBe(1)
    const ref = (name: string, repository = "smithersai/smithers", file = "npm-dist-tag.yml") => ({
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: name,
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/${file}@${name}`
    })
    expect(run(guard, ref("refs/heads/main")).status).toBe(0)
    for (
      const refused of [
        ref("refs/heads/feature"),
        ref("refs/heads/main-2"),
        ref("refs/tags/v1.0.0"),
        ref("refs/pull/7/merge"),
        ref("refs/heads/main", "fork/smithers"),
        ref("refs/heads/main", "smithersai/smithers", "release.yml"),
        {
          ...ref("refs/heads/main"),
          GITHUB_WORKFLOW_REF: "smithersai/smithers/.github/workflows/npm-dist-tag.yml@refs/heads/feature"
        },
        { GITHUB_REPOSITORY: "smithersai/smithers", GITHUB_REF: "refs/heads/main" },
        {}
      ]
    ) {
      const ran = run(guard, refused)
      expect(ran.status, JSON.stringify(refused)).toBe(1)
      expect(ran.stdout).toContain("::error::A dist-tag moves only from")
    }
  })

  // R2-Neon-D3-003: dist-tag-request.mjs, a script of the checkout, ran with NPM_TOKEN in its environment.
  it("gives the npm token to npm alone, after the checkout's one script has run without registry auth", () => {
    const script = move.steps.findIndex(runsRepositoryScript)
    expect(move.steps[script]?.run).toBe("node .smithers/flows/release/dist-tag-request.mjs")
    expect(move.steps.filter(runsRepositoryScript)).toHaveLength(1)
    // The job hands every step its inputs and no secret.
    expect(JSON.stringify(move.env)).not.toMatch(credential)
    // Up to and including that script: no credential in any environment, and no .npmrc that would send one.
    for (const step of move.steps.slice(0, script + 1)) {
      expect(JSON.stringify(step.env ?? {}), step.name ?? step.uses).not.toMatch(credential)
      expect(JSON.stringify(step.with ?? {}), step.name ?? step.uses).not.toMatch(/registry-url|token|secrets\./)
    }
    // After it: every step that talks to the registry carries the token, and runs npm and nothing of the checkout.
    const later = move.steps.slice(script + 1)
    const registry = later.findIndex((step) => step.with?.["registry-url"] !== undefined)
    const npm = later.filter((step) => /\bnpm (view|dist-tag)\b/.test(step.run ?? ""))
    expect(later[registry]?.with?.["registry-url"]).toBe("https://registry.npmjs.org")
    expect(npm.map((step) => step.name)).toEqual([
      "Check the registry",
      "Move the dist-tag",
      "Show the dist-tags after"
    ])
    for (const step of npm) {
      expect(later.indexOf(step), step.name).toBeGreaterThan(registry)
      expect(step.env, step.name).toEqual({ NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" })
    }
    const holders = move.steps.filter((step) => credential.test(JSON.stringify(step.env ?? {})))
    expect(holders).toEqual(npm)
  })
})

describe("release.yml", () => {
  const release = workflow("release")
  const validate = release.jobs["validate-source"] as Job
  const helper = release.jobs["native-helper"] as Job
  const publish = release.jobs["publish"] as Job
  const dispatch = { GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_TAG: "v1.0.0", DRY_RUN: "true" }
  const push = { GITHUB_EVENT_NAME: "push", RELEASE_TAG: "v1.0.0", DRY_RUN: "false" }
  const none = { SOURCE_REF: "", CANDIDATE_RUN_ID: "", CANDIDATE_ARTIFACT_ID: "" }

  // R1-Neon-D3-002: the helpers' Cargo build scripts ran on five runners before anything checked the source.
  it("builds the native helpers only from the commit it found on main, with no credentials kept", () => {
    expect(helper.needs).toBe("validate-source")
    expect(validate.needs).toBeUndefined()
    expect(validate.outputs).toEqual({ sha: "${{ steps.source.outputs.sha }}" })
    const checkout = helper.steps[0] as Step
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(checkout.with).toEqual({ ref: "${{ needs.validate-source.outputs.sha }}", "persist-credentials": false })
    // Nothing of the source runs in the job that validates it: its steps are the two checks and a checkout.
    expect(validate.steps.map((step) => step.name ?? step.uses?.split("@")[0])).toEqual([
      "Validate release inputs",
      "actions/checkout",
      "Require a release source on main"
    ])
    expect(validate.steps[1]?.with).toMatchObject({ "fetch-depth": 0, "persist-credentials": false })
  })

  it("checks a release's inputs as text before any of them names a checkout", () => {
    const inputs = stepOf(validate, "Validate release inputs")
    const sha = "a".repeat(40)
    expect(run(inputs, { ...push, ...none }).status).toBe(0)
    expect(run(inputs, { ...dispatch, ...none }).status).toBe(0)
    expect(run(inputs, { ...dispatch, ...none, SOURCE_REF: sha }).status).toBe(0)
    for (const tag of ["main", "refs/heads/x", "v", "vx", "v1.0.0; true", "v1.0.0 x", "v1.0.0\nx", "--upload-pack=x"]) {
      const ran = run(inputs, { ...push, ...none, RELEASE_TAG: tag })
      expect(ran.status, JSON.stringify(tag)).toBe(1)
      expect(ran.stderr).toContain("v<version> format")
    }
    for (const source of ["main", sha.slice(0, 12), `${sha}0`, "g".repeat(40), `${sha}; true`]) {
      const ran = run(inputs, { ...dispatch, ...none, SOURCE_REF: source })
      expect(ran.status, JSON.stringify(source)).toBe(1)
      expect(ran.stderr).toContain("full 40- or 64-character hexadecimal commit SHA")
    }
    // A sourceRef only rehearses: never on a tag push, never with dryRun off, never with an archived candidate.
    for (
      const refused of [
        { ...push, ...none, SOURCE_REF: sha },
        { ...dispatch, ...none, SOURCE_REF: sha, DRY_RUN: "false" },
        { ...dispatch, ...none, SOURCE_REF: sha, CANDIDATE_RUN_ID: "10" },
        { ...dispatch, ...none, SOURCE_REF: sha, CANDIDATE_ARTIFACT_ID: "20" }
      ]
    ) {
      const ran = run(inputs, refused)
      expect(ran.status).toBe(1)
      expect(ran.stderr).toContain("only for a fresh workflow_dispatch dry run")
    }
  })

  it("refuses, before any build, a tag or a sourceRef whose commit is not on main", () => {
    const source = stepOf(validate, "Require a release source on main")
    expect(source.id).toBe("source")
    const { directory, git, onMain, offMain } = repository()
    const output = join(directory, "..", `${directory.split("/").at(-1)}-output`)
    created.push(output)
    const at = (commit: string, env: Readonly<Record<string, string>>) => {
      git("checkout", "--quiet", "--detach", commit)
      writeFileSync(output, "")
      return run(source, { ...none, ...env, GITHUB_OUTPUT: output }, directory)
    }
    // A v* tag on main, by a push and by a dispatched releaseTag: the commit goes on to the jobs that build.
    for (const event of [push, dispatch]) {
      expect(at(git("rev-parse", "v1.0.0^{commit}"), event).status).toBe(0)
      expect(readFileSync(output, "utf8")).toBe(`sha=${onMain}\n`)
    }
    // A v* tag on a commit nobody merged, by either path: nothing is handed on.
    for (const event of [push, dispatch]) {
      const ran = at(git("rev-parse", "v6.6.6^{commit}"), { ...event, RELEASE_TAG: "v6.6.6" })
      expect(ran.status).toBe(1)
      expect(ran.stderr).toContain(`The release source ${offMain} must be reachable from origin/main.`)
      expect(readFileSync(output, "utf8")).toBe("")
    }
    // A sourceRef: the commit checked out is the one asked for, in either case of its digits, and is on main.
    expect(at(onMain, { ...dispatch, SOURCE_REF: onMain.toUpperCase() }).status).toBe(0)
    expect(at(offMain, { ...dispatch, SOURCE_REF: offMain }).status).toBe(1)
    const other = at(onMain, { ...dispatch, SOURCE_REF: offMain })
    expect(other.status).toBe(1)
    expect(other.stderr).toContain("does not match sourceRef")
    // No main to compare with is a refusal, never a pass.
    git("update-ref", "-d", "refs/remotes/origin/main")
    expect(at(onMain, push).status).toBe(1)
  })

  // R1-Neon-D3-002, R1-Fable-D3-013: only a sourceRef rehearsal was compared with main; a tag push published any commit.
  it("refuses, in the job that publishes, a tag whose commit is not on main, before any script of the source runs", () => {
    const names = publish.steps.map((step) => step.name ?? step.uses?.split("@")[0])
    const verify = stepOf(publish, "Verify explicit dry-run source")
    const reviewed = stepOf(publish, "Require a reviewed workflow ref for publication")
    const order = ["actions/checkout", verify.name, reviewed.name, "Install pinned Rust toolchain"].map((name) =>
      names.indexOf(name)
    )
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(order[0]).toBeGreaterThan(-1)
    // Before the two guards, the job runs no script of the repository's: every earlier step is inline text or the
    // checkout.
    for (const step of publish.steps.slice(0, order[2])) {
      expect(step.uses === undefined || step.uses.startsWith("actions/checkout@"), step.name).toBe(true)
      expect(step.run ?? "", step.name).not.toMatch(/\b(node|pnpm|npm|cargo|bash|sh) [^\n]*\.(mjs|js|ts|sh)\b/)
    }
    expect(verify.if).toBeUndefined()
    expect(reviewed.if).toBeUndefined()
    expect(publish.needs).toEqual(["validate-source", "native-helper"])

    const { directory, git, onMain, offMain } = repository()
    const at = (commit: string, env: Readonly<Record<string, string>>) => {
      git("checkout", "--quiet", "--detach", commit)
      return run(verify, { ...none, ...env }, directory)
    }
    for (const event of [push, dispatch, { ...dispatch, DRY_RUN: "false" }]) {
      expect(at(onMain, event).status).toBe(0)
      const ran = at(offMain, { ...event, RELEASE_TAG: "v6.6.6" })
      expect(ran.status).toBe(1)
      expect(ran.stderr).toContain("a tag off main publishes nothing")
    }
    expect(at(onMain, { ...dispatch, SOURCE_REF: onMain }).status).toBe(0)
    expect(at(offMain, { ...dispatch, SOURCE_REF: offMain }).stderr).toContain(
      "sourceRef must be reachable from origin/main"
    )
  })

  // R2-Astra-D3-001, R2-Neon-D3-006: publish resolved the tag again, so a tag moved between two commits of main
  // packed one commit's packages with the helpers built from the other.
  it("packs and installs only the commit the helpers were built from, and stops when the tag has moved off it", () => {
    const installer = release.jobs["installer-archive"] as Job
    const pinned = "${{ needs.validate-source.outputs.sha }}"
    expect(publish.needs).toEqual(["validate-source", "native-helper"])
    expect(installer.needs).toEqual(["validate-source", "candidate-result"])
    const checkouts = (job: Job) => job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"))
    for (const job of [helper, publish, installer]) {
      expect(checkouts(job).map((step) => step.with?.["ref"])).toEqual([pinned])
    }
    const names = publish.steps.map((step) => step.name ?? step.uses?.split("@")[0])
    const guard = stepOf(publish, "Require the validated release source")
    expect(guard.if).toBeUndefined()
    expect(guard.env).toEqual({ VALIDATED_SHA: pinned })
    // Straight after the checkout, so before anything is installed, built or packed.
    expect(names.indexOf(guard.name)).toBe(names.indexOf("actions/checkout") + 1)
    expect(names.indexOf(guard.name)).toBeLessThan(names.indexOf("Pack and smoke-test release artifacts"))

    const { directory, git, onMain, offMain } = repository()
    const tip = git("rev-parse", "refs/remotes/origin/main")
    const at = (commit: string, env: Readonly<Record<string, string>>) => {
      git("checkout", "--quiet", "--detach", commit)
      return run(guard, { ...none, ...env }, directory)
    }
    // The tag still names the validated commit, and that commit is the one checked out.
    for (const event of [push, dispatch, { ...dispatch, DRY_RUN: "false" }]) {
      expect(at(onMain, { ...event, VALIDATED_SHA: onMain }).status).toBe(0)
    }
    // An annotated tag is compared by the commit it peels to.
    git("-c", "user.name=a", "-c", "user.email=a@example.invalid", "tag", "-a", "-m", "release", "v2.0.0", onMain)
    expect(git("rev-parse", "v2.0.0")).not.toBe(onMain)
    expect(at(onMain, { ...push, RELEASE_TAG: "v2.0.0", VALIDATED_SHA: onMain }).status).toBe(0)
    // A checkout that is some other commit, whatever the tag says.
    const elsewhere = at(tip, { ...push, VALIDATED_SHA: onMain })
    expect(elsewhere.status).toBe(1)
    expect(elsewhere.stderr).toContain(`The checked-out source ${tip} is not the validated release source ${onMain}.`)
    // The tag moved from one commit of main to another after validate-source ran: both are on main, and nothing packs.
    git("tag", "--force", "v1.0.0", tip)
    const moved = at(onMain, { ...push, VALIDATED_SHA: onMain })
    expect(moved.status).toBe(1)
    expect(moved.stderr).toContain(`The release tag v1.0.0 moved to ${tip} after ${onMain} was validated`)
    // A sourceRef rehearsal names a commit and has no tag to compare, but its checkout is still the validated one.
    expect(at(onMain, { ...dispatch, SOURCE_REF: onMain, VALIDATED_SHA: onMain }).status).toBe(0)
    expect(at(tip, { ...dispatch, SOURCE_REF: onMain, VALIDATED_SHA: onMain }).status).toBe(1)
    // A deleted tag, and a run that was handed no commit, are refusals.
    git("tag", "--delete", "v1.0.0")
    const deleted = at(onMain, { ...push, VALIDATED_SHA: onMain })
    expect(deleted.status).toBe(1)
    expect(deleted.stderr).toContain("The release tag v1.0.0 no longer exists")
    for (const sha of ["", "v6.6.6", offMain.slice(0, 12)]) {
      const ran = at(offMain, { ...push, RELEASE_TAG: "v6.6.6", VALIDATED_SHA: sha })
      expect(ran.status, JSON.stringify(sha)).toBe(1)
      expect(ran.stderr).toContain("validate-source handed on no commit SHA")
    }
  })

  // R1-Fable-D3-013: a dispatch from a branch runs that branch's copy of this file, with the npm credentials.
  it("publishes only from the release tag's or main's copy of the workflow, and rehearses from anywhere", () => {
    const reviewed = stepOf(publish, "Require a reviewed workflow ref for publication")
    const ref = (name: string, repository = "smithersai/smithers", file = "release.yml") => ({
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: name,
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/${file}@${name}`
    })
    const real = { ...push, ...none }
    expect(run(reviewed, { ...real, ...ref("refs/tags/v1.0.0") }).status).toBe(0)
    expect(run(reviewed, { ...real, GITHUB_EVENT_NAME: "workflow_dispatch", ...ref("refs/heads/main") }).status).toBe(0)
    for (
      const refused of [
        ref("refs/heads/feature"),
        ref("refs/tags/v9.9.9"),
        ref("refs/heads/main-2"),
        ref("refs/pull/7/merge"),
        ref("refs/tags/v1.0.0", "fork/smithers"),
        ref("refs/tags/v1.0.0", "smithersai/smithers", "other.yml"),
        {
          ...ref("refs/tags/v1.0.0"),
          GITHUB_WORKFLOW_REF: "smithersai/smithers/.github/workflows/release.yml@refs/heads/feature"
        }
      ]
    ) {
      const ran = run(reviewed, { ...real, ...refused })
      expect(ran.status, JSON.stringify(refused)).toBe(1)
      expect(ran.stderr).toContain("Publication runs only from")
    }
    // A dry run and a sourceRef rehearsal publish nothing, so any ref may start one.
    expect(run(reviewed, { ...dispatch, ...none, ...ref("refs/heads/feature") }).status).toBe(0)
    expect(
      run(reviewed, {
        ...dispatch,
        ...none,
        SOURCE_REF: "a".repeat(40),
        DRY_RUN: "false",
        ...ref("refs/heads/feature")
      }).status
    )
      .toBe(0)
    // And the publish step itself still never runs for either.
    expect(stepOf(publish, "Publish packages in dependency order").if).toBe(
      "env.DRY_RUN != 'true' && !inputs.sourceRef && matrix.lane != 'gates'"
    )
  })
})
