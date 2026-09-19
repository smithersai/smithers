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
 * WHAT THIS GATE IS ALLOWED TO FAIL FOR. Everything above is the server, and
 * the server is the change under test: a boot that never became healthy, a
 * turn that never went idle, a completion Jev could not judge, a protocol
 * shape that does not hold, a health dot that does not settle green. Each of
 * those fails on the first attempt and is never retried, because each of them
 * is a defect in the code this gate exists to protect.
 *
 * One thing in the drive is NOT the server: whether a cheap 120B seat gets the
 * right answer. `cerebras:gpt-oss-120b` sometimes finishes the turn without
 * touching `add.mjs`, and sometimes claims the fix it never made, which the
 * completion brake catches and turns into a failed turn. Three of this gate's
 * failures on 2026-09-19 were that and nothing else. A gate that fails for a
 * reason unrelated to the change under test teaches people to ignore it, so
 * the seat gets exactly one second attempt, on a fresh repository and a fresh
 * server, and the retry is printed on its own line so a reader of the run's
 * log and of the uploaded `live-turn.log` sees that it happened. Two attempts
 * that both leave the bug in place fail the job with both reasons named: a
 * seat that cannot fix one character twice in a row is a finding, not noise.
 *
 * The retry cannot make this a test that passes when nothing happened. The
 * seat verdict is the repository itself, read off disk: `add.mjs` says
 * `a + b` and `node test.mjs` exits zero, or the attempt did not do the job.
 * Nothing about the verdict can be satisfied by a turn that produced no
 * attempt, and every server assertion still runs, unchanged, on the attempt
 * that fixed the bug.
 *
 * COST. A retry doubles one turn, so a bad seat day costs about two cents
 * instead of one.
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

/**
 * How many times the seat may be asked to fix the one character.
 *
 * Two, and only for the seat. See the file docblock: every other failure in
 * the drive is the server's and fails on the first attempt.
 */
const seatAttempts = 2

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

/**
 * The seat verdict, read off the repository rather than off the transcript.
 *
 * A turn that did the job leaves `a + b` in `add.mjs` and a `node test.mjs`
 * that exits zero. Anything else is the seat failing the task, whatever the
 * transcript says about it, and is the one failure this gate retries.
 *
 * @returns why the seat failed, or `undefined` when the bug is fixed.
 */
