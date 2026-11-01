// What makes a flow's recording reviewable, as pure functions: e2e/gifs.mjs plans each video's and GIF's frames with
// `plan` and their timeline with `chaptersOf`, and e2e/check-gifs.mjs fails a GIF that `problems` finds fault with
// and a video that `videoProblems` does.
// Frames are FPS per second and measured on a small grayscale copy (MEASURE_WIDTH × MEASURE_HEIGHT), so the pixel
// counts below are counts there.

export const FPS = 10
export const MEASURE_WIDTH = 320
export const MEASURE_HEIGHT = 180

/** A pixel this far from the frame's most common shade is detail: text, a border, an icon. */
const DETAIL_LEVEL = 24
/** A pixel that moved this far from the previous frame changed; less is video noise. */
const CHANGE_LEVEL = 16
/** Rows at the bottom that `detail` ignores: the caption strip a recording carries. */
export const CAPTION_ROWS = 12
/** Fewer detail pixels than this and the frame is blank: a white page before the app paints, or an empty shell. */
export const BLANK_DETAIL = 30
/** At most this many changed pixels and the frame repeats the previous one. */
export const STILL_CHANGE = 2
/** Fewer changed pixels than this and nothing a viewer follows happened: a caret, typing dots, one keystroke. */
export const QUIET_CHANGE = 60

/** One frame's measure: detail pixels, pixels changed since the frame before, and for a GIF's check, `skip`. */
export interface Frame {
  readonly detail: number
  readonly changed: number
  /** Pixels that changed between the frame before and the frame after: a flash leaves them alike. */
  readonly skip?: number
}

/**
 * How a plan paces its output, in frames: a quiet stretch's most, an idle stretch's most (`cutIdle`), a cut-short
 * scene's least, the end hold, the least a chapter shows, and the title card (`titleCardOf`).
 */
export interface Pace {
  readonly quiet: number
  readonly idle: number
  readonly scene: number
  readonly hold: number
  readonly chapter: number
  readonly title: number
}

/**
 * Something a test did (e2e/fixtures.ts records them): a helper's `step`, which has an `end`, or an action a page saw:
 * a navigation, click, typing or key press. Times are ms since the epoch.
 */
export interface Mark {
  readonly start: number
  readonly end?: number
  readonly label: string
}

/** A chapter of a recording: `t` seconds in, and what the test did from there. */
export interface Chapter {
  readonly t: number
  readonly label: string
}

/**
 * The video Will reviews: waits shortened hard, never skipped. Will, 2026-10-20, on the branch workspace's recordings:
 * "most of the recording looks like an empty screen"; a quiet wait now plays in 1.5 s and an idle one in 2 s.
 */
export const VIDEO_PACE: Pace = { quiet: 1.5 * FPS, idle: 2 * FPS, scene: 1.5 * FPS, hold: 2 * FPS, chapter: 1 * FPS, title: 2 * FPS }
/** The GIF preview: shorter still. */
export const GIF_PACE: Pace = { quiet: 1 * FPS, idle: 1.5 * FPS, scene: 1 * FPS, hold: 1.5 * FPS, chapter: 0.5 * FPS, title: 1.5 * FPS }

/**
 * Fewer changed pixels than this and a frame is idle: a spinner, typing dots, a caret, one line of output (1% of the
 * measured picture). An idle stretch is waiting, however long, even when it is never quite still.
 */
export const IDLE_CHANGE = Math.round(MEASURE_WIDTH * MEASURE_HEIGHT * 0.01)

/** Over this many bytes a GIF is too heavy to review. */
export const MAX_GIF_BYTES = 5 * 1024 * 1024
/** A frame repeated longer than this is a frozen GIF: longer than a quiet stretch, a scene and the end hold. */
export const MAX_STILL_FRAMES = 4 * FPS
/** A frame that differs from both neighbors in this many pixels, while they match each other, is a flash. */
const FLASH_CHANGE = Math.round(MEASURE_WIDTH * MEASURE_HEIGHT * 0.02)
const FLASH_SAME = Math.round(MEASURE_WIDTH * MEASURE_HEIGHT * 0.002)

