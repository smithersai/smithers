// The runner's transcript spool across restarts (src/runner/Spool.ts): a line a crash left torn never swallows the
// event written after it, so every event survives the next restart and the host's contiguous acknowledgement advances.
import * as Transcript from "@smthrs/agent/Transcript"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import * as Host from "../src/runner/Host.ts"
import * as Spool from "../src/runner/Spool.ts"

const key = "todo:spool#g1"
let stateDir = ""
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "runner-spool-"))
})
afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

const lineOf = (seq: number) => JSON.stringify({ seq, at: 1, kind: Transcript.KINDS.turn, update: {} })
const seqsOnDisk = () =>
  readFileSync(Spool.fileOf(stateDir, key), "utf8").split("\n").filter((line) => line !== "").map((line) =>
    (JSON.parse(line) as Transcript.Event).seq
  )

/** A host that acknowledges only a contiguous run of sequence numbers, as the flow host does. */
const hostOf = () => {
  const received: Array<number> = []
  const host = Host.Host.of({
    claim: () => Effect.die("unused"),
    heartbeat: () => Effect.die("unused"),
    settle: () => Effect.die("unused"),
    gitCredential: () => Effect.die("unused"),
    events: ({ events }) =>
      Effect.sync(() => {
        for (const event of events) if (event.seq === received.length) received.push(event.seq)
        return { next: received.length }
      })
  })
  return { host, received }
}

/** Opens the spool as a restarted runner does, appends `appends` events, and closes it. */
const restart = (appends: number) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const spool = yield* Spool.open({ stateDir, key, claim: "c", scrub: (text) => text })
      for (let i = 0; i < appends; i++) yield* spool.append(Transcript.KINDS.turn, {})
    }).pipe(Effect.scoped)
  )

const seed = (text: string) => {
  mkdirSync(dirname(Spool.fileOf(stateDir, key)), { recursive: true })
  writeFileSync(Spool.fileOf(stateDir, key), text)
}

test("a torn final line is cut off, so the event after a restart survives the next restart and drains", async () => {
  seed(`${lineOf(0)}\n${lineOf(1).slice(0, 12)}`)
  await restart(1)
  expect(seqsOnDisk()).toEqual([0, 1])
  await restart(1)
  expect(seqsOnDisk()).toEqual([0, 1, 2])

  const { host, received } = hostOf()
  const drained = await Effect.runPromise(
    Effect.gen(function*() {
      const spool = yield* Spool.open({ stateDir, key, claim: "c", scrub: (text) => text })
      return yield* spool.drain
    }).pipe(Effect.scoped, Effect.provideService(Host.Host, host))
  )
  expect(drained).toBe("sent")
  expect(received).toEqual([0, 1, 2])
})

test("a whole final event missing its newline is kept and ended before the next event", async () => {
  seed(lineOf(0))
  await restart(1)
  expect(readFileSync(Spool.fileOf(stateDir, key), "utf8").startsWith(`${lineOf(0)}\n{`)).toBe(true)
  expect(seqsOnDisk()).toEqual([0, 1])
})
