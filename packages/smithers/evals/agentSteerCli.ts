/**
 * The steer and stop eval of external agents (TEST-11; slice S3 of the G1/G2 design): a real `smthrs runner` serve loop
 * drives each real ACP agent the operator's profiles name, against the runner's test peer (test/fixtures/runner/host.ts)
 * and a real jj checkout. Nothing about the agents is scripted.
 *
 * - steer: a task that starts with a 20-second command, and a person's steer, handed over while the command runs, that
 *   asks for a second line. The settled change must carry both lines, and the runner must say the agent read the steer.
 * - stop: a task that runs a 10-minute command (a `node -e` timer) in the agent's shell tool. The host asks the runner to stop; the job
 *   must settle Cancelled with no process of the agent's tree left, the command included, within 20 s.
 *
 * The profiles are the operator's own configuration, never this repository's: `AGENT_STEER_PROFILES` names a JSON file
 * of `runner.json` profiles (argv, env, prestart), whose agents and accounts this code never names (PROC-23).
 *
 * @since 1.0.0
 */
import { Effect, Fiber } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as RunnerCmd from "../src/commands/Runner.vibe"
import * as Config from "../src/runner/Config.vibe"
import * as Host from "../test/fixtures/runner/host.ts"

/** What one case did, by profile: whether it passed, and the evidence. */
export interface Trial {
  readonly profile: string
  readonly kind: "steer" | "stop"
  readonly pass: boolean
  readonly outcome: string
  readonly ms: number
  readonly detail: Readonly<Record<string, unknown>>
}

const REPOSITORY = "github/acme/app"
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8")

/** The processes on this host whose command line contains `needle`, by pid. */
const running = (needle: string): Array<number> =>
  execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      return match !== null && match[2]!.includes(needle) && !match[2]!.includes("/bin/ps") ? [Number(match[1])] : []
    })

/** Each process's ancestry, pid to pid 1, with its parent, group and command (the command cut to 80 characters). */
const ancestry = (pids: ReadonlyArray<number>) => {
  const table = new Map<number, { readonly ppid: number; readonly pgid: number; readonly command: string }>()
  for (
    const line of execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }).split("\n")
  ) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match !== null) {
      table.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]!.slice(0, 80) })
    }
  }
  return pids.map((pid) => {
    const chain: Array<string> = []
    for (let at: number | undefined = pid; at !== undefined && at > 1 && chain.length < 12;) {
      const entry = table.get(at)
      if (entry === undefined) break
      chain.push(`${at}<${entry.ppid} g${entry.pgid} ${entry.command}`)
      at = entry.ppid
    }
    return chain
  })
}