/** A top-right box `measure` leaves out of detail, in measured pixels: a device's name badge (e2e/devices.ts). */
export interface Corner {
  readonly width: number
  readonly height: number
}

/**
 * Measures one grayscale frame (MEASURE_WIDTH × MEASURE_HEIGHT bytes) against the one before it.
 * `detail` counts pixels away from the frame's most common shade, above the caption rows and outside `corner`;
 * `changed` counts pixels that moved since `previous`, every pixel for the first frame.
 */
export const measure = (frame: Uint8Array, previous: Uint8Array | undefined, corner?: Corner): Frame => {
  const rows = MEASURE_HEIGHT - CAPTION_ROWS
  const skipped = (index: number) =>
    corner !== undefined && index % MEASURE_WIDTH >= MEASURE_WIDTH - corner.width && Math.floor(index / MEASURE_WIDTH) < corner.height
  const histogram = new Uint32Array(256)
  for (let index = 0; index < rows * MEASURE_WIDTH; index++) histogram[frame[index]!]++
  let mode = 0
  for (let value = 1; value < 256; value++) if (histogram[value]! > histogram[mode]!) mode = value
  let detail = 0
  for (let index = 0; index < rows * MEASURE_WIDTH; index++) if (Math.abs(frame[index]! - mode) > DETAIL_LEVEL && !skipped(index)) detail++
  return { detail, changed: changedBetween(frame, previous) }
}

/**
 * One recorded frame of several panes side by side (e2e/devices.ts' tabs): blank only when every pane is, so the dark
 * gap between panes is never detail; its detail and change are the panes' summed.
 */
export const combine = (panes: ReadonlyArray<Frame>): Frame => ({
  detail: panes.every(isBlank) ? 0 : panes.reduce((sum, pane) => sum + pane.detail, 0),
  changed: panes.reduce((sum, pane) => sum + pane.changed, 0),
})

/** Pixels that moved between two grayscale frames; every pixel when there is no earlier frame. */
export const changedBetween = (frame: Uint8Array, previous: Uint8Array | undefined) => {
  if (previous === undefined) return frame.length
  let changed = 0
  for (let index = 0; index < frame.length; index++) if (Math.abs(frame[index]! - previous[index]!) > CHANGE_LEVEL) changed++
  return changed
}

export const isBlank = (frame: Frame) => frame.detail < BLANK_DETAIL

/**
 * How many times each recorded frame goes into the output (0 drops it), from each frame's `measure`, at `pace`.
 *
 * - Blank frames go: a page loading under the dev server is seconds of white that reads as a glitch.
 * - A quiet stretch keeps at most `pace.quiet` frames, picked evenly and ending on its last, so a wait plays fast.
 * - A scene a blank cuts short repeats its last frame up to `pace.scene`, so a page shown for a moment can be read.
 * - The last frame holds `pace.hold` more.
 *
 * Every frame with change a viewer follows (a streamed answer, a new screen) stays.
 */
export const plan = (frames: ReadonlyArray<Frame>, pace: Pace) => {
  const repeat = frames.map(() => 0)
  let scene: Array<number> = []
  const endScene = () => {
    if (scene.length === 0) return
    const shown = scene.reduce((sum, index) => sum + repeat[index]!, 0)
    // A scene's first frame always shows, so it has a last shown frame.
    const last = scene.findLast((index) => repeat[index]! > 0)!
    repeat[last]! += Math.max(0, pace.scene - shown)
    scene = []
  }
  let quiet: Array<number> = []
  const endQuiet = () => {
    const keep = Math.min(quiet.length, pace.quiet)
    for (let pick = 1; pick <= keep; pick++) repeat[quiet[Math.round((pick * quiet.length) / keep) - 1]!] = 1
    quiet = []
  }
  for (const [index, frame] of frames.entries()) {
    if (isBlank(frame)) {
      endQuiet()
      endScene()
      continue
    }
    scene.push(index)
    if (frame.changed < QUIET_CHANGE && scene.length > 1) {
      quiet.push(index)
      continue
    }
    endQuiet()
    repeat[index] = 1
  }
  endQuiet()
  endScene()
  const last = repeat.findLastIndex((count) => count > 0)
  if (last >= 0) repeat[last]! += pace.hold
  return repeat
}

