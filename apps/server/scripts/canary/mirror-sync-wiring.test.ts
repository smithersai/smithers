/*
 * The mirror-sync gate: the workflow that keeps the Smithers Cloud mirror on
 * main pushes to the mirror the Worker actually reads, never forces, never
 * puts the credential in a URL, and skips honestly when the secret is unset.
 *
 * The mirror name is read from the catalog (publicRepoCatalog.ts), never
 * restated here: a catalog rename that leaves the workflow pushing to the old
 * namespace is exactly the drift this file exists to catch.
 */
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AVAILABLE_REPOS } from "../../src/publicRepoCatalog"

const workflowPath = fileURLToPath(new URL("../../../../.github/workflows/mirror-sync.yml", import.meta.url))
const source = readFileSync(workflowPath, "utf8")

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly if?: unknown
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}

interface Workflow {
  readonly on: { readonly push?: { readonly branches?: ReadonlyArray<string> }; readonly pull_request?: unknown }
  readonly permissions: Record<string, string>
  readonly concurrency: { readonly group: string; readonly "cancel-in-progress": boolean }
  readonly jobs: Record<string, { readonly if?: unknown; readonly steps: ReadonlyArray<Step> }>
}

const workflow = Bun.YAML.parse(source) as Workflow
const jobs = Object.values(workflow.jobs)
const steps = jobs.flatMap((job) => job.steps)
const push = steps.find((step) => typeof step.run === "string" && step.run.includes("git ") && step.run.includes("push"))

