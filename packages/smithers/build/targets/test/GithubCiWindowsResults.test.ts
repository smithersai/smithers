/** A Windows matrix must use the shell that expands its result-file paths. */
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import * as Yaml from "yaml"
import * as CiToolchain from "../src/CiToolchain.ts"
import * as GithubCiGen from "../src/GithubCiGen.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Verb from "../src/Verb.ts"

// The case runs every generated gate step as a real process: 11 s alone on an
// idle host, 17 s pinned to one core, 8.5 s inside the full suite on two cores,
// and over the 30 s suite default inside the release gates job, which runs two
// targets at once on 4 vCPUs (dry run 43293593020). 90 s is five times the
// slowest local run.
it("runs generated Windows matrix gates and retains distinct passing and failing receipts", async () => {
  const runtime = Runtime.Node({ version: ">=26.4.0" })
  const packageManager = PackageManager.Pnpm({ version: "11.25.0", runtime })
  const workflow = Yaml.parse(GithubCiGen.render({
    packageManager,
    workflowName: "Windows results",
    pushBranches: ["main"],
    pullRequest: true,
    workflowDispatch: false,
    cancelInProgress: false,
    requiredJobs: [],
    gates: [],
    results: true,
    output: ".github/workflows/ci.yml",
    mode: "write",
    jobs: [{
      id: "packages",
      matrix: [{ os: "ubuntu-latest", advisory: false }, { os: "macos-latest", advisory: true }, {
        os: "windows-latest",
        advisory: true
      }],
      toolchain: CiToolchain.Needs({ runtimes: [CiToolchain.Node({ runtime, release: "26.4.0" })] }),
      steps: [
        { name: "Passing gate", verb: Verb.Test, pattern: "//:pass" },
        { name: "Failing gate", verb: Verb.Test, pattern: "//:fail" }
      ]
    }]
  }))
  const steps = workflow.jobs.packages.steps as Array<
    { name?: string; shell?: string; run?: string; env?: Record<string, string> }
  >
  const gates = steps.filter((step) => step.name?.endsWith("gate"))
  expect(gates).toHaveLength(2)
  // Without this, GitHub selects pwsh on Windows: $RUNNER_TEMP and
  // $GITHUB_ACTION are unset PowerShell variables, not environment variables.
  for (const step of gates) {
    expect(step.shell).toBe("bash")
    expect(step.env?.["MSYS2_ARG_CONV_EXCL"]).toBe("//")
  }

  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(tmpdir(), "ci results ")))
  const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
  try {
    await Fs.writeFile(Path.join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await Fs.writeFile(Path.join(root, "yarn.lock"), "# yarn lockfile v1\n")
    // Like the repository's gates, this fixture must use the installed tree.
    // pnpm's default dependency check would reinstall through the shared symlink.
    await Fs.writeFile(Path.join(root, "pnpm-workspace.yaml"), "verifyDepsBeforeRun: false\n")
    await Fs.symlink(Path.join(repository, "node_modules"), Path.join(root, "node_modules"), "junction")
    // Generated gates invoke the repository CLI path, not the ambient pnpm bin.
    await Fs.mkdir(Path.join(root, "packages", "smithers"), { recursive: true })
    await Fs.symlink(
      Path.join(repository, "packages", "smithers", "bin"),
      Path.join(root, "packages", "smithers", "bin"),
      "junction"
    )
    await Fs.writeFile(
      Path.join(root, "WORKSPACE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("ci-results", {
  repository: "git+https://example.invalid/ci-results.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})`
    )
    await Fs.writeFile(
      Path.join(root, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  pass: S.Shell.Test({ shell: "exit 0" }),
  fail: S.Shell.Test({ shell: "exit 17" })
} })`
    )
    const initialized = spawnSync("jj", ["git", "init", root], { encoding: "utf8" })
    expect(initialized.status, initialized.stderr).toBe(0)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TMPDIR|TEMP|TMP|NODE_COMPILE_CACHE)$/i.test(key)
      )
    )
    const runnerTemp = Path.join(root, "runner temp")
    const execute = (step: typeof steps[number], action: string) =>
      spawnSync(step.shell!, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run!], {
        cwd: root,
        env: { ...env, ...step.env, RUNNER_TEMP: runnerTemp, GITHUB_ACTION: action },
        encoding: "utf8"
      })
    const marker = steps.find((step) => step.name === "Start smthrs results")!
    expect(execute(marker, "marker").status).toBe(0)
    for (const [index, step] of gates.entries()) {
      const action = `gate_${index}`
      const result = execute(step, action)
      expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(index === 0 ? 0 : 1)
      const receipt = JSON.parse(await Fs.readFile(Path.join(runnerTemp, "smthrs-results", `${action}.json`), "utf8"))
      expect(receipt.results).toEqual([expect.objectContaining({
        label: index === 0 ? "//:pass" : "//:fail",
        status: index === 0 ? "ran" : "failed"
      })])
    }
    expect((await Fs.readdir(Path.join(runnerTemp, "smthrs-results"))).sort())
      .toEqual(["attempt.json", "gate_0.json", "gate_1.json"])
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}, 90_000)