/**
 * `repeat` (a `plan`) with each idle stretch, consecutive frames that each changed less than IDLE_CHANGE, cut to at most
 * `pace.idle` shown frames, picked evenly and ending on its last, which keeps any scene or end hold it carried. A wait
 * that a spinner or a blinking caret keeps from being quiet still plays fast.
 */
export const cutIdle = (repeat: ReadonlyArray<number>, frames: ReadonlyArray<Frame>, pace: Pace) => {
  const cut = [...repeat]
  let run: Array<number> = []
  const endRun = () => {
    const shown = run.filter((index) => cut[index]! > 0)
    run = []
    if (shown.length <= pace.idle) return
    const last = shown.at(-1)!
    const extra = cut[last]! - 1
    for (const index of shown) cut[index] = 0
    for (let pick = 1; pick <= pace.idle; pick++) cut[shown[Math.round((pick * shown.length) / pace.idle) - 1]!] = 1
    cut[last]! += extra
  }
  for (const [index, frame] of frames.entries()) {
    if (!isBlank(frame) && frame.changed < IDLE_CHANGE) run.push(index)
    else endRun()
  }
  endRun()
  return cut
}

/**
 * `repeat` with every chapter shown at least `least` frames, so a viewer can read each step: a chapter that would show
 * less holds its last shown frame longer, and one whose frames a quiet stretch dropped shows its first frame. A
 * chapter of blank frames only (a page load), or one that starts on the same frame as the next, stays empty. `found`
 * are the chapters on the recording's timeline, over `frames`.
 */
export const holdChapters = (repeat: ReadonlyArray<number>, frames: ReadonlyArray<Frame>, found: ReadonlyArray<Chapter>, least: number) => {
  const held = [...repeat]
  const starts = found.map((chapter) => Math.min(Math.round(chapter.t * FPS), held.length))
  for (const [index, from] of starts.entries()) {
    const to = starts[index + 1] ?? held.length
    let shown = 0
    let last = -1
    for (let frame = from; frame < to; frame++) {
      if (held[frame]! === 0) continue
      shown += held[frame]!
      last = frame
    }
    if (last >= 0 && shown < least) held[last]! += least - shown
    if (last >= 0) continue
    const first = frames.findIndex((frame, at) => at >= from && at < to && !isBlank(frame))
    if (first >= 0) held[first] = least
  }
  return held
}

/** A known screenshot-tool interval on the test clock, retained in the media manifest. */
export interface Capture { readonly start: number; readonly end: number }

/** Remove only declared evidence captures, never an inferred visual glitch.
 * Chromium temporarily resizes tall documents during a full-page screenshot.
 * Frame intervals overlap the cut conservatively, including the recording lag.
 */
export const withoutCaptures = (frames: ReadonlyArray<Frame>, captures: ReadonlyArray<Capture>, startedAt: number) =>
  frames.map((frame, index) => captures.some(({ start, end }) => {
    const from = Math.max(startedAt, start - RECORDING_LAG * 1000)
    return startedAt + index * 1000 / FPS < end && startedAt + (index + 1) * 1000 / FPS > from
  }) ? { detail: 0, changed: 0 } : frame)

/** Where each recorded frame starts in the output, in output frames, for a `plan`'s repeats. */
export const outputStarts = (repeat: ReadonlyArray<number>) => {
  const starts: Array<number> = []
  let at = 0
  for (const count of repeat) {
    starts.push(at)
    at += count
  }
  return starts
}

/**
 * How far a recording's picture runs ahead of the test's clock, in seconds: a page turns white for a reload 0.05 to
 * 0.12 s before the test hears of the navigation (measured on the branch-workspace recordings, 2026-10-20).
 */
export const RECORDING_LAG = 0.15

