/**
 * The live proof: a real seat, a real Jev key, a real git repository with a
 * planted one-character bug, driven over HTTP exactly the way the hosted app
 * drives it, and the bug is fixed on disk when the turn goes idle.
 *
 * The server is the spawned verb, not an in-process layer. The engine
 * driver's host (the kernel-guarded platform, the seat resolver, the flow
 * registry) is assembled in `packages/smithers/src/commands/OpenCode.ts` out
 * of that package's private `NativeEquipment`, and that package depends on
 * this one, so building the host here would invert the dependency. Spawning
 * `smithers opencode` also puts the operator's own boot path under test,
 * including its refusal to start without `AI_GATEWAY_API_KEY`.
 *
 * The turn costs money, so it runs only when both keys are in the
 * environment and skips with a message naming them when either is absent: a
 * contributor with no keys still gets a green suite. Nothing here imports
 * `src`, so skipping cannot move the package's coverage.
 *
 * Every wait is bounded, the frame budget is capped at eight, and the prompt
 * is one edit in one file so the turn needs few frames.
 *
 * Run this file ALONE with `--coverage.enabled=false`. The package config's
 * 100% thresholds are measured over `src`, and one file that imports none of
 * it reports 0%, so `vitest run test/LiveBugFix.test.ts` exits 1 on coverage
 * after the turn itself passed. `.github/workflows/live-opencode.yml` is that
 * command in CI, and it is a workflow of its own because a target step cannot
 * carry a seat key: the build executor hands a child only
 * `Exec.inheritedEnvironmentNames` plus declared values, and a declared secret
 * arrives as a placeholder the proxy substitutes for plain HTTP alone, so this
 * file skips under `smthrs test` with both keys exported.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/** The two keys a live turn needs, and what each one buys. */
const required: ReadonlyArray<readonly [string, string]> = [
  ["CEREBRAS_API_KEY", "the seat that runs the turn"],
  ["AI_GATEWAY_API_KEY", "the Jev key that judges its completion"]
]

const absent = required.filter(([name]) => (process.env[name] ?? "") === "")

/** Why the live turn is not running, or `undefined` when it is. */
const refusal: string | undefined = absent.length === 0 ?
  undefined :
  `Live turn skipped. Set ${
    absent.map(([name, what]) => `${name} (${what})`).join(" and ")
  }, then run this file again. Everything else in this suite runs without keys.`

/** The frame budget: one edit in one file does not need more. */
const maxFrames = 8

/** Every wait in the drive, bounded. */
const budget = { boot: 120_000, permission: 180_000, idle: 420_000, test: 60_000 }

// `test/` -> the package -> `packages/smithers`, which holds the CLI bin.
const verb = join(dirname(dirname(import.meta.dirname)), "bin", "smithers.mjs")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

/** A real git repository whose one test fails on a one-character bug. */
const plantedRepository = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-opencode-live-"))
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name: "planted", type: "module" }, null, 2)}\n`)
  // The bug: `-` where the one test requires `+`.
  writeFileSync(join(directory, "add.mjs"), "export const add = (a, b) => a - b\n")
  writeFileSync(
    join(directory, "test.mjs"),
    [
      `import { add } from "./add.mjs"`,
      ``,
      `if (add(2, 3) !== 5) {`,
      `  console.error(\`add(2, 3) is \${add(2, 3)}, expected 5\`)`,
      `  process.exit(1)`,
      `}`,
      `console.log("ok")`,
      ``
    ].join("\n")
  )
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], {
      cwd: directory,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "live",
        GIT_AUTHOR_EMAIL: "live@test",
        GIT_COMMITTER_NAME: "live",
        GIT_COMMITTER_EMAIL: "live@test"
      }
    })
  git("init", "--quiet", "--initial-branch", "main")
  git("add", "add.mjs", "test.mjs", "package.json")
  git("commit", "--quiet", "--no-gpg-sign", "-m", "the planted bug")
  return directory
}

interface Frame {
  readonly type: string
  readonly properties: Record<string, unknown>
}

interface ToolPart {
  readonly type: "tool"
  readonly tool: string
  readonly state: {
    readonly status: string
    readonly metadata?: {
      readonly color?: string
      readonly reason?: string
      readonly answers?: Record<string, { readonly probability?: number; readonly label?: string }>
    }
  }
}

interface Item {
  readonly info: { readonly id: string; readonly role: string; readonly finish?: string; readonly error?: unknown }
  readonly parts: ReadonlyArray<ToolPart | { readonly type: string; readonly text?: string }>
}

const cleanup: Array<() => void> = []
afterAll(() => {
  for (const undo of cleanup.reverse()) undo()
})

