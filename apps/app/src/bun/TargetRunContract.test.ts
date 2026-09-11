/*
 * The frames the backend RECORDS have to satisfy the contract the UI reads
 * (@smthrs/rpc/TargetGraph): a run-local `seq` on every frame, a graph
 * response that carries the declaration `digest` the card compares to decide
 * staleness, and a run store whose memory is bounded by a chatty run.
 *
 * Each case here failed against the merged lanes before the fix beside it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TargetRunEvent } from "@smthrs/rpc/TargetGraph"
import { TargetRunEventSchema } from "@smthrs/rpc/TargetGraph"
import { createTargetRunner } from "./Targets"
import type { TargetRun } from "./Targets"
import { clearTargetGraphCache, queryTargetGraph } from "./TargetGraph"
import { createTargetRunHistory, MAX_RETAINED_LOG_CHARS } from "./TargetRunHistory"
import type { NodeSidecar } from "./Node"

let scratch = ""
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "smithers-run-contract-"))
  clearTargetGraphCache()
})
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/*
 * A stand-in loader: `node <cli> <label>` is what the runner spawns, so a
 * script that prints the executor's stable status lines drives the real
 * parser, the real emit path, and the real history store with no mocks.
 */
const fakeCli = async (script: string): Promise<{ cli: string; node: NodeSidecar }> => {
  const cli = join(scratch, "cli.mjs")
  await writeFile(cli, script)
  return { cli, node: { path: process.execPath, version: "v22.19.0" } }
}

const collect = async (script: string): Promise<{ frames: Array<TargetRunEvent>; run: TargetRun }> => {
  const { cli, node } = await fakeCli(script)
  const frames: Array<TargetRunEvent> = []
  const runner = createTargetRunner({ publish: () => {}, cli, autoStartMs: 5, onEvent: (_run, frame) => { frames.push(frame) } })
  const run = runner.start({ repoId: "r", repo: scratch, workspace: ".", label: "//src:build", node, edges: [] })
  runner.attach(run.runId)
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (frames.some((frame) => frame.type === "exit")) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
  await runner.stop()
  return { frames, run }
}

test("every recorded frame carries a run-local seq, 0-based and gap-free", async () => {
  const { frames } = await collect(
    `process.stdout.write("//src:build  ran  1.5s\\n1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (1.5s)\\n")\n`
  )
  expect(frames.length).toBeGreaterThan(2)
  /*
   * The contract says replay orders by `seq`, never by `at`, so a frame
   * without one is a frame replay cannot place. stdout/exit/error frames
   * carry no `at` at all — without `seq` they are unordered by construction.
   */
  const seqs = frames.map((frame) => frame.seq)
  expect(seqs.every((seq) => typeof seq === "number")).toBe(true)
  expect(seqs).toEqual(frames.map((_frame, index) => index))
  /* The schema has to accept what the backend actually emits. */
  for (const frame of frames) expect(TargetRunEventSchema.safeParse(frame).success).toBe(true)
})

test("two runs each number their own frames from zero", async () => {
  const script = `process.stdout.write("//src:build  ran  1ms\\n")\n`
  const first = await collect(script)
  const second = await collect(script)
  expect(first.frames[0]?.seq).toBe(0)
  expect(second.frames[0]?.seq).toBe(0)
  expect(first.run.runId).not.toBe(second.run.runId)
})

test("the graph response carries the declaration digest the card compares", async () => {
  await writeFile(join(scratch, "PACKAGE.ts"), "export const a = 1\n")
  const cli = join(scratch, "graph-cli.mjs")
  await writeFile(
    cli,
    `const args = process.argv.slice(2)
if (args[0] === "graph") process.stdout.write(JSON.stringify({ graph: "//src:build\\n", targets: [{ label: "//src:build", target: "Shell.Build", kinds: ["build"] }] }))
else process.stdout.write(JSON.stringify({ targets: [{ label: "//src:build", target: "Shell.Build", kinds: ["build"] }] }))
`
  )
  const node: NodeSidecar = { path: process.execPath, version: "v22.19.0" }
  const first = await queryTargetGraph({ repoId: "r", repo: scratch, node, cli })
  /*
   * `TargetGraphResponse.digest` is documented as the field a card compares
   * to decide whether its cached graph went stale after a declaration edit.
   * The backend computed the digest for its own cache and dropped it on the
   * floor, so every response the UI saw had `digest: undefined` and no card
   * could ever detect staleness.
   */
  expect(typeof first.digest).toBe("string")
  expect(first.digest).toMatch(/^[0-9a-f]{64}$/)

  /* Editing a declaration changes the digest AND reloads the graph. */
  await new Promise((resolve) => setTimeout(resolve, 12))
  await writeFile(join(scratch, "PACKAGE.ts"), "export const a = 2\nexport const b = 3\n")
  const second = await queryTargetGraph({ repoId: "r", repo: scratch, node, cli })
  expect(second.digest).not.toBe(first.digest)

  /* An untouched repository keeps the digest, which is what makes it usable. */
  const third = await queryTargetGraph({ repoId: "r", repo: scratch, node, cli })
  expect(third.digest).toBe(second.digest)
})