/**
 * A recording's chapters, from what its test did: every helper `step`, and every action outside one, at its seconds
 * from `startedAt` (the recording's first frame) less RECORDING_LAG, never before 0, named in product words
 * (`plainLabel`). What happens inside a step, an action or a nested step, is part of its chapter. A repeated label,
 * such as a retried click or typing, is one chapter; an action with nothing to say (a click on the page) is none.
 */
export const chaptersOf = (marks: ReadonlyArray<Mark>, startedAt: number) => {
  // Earlier first; of two that start together, the longer, which holds the other.
  const sorted = [...marks].sort((left, right) => left.start - right.start || (right.end ?? right.start) - (left.end ?? left.start))
  const inside = (mark: Mark, index: number) =>
    sorted.some(
      (outer, at) => at < index && outer.end !== undefined && outer.start <= mark.start && (mark.end ?? mark.start) <= outer.end,
    )
  const found: Array<Chapter> = []
  for (const [index, mark] of sorted.entries()) {
    if (inside(mark, index)) continue
    const label = plainLabel(mark.label)
    if (label === "") continue
    const next = { t: Math.max(0, Number(((mark.start - startedAt) / 1000 - RECORDING_LAG).toFixed(3))), label }
    if (found.at(-1)?.label !== next.label) found.push(next)
  }
  return found
}

/** A video longer than this needs at least MIN_CHAPTERS chapters, so its timeline can be followed. */
export const CHAPTERED_SECONDS = 5
export const MIN_CHAPTERS = 2

/**
 * Whether a test whose Playwright status is `status` gets a video and GIF. A skipped test did nothing to show: its
 * page's recording is blank, so it gets neither, and no check of one fails the run.
 */
export const recordable = (status: string | undefined) => status !== "skipped"

/** What is wrong with a video Will reviews, from its length in seconds and its chapters: empty when it is fine. */
export const videoProblems = (seconds: number, chapterCount: number) =>
  seconds > CHAPTERED_SECONDS && chapterCount < MIN_CHAPTERS
    ? [`too few chapters: ${chapterCount} for ${seconds.toFixed(1)} s`]
    : []

/**
 * Chapters on the output's timeline: each at the output time of its recorded frame, under `repeat`. Chapters that land
 * on the same output frame (actions while a page loaded) keep the last, which is what the screen shows next.
 */
export const retime = (found: ReadonlyArray<Chapter>, repeat: ReadonlyArray<number>) => {
  const starts = outputStarts(repeat)
  const total = repeat.reduce((sum, count) => sum + count, 0)
  const timed: Array<Chapter> = []
  for (const chapter of found) {
    const at = starts[Math.min(Math.round(chapter.t * FPS), repeat.length - 1)]!
    const next = { t: Number((Math.min(at, Math.max(0, total - 1)) / FPS).toFixed(1)), label: chapter.label }
    if (timed.at(-1)?.t === next.t) timed.pop()
    if (timed.at(-1)?.label !== next.label) timed.push(next)
  }
  return timed
}

/** The chapter showing at recorded frame `frame`: the last one that started at or before it, or -1. */
export const chapterAt = (found: ReadonlyArray<Chapter>, frame: number) => found.findLastIndex((chapter) => Math.round(chapter.t * FPS) <= frame)

