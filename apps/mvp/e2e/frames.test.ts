import { describe, expect, it } from "vitest"
import {
  BLANK_DETAIL,
  CAPTION_ROWS,
  chapterAt,
  chaptersFileOf,
  chaptersIn,
  chaptersOf,
  combine,
  cutIdle,
  type Frame,
  GIF_PACE,
  holdChapters,
  IDLE_CHANGE,
  isBlank,
  type Mark,
  MAX_GIF_BYTES,
  MAX_STILL_FRAMES,
  MEASURE_HEIGHT,
  MEASURE_WIDTH,
  measure,
  withoutCaptures,
  outputStarts,
  placeOfPath,
  plainLabel,
  plan,
  problems,
  QUIET_CHANGE,
  RECORDING_LAG,
  retime,
  themeFor,
  titleCardOf,
  VIDEO_PACE,
  videoProblems,
} from "./frames.ts"

const PIXELS = MEASURE_WIDTH * MEASURE_HEIGHT

const blank: Frame = { detail: 0, changed: 0 }
const shown = (changed: number): Frame => ({ detail: 500, changed })
/** A new screen: everything moved. */
const cut = shown(PIXELS)
const still = shown(0)
const shownFrames = (repeat: ReadonlyArray<number>) => repeat.reduce((sum, count) => sum + count, 0)

describe("measure", () => {
  it("counts detail away from the frame's shade, above the caption rows, and pixels changed since the frame before", () => {
    const white = new Uint8Array(PIXELS).fill(255)
    expect(measure(white, undefined)).toEqual({ detail: 0, changed: PIXELS })
    expect(measure(white, white)).toEqual({ detail: 0, changed: 0 })

    const text = white.slice()
    for (let index = 0; index < 40; index++) text[MEASURE_WIDTH * 10 + index] = 0
    // Video noise under the change level moves nothing.
    const noisy = text.slice()
    noisy[0] = 250
    expect(measure(text, white)).toEqual({ detail: 40, changed: 40 })
    expect(measure(noisy, text)).toEqual({ detail: 40, changed: 0 })

    // A caption strip at the bottom is not detail: a blank page under a caption is still blank.
    const captioned = white.slice()
    captioned.fill(17, (MEASURE_HEIGHT - CAPTION_ROWS) * MEASURE_WIDTH)
    expect(measure(captioned, white).detail).toBe(0)
    expect(isBlank(measure(captioned, white))).toBe(true)
    expect(isBlank({ detail: BLANK_DETAIL, changed: 0 })).toBe(false)

    // A device's name badge in the top-right corner is not detail either: a white page under a badge is blank.
    const badged = white.slice()
    for (let row = 1; row < 5; row++) badged.fill(31, row * MEASURE_WIDTH + MEASURE_WIDTH - 20, row * MEASURE_WIDTH + MEASURE_WIDTH - 2)
    expect(measure(badged, white).detail).toBe(72)
    expect(measure(badged, white, { width: 24, height: 6 })).toEqual({ detail: 0, changed: 72 })
    expect(measure(badged, white, { width: 10, height: 6 }).detail).toBe(40)
  })
})

describe("combine", () => {
  it("is blank only when every pane is, and sums the panes' detail and change", () => {
    expect(combine([blank, { detail: 0, changed: 7 }])).toEqual({ detail: 0, changed: 7 })
    expect(combine([blank, shown(5)])).toEqual({ detail: 500, changed: 5 })
    expect(combine([shown(1), shown(2)])).toEqual({ detail: 1000, changed: 3 })
  })
})