test("a chatty run does not grow the in-memory run store without bound", async () => {
  const history = createTargetRunHistory()
  const run: TargetRun = {
    runId: "chatty", repoId: "r", repo: scratch, workspace: ".", label: "//src:build", labels: ["//src:build"],
    startedAt: Date.now(), status: "running", exitCode: null
  }
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: Date.now() })
  /*
   * Every stdout frame was retained in memory for the life of the process,
   * and the runs map never evicts, so one noisy `tsc` run pinned its whole
   * output in the backend's heap. The disk journal still holds every byte;
   * memory keeps the TAIL a human reads.
   */
  const chunk = "x".repeat(10_000)
  for (let index = 0; index < 400; index++) {
    history.event(run, { type: "stdout", data: chunk, label: "//src:build" })
  }
  history.event(run, { type: "exit", code: 0 })
  const replay = await history.replay(run.runId)
  const retained = (replay?.events ?? [])
    .filter((event) => event.type === "stdout" || event.type === "stderr")
    .reduce((total, event) => total + (event as { data: string }).data.length, 0)
  expect(retained).toBeLessThanOrEqual(MAX_RETAINED_LOG_CHARS)
  /* Structured frames are never evicted: the timeline and overlay need them all. */
  expect(replay?.events.some((event) => event.type === "started")).toBe(true)
  expect(replay?.events.some((event) => event.type === "exit")).toBe(true)
  expect(replay?.run.status).toBe("done")
  /* The tail is kept, not the head: the end of a run is what explains it. */
  const logs = (replay?.events ?? []).filter((event) => event.type === "stdout")
  expect(logs.length).toBeGreaterThan(0)
})

test("the runner reads the next chunk of child output only after the consumer took the last one", async () => {
  /*
   * The pump used to hand every chunk to `onEvent` as fast as the pipe
   * delivered it, so a chatty child queued its whole output in the journal's
   * append chain before one byte reached the disk. Now a consumer that
   * returns a promise paces the reads: while it holds the first frame, no
   * later frame is delivered, even after the child has finished writing.
   */
  const marker = join(scratch, "wrote-everything")
  const { cli, node } = await fakeCli(`
    import { writeSync, writeFileSync } from "node:fs"
    const buffer = Buffer.from("x".repeat(12_000_000))
    let offset = 0
    while (offset < buffer.length) offset += writeSync(1, buffer, offset)
    writeFileSync(${JSON.stringify(marker)}, "")
  `)
  const frames: Array<TargetRunEvent> = []
  let releaseFirst: (() => void) | undefined
  const runner = createTargetRunner({
    publish: () => {}, cli, autoStartMs: 5,
    onEvent: (_run, frame) => {
      frames.push(frame)
      if (frame.type === "stdout" && releaseFirst === undefined) return new Promise<void>((resolve) => { releaseFirst = resolve })
      return undefined
    }
  })
  const run = runner.start({ repoId: "r", repo: scratch, workspace: ".", label: "//src:build", node, edges: [] })
  runner.attach(run.runId)
  const until = async (ready: () => boolean | Promise<boolean>): Promise<void> => {
    for (let attempt = 0; attempt < 3000; attempt++) {
      if (await ready()) return
      await Bun.sleep(10)
    }
    throw new Error("condition not met")
  }
  await until(() => releaseFirst !== undefined)
  await until(() => Bun.file(marker).exists())
  await Bun.sleep(100)
  expect(frames.filter((frame) => frame.type === "stdout")).toHaveLength(1)
  expect(frames.some((frame) => frame.type === "exit")).toBe(false)
  releaseFirst!()
  await until(() => frames.some((frame) => frame.type === "exit"))
  const delivered = frames.filter((frame) => frame.type === "stdout").reduce((total, frame) => total + (frame as { data: string }).data.length, 0)
  expect(delivered).toBe(12_000_000)
  expect(frames.find((frame) => frame.type === "exit")).toMatchObject({ code: 0 })
  await runner.stop()
})