/** The longest run of `test`-matching frames, in frames. */
const longestRun = (frames: ReadonlyArray<Frame>, test: (frame: Frame) => boolean) => {
  let longest = 0
  let run = 0
  for (const frame of frames) {
    run = test(frame) ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

/**
 * What is wrong with a GIF, from its frames at FPS (each with `measure` and `skip`, the pixels that changed between its
 * neighbors) and its size in bytes: empty when it is fine to review.
 */
export const problems = (frames: ReadonlyArray<Frame>, bytes: number) => {
  const found: Array<string> = []
  if (frames.length < GIF_PACE.scene) found.push(`too short: ${frames.length} frames`)
  const blank = frames.filter(isBlank).length
  if (blank > 0 && blank === frames.length) found.push("blank: every frame")
  else if (blank > 0) found.push(`blank frames: ${blank} of ${frames.length}`)
  const still = longestRun(frames, (frame) => frame.changed <= STILL_CHANGE) + 1
  if (still > MAX_STILL_FRAMES) found.push(`frozen: one frame for ${(still / FPS).toFixed(1)} s`)
  const flashes = frames.filter(
    (frame, index) =>
      index > 0 && index < frames.length - 1 && frame.changed > FLASH_CHANGE && frames[index + 1]!.changed > FLASH_CHANGE && (frame.skip ?? Number.POSITIVE_INFINITY) <= FLASH_SAME,
  ).length
  if (flashes > 0) found.push(`glitched: ${flashes} frames flash for 0.1 s`)
  if (bytes > MAX_GIF_BYTES) found.push(`too big: ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  return found
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Where a path in the app goes, in product words: `/octocat/Spoon-Knife/tree/main?terminal=me` is "the terminal on main". */
export const placeOfPath = (target: string): string => {
  const url = new URL(target, "http://app")
  const parts = url.pathname.split("/").filter((part) => part !== "").map(decodeURIComponent)
  const terminal = url.searchParams.get("terminal")
  if (parts.length === 0) return "Smithers"
  if (parts[0] === "app") {
    if (parts[1] === "views") return "a view full screen"
    // The app's own pages under /app: its runs and flows (src/router.tsx), named as at the top level.
    if (parts[1] === "runs" || parts[1] === "flows") return placeOfPath(`/${parts.slice(1).map(encodeURIComponent).join("/")}`)
    return "the home conversation"
  }
  if (parts[0] === "flows") return parts.length === 1 ? "flows" : "a flow"
  if (parts[0] === "runs") return parts.length === 1 ? "runs" : "a run"
  if (parts.length === 1) return parts[0]!
  const repo = `${parts[0]}/${parts[1]}`
  const [section, ref, ...path] = parts.slice(2)
  if (section === undefined) return repo
  if (section === "issues") return ref === undefined ? `${repo}'s issues` : ref === "new" ? "a new issue" : `issue #${ref}`
  if (section === "stack") return `${repo}'s stack`
  if ((section === "tree" || section === "blob" || section === "raw") && ref !== undefined) {
    if (terminal !== null) return `the terminal on ${ref}`
    return path.length === 0 ? `branch ${ref}` : `${path.join("/")} on ${ref}`
  }
  return `${repo} ${parts.slice(2).join("/")}`.replace(UUID, "…")
}

const FIELDS: Record<string, string> = { "Message Smithers": "the composer", "Terminal input": "the terminal" }
const fieldOf = (name: string) => FIELDS[name] ?? name

/**
 * A chapter's label in product words for the caption and the timeline, never code: a navigation names the place
 * (`placeOfPath`), not its URL; `Click "Share" button` is `Click Share`; Enter in the composer is `Send`; typing in a
 * field names the field; a click on the page says nothing (""), so it is no chapter. Ids never show. A device's name
 * before the action (`Maya: `) stays. Anything else, such as a helper's step, keeps its words.
 */
export const plainLabel = (label: string): string => {
  const match = /^((?:[^:"]{1,40}): )?(.*)$/s.exec(label)!
  const who = match[1] ?? ""
  const action = match[2]!
  const plain = (() => {
    const open = /^Open (\/\S*)$/.exec(action)
    if (open) return `Open ${placeOfPath(open[1]!)}`
    if (/^Click (the page|frame|"Terminal" frame)$/.test(action)) return action.endsWith("frame") ? "Click the terminal" : ""
    const click = /^Click "(.+)" (?:button|link|toggle|menu|field|option|combobox|tab|checkbox|radio)$/.exec(action)
    if (click) return `Click ${click[1]}`
    const typed = /^Type in "(.+)" field$/.exec(action)
    if (typed) return typed[1] === "Message Smithers" ? "Type a message" : `Type in ${fieldOf(typed[1]!)}`
    const pressed = /^Press (\S+) in "(.+)" field$/.exec(action)
    if (pressed) return pressed[1] === "Enter" && pressed[2] === "Message Smithers" ? "Send" : `Press ${pressed[1]} in ${fieldOf(pressed[2]!)}`
    return action
  })()
  return plain === "" ? "" : `${who}${plain}`.replace(UUID, "…")
}

/** What a recording's title card says: the feature, the test's name, and one line saying what the test proves. */
export interface TitleCard {
  readonly feature: string
  readonly name: string
  readonly line: string
}

const sentence = (text: string) => {
  const trimmed = text.trim()
  return trimmed === "" ? "" : `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}`
}

/**
 * The title card a recording opens on (e2e/gifs.mjs, `pace.title` frames): the feature is the test's describe blocks,
 * else its spec's name (`branch-workspace` is "Branch workspace"); the name is its title up to the first colon; the
 * line is the spec's `summary` annotation, else the title after the colon, as a sentence.
 */
export const titleCardOf = (test: {
  readonly spec: string
  readonly title: string
  readonly describe?: ReadonlyArray<string> | undefined
  readonly summary?: string | undefined
}): TitleCard => {
  const feature = test.describe !== undefined && test.describe.length > 0 ? test.describe.join(" · ") : sentence(test.spec.replace(/[-_]+/g, " "))
  const colon = test.title.indexOf(":")
  const name = sentence(colon < 0 ? test.title : test.title.slice(0, colon))
  const rest = sentence(colon < 0 ? "" : test.title.slice(colon + 1))
  const line = test.summary !== undefined && test.summary.trim() !== "" ? sentence(test.summary) : rest === "" ? "" : /[.!?]$/.test(rest) ? rest : `${rest}.`
  return { feature, name, line }
}

/** The app's two modes, as its theme setting names them (src/features/theme/contract.ts). */
export type Theme = "light" | "dark"

/**
 * The mode a test records in: about half the recordings are dark (Will, 2026-10-20: "half of them should be dark
 * mode"), chosen by a hash of the spec and the test's title, so a test re-recorded keeps its mode. A test whose
 * assertions depend on the mode it starts in names it with a `theme` annotation (`{ type: "theme", description:
 * "light" }`), which wins.
 */
export const themeFor = (spec: string, title: string, annotations: ReadonlyArray<{ readonly type: string; readonly description?: string | undefined }> = []): Theme => {
  const named = annotations.find((annotation) => annotation.type === "theme")?.description
  if (named === "light" || named === "dark") return named
  // FNV-1a, 32 bits, then MurmurHash3's finalizer, which spreads every input bit into the low bit FNV-1a leaves weak:
  // stable across runs, machines and Node versions.
  let hash = 0x811c9dc5
  for (const char of `${spec}\u0000${title}`) {
    hash ^= char.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash & 1) === 0 ? "light" : "dark"
}

/** A recording's `<test>.chapters.json`: what it shows, whether its test passed, and its timeline after the title card. */
export interface ChaptersFile extends TitleCard {
  readonly title: string
  /** Playwright's status for the run: `passed`, `failed`, `timedOut`, `skipped` or `interrupted`. */
  readonly status: string
  /** The mode the app was recorded in (`themeFor`). */
  readonly theme: Theme
  readonly chapters: ReadonlyArray<Chapter>
}

/**
 * The chapters file for a video that opens on `card` for `titleFrames` frames, then plays `chapters` (`retime`'s, on
 * the recording's own output): the card is the first chapter, and every other moves later by its length.
 */
export const chaptersFileOf = (
  card: TitleCard,
  test: { readonly title: string; readonly status: string | undefined; readonly theme: Theme },
  titleFrames: number,
  chapters: ReadonlyArray<Chapter>,
): ChaptersFile => ({
  title: test.title,
  ...card,
  status: test.status ?? "unknown",
  theme: test.theme,
  chapters: [
    { t: 0, label: card.name },
    ...chapters.map((chapter) => ({ t: Number((chapter.t + titleFrames / FPS).toFixed(1)), label: chapter.label })),
  ],
})

/** The chapters in a `<test>.chapters.json`: the file's `chapters`, or the whole file when it is the older bare list. */
export const chaptersIn = (file: unknown): ReadonlyArray<Chapter> =>
  Array.isArray(file) ? file : (file as { readonly chapters?: ReadonlyArray<Chapter> } | null)?.chapters ?? []