describe("plan", () => {
  it("cuts page loads and holds each scene a page load cut short (the branch conversation recording)", () => {
    // 5 s of white, 0.3 s of the branch, 9 s of white, 0.3 s of the next branch, 7 s of white: what Will saw.
    const frames = [...Array(50).fill(blank), cut, still, still, ...Array(90).fill(blank), cut, shown(10), still, ...Array(70).fill(blank)]
    const repeat = plan(frames, GIF_PACE)
    expect(frames.filter((frame, index) => isBlank(frame) && repeat[index]! > 0)).toEqual([])
    // Each scene shows at least GIF_PACE.scene frames, on its last frame; the end holds GIF_PACE.hold more.
    expect(repeat.slice(50, 53)).toEqual([1, 1, 1 + GIF_PACE.scene - 3])
    expect(repeat.slice(143, 146)).toEqual([1, 1, 1 + GIF_PACE.scene - 3 + GIF_PACE.hold])
    expect(shownFrames(repeat)).toBe(2 * GIF_PACE.scene + GIF_PACE.hold)
  })

  it("plays a quiet stretch in at most pace.quiet frames, evenly, ending on its last frame", () => {
    const frames = [cut, ...Array(100).fill(shown(QUIET_CHANGE - 1)), cut]
    const repeat = plan(frames, VIDEO_PACE)
    const kept = repeat.flatMap((count, index) => (count > 0 && index > 0 && index < 101 ? [index] : []))
    expect(kept).toHaveLength(VIDEO_PACE.quiet)
    expect(kept.at(-1)).toBe(100)
    expect(kept[0]).toBe(Math.round(100 / VIDEO_PACE.quiet))
    // A short quiet stretch plays whole.
    expect(plan([cut, still, still, cut], GIF_PACE)).toEqual([1, 1, 1, 1 + GIF_PACE.scene - 4 + GIF_PACE.hold])
  })

  it("keeps every frame with change a viewer follows, and holds the last", () => {
    const frames = [cut, ...Array(40).fill(shown(QUIET_CHANGE))]
    expect(plan(frames, GIF_PACE)).toEqual([...Array(40).fill(1), 1 + GIF_PACE.hold])
  })

  it("shows nothing of a recording that is blank throughout", () => {
    expect(plan(Array(30).fill(blank), VIDEO_PACE)).toEqual(Array(30).fill(0))
    expect(plan([], VIDEO_PACE)).toEqual([])
  })
})

describe("cutIdle", () => {
  // Will, 2026-10-20, on the branch terminal's recording: "most of the recording looks like an empty screen". The 12 s
  // wait for the machine kept animating (the wordmark, a spinner), so it was never quiet and played in full.
  it("plays an idle stretch, small changes however long, in at most pace.idle frames, evenly, ending on its last", () => {
    const frames = [cut, ...Array(120).fill(shown(IDLE_CHANGE - 1)), cut]
    const repeat = cutIdle(plan(frames, VIDEO_PACE), frames, VIDEO_PACE)
    const kept = repeat.flatMap((count, index) => (count > 0 && index > 0 && index < 121 ? [index] : []))
    expect(kept).toHaveLength(VIDEO_PACE.idle)
    expect(kept.at(-1)).toBe(120)
    // The frames around it, a new screen each, stay; the last holds the end.
    expect([repeat[0], repeat[121]]).toEqual([1, 1 + VIDEO_PACE.hold])
  })

  it("keeps a short idle stretch, change a viewer follows, and the scene or end hold its last frame carries", () => {
    const short = [cut, ...Array(VIDEO_PACE.idle - 1).fill(shown(IDLE_CHANGE - 1)), cut]
    expect(cutIdle(plan(short, VIDEO_PACE), short, VIDEO_PACE)).toEqual(plan(short, VIDEO_PACE))
    const busy = [cut, ...Array(60).fill(shown(IDLE_CHANGE))]
    expect(cutIdle(plan(busy, VIDEO_PACE), busy, VIDEO_PACE)).toEqual(plan(busy, VIDEO_PACE))
    // An idle stretch that ends the recording: its last frame still holds the end.
    const ending = [cut, ...Array(80).fill(shown(IDLE_CHANGE - 1))]
    const repeat = cutIdle(plan(ending, GIF_PACE), ending, GIF_PACE)
    expect(repeat.at(-1)).toBe(1 + GIF_PACE.hold)
    expect(shownFrames(repeat)).toBe(1 + GIF_PACE.idle + GIF_PACE.hold)
    // Blank frames split stretches and stay dropped.
    const split = [cut, ...Array(30).fill(shown(1)), blank, ...Array(30).fill(shown(1))]
    expect(cutIdle(plan(split, VIDEO_PACE), split, VIDEO_PACE)[31]).toBe(0)
  })
})

