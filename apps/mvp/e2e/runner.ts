import { type APIRequestContext, expect, type Page, request as requests, test } from "@playwright/test"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { baseURL, writeHeaders } from "./target"

// An external agent on a runner this machine runs (decision 0136, docs/features/agent-runners.md), as a repository's
// Admin sets one up: the spec registers a runner and names the repository's coding agent, then starts the runner
// itself (`smthrs runner serve`) with the deterministic ACP test agent as the profile's command, so a TODO's prompt
// is the agent's script (packages/smithers/agent/test/fixtures/acp-test-agent.mjs): `add the line \`X\` to \`F\``.
// The `agentRunner` need (e2e/target.ts) says where it may: a scratch repository the test account administers,
// E2E_FACTORY_REPOSITORY, with E2E_RUNNER_MIRROR naming a jj clone of it.

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const smthrs = join(root, "packages/smithers/bin/smithers.mjs")
const testAgent = join(root, "packages/smithers/agent/test/fixtures/acp-test-agent.mjs")

/**
 * An Admin's write to the repository's runners or agents, in the signed-in person's session. Answers the execution whose
 * receipt says how it ended: a 202 means only that its flow started.
 */
export const adminWrite = async (api: APIRequestContext, repo: string, path: string, method: "PUT" | "DELETE", body?: unknown) => {
  const response = await api.fetch(new URL(`/api/repos/${repo}/${path}`, baseURL).href, {
    method,
    headers: writeHeaders(),
    ...(body === undefined ? {} : { data: body }),
  })
  expect(response.status(), `${method} ${path}`).toBe(202)
  return ((await response.json()) as { readonly execution: string }).execution
}

/**
 * The environment a runner machine has: this one's, without what Playwright adds for its own workers. Its
 * NODE_OPTIONS registers VibeLang's loader (playwright.config.ts), which every node the runner starts, its agents
 * included, would then load from their checkout and fail on ("Cannot find package 'vibelang'").
 */
export const runnerEnv = (env: NodeJS.ProcessEnv = process.env, url = baseURL): NodeJS.ProcessEnv => {
  const { NODE_OPTIONS: _options, NODE_PATH: _path, PLAYWRIGHT_TEST: _test, TEST_WORKER_INDEX: _worker, TEST_PARALLEL_INDEX: _parallel, ...rest } = env
  return { ...rest, NODE_TLS_REJECT_UNAUTHORIZED: new URL(url).hostname === "localhost" ? "0" : "1" }
}

/** A runner this spec started for `repo`, and the coding agent it serves. */
export interface Runner {
  readonly name: string
  /** The runner's state directory; the test agent keeps its own state in `agent` under it. */
  readonly state: string
  /** What the runner wrote so far, for a failing test's attachment. */
  readonly log: () => string
  /** Keeps the runner's log in the test's results, on disk at once: a run killed later still has it. */
  readonly attach: () => Promise<void>
  /** The machine dies: the runner's process ends at once, with nothing said to the app. */
  readonly kill: () => void
  /**
   * The session on a request context of the runner's own, for cleanup: a test out of time has closed its page, and
   * what it left behind must still go.
   */
  readonly api: APIRequestContext
  /** The repository codes with Smithers' own agent again, the runner is retired, and its process and state go. */
  readonly stop: () => Promise<void>
}

/** Every step of a test's cleanup, whichever failed: the first one's error must not leave a runner claiming jobs. */
export const cleanUp = async (...steps: ReadonlyArray<() => Promise<unknown>>) => {
  for (const step of steps) await step().catch((error: unknown) => console.error(`cleanup: ${String(error)}`))
}

/**
 * Registers a runner for `repo` that runs `capacity` jobs at once, makes its ACP test agent the repository's coding
 * agent, and starts it. `word` makes its name unique to the run; `origin` is where the runner reaches the app (its own
 * unless set, such as a spec's relay). The caller stops it in a `finally`.
 */
