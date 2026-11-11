/**
 * The `runner` placement: an issue's agent is an external agent job on a local Smithers runner. The end-to-end test
 * runs the placement's two steps on their own engine against a real `smthrs runner serve` process over a real jj
 * mirror, with the deterministic ACP test agent as the runner's profile, and records the job's files as one change in
 * a real host workspace. Nothing in this flow names a vendor CLI: the profile is the runner's.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as RunnerJobs from "@smthrs/cli/RunnerJobs"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { RecordRunnerWork, Report, RunnerFix, runnerFixWith, runnerTask, writeChanges } from "../work/flow.ts"

const SMITHERS = fileURLToPath(new URL("../../../../packages/smithers/", import.meta.url))
const AGENT = join(SMITHERS, "agent/test/fixtures/acp-test-agent.mjs")
const BIN = join(SMITHERS, "bin/smithers.mjs")
const REPOSITORY = "github/acme/app"
const text = { title: "Notes lack alpha", body: "add the line `alpha` to `NOTES.md`", comments: [] }

test("a runner job is the issue's brief at the workspace's base, on the operator's profile", () => {
  const task = runnerTask({
    repo: "o/r",
    issue: 7,
    text,
    base: "a".repeat(40),
    runner: { profile: "claude-pool", repository: REPOSITORY }
  })
  assert.deepEqual(task.agent, { name: "issue-sweep", labels: [], profile: "claude-pool", maxHours: 2, restarts: 1 })
  assert.equal(task.repository, REPOSITORY)
  assert.equal(task.base, "a".repeat(40))
  assert.deepEqual(task.context, { issue: "o/r#7" })
  // The runner's checkout has no dependencies installed; the brief says so instead of claiming they are.
  assert.match(task.prompt, /pnpm install --frozen-lockfile --prefer-offline/)
  assert.doesNotMatch(task.prompt, /with dependencies installed/)
  assert.match(task.prompt, /<issue title="Notes lack alpha">\nadd the line `alpha` to `NOTES.md`/)
})

test("a runner change that names a path outside the workspace, or its store, writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-runner-paths-"))
  try {
    for (const path of ["../escape.txt", ".jj/repo/x", ".git/config", "/etc/passwd"]) {
      const exit = await Effect.runPromiseExit(
        writeChanges(root, { additions: [{ path: "ok.txt", contents: "b2sK" }, { path, contents: "" }], deletions: [] })
      )
      assert.ok(Exit.isFailure(exit), path)
      assert.ok(JSON.stringify(exit.cause).includes("outside the workspace"), path)
      assert.equal(existsSync(join(root, "ok.txt")), false, path)
    }
    await Effect.runPromise(
      writeChanges(root, { additions: [{ path: "a/b.txt", contents: "b2sK" }], deletions: ["gone.txt"] })
    )
    assert.equal(readFileSync(join(root, "a/b.txt"), "utf8"), "ok\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The placement's steps as the work flow runs them, minus the issue read and the workspace preparation. */
const Caller = Flow.make("issue-sweep/test/runner-caller", {
  payload: { base: Schema.String, directory: Schema.String },
  success: Report,
  error: Schema.Union([RunnerFix.errorSchema, RecordRunnerWork.errorSchema]),
  body: ({ base, directory }) =>
    RunnerFix.call({ repo: "o/r", issue: 7, text, base, runner: { profile: "test-agent", repository: REPOSITORY } })
      .pipe(
        Node.bindPlanned((result) =>
          RecordRunnerWork.call({
            issue: 7,
            title: text.title,
            profile: "test-agent",
            workspace: { directory, base },
            result
          })
        )
      )
})

test("an issue fixed on a real runner lands in the host workspace as one change on its base", {
  timeout: 240_000
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-runner-"))
  const saved = process.env.JJ_CONFIG
  const children: Array<ChildProcess> = []
  t.after(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // Gone already.
      }
    }
    if (saved === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = saved
    rmSync(root, { recursive: true, force: true })
  })
  const jjConfig = join(root, "jj.toml")
  writeFileSync(jjConfig, "[user]\nname = \"t\"\nemail = \"t@t\"\n")
  // work/flow.ts runs jj with this process's environment.
  process.env.JJ_CONFIG = jjConfig
  const cmd = (cwd: string, command: string, ...args: Array<string>) =>
    execFileSync(command, args, { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] })
  const seed = join(root, "seed")
  cmd(root, "git", "init", "-q", "-b", "main", seed)
  writeFileSync(join(seed, "README.md"), "hello\n")
  cmd(seed, "git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A")
  cmd(seed, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first")
  const base = cmd(seed, "git", "rev-parse", "HEAD").trim()
  cmd(root, "git", "clone", "-q", "--bare", seed, join(root, "origin.git"))
  const host = join(root, "host")
  const mirror = join(root, "mirror")
  cmd(root, "jj", "git", "clone", "--colocate", "--quiet", join(root, "origin.git"), host)
  cmd(root, "jj", "git", "clone", "--quiet", join(root, "origin.git"), mirror)
  const directory = join(root, "issue-7")
  cmd(host, "jj", "workspace", "add", directory, "--name", "issue-7", "-r", base)

  const agentState = join(root, "agent-state")
  mkdirSync(agentState)
  const configPath = join(root, "runner.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "test-runner",
      capacity: 1,
      stateDir: join(root, "state"),
      heartbeatSeconds: 1,
      pollSeconds: 1,
      admission: { loadPerCpu: 1000, diskFloorGb: 0 },
      repositories: { [REPOSITORY]: { mirror } },
      profiles: { "test-agent": { argv: [process.execPath, AGENT], env: { ACP_TEST_AGENT_STATE: agentState } } }
    })
  )
  let log = ""
  const daemon = spawn(process.execPath, [BIN, "runner", "serve", "--config", configPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  daemon.stdout!.on("data", (chunk) => (log += chunk))
  daemon.stderr!.on("data", (chunk) => (log += chunk))
  children.push(daemon)

  const engine = Layer.mergeAll(runnerFixWith(RunnerJobs.layer(configPath)), Interpreter.layer(Caller)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  const exit = await Effect.runPromiseExit(
    Caller.execute({ base, directory }, { executionId: "sweep/7" }).pipe(Effect.provide(engine))
  )
  assert.ok(Exit.isSuccess(exit), `${JSON.stringify(exit)}\n${log}`)
  const report = exit.value
  assert.equal(report.agent, "runner")
  assert.equal(report.account, "test-agent")
  assert.equal(report.base, base)
  assert.match(report.patch, /\+alpha/)
  const jjHost = (...args: Array<string>) => cmd(host, "jj", "--ignore-working-copy", ...args)
  assert.equal(jjHost("log", "--no-graph", "-r", `${report.change}-`, "-T", "commit_id").trim(), base)
  assert.match(jjHost("log", "--no-graph", "-r", report.change, "-T", "description"), /\(#7\)/)
  assert.equal(jjHost("file", "show", "-r", report.change, "NOTES.md"), "alpha\n")
})