describe("holdChapters", () => {
  it("shows each chapter at least `least` frames, on its last shown frame or else its first non-blank one", () => {
    // a: frames 0-2 shown once; b: 3-5 blank (a page load); c: frame 6 shown 3 times, 7 dropped; d: 8-9 quiet, dropped.
    const repeat = [1, 1, 1, 0, 0, 0, 3, 0, 0, 0]
    const frames = [cut, still, still, blank, blank, blank, cut, still, still, still]
    const found = [
      { t: 0, label: "a" },
      { t: 0.3, label: "b" },
      { t: 0.6, label: "c" },
      { t: 0.8, label: "d" },
      { t: 0.8, label: "d on the same frame" },
      { t: 9, label: "after the end" },
    ]
    expect(holdChapters(repeat, frames, found, 5)).toEqual([1, 1, 3, 0, 0, 0, 5, 0, 5, 0])
    expect(holdChapters(repeat, frames, found.slice(0, 3), 2)).toEqual(repeat)
    expect(holdChapters(repeat, frames, [], 5)).toEqual(repeat)
  })
})

describe("outputStarts", () => {
  it("places each recorded frame at the output frame it starts on", () => {
    expect(outputStarts([0, 2, 0, 1, 3])).toEqual([0, 0, 2, 2, 3])
  })
})

describe("chaptersOf", () => {
  const at = (seconds: number) => 1_000_000 + seconds * 1000
  const action = (label: string, seconds: number): Mark => ({ start: at(seconds), label })
  const step = (label: string, from: number, to: number): Mark => ({ start: at(from), end: at(to), label })

  it("names each step and each action outside one, from the recording's start, once per repeat", () => {
    const marks = [
      action('A: Press Enter in "Message Smithers" field', 4.2),
      step('A: ask "hello"', 4, 4.5),
      action('A: Type in "Message Smithers" field', 4.1),
      step("A: open the composer", 4, 4.05),
      action("Open /octocat/Spoon-Knife", 1),
      action('Click "Open terminal" button', 3),
      action('Click "Open terminal" button', 3.5),
      action("Press Escape", 6),
    ]
    // Each at its seconds from the recording's start, less the picture's lead on the test's clock.
    expect(chaptersOf(marks, at(-RECORDING_LAG))).toEqual([
      { t: 1, label: "Open octocat/Spoon-Knife" },
      { t: 3, label: "Click Open terminal" },
      { t: 4, label: 'A: ask "hello"' },
      { t: 6, label: "Press Escape" },
    ])
  })

  it("keeps one of two steps that span the same time, and puts a mark before the recording at its start", () => {
    expect(chaptersOf([step("inner", 1, 2), step("outer", 1, 2)], at(0))).toHaveLength(1)
    expect(chaptersOf([step("Open A", -2, -1)], at(0))).toEqual([{ t: 0, label: "Open A" }])
    expect(chaptersOf([], at(0))).toEqual([])
    expect(chaptersOf([action("Click the page", 1), action("Press Escape", 2)], at(-RECORDING_LAG))).toEqual([{ t: 2, label: "Press Escape" }])

    // A step and an action that start in the same millisecond: the step holds the action.
    expect(chaptersOf([action("Click A", 2), step("Step", 2, 3)], at(-RECORDING_LAG))).toEqual([{ t: 2, label: "Step" }])
    expect(chaptersOf([step("Step", 2, 3), action("Click A", 2)], at(-RECORDING_LAG))).toEqual([{ t: 2, label: "Step" }])
    expect(chaptersOf([action("Click A", 2), action("Press B", 2)], at(0))).toHaveLength(2)
  })
})

