import { NodeHost } from "@smthrs/platform-node"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect, inject, it } from "vitest"
import { execute } from "../src/RealCliDriver.ts"
import * as Recording from "../src/TerminalRecording.ts"

const run = <A, E>(effect: Effect.Effect<A, E, NodeHost.NodeHost>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeHost.layer)))
const tools = inject("terminalTools")
const options = { title: "Repository journey", renderer: tools.renderer, env: tools.env }
const directory = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped(), "evidence")
})

describe("reproducible terminal evidence", () => {
  it("renders real GIF frames and retains deterministic replay and conversion instructions", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const recording = yield* Recording.make({ ...options, columns: 40, rows: 8 })
      yield* recording.capture("Signed out", "logged_in: false\ntoken_set: false")
      yield* recording.capture("Open repository", "https://smithers.sh/team/repository")
      const first = yield* recording.write(yield* directory)
      const second = yield* recording.write(yield* directory)
      expect(yield* fs.readFile(first.gif)).toEqual(yield* fs.readFile(second.gif))
      expect(yield* fs.readFileString(first.cast)).toBe(yield* fs.readFileString(second.cast))
      const cast = (yield* fs.readFileString(first.cast)).trim().split("\n").map((line) => JSON.parse(line))
      expect(cast[0]).toMatchObject({ version: 2, width: 40, height: 8, timestamp: 0, title: options.title })
      expect(cast[1]).toEqual([0, "o", "\x1b[2J\x1b[Hlogged_in: false\r\ntoken_set: false"])
      expect(cast[2]).toEqual([0.8, "o", "\x1b[2J\x1b[Hhttps://smithers.sh/team/repository"])
      expect(cast.at(-1)).toEqual([1.6, "o", ""])
      const manifest = JSON.parse(yield* fs.readFileString(first.manifest))
      expect(manifest.frames.map((frame: Recording.Frame) => frame.label)).toEqual(["Signed out", "Open repository"])
      expect(manifest.renderer.executable).toBe(tools.renderer)
      expect(manifest.renderer.args).toContain("terminal.gif")
      expect(yield* fs.readFileString(first.gif.replace("terminal.gif", "frame-0000.txt"))).toBe(
        "logged_in: false\ntoken_set: false"
      )
      // Decode with a second real process: a header alone cannot prove animation.
      const { execute } = yield* Effect.promise(() => import("../src/RealCliDriver.ts"))
      const decoded = yield* execute({
        executable: tools.probe,
        args: [
          "-v",
          "error",
          "-count_frames",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=nb_read_frames,width,height",
          "-of",
          "json",
          first.gif
        ],
        env: options.env,
        cwd: "/tmp"
      })
      const video = JSON.parse(decoded.stdout).streams[0]
      expect(video.width).toBe(424)
      expect(video.height).toBe(176)
      expect(Number(video.nb_read_frames)).toBeGreaterThan(1)
    })))
  })

  it("preserves custom frame delays in the decoded GIF and cast", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const out = yield* directory
      // Exercise successful publication with the public default renderer.
      const recording = yield* Recording.make({ title: options.title, env: options.env, frameDurationMs: 250 })
      yield* recording.capture("first", "First screen")
      yield* recording.capture("second", "Second screen")
      const evidence = yield* recording.write(out)
      const result = yield* execute({
        executable: tools.probe,
        env: options.env,
        cwd: out,
        args: [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_frames",
          "-show_entries",
          "frame=pts_time,duration_time",
          "-of",
          "json",
          evidence.gif
        ]
      })
      expect(result.code).toBe(0)
      const frames = JSON.parse(result.stdout).frames as Array<{ pts_time: string; duration_time: string }>
      expect(frames.map((frame) => [Number(frame.pts_time), Number(frame.duration_time)]))
        .toEqual([[0, 0.25], [0.25, 0.25]])
      const cast = (yield* fs.readFileString(evidence.cast)).trim().split("\n").map((line) => JSON.parse(line))
      expect(cast.slice(1).map((event) => event[0])).toEqual([0, 0.25, 0.5])
    })))
  })

  it("rejects off-screen rows and display-width overflow before publishing evidence", async () => {
    await run(Effect.gen(function*() {
      const recording = yield* Recording.make({ ...options, columns: 1, rows: 1 })
      for (const screen of ["\n\nX", "ab", "界", "😀"]) {
        expect(yield* recording.capture("clipped", screen).pipe(Effect.result))
          .toMatchObject({ _tag: "Failure", failure: { reason: "invalid-frame" } })
      }
      yield* recording.capture("fits", "e\u0301")
      const wide = yield* Recording.make({ ...options, columns: 2, rows: 2 })
      yield* wide.capture("wide glyphs fit", "界\n😀")
    }))
  })

  it("keeps the bottom terminal row visible even when fallback glyphs change font metrics", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const out = yield* directory
      const recording = yield* Recording.make(options)
      yield* recording.capture("Input remains visible", "┃\n" + "\n".repeat(38) + "Footer input and keys")
      yield* recording.write(out)
      const result = yield* execute({
        executable: tools.renderer,
        env: options.env,
        cwd: out,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          "terminal.gif",
          "-vf",
          "crop=iw:24:0:ih-24,signalstats,metadata=print:file=footer-stats.txt",
          "-frames:v",
          "1",
          "-f",
          "null",
          "-"
        ]
      })
      expect(result.code).toBe(0)
      const stats = yield* fs.readFileString(`${out}/footer-stats.txt`)
      const min = Number(stats.match(/lavfi.signalstats.YMIN=(\d+)/)![1])
      const max = Number(stats.match(/lavfi.signalstats.YMAX=(\d+)/)![1])
      expect(max).toBeGreaterThan(min)
    })))
  })

  it.each([
    { title: " " },
    { columns: 0 },
    { rows: 101 },
    { frameDurationMs: 199 },
    { frameDurationMs: 201 },
    { maxFrames: 257 },
    { columns: NaN }
  ])("refuses invalid recording geometry %j", async (value) => {
    expect(await run(Recording.make({ ...options, ...value }).pipe(Effect.result)))
      .toMatchObject({ _tag: "Failure", failure: { reason: "invalid-options" } })
  })

  it("refuses empty evidence, blank frames, escapes and frame overflow", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const recording = yield* Recording.make({ title: "Bounds", columns: 1, rows: 1, maxFrames: 1 })
      expect(yield* recording.write(yield* directory).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "empty" }
      })
      for (const [label, screen] of [["", "x"], ["label", " "], ["label", "\x1b[H"], ["label", "x".repeat(9)]]) {
        expect(yield* recording.capture(label!, screen!).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid-frame" }
        })
      }
      yield* recording.capture("first", "x")
      expect(yield* recording.capture("second", "y").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "frame-limit" }
      })
    })))
  })

  it("keeps frames on conversion failure without publishing a success manifest", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const recording = yield* Recording.make({ title: options.title, renderer: process.execPath })
      yield* recording.capture("failure retained", "Renderer fails")
      const out = yield* directory
      expect(yield* recording.write(out).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "conversion" }
      })
      expect(yield* fs.exists(`${out}/terminal.cast`)).toBe(true)
      expect(yield* fs.exists(`${out}/manifest.json`)).toBe(false)
    })))
  })

  it("rejects corrupt renderer evidence using a faulty filesystem service", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      // Exercise the public default renderer too; PATH names the supplied tools.
      const recording = yield* Recording.make({ title: options.title, env: options.env })
      yield* recording.capture("public frame", "hello")
      const out = yield* directory
      const faulty = { ...fs, readFile: () => Effect.succeed(new TextEncoder().encode("broken")) }
      expect(yield* recording.write(out).pipe(Effect.provideService(FileSystem.FileSystem, faulty), Effect.result))
        .toMatchObject({ _tag: "Failure", failure: { reason: "conversion" } })
      expect(yield* fs.exists(`${out}/manifest.json`)).toBe(false)
    })))
  })

  it("refuses an existing destination instead of reusing stale artifacts", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const recording = yield* Recording.make(options)
      yield* recording.capture("public frame", "hello")
      const fs = yield* FileSystem.FileSystem
      const out = yield* directory
      yield* fs.makeDirectory(out)
      yield* fs.writeFileString(`${out}/terminal.gif`, "stale")
      expect((yield* recording.write(out).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* fs.readFileString(`${out}/terminal.gif`)).toBe("stale")
    })))
  })
})
