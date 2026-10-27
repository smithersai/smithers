/**
 * The run page's vocabulary and geometry (apps/mvp decision 0014 §5): the
 * words a run's state shows, the glyphs beside them, how long a run or a step
 * took, and where each step's bar sits on the timeline. Framework-free and
 * pure, so a terminal frontend reads the same words and the same bars.
 */

/** A run's state as its engine records it. */
export type RunState = "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled";

/**
 * The closed vocabulary a run shows (decision 0009 §4, plus 0014's
 * `On another device`, `Expired` and `No access`).
 */
export type RunWord =
  | "Queued"
  | "Working"
  | "Waiting"
  | "Stopping"
  | "Stopped"
  | "Failed"
  | "Done"
  | "On another device"
  | "Expired"
  | "No access";

/** Every word, in the order a list sorts by attention. */
export const RUN_WORDS: ReadonlyArray<RunWord> = [
  "Failed",
  "Waiting",
  "Working",
  "Stopping",
  "Queued",
  "Done",
  "Stopped",
  "On another device",
  "Expired",
  "No access",
];

/** The glyph each word shows beside it. */
export const RUN_WORD_GLYPHS: Readonly<Record<RunWord, string>> = Object.freeze({
  Queued: "○",
  Working: "◌",
  Waiting: "○",
  Stopping: "◌",
  Stopped: "■",
  Failed: "✕",
  Done: "✓",
  "On another device": "↗",
  Expired: "–",
  "No access": "⊘",
});

/** The tone each word paints with: a badge variant. */
export type RunTone = "default" | "muted" | "warning" | "destructive" | "success";

/** The tone of each word. */
export const RUN_WORD_TONES: Readonly<Record<RunWord, RunTone>> = Object.freeze({
  Queued: "muted",
  Working: "default",
  Waiting: "muted",
  Stopping: "muted",
  Stopped: "muted",
  Failed: "destructive",
  Done: "success",
  "On another device": "muted",
  Expired: "muted",
  "No access": "destructive",
});

/**
 * The word a run's state shows. A run not yet settled whose cancellation was
 * requested reads `Stopping` until its engine settles it.
 */
export const runWord = (state: RunState, options: { readonly cancelRequested?: boolean } = {}): RunWord => {
  switch (state) {
    case "pending":
      return options.cancelRequested === true ? "Stopping" : "Queued";
    case "running":
      return options.cancelRequested === true ? "Stopping" : "Working";
    case "suspended":
      return options.cancelRequested === true ? "Stopping" : "Waiting";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
  }
};

/** Whether a run in `state` has settled: it changes no more. */
export const isSettled = (state: RunState): boolean =>
  state === "completed" || state === "failed" || state === "cancelled";

/** A step's state as the run's journal records it. */
export type StepState = "pending" | "running" | "completed" | "failed" | "waiting" | "skipped" | "cancelled";

/** The glyph each step state shows. */
export const STEP_GLYPHS: Readonly<Record<StepState, string>> = Object.freeze({
  pending: "○",
  running: "◌",
  completed: "✓",
  failed: "✕",
  waiting: "○",
  skipped: "–",
  cancelled: "■",
});

/** The word each step state reads as, for screen readers and the detail pane. */
export const STEP_WORDS: Readonly<Record<StepState, string>> = Object.freeze({
  pending: "Queued",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  waiting: "Waiting",
  skipped: "Skipped",
  cancelled: "Stopped",
});

/** A clock duration: `0:42`, `12:05`, `1:02:03`. Negative or unreadable time is `0:00`. */
export const clockDuration = (ms: number): string => {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
};

/** A step's duration: `12 ms`, `1.2 s`, `42 s`, then a clock from a minute on. */
export const stepDuration = (ms: number): string => {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 10_000) return `${(Math.floor(value / 100) / 10).toFixed(1)} s`;
  if (value < 60_000) return `${Math.floor(value / 1000)} s`;
  return clockDuration(value);
};

/** How long until `atMs` from `now`: `in 8 s`, `in 2 m`, `in 1 h 5 m`, or `now` once due. */
export const untilWords = (atMs: number, now: number): string => {
  const delta = atMs - now;
  if (!Number.isFinite(delta) || delta < 1000) return "now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `in ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} m`;
};

/** One step of a run, as the tree, the timeline and the detail pane read it. */
export interface StepRow {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly state: StepState;
  readonly startedAtMs: number;
  /** Absent while the step is open. */
  readonly endedAtMs: number | null;
  /** How deep the step nests: 0 at the run's own steps. */
  readonly depth: number;
  readonly attempts: number;
  readonly failedAttempts: number;
}

/** How long a step ran, or has run so far at `now`. */
export const stepElapsed = (step: Pick<StepRow, "startedAtMs" | "endedAtMs">, now: number): number =>
  Math.max((step.endedAtMs ?? now) - step.startedAtMs, 0);

/**
 * One step's bar on the timeline, as percentages of the shared axis. `instant`
 * steps ended where they began and render as a marker; `open` steps run to now.
 */
export interface WaterfallBar {
  readonly id: string;
  readonly left: number;
  readonly width: number;
  readonly instant: boolean;
  readonly open: boolean;
}

/** The axis every bar shares: from the earliest start to the latest end, an open step ending at `now`. */
export const waterfallAxis = (
  steps: ReadonlyArray<Pick<StepRow, "startedAtMs" | "endedAtMs">>,
  now: number,
): { readonly start: number; readonly end: number } => {
  if (steps.length === 0) return { start: now, end: now };
  const start = Math.min(...steps.map((step) => step.startedAtMs));
  const end = Math.max(...steps.map((step) => Math.max(step.endedAtMs ?? now, step.startedAtMs)));
  return { start, end };
};

const percent = (value: number): number => Math.round(value * 100) / 100;

/**
 * Every step's bar, in the order given. On a zero-width axis (every step an
 * instant at one moment) each bar is a marker at the start.
 */
export const waterfallBars = (steps: ReadonlyArray<StepRow>, now: number): ReadonlyArray<WaterfallBar> => {
  const axis = waterfallAxis(steps, now);
  const span = axis.end - axis.start;
  return steps.map((step) => {
    const open = step.endedAtMs === null;
    const end = Math.max(step.endedAtMs ?? now, step.startedAtMs);
    const instant = !open && end === step.startedAtMs;
    if (span <= 0) return { id: step.id, left: 0, width: 0, instant: true, open };
    return {
      id: step.id,
      left: percent(((step.startedAtMs - axis.start) / span) * 100),
      width: percent(((end - step.startedAtMs) / span) * 100),
      instant,
      open,
    };
  });
};

/** One attempt of a step: its number, how it ended, and its closed failure code. */
export interface AttemptRow {
  readonly attempt: number;
  readonly state: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly error: string | null;
}

/** An attempt as it reads: `2 ✓`, `1 ✕ unavailable`, `3 ◌` while it runs. */
export const attemptWords = (attempt: AttemptRow): string => {
  if (attempt.error !== null) return `${attempt.attempt} ✕ ${attempt.error}`;
  if (attempt.state === "failed") return `${attempt.attempt} ✕`;
  if (attempt.state === "cancelled") return `${attempt.attempt} ■`;
  if (attempt.finishedAtMs === null) return `${attempt.attempt} ◌`;
  return `${attempt.attempt} ✓`;
};

/** A journal record's time as an offset from `originMs`: `+0 ms`, `+1.2 s`. */
export const offsetWords = (atMs: number, originMs: number): string => `+${stepDuration(atMs - originMs)}`;