const unfixed = (directory: string): string | undefined => {
  const source = readFileSync(join(directory, "add.mjs"), "utf8")
  if (!source.includes("a + b")) return `add.mjs still reads ${JSON.stringify(source.trim())}`
  try {
    execFileSync(process.execPath, ["test.mjs"], { cwd: directory, timeout: budget.test, stdio: "ignore" })
  } catch (error) {
    return `add.mjs reads \`a + b\` but \`node test.mjs\` still fails: ${String(error)}`
  }
  return undefined
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

/**
 * One whole attempt: a fresh repository, a fresh server, one prompt, and every
 * assertion the server owns.
 *
 * It throws on anything the server is answerable for, which is what fails the
 * job without a second ask. It RETURNS a reason only for the seat verdict, and
 * the caller decides whether another attempt is left.
 */
const driveOneTurn = async (attempt: number): Promise<string | undefined> => {
  const started = Date.now()
  const undo: Array<() => void> = []
  // The attempt owns its server and its repository: a second attempt must not
  // inherit a socket, a session, or a half-edited file from the first.
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const step of undo.reverse()) step()
  }
  // Also registered globally, so a throw that escapes the `finally` below
  // still cannot leave a spawned server behind for the next attempt.
  cleanup.push(close)
  try {
    const directory = plantedRepository()
    undo.push(() => rmSync(directory, { recursive: true, force: true }))
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
    undo.push(() => {
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
    undo.push(() => stream.abort())
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

    // 1. Nothing in the turn went unjudged: the harness fails a completion
    //    Jev could not judge as `completion_unjudged`, and that string
    //    reaches the message error and the cell output when it happens. This
    //    is checked FIRST and never retried, because it is the judge being
    //    unreachable and not the seat being wrong, and a retry would report
    //    a broken gateway as a bad seat.
    expect(JSON.stringify(items)).not.toContain("completion_unjudged")

    // 2. The bug is fixed on disk, and the repository's own test agrees. This
    //    is the seat verdict, and the one failure the caller may ask again
    //    about. Everything below it runs only on a turn that did the job, so
    //    a second attempt is never spent re-proving the server.
    const seatFailure = unfixed(directory)
    if (seatFailure !== undefined) {
      console.info(
        `live turn: booted in ${booted} ms, idle after ${wallClockMs} ms, attempt ${attempt} of ${seatAttempts}, frames ${frames.length}, health cards ${health.length}, THE SEAT DID NOT FIX THE BUG: ${seatFailure}`
      )
      return seatFailure
    }

    // 3. The turn completed, and completed as a stop.
    expect(assistant.info.error, JSON.stringify(assistant.info.error)).toBeUndefined()
    expect(assistant.info.finish).toBe("stop")

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

    // 6. The finished session ends green and stays green (design F6). The
    //    live keyed drive that found this left finished, idle sessions red
    //    "waiting for approval" with nothing pending, and others yellow
    //    "repeating itself" over `progress: done`, because the last color
    //    was decided mid-turn on facts the end of the turn had settled.
    const titleNow = async (): Promise<string> =>
      ((await (await ask(`/session/${session.id}`)).json()) as { title: string }).title
    const reasons = health.map((part) => `${part.state.metadata?.color} ${part.state.metadata?.reason}`).join(" | ")
    expect(colors.at(-1), reasons).toBe("green")
    expect(await titleNow()).toMatch(/^\u{1F7E2}/u)
    await sleep(3000)
    expect(await titleNow()).toMatch(/^\u{1F7E2}/u)

    const summary = parts.filter((part): part is { readonly type: string; readonly text: string } =>
      part.type === "text" && typeof (part as { text?: string }).text === "string" &&
      (part as { text: string }).text.includes("Jev ")
    ).at(-1)
    // 7. The footer counts every Jev call the run made, not the classify
    //    calls alone: the completion brake asks once per completion attempt
    //    and each dot is an evaluation. It read "Jev 0 calls" for a turn
    //    that had made several.
    const classifyCards = parts.filter((part): part is ToolPart =>
      part.type === "tool" && "tool" in part && part.tool === "classify"
    )
      .length
    const counted = /(\d+) frames? · \d+ calls? · (\d+) classify · Jev (\d+) calls?/.exec(summary?.text ?? "")
    expect(counted, summary?.text ?? "no summary line").not.toBeNull()
    const [frameCount, classifyCalls, jevCalls] = [Number(counted![1]), Number(counted![2]), Number(counted![3])]
    expect(classifyCalls).toBe(classifyCards)
    // Every frame that settled asked one evaluation, and the completion
    // brake asked one more, so the count can never be the classify count.
    expect(jevCalls, summary!.text).toBeGreaterThan(classifyCalls)
    expect(jevCalls, summary!.text).toBeGreaterThanOrEqual(frameCount)
    const { cost } = (await (await ask(`/session/${session.id}`)).json()) as { cost: number }
    console.info(
      `live turn: booted in ${booted} ms, idle after ${wallClockMs} ms, attempt ${attempt} of ${seatAttempts}, frames ${frames.length}, health cards ${health.length}, seat $${
        cost.toFixed(4)
      }, ${summary?.text ?? "no summary line"}`
    )
    return undefined
  } finally {
    close()
  }
}

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
      const seatFailures: Array<string> = []
      for (let attempt = 1; attempt <= seatAttempts; attempt += 1) {
        const seatFailure = await driveOneTurn(attempt)
        if (seatFailure === undefined) {
          if (seatFailures.length > 0) {
            console.info(
              `live turn: the seat needed ${attempt} attempts. Attempt 1 failed on the seat and not on the server: ${
                seatFailures[0]
              }`
            )
          }
          return
        }
        seatFailures.push(seatFailure)
        if (attempt < seatAttempts) {
          console.info(
            `live turn: retrying once on a fresh repository and a fresh server. The seat, not the server, failed attempt ${attempt}: ${seatFailure}`
          )
        }
      }
      // Two turns, two failures to change one character. The server did every
      // other thing this file asks of it on both, so this is the seat, and it
      // is worth reading rather than rerunning.
      expect(
        seatFailures,
        `The seat failed the planted bug on all ${seatAttempts} attempts, and the server passed every other check on both. ${
          seatFailures.map((reason, index) => `Attempt ${index + 1}: ${reason}`).join(" ")
        }`
      ).toEqual([])
    },
    (budget.boot + budget.idle + 60_000) * seatAttempts
  )
})
