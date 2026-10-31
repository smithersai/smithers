import { expect, type Page } from "@playwright/test"
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

/** An Admin's write to the repository's runners or agents, as the signed-in page. */
const adminWrite = async (page: Page, repo: string, path: string, method: "PUT" | "DELETE", body?: unknown) => {
  const response = await page.request.fetch(new URL(`/api/repos/${repo}/${path}`, baseURL).href, {
    method,
    headers: writeHeaders(),
    ...(body === undefined ? {} : { data: body }),
  })
  expect(response.status(), `${method} ${path}`).toBe(202)
}

/**
 * The environment a runner machine has: this one's, without what Playwright adds for its own workers. Its
 * NODE_OPTIONS registers VibeLang's loader (playwright.config.ts), which every node the runner starts, its agents
 * included, would then load from their checkout and fail on ("Cannot find package 'vibelang'").
 */
export const runnerEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { NODE_OPTIONS: _options, NODE_PATH: _path, PLAYWRIGHT_TEST: _test, TEST_WORKER_INDEX: _worker, TEST_PARALLEL_INDEX: _parallel, ...rest } = env
  return { ...rest, NODE_TLS_REJECT_UNAUTHORIZED: new URL(baseURL).hostname === "localhost" ? "0" : "1" }
}

/** A runner this spec started for `repo`, and the coding agent it serves. */
export interface Runner {
  readonly name: string
  /** The runner's state directory; the test agent keeps its own state in `agent` under it. */
  readonly state: string
  /** What the runner wrote so far, for a failing test's attachment. */
  readonly log: () => string
  /** The repository codes with Smithers' own agent again, the runner is retired, and its process and state go. */
  readonly stop: () => Promise<void>
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
  options: { readonly origin?: string } = {},
): Promise<Runner> => {
  const state = mkdtempSync(join(tmpdir(), "agent-runner-e2e-"))
  const name = `e2e-${word}`
  const output: Array<Buffer> = []
  const agentErrors = join(state, "agent.stderr")
  let runner: ChildProcess | undefined
  const stop = async () => {
    await adminWrite(page, repo, `agents/${name}`, "DELETE").catch(() => undefined)
    await adminWrite(page, repo, `runners/${name}`, "DELETE").catch(() => undefined)
    if (runner !== undefined && runner.exitCode === null && runner.signalCode === null) {
      // A service manager's stop: SIGTERM, then SIGKILL if it hasn't exited in 30 s.
      const exited = new Promise((done) => runner!.once("exit", done))
      runner.kill("SIGTERM")
      const killed = setTimeout(() => runner!.kill("SIGKILL"), 30_000)
      await exited
      clearTimeout(killed)
    }
    rmSync(state, { recursive: true, force: true })
  }
  try {
    // The CLI's JSON answer: its text form adds a `sha256:` label and any notices to the hash.
    const token = execFileSync(process.execPath, [smthrs, "runner", "token", "--state", state, "--format", "json"], { encoding: "utf8" })
    const sha = (JSON.parse(token) as { sha256: string }).sha256
    await adminWrite(page, repo, `runners/${name}`, "PUT", { tokenSha256: sha, labels: ["e2e"], capacity })
    await adminWrite(page, repo, `agents/${name}`, "PUT", { labels: ["e2e"], profile: "acp-test", coding: true })
    const config = {
      origin: options.origin ?? new URL(baseURL).origin,
      name,
      capacity,
      stateDir: state,
      repositories: { [`github/${repo.toLowerCase()}`]: { mirror: process.env.E2E_RUNNER_MIRROR! } },
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
  return { name, state, log: () => `${Buffer.concat(output).toString()}\n--- the agent's stderr ---\n${agentLog()}`, stop }
}