describe("a live turn on a real seat", () => {
  it("names both keys it needs when it cannot run", () => {
    expect(required.map(([name]) => name)).toEqual(["CEREBRAS_API_KEY", "AI_GATEWAY_API_KEY"])
    if (refusal !== undefined) console.info(refusal)
    expect(refusal === undefined || refusal.includes("Live turn skipped")).toBe(true)
  })

  // The name IS the message: a reporter prints a skipped test's title, so a
  // contributor with no keys reads why this one did not run.
  it.skipIf(refusal !== undefined)(
    refusal ?? "fixes the planted bug on disk, finishes stop, and Jev judges every completion",
    async () => {
      const started = Date.now()
      const directory = plantedRepository()
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
      const port = await freePort()
      const base = `http://127.0.0.1:${port}`
      const logged: Array<string> = []

      const { spawn } = await import("node:child_process")
      const child = spawn(
        process.execPath,
        [
          verb,
          "opencode",
          directory,
          "--port",
          String(port),
          "--seat",
          "cerebras:gpt-oss-120b",
          "--max-frames",
          String(maxFrames),
          "--quiet"
        ],
        { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
      )
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => logged.push(chunk))
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => logged.push(chunk))
      let exited = false
      child.once("exit", () => {
        exited = true
      })
      cleanup.push(() => {
        if (!exited) child.kill("SIGTERM")
      })

      const ask = async (path: string, init?: RequestInit): Promise<Response> => fetch(`${base}${path}`, init)
      const healthy = async (): Promise<boolean> => ask("/global/health").then((r) => r.ok).catch(() => false)
      const bootDeadline = Date.now() + budget.boot
      while (!await healthy()) {
        expect(exited, `the server exited during boot:\n${logged.join("")}`).toBe(false)
        expect(Date.now(), `the server never became healthy:\n${logged.join("")}`).toBeLessThan(bootDeadline)
        await sleep(200)
      }
      const booted = Date.now() - started

      // The event stream, drained continuously: the hub subscribes a consumer
      // when it pulls past the replay prologue, so a reader that stops
      // between frames misses what is published next.
      const frames: Array<Frame> = []
      const stream = new AbortController()
      cleanup.push(() => stream.abort())
      const events = await ask("/global/event", { signal: stream.signal, headers: { accept: "text/event-stream" } })
      void (async () => {
        const reader = events.body!.getReader()
        const decoder = new TextDecoder()
        let buffered = ""
        for (;;) {
          const read = await reader.read().catch(() => ({ done: true, value: undefined }))
          if (read.done === true) return
          buffered += decoder.decode(read.value)
          const parts = buffered.split("\n\n")
          buffered = parts.pop() ?? ""
          for (const part of parts) {
            if (!part.startsWith("data: ")) continue
            frames.push((JSON.parse(part.slice(6)) as { payload: Frame }).payload)
          }
        }
      })()
      const post = (path: string, payload?: unknown): Promise<Response> =>
        ask(path, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://app.opencode.ai" },
          body: JSON.stringify(payload ?? {})
        })

      const session = (await (await post("/session", { title: "live bug fix" })).json()) as { id: string }
      await post(`/session/${session.id}/prompt_async`, {
        parts: [{
          type: "text",
          text:
            "`node test.mjs` fails in this directory. One character in add.mjs is wrong. Fix that one character and nothing else, then run `node test.mjs` to confirm it passes."
        }]
      })

      // The app answers the permission card the turn parks on; the shell call
      // that runs the test needs one. `always` keeps one reply enough.
      const answered = new Set<string>()
      const answerPending = async (): Promise<void> => {
        const pending = await (await ask("/permission")).json().catch(() => []) as Array<
          { id: string; sessionID: string }
        >
        for (const request of pending) {
          if (request.sessionID !== session.id || answered.has(request.id)) continue
          answered.add(request.id)
          await post(`/session/${session.id}/permissions/${request.id}`, { response: "always" })
        }
      }
      const idle = () =>
        frames.some((frame) => frame.type === "session.idle" && frame.properties["sessionID"] === session.id)
      const idleDeadline = Date.now() + budget.idle
      while (!idle()) {
        expect(exited, `the server exited mid-turn:\n${logged.join("")}`).toBe(false)
        expect(Date.now(), `the turn never went idle; frames: ${frames.map((f) => f.type).join(", ")}`)
          .toBeLessThan(idleDeadline)
        await answerPending()
        await sleep(250)
      }
      const wallClockMs = Date.now() - started

      const items = (await (await ask(`/session/${session.id}/message`)).json()) as Array<Item>
      const assistant = items.filter((item) => item.info.role === "assistant").at(-1)!
      const parts = items.flatMap((item) => item.parts)
      const health = parts.filter((part): part is ToolPart =>
        part.type === "tool" && "tool" in part && part.tool === "health"
      )
      const judged = health.flatMap((part) => Object.values(part.state.metadata?.answers ?? {}))
        .filter((answer) => typeof answer.probability === "number")

      // 1. The turn completed, and completed as a stop.
      expect(assistant.info.error, JSON.stringify(assistant.info.error)).toBeUndefined()
      expect(assistant.info.finish).toBe("stop")

      // 2. Nothing in the turn went unjudged: the harness fails a completion
      //    Jev could not judge as `completion_unjudged`, and that string
      //    reaches the message error and the cell output when it happens.
      expect(JSON.stringify(items)).not.toContain("completion_unjudged")

      // 3. The bug is fixed on disk, and the repository's own test agrees.
      expect(readFileSync(join(directory, "add.mjs"), "utf8")).toContain("a + b")
      execFileSync(process.execPath, ["test.mjs"], { cwd: directory, timeout: budget.test, stdio: "ignore" })

      // 4. At least one classify call answered with probabilities.
      expect(judged.length).toBeGreaterThan(0)
      for (const answer of judged) {
        expect(answer.probability).toBeGreaterThanOrEqual(0)
        expect(answer.probability).toBeLessThanOrEqual(1)
      }

      // 5. A health decision was recorded, with a color.
      const colors = health.map((part) => part.state.metadata?.color)
      expect(colors.length).toBeGreaterThan(0)
      for (const color of colors) expect(["green", "yellow", "red", "gray"]).toContain(color)

      const summary = parts.filter((part): part is { readonly type: string; readonly text: string } =>
        part.type === "text" && typeof (part as { text?: string }).text === "string" &&
        (part as { text: string }).text.includes("Jev ")
      ).at(-1)
      const { cost } = (await (await ask(`/session/${session.id}`)).json()) as { cost: number }
      console.info(
        `live turn: booted in ${booted} ms, idle after ${wallClockMs} ms, frames ${frames.length}, health cards ${health.length}, seat $${
          cost.toFixed(4)
        }, ${summary?.text ?? "no summary line"}`
      )
    },
    budget.boot + budget.idle + 60_000
  )
})