/** Runs one case of `kind` with `profile` under a fresh runner and host; never throws for an agent's failure. */
const trial = async (
  kind: "steer" | "stop",
  name: string,
  profile: Partial<Config.Profile>
): Promise<Trial> => {
  const root = mkdtempSync(join(tmpdir(), `agent-steer-${kind}-`))
  const stateDir = join(root, "state")
  const made = await Effect.runPromise(Config.makeToken(stateDir))
  const host = await Host.start(readFileSync(made.file, "utf8").trim())
  const mirror = Host.mirror(root)
  const configPath = join(root, "runner.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      origin: host.origin,
      name: "eval-runner",
      capacity: 1,
      stateDir,
      heartbeatSeconds: 2,
      pollSeconds: 1,
      repositories: { [REPOSITORY]: { mirror: mirror.path } },
      profiles: { [name]: profile }
    })
  )
  const word = `w${Date.now().toString(36)}`
  const startedAt = Date.now()
  const serving = Effect.runFork(RunnerCmd.serve(configPath))
  try {
    if (kind === "steer") {
      const row = host.enqueue(Host.task({
        profile: name,
        base: mirror.base,
        prompt: `First run the shell command \`sleep 20\` in the foreground and wait for it. Then add the line ` +
          `\`alpha-${word}\` to NOTES.md. Change nothing else, and run no tests.`
      }))
      while (row.state === "queued") await sleep(200)
      await sleep(6_000)
      const steeredAt = Date.now()
      row.steers = [{
        id: `steer-${word}`,
        text: `Also add the line \`steer-${word}\` to NOTES.md, after the other line.`
      }]
      let deliveredMs: number | undefined
      const watch = (async () => {
        while (row.state !== "settled") {
          if (deliveredMs === undefined && row.delivered.length > 0) deliveredMs = Date.now() - steeredAt
          await sleep(200)
        }
      })()
      const outcome = await host.settled(row, 20 * 60_000)
      await watch
      const notes = outcome._tag === "Done"
        ? outcome.changes.additions.filter((file) => file.path === "NOTES.md").map((file) => decode(file.contents))
          .join("")
        : ""
      const both = notes.includes(`alpha-${word}`) && notes.includes(`steer-${word}`)
      return {
        profile: name,
        kind,
        pass: outcome._tag === "Done" && both && row.delivered.includes(`steer-${word}`),
        outcome: outcome._tag,
        ms: Date.now() - startedAt,
        detail: {
          deliveredMs: deliveredMs ?? null,
          notes,
          paths: outcome._tag === "Done"
            ? [...outcome.changes.additions.map((file) => file.path), ...outcome.changes.deletions]
            : [],
          summary: outcome._tag === "Done" ? outcome.summary.slice(-600) : null,
          usage: outcome._tag === "Done" ? outcome.usage : null
        }
      }
    }
    // A ten-minute command no shell hook refuses as a bare sleep, found again by its own number.
    const marker = `600${100 + Math.floor(Math.random() * 900)}`
    const command = `node -e "setTimeout(() => {}, ${marker})"`
    const row = host.enqueue(Host.task({
      profile: name,
      base: mirror.base,
      prompt: `Use your shell tool to run the command \`${command}\` in the foreground and wait for it to ` +
        `finish. Do nothing else.`
    }))
    const until = Date.now() + 5 * 60_000
    while (running(`}, ${marker})`).length === 0 && Date.now() < until) await sleep(500)
    const before = running(`}, ${marker})`)
    const lineage = ancestry(before)
    const askedAt = Date.now()
    row.cancel = true
    const outcome = await host.settled(row, 2 * 60_000)
    const stopMs = Date.now() - askedAt
    const after = running(`}, ${marker})`)
    return {
      profile: name,
      kind,
      pass: before.length > 0 && after.length === 0 && outcome._tag === "Cancelled" && outcome.processTreeGone &&
        stopMs <= 20_000,
      outcome: outcome._tag,
      ms: Date.now() - startedAt,
      detail: {
        stopMs,
        commandsBefore: before.length,
        commandsAfter: after.length,
        settled: outcome,
        ancestry: lineage,
        survivors: ancestry(after)
      }
    }
  } catch (cause) {
    return {
      profile: name,
      kind,
      pass: false,
      outcome: "error",
      ms: Date.now() - startedAt,
      detail: { cause: String(cause) }
    }
  } finally {
    await Effect.runPromise(Fiber.interrupt(serving))
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Runs both cases for every profile in `AGENT_STEER_PROFILES`'s file (only those in `AGENT_STEER_ONLY`, a
 * comma-separated list, when set, and only the cases in `AGENT_STEER_KINDS`), one after another. A stop case records
 * each command's process ancestry before the stop, and any survivor's after.
 */
export const run = async (): Promise<ReadonlyArray<Trial>> => {
  const file = process.env.AGENT_STEER_PROFILES
  if (file === undefined || file === "") throw new Error("AGENT_STEER_PROFILES names no profiles file")
  const profiles = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<Config.Profile>>
  const only = (process.env.AGENT_STEER_ONLY ?? "").split(",").filter((each) => each !== "")
  const trials: Array<Trial> = []
  for (const [name, profile] of Object.entries(profiles)) {
    if (only.length > 0 && !only.includes(name)) continue
    const kinds = (process.env.AGENT_STEER_KINDS ?? "steer,stop").split(",") as Array<"steer" | "stop">
    for (const kind of kinds) trials.push(await trial(kind, name, profile))
  }
  return trials
}