describe("plainLabel", () => {
  // Will, 2026-10-20: "I don't even know what I'm looking at here". The captions named URLs, ids and field roles.
  it("names a navigation's place, a control by its name and the composer's Enter as Send; keeps a device's name", () => {
    expect(plainLabel("Open /octocat/Spoon-Knife/tree/test-branch")).toBe("Open branch test-branch")
    expect(plainLabel("Maya: Open /octocat/Hello-World/tree/test?terminal=me")).toBe("Maya: Open the terminal on test")
    expect(plainLabel("Open /app/views/cbd4c649-0f2f-4f41-9120-3e3d1c4f41fe?conversation=6e2ad834-f5e2-57b8-9757-d44d6058971f")).toBe(
      "Open a view full screen",
    )
    expect(plainLabel('Maya: Click "Share" button')).toBe("Maya: Click Share")
    expect(plainLabel('Click "Remove local-teammate" button')).toBe("Click Remove local-teammate")
    expect(plainLabel('Ben: Type in "Message Smithers" field')).toBe("Ben: Type a message")
    expect(plainLabel('Press Enter in "Message Smithers" field')).toBe("Send")
    expect(plainLabel('Maya: Press Enter in "Terminal input" field')).toBe("Maya: Press Enter in the terminal")
    expect(plainLabel('Type in "Add people" field')).toBe("Type in Add people")
    expect(plainLabel('Click "Terminal" frame')).toBe("Click the terminal")
  })

  it("says nothing of a click on the page, never shows an id, and keeps a step's own words", () => {
    expect(plainLabel("Maya: Click the page")).toBe("")
    expect(plainLabel("Click the page")).toBe("")
    expect(plainLabel("Open the terminal")).toBe("Open the terminal")
    expect(plainLabel('Ask "Reply with exactly the word: branch-1"')).toBe('Ask "Reply with exactly the word: branch-1"')
    expect(plainLabel("Ben: open the composer")).toBe("Ben: open the composer")
    expect(plainLabel("Run 3f2a9c1e-0000-4000-8000-000000000000")).toBe("Run …")
  })

  it("places every route in product words", () => {
    expect(
      [
        "/",
        "/app",
        "/flows",
        "/flows/new",
        "/runs",
        "/runs/r-1",
        "/octocat",
        "/octocat/Spoon-Knife",
        "/octocat/Spoon-Knife/issues",
        "/octocat/Spoon-Knife/issues/new",
        "/octocat/Spoon-Knife/issues/12",
        "/octocat/Spoon-Knife/stack",
        "/octocat/Spoon-Knife/blob/main/src/a.ts",
        "/octocat/Spoon-Knife/tree/main/src",
        "/octocat/Spoon-Knife/settings/x",
        "/app/runs",
        "/app/runs/abc%2Fchat%2FRespond%40x%3A1%230%2Fcall%2F0.0",
        "/app/flows/new",
      ].map(placeOfPath),
    ).toEqual([
      "Smithers",
      "the home conversation",
      "flows",
      "a flow",
      "runs",
      "a run",
      "octocat",
      "octocat/Spoon-Knife",
      "octocat/Spoon-Knife's issues",
      "a new issue",
      "issue #12",
      "octocat/Spoon-Knife's stack",
      "src/a.ts on main",
      "src on main",
      "octocat/Spoon-Knife settings/x",
      "runs",
      "a run",
      "a flow",
    ])
  })
})

describe("titleCardOf", () => {
  it("names the feature from the describe blocks or the spec, the test up to its colon, and what it proves after it", () => {
    expect(
      titleCardOf({ spec: "branch-workspace", title: "branch conversation: a question asked on a branch is stored in that branch's conversation only" }),
    ).toEqual({
      feature: "Branch workspace",
      name: "Branch conversation",
      line: "A question asked on a branch is stored in that branch's conversation only.",
    })
    expect(titleCardOf({ spec: "chat", title: "shortcut", describe: ["Composer", "keys"] })).toEqual({
      feature: "Composer · keys",
      name: "Shortcut",
      line: "",
    })
  })

  it("prefers the spec's summary, as a sentence; a line that ends a sentence keeps its mark", () => {
    expect(titleCardOf({ spec: "home", title: "declared: it renders.", summary: "  a repository's own home renders first." }).line).toBe(
      "A repository's own home renders first.",
    )
    expect(titleCardOf({ spec: "home", title: "declared: does it render?", summary: " " }).line).toBe("Does it render?")
  })
})

describe("themeFor", () => {
  // Will, 2026-10-20: "you should randomly do the gif in dark mode or light mode half of them should be dark mode".
  it("records about half the tests dark, the same test always in the same mode", () => {
    const titles = Array.from({ length: 400 }, (_, index) => `test ${index}: proves ${index}`)
    const dark = titles.filter((title) => themeFor("spec", title) === "dark").length
    expect(dark).toBeGreaterThan(160)
    expect(dark).toBeLessThan(240)
    expect(titles.map((title) => themeFor("spec", title))).toEqual(titles.map((title) => themeFor("spec", title)))
    // The spec is part of the choice: one title in two specs need not share a mode.
    expect(new Set(["a", "b", "c", "d", "e", "f"].map((spec) => themeFor(spec, "same title"))).size).toBe(2)
  })

  it("lets a test whose assertions need a mode name it", () => {
    const title = titlesThatAre("dark")
    expect(themeFor("spec", title, [{ type: "theme", description: "light" }])).toBe("light")
    expect(themeFor("spec", titlesThatAre("light"), [{ type: "summary", description: "x" }, { type: "theme", description: "dark" }])).toBe("dark")
    // Anything else in the annotation leaves the hash's choice.
    expect(themeFor("spec", title, [{ type: "theme", description: "sepia" }])).toBe("dark")
  })
})