function runPush(failure: string, token = "test-token") {
  const directory = mkdtempSync(join(tmpdir(), "mirror-sync-"))
  const attempts = join(directory, "attempts")
  const delays = join(directory, "delays")
  try {
    writeFileSync(attempts, "0")
    writeFileSync(delays, "")
    // Execute the workflow's shell with a fake transport, never a real push.
    writeFileSync(join(directory, "git"), `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  echo test-head
  exit 0
fi
attempt=$(cat "$MIRROR_TEST_ATTEMPTS")
attempt=$((attempt + 1))
echo "$attempt" > "$MIRROR_TEST_ATTEMPTS"
case "$MIRROR_TEST_FAILURE" in
  rejected) echo '! [rejected] main -> main (non-fast-forward)' >&2; exit 1 ;;
  401) echo 'fatal: The requested URL returned error: 401' >&2; exit 128 ;;
  persistent) echo 'fatal: The requested URL returned error: 500' >&2; exit 128 ;;
esac
if [ "$attempt" -eq 1 ]; then
  echo "fatal: The requested URL returned error: $MIRROR_TEST_FAILURE" >&2
  exit 128
fi
echo 'main -> main'
`, { mode: 0o755 })
    writeFileSync(join(directory, "sleep"), '#!/bin/sh\necho "$1" >> "$MIRROR_TEST_DELAYS"\n', { mode: 0o755 })
    // Keep this Linux workflow portable to developer machines with BSD base64.
    writeFileSync(join(directory, "base64"), '#!/bin/sh\ncat > /dev/null\necho test-header\n', { mode: 0o755 })
    const result = Bun.spawnSync({
      cmd: ["bash", "-eo", "pipefail", "-c", push?.run ?? ""],
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        SMITHERS_CLOUD_MIRROR_TOKEN: token,
        MIRROR_URL: "https://mirror.invalid/repo.git",
        MIRROR_TEST_ATTEMPTS: attempts,
        MIRROR_TEST_DELAYS: delays,
        MIRROR_TEST_FAILURE: failure,
      },
      timeout: 10_000,
    })
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      attempts: Number(readFileSync(attempts, "utf8")),
      delays: readFileSync(delays, "utf8").trim(),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("mirror-sync.yml keeps the Cloud mirror on main", () => {
  it("runs on a push to main and on nothing else", () => {
    expect(workflow.on.push?.branches).toEqual(["main"])
    expect(workflow.on.pull_request).toBeUndefined()
    expect(Object.keys(workflow.on)).toEqual(["push"])
  })

  it("holds a read-only token and serializes runs without cancelling one", () => {
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.concurrency).toEqual({ group: "mirror-sync", "cancel-in-progress": false })
  })

  it("checks out the full history the push transfers", () => {
    const checkout = steps.find((step) => /^actions\/checkout@/.test(step.uses ?? ""))
    expect(checkout?.with).toEqual({ "fetch-depth": 0 })
  })

  it("pushes HEAD to main of the mirror the Worker serves signed out", () => {
    const smithers = AVAILABLE_REPOS.find((repo) => repo.name === "smithersai/smithers")
    expect(smithers).toBeDefined()
    expect(push).toBeDefined()
    expect(push?.env?.MIRROR_URL).toBe(`https://api.jjhub.tech/${smithers?.cloudRepo}.git`)
    expect(push?.run).toMatch(/push "\$MIRROR_URL" HEAD:refs\/heads\/main/)
  })

  it("never forces and never carries the token in the remote URL", () => {
    expect(push?.run).not.toMatch(/--force|\s-f\s|\+refs\/|force-with-lease/)
    expect(push?.run).not.toMatch(/@api\.jjhub\.tech/)
    expect(push?.env?.SMITHERS_CLOUD_MIRROR_TOKEN).toBe("${{ secrets.SMITHERS_CLOUD_MIRROR_TOKEN }}")
  })

  it("masks the derived Basic header before any command can echo it", () => {
    // Actions redacts a secret's own value, never a value derived from it, and
    // this repository's logs are world-readable. The base64 of
    // `x-access-token:<token>` is a write credential for the mirror, so it is
    // registered with ::add-mask:: between the line that builds it and the
    // first command that receives it.
    const run = push?.run ?? ""
    const built = run.indexOf("authorization=")
    const mask = run.indexOf("::add-mask::$authorization")
    const used = run.indexOf("git -c")
    expect(built).toBeGreaterThanOrEqual(0)
    expect(mask).toBeGreaterThan(built)
    expect(used).toBeGreaterThan(mask)
  })

  it("skips with a notice naming the secret when it is unset, and fails a rejected push", () => {
    const run = push?.run ?? ""
    const guard = run.indexOf('[ -z "$SMITHERS_CLOUD_MIRROR_TOKEN" ]')
    const notice = run.indexOf("::notice")
    const exit = run.indexOf("exit 0")
    const command = run.indexOf("git ")
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(notice).toBeGreaterThan(guard)
    expect(run.slice(notice, exit)).toContain("SMITHERS_CLOUD_MIRROR_TOKEN")
    expect(exit).toBeGreaterThan(notice)
    expect(command).toBeGreaterThan(exit)
    // A rejected push must redden the run: no `|| true`, no `continue-on-error`.
    expect(run).not.toContain("|| true")
    expect(source).not.toContain("continue-on-error")
    for (const job of jobs) expect(job.if).toBeUndefined()
    for (const step of steps) expect(step.if).toBeUndefined()
  })

  it.each(["500", "502", "503", "504"])("recovers from a transient HTTP %s without claiming early success", (status) => {
    const result = runPush(status)
    expect(result.exitCode).toBe(0)
    expect(result.attempts).toBe(2)
    expect(result.delays).toBe("10")
    expect(result.output.indexOf("retrying")).toBeLessThan(result.output.indexOf("Pushed test-head"))
    expect(result.output).not.toContain("test-token")
  })

  it("fails persistent proxy errors after four attempts", () => {
    const result = runPush("persistent")
    expect(result.exitCode).toBe(128)
    expect(result.attempts).toBe(4)
    expect(result.delays).toBe("10\n20\n30")
    expect(result.output).not.toContain("Pushed test-head")
  })

  it.each(["401", "rejected"])("fails %s immediately", (failure) => {
    const result = runPush(failure)
    expect(result.exitCode).not.toBe(0)
    expect(result.attempts).toBe(1)
    expect(result.delays).toBe("")
    expect(result.output).not.toContain("Pushed test-head")
  })

  it("makes no push attempt when the token is missing", () => {
    const result = runPush("500", "")
    expect(result.exitCode).toBe(0)
    expect(result.attempts).toBe(0)
    expect(result.output).toContain("::notice title=Mirror sync skipped::")
    expect(result.output).not.toContain("Pushed test-head")
  })
})