export const startRunner = async (
  page: Page,
  repo: string,
  word: string,
  capacity: number,
  options: { readonly origin?: string; readonly heartbeatSeconds?: number; readonly mirror?: string } = {},
): Promise<Runner> => {
  const state = mkdtempSync(join(tmpdir(), "agent-runner-e2e-"))
  const name = `e2e-${word}`
  const output: Array<Buffer> = []
  const agentErrors = join(state, "agent.stderr")
  const api = await requests.newContext({ baseURL, storageState: await page.context().storageState(), ignoreHTTPSErrors: test.info().project.use.ignoreHTTPSErrors })
  let runner: ChildProcess | undefined
  // Whatever ends this worker, the runner ends with it: alive with no one reading it, it would claim another test's job
  // and die on its first log line, holding that job for the agent's hours.
  const orphaned = () => runner?.kill("SIGKILL")
  process.once("exit", orphaned)
  const stop = async () => {
    await adminWrite(api, repo, `agents/${name}`, "DELETE").catch(() => undefined)
    await adminWrite(api, repo, `runners/${name}`, "DELETE").catch(() => undefined)
    process.off("exit", orphaned)
    if (runner !== undefined && runner.exitCode === null && runner.signalCode === null) {
      // A service manager's stop: SIGTERM, then SIGKILL if it hasn't exited in 30 s.
      const exited = new Promise((done) => runner!.once("exit", done))
      runner.kill("SIGTERM")
      const killed = setTimeout(() => runner!.kill("SIGKILL"), 30_000)
      await exited
      clearTimeout(killed)
    }
    rmSync(state, { recursive: true, force: true })
    await api.dispose()
  }
  try {
    // The CLI's JSON answer: its text form adds a `sha256:` label and any notices to the hash.
    const token = execFileSync(process.execPath, [smthrs, "runner", "token", "--state", state, "--format", "json"], { encoding: "utf8" })
    const sha = (JSON.parse(token) as { sha256: string }).sha256
    await adminWrite(api, repo, `runners/${name}`, "PUT", { tokenSha256: sha, labels: ["e2e"], capacity })
    await adminWrite(api, repo, `agents/${name}`, "PUT", { labels: ["e2e"], profile: "acp-test", coding: true })
    // A 202 means `admin/SetAgent` started. A TODO committed before it writes reads no agent and takes its committer's
    // connection instead: production's write landed 2 to 6 s after its 202, and one lane of ten lost that race.
    await expect.poll(async () => {
      const response = await api.get(new URL(`/api/repos/${repo}/agents/${name}`, baseURL).href)
      return response.status() === 200 ? ((await response.json()) as { readonly coding: boolean }).coding : false
    }, { timeout: 60_000 }).toBe(true)
    const config = {
      origin: options.origin ?? new URL(baseURL).origin,
      name,
      capacity,
      stateDir: state,
      ...(options.heartbeatSeconds === undefined ? {} : { heartbeatSeconds: options.heartbeatSeconds }),
      // The test machine's own load mustn't hold its claims (decision 0144).
      admission: { loadPerCpu: 1000, diskFloorGb: 0 },
      // A mirror that doesn't exist yet is cloned with the host's read credential (decision 0148).
      repositories: { [`github/${repo.toLowerCase()}`]: { mirror: options.mirror ?? process.env.E2E_RUNNER_MIRROR! } },
      // The runner drops its agent's stderr; the shell keeps it beside the state, for the log.
      profiles: {
        "acp-test": {
          argv: ["/bin/sh", "-c", 'exec "$0" "$1" 2>>"$2"', process.execPath, testAgent, agentErrors],
          env: { ACP_TEST_AGENT_STATE: join(state, "agent") },
        },
      },
    }
    writeFileSync(join(state, "runner.json"), JSON.stringify(config))
    runner = spawn(process.execPath, [smthrs, "runner", "serve", "--config", join(state, "runner.json")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: runnerEnv(),
    })
    // Its log lines go to stdout, its errors to stderr: both, in order, for a failing test's attachment.
    runner.stdout!.on("data", (chunk: Buffer) => output.push(chunk))
    runner.stderr!.on("data", (chunk: Buffer) => output.push(chunk))
  } catch (error) {
    await stop()
    throw error
  }
  const agentLog = () => {
    try {
      return readFileSync(agentErrors, "utf8")
    } catch {
      return ""
    }
  }
  const log = () => `${Buffer.concat(output).toString()}\n--- the agent's stderr ---\n${agentLog()}`
  return {
    name,
    state,
    log,
    api,
    attach: async () => {
      const path = test.info().outputPath("runner.log")
      writeFileSync(path, log())
      await test.info().attach("runner.log", { path, contentType: "text/plain" })
    },
    kill: () => void runner!.kill("SIGKILL"),
    stop,
  }
}