/** A title the hash records in `mode`. */
const titlesThatAre = (mode: "light" | "dark") =>
  Array.from({ length: 50 }, (_, index) => `t${index}`).find((title) => themeFor("spec", title) === mode)!

describe("chaptersFileOf", () => {
  it("opens on the title card, moves every chapter after it, and says whether the run passed", () => {
    const card = { feature: "Branch workspace", name: "Branch terminal", line: "A reload keeps the shell." }
    expect(chaptersFileOf(card, { title: "branch terminal: …", status: "passed", theme: "dark" }, VIDEO_PACE.title, [{ t: 0, label: "Open branch main" }, { t: 3.4, label: "Type \"ls\"" }])).toEqual({
      title: "branch terminal: …",
      feature: "Branch workspace",
      name: "Branch terminal",
      line: "A reload keeps the shell.",
      status: "passed",
      theme: "dark",
      chapters: [
        { t: 0, label: "Branch terminal" },
        { t: 2, label: "Open branch main" },
        { t: 5.4, label: "Type \"ls\"" },
      ],
    })
    expect(chaptersFileOf(card, { title: "t", status: undefined, theme: "light" }, 0, []).status).toBe("unknown")
  })

  it("reads the chapters of a file and of the older bare list", () => {
    const chapters = [{ t: 0, label: "a" }]
    expect(chaptersIn(chapters)).toEqual(chapters)
    expect(chaptersIn({ status: "failed", chapters })).toEqual(chapters)
    expect(chaptersIn({ status: "failed" })).toEqual([])
    expect(chaptersIn(null)).toEqual([])
  })
})

describe("videoProblems", () => {
  it("fails a video over 5 s with fewer than 2 chapters", () => {
    expect(videoProblems(19, 0)).toEqual(["too few chapters: 0 for 19.0 s"])
    expect(videoProblems(5.5, 1)).toEqual(["too few chapters: 1 for 5.5 s"])
    expect(videoProblems(5.5, 2)).toEqual([])
    expect(videoProblems(5, 0)).toEqual([])
  })
})

describe("retime", () => {
  it("moves each chapter to its frame's place in the output, the last of several on one frame winning", () => {
    // Frames 0-9 dropped (a page load), 10-19 kept once, 20-29 dropped, 30 held 5.
    const repeat = [...Array(10).fill(0), ...Array(10).fill(1), ...Array(10).fill(0), 5]
    expect(
      retime(
        [
          { t: 0, label: "Navigate" },
          { t: 0.5, label: "Click Chat" },
          { t: 1.5, label: "Fill" },
          { t: 2.5, label: "Reload" },
          { t: 9, label: "Past the end" },
        ],
        repeat,
      ),
    ).toEqual([
      { t: 0, label: "Click Chat" },
      { t: 0.5, label: "Fill" },
      { t: 1, label: "Past the end" },
    ])
    expect(retime([{ t: 0, label: "A" }, { t: 0.1, label: "A" }], [1, 1])).toEqual([{ t: 0, label: "A" }])
    expect(retime([{ t: 0, label: "A" }], [0])).toEqual([{ t: 0, label: "A" }])
  })
})

describe("chapterAt", () => {
  it("is the last chapter started by a frame, or -1 before the first", () => {
    const found = [
      { t: 1, label: "a" },
      { t: 2.5, label: "b" },
    ]
    expect([0, 9, 10, 24, 25, 99].map((frame) => chapterAt(found, frame))).toEqual([-1, -1, 0, 0, 1, 1])
  })
})

describe("problems", () => {
  const playing = (count: number) => [cut, ...Array.from({ length: count - 1 }, (_, index) => shown(index % 2 === 0 ? 500 : 30))]

  it("passes a GIF that plays", () => {
    expect(problems(playing(60), 1024)).toEqual([])
  })

  it("names blank, frozen, flashing, short and heavy GIFs", () => {
    expect(problems(Array(20).fill(blank), 10)).toEqual(["blank: every frame"])
    expect(problems([...playing(20), blank, ...playing(20)], 10)).toEqual(["blank frames: 1 of 41"])
    expect(problems([cut, ...Array(MAX_STILL_FRAMES).fill(still)], 10)).toEqual([`frozen: one frame for ${((MAX_STILL_FRAMES + 1) / 10).toFixed(1)} s`])
    expect(problems([cut, ...Array(MAX_STILL_FRAMES - 1).fill(still)], 10)).toEqual([])
    const flash = [...playing(10), { ...shown(PIXELS), skip: 0 }, { ...shown(PIXELS), skip: PIXELS }, ...playing(10)]
    expect(problems(flash, 10)).toEqual(["glitched: 1 frames flash for 0.1 s"])
    // Two new screens in a row are no flash when nothing says the screen came back.
    expect(problems([...playing(10), shown(PIXELS), shown(PIXELS), ...playing(10)], 10)).toEqual([])
    expect(problems([cut, shown(500)], 10)).toEqual(["too short: 2 frames"])
    expect(problems(playing(20), MAX_GIF_BYTES + 1)).toEqual(["too big: 5.0 MB"])
  })
})


describe("withoutCaptures", () => {
  it("cuts declared screenshot intervals, including overlapping frame edges and recording lag", () => {
    const frames = Array(10).fill(shown(0))
    const kept = (captures: Array<{ start: number; end: number }>) => withoutCaptures(frames, captures, 1000).map((frame) => isBlank(frame) ? 0 : 1)
    expect(withoutCaptures(frames, [], 1000)).toEqual(frames)
    expect(kept([{ start: 1450, end: 1600 }])).toEqual([1, 1, 1, 0, 0, 0, 1, 1, 1, 1])
    expect(kept([{ start: 1000, end: 1100 }, { start: 1800, end: 1900 }])).toEqual([0, 1, 1, 1, 1, 1, 0, 0, 0, 1])
    expect(kept([{ start: 0, end: 500 }, { start: 3000, end: 3100 }])).toEqual(Array(10).fill(1))
    expect(frames).toEqual(Array(10).fill(shown(0)))
  })

  it("removes the measured production screenshot flash without exempting ordinary flashes", () => {
    // Measurements from the saved mobile docs GIF: frame 34 is a compressed
    // full-document capture between matching viewport frames (320 x 180).
    const frames = [...Array(34).fill({ detail: 2481, changed: 1 }),
      { detail: 8171, changed: 9516, skip: 0 }, { detail: 2486, changed: 9524, skip: 9513 },
      ...Array(20).fill({ detail: 2486, changed: 1 })]
    expect(problems(frames, 1)).toContain("glitched: 1 frames flash for 0.1 s")
    const edited = withoutCaptures(frames, [{ start: 3400, end: 3500 }], 0)
    expect(problems(edited.filter((frame) => !isBlank(frame)), 1).filter((problem) => problem.startsWith("glitched"))).toEqual([])
    expect(withoutCaptures(frames, [], 0)).toEqual(frames)
  })

  it("allocates chapter holds to real frames when a screenshot ends a chapter", () => {
    const frames = withoutCaptures(Array(20).fill(shown(0)), [{ start: 500, end: 1000 }], 0)
    const repeat = holdChapters(plan(frames, { ...GIF_PACE, quiet: 1, scene: 1, hold: 0 }), frames,
      [{ t: 0, label: "Open document" }, { t: 1, label: "Read document" }], GIF_PACE.chapter)
    expect(repeat.slice(0, 3).reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(GIF_PACE.chapter)
    expect(repeat.slice(3, 10)).toEqual(Array(7).fill(0))
  })

  it("does not excuse unmarked visual flashes or turn blank recordings into content", () => {
    const flash = [...Array(10).fill(shown(0)), { ...shown(2000), skip: 0 }, shown(2000), ...Array(10).fill(shown(0))]
    expect(problems(withoutCaptures(flash, [], 0), 10)).toContain("glitched: 1 frames flash for 0.1 s")
    expect(plan(withoutCaptures(Array(20).fill(blank), [{ start: 500, end: 900 }], 0), GIF_PACE)).toEqual(Array(20).fill(0))
  })
})
