/** @jsxImportSource react */
// The run page's pieces under happy-dom: real createRoot + act.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  attemptWords,
  clockDuration,
  isSettled,
  offsetWords,
  RUN_WORD_GLYPHS,
  RUN_WORD_TONES,
  RUN_WORDS,
  RunDetails,
  type RunDetailsJob,
  RunHeader,
  RunJournal,
  RunList,
  type RunState,
  RunStatusPill,
  RunWaterfall,
  runWord,
  smithersUiCss,
  SpanDetail,
  SpanTree,
  STEP_GLYPHS,
  STEP_WORDS,
  stepDuration,
  stepElapsed,
  type StepRow,
  untilWords,
  waitWords,
  waterfallAxis,
  waterfallBars,
} from "../src";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  if (root === undefined) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const mounted = root;
  await act(async () => mounted.render(element));
}

const $ = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);
const $$ = (selector: string) => [...container!.querySelectorAll<HTMLElement>(selector)];
const key = (element: HTMLElement, name: string) =>
  act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });

const step = (id: string, overrides: Partial<StepRow> = {}): StepRow => ({
  id,
  label: id,
  kind: "ActionCall",
  state: "completed",
  startedAtMs: 1_000,
  endedAtMs: 2_000,
  depth: 0,
  attempts: 1,
  failedAttempts: 0,
  ...overrides,
});

describe("the run vocabulary", () => {
  test("every state reads as one word, and a requested stop reads Stopping until it settles", () => {
    const table: ReadonlyArray<readonly [RunState, boolean, string]> = [
      ["pending", false, "Queued"],
      ["pending", true, "Stopping"],
      ["running", false, "Working"],
      ["running", true, "Stopping"],
      ["suspended", false, "Waiting"],
      ["suspended", true, "Stopping"],
      ["completed", false, "Done"],
      ["completed", true, "Done"],
      ["failed", false, "Failed"],
      ["failed", true, "Failed"],
      ["cancelled", false, "Stopped"],
      ["cancelled", true, "Stopped"],
    ];
    for (const [state, cancelRequested, word] of table) expect([state, cancelRequested, runWord(state, { cancelRequested })]).toEqual([state, cancelRequested, word]);
    expect(runWord("running")).toBe("Working");
  });

  test("a settled run changes no more", () => {
    expect(["pending", "running", "suspended"].map((state) => isSettled(state as RunState))).toEqual([false, false, false]);
    expect(["completed", "failed", "cancelled"].map((state) => isSettled(state as RunState))).toEqual([true, true, true]);
  });

  test("every word has a glyph and a tone; failures are ember, done is success, nothing else shouts", () => {
    expect(Object.keys(RUN_WORD_GLYPHS).sort()).toEqual([...RUN_WORDS].sort());
    expect(Object.keys(RUN_WORD_TONES).sort()).toEqual([...RUN_WORDS].sort());
    expect(RUN_WORD_TONES.Failed).toBe("destructive");
    expect(RUN_WORD_TONES.Done).toBe("success");
    expect(RUN_WORD_TONES.Working).toBe("default");
    expect(Object.isFrozen(RUN_WORD_GLYPHS) && Object.isFrozen(RUN_WORD_TONES)).toBe(true);
    expect(Object.keys(STEP_GLYPHS)).toEqual(Object.keys(STEP_WORDS));
  });

  test("durations: a clock for a run, milliseconds and seconds for a step", () => {
    expect(clockDuration(42_000)).toBe("0:42");
    expect(clockDuration(725_999)).toBe("12:05");
    expect(clockDuration(3_723_000)).toBe("1:02:03");
    expect(clockDuration(-5)).toBe("0:00");
    expect(clockDuration(Number.NaN)).toBe("0:00");
    expect(stepDuration(12.4)).toBe("12 ms");
    expect(stepDuration(999)).toBe("999 ms");
    expect(stepDuration(1_234)).toBe("1.2 s");
    expect(stepDuration(9_999)).toBe("9.9 s");
    expect(stepDuration(42_500)).toBe("42 s");
    expect(stepDuration(65_000)).toBe("1:05");
    expect(stepDuration(-1)).toBe("0 ms");
    expect(stepDuration(Number.POSITIVE_INFINITY)).toBe("0 ms");
  });

  test("until: seconds, minutes, hours, and now once due", () => {
    expect(untilWords(10_000, 2_000)).toBe("in 8 s");
    expect(untilWords(2_000 + 125_000, 2_000)).toBe("in 2 m");
    expect(untilWords(3_600_000, 0)).toBe("in 1 h");
    expect(untilWords(3_900_000, 0)).toBe("in 1 h 5 m");
    expect(untilWords(500, 0)).toBe("now");
    expect(untilWords(0, 5_000)).toBe("now");
    expect(untilWords(Number.NaN, 0)).toBe("now");
  });

  test("a step's elapsed time runs to now while open, and never goes below zero", () => {
    expect(stepElapsed({ startedAtMs: 1_000, endedAtMs: 1_500 }, 9_000)).toBe(500);
    expect(stepElapsed({ startedAtMs: 1_000, endedAtMs: null }, 4_000)).toBe(3_000);
    expect(stepElapsed({ startedAtMs: 5_000, endedAtMs: null }, 4_000)).toBe(0);
  });

  test("attempts and journal offsets as they read", () => {
    expect(attemptWords({ attempt: 1, state: "failed", startedAtMs: 0, finishedAtMs: 1, error: "unavailable" })).toBe("1 ✕ unavailable");
    expect(attemptWords({ attempt: 2, state: "failed", startedAtMs: 0, finishedAtMs: 1, error: null })).toBe("2 ✕");
    expect(attemptWords({ attempt: 3, state: "started", startedAtMs: 0, finishedAtMs: null, error: null })).toBe("3 ◌");
    expect(attemptWords({ attempt: 2, state: "succeeded", startedAtMs: 0, finishedAtMs: 1, error: null })).toBe("2 ✓");
    expect(offsetWords(1_000, 1_000)).toBe("+0 ms");
    expect(offsetWords(2_234, 1_000)).toBe("+1.2 s");
  });

  test("a wait reads its kind, since when and when it wakes, leaving out what it lacks", () => {
    expect(waitWords({ kind: "timer", sinceMs: 0, wakeAtMs: 70_000 }, 10_000)).toBe("timer · since 10s ago · wakes in 1 m");
    expect(waitWords({ kind: "human", sinceMs: null, wakeAtMs: null }, 10_000)).toBe("human");
  });
});

describe("waterfallBars", () => {
  test("bars share an axis from the earliest start to the latest end", () => {
    const bars = waterfallBars([step("a", { startedAtMs: 0, endedAtMs: 1_000 }), step("b", { startedAtMs: 1_000, endedAtMs: 4_000 })], 9_999);
    expect(bars).toEqual([
      { id: "a", left: 0, width: 25, instant: false, open: false },
      { id: "b", left: 25, width: 75, instant: false, open: false },
    ]);
  });

  test("an open step runs to now, which stretches the axis", () => {
    expect(waterfallAxis([step("a", { startedAtMs: 0, endedAtMs: 1_000 }), step("b", { startedAtMs: 500, endedAtMs: null })], 2_000)).toEqual({ start: 0, end: 2_000 });
    const bars = waterfallBars([step("a", { startedAtMs: 0, endedAtMs: 1_000 }), step("b", { startedAtMs: 500, endedAtMs: null })], 2_000);
    expect(bars[1]).toEqual({ id: "b", left: 25, width: 75, instant: false, open: true });
  });

  test("a step that ended where it began is an instant marker", () => {
    const bars = waterfallBars([step("a", { startedAtMs: 0, endedAtMs: 3_000 }), step("b", { startedAtMs: 1_000, endedAtMs: 1_000 })], 0);
    expect(bars[1]).toEqual({ id: "b", left: 33.33, width: 0, instant: true, open: false });
  });

  test("a zero-width axis makes every bar a marker at the start; no steps make no bars", () => {
    expect(waterfallBars([step("a", { startedAtMs: 5, endedAtMs: 5 }), step("b", { startedAtMs: 5, endedAtMs: 5 })], 0)).toEqual([
      { id: "a", left: 0, width: 0, instant: true, open: false },
      { id: "b", left: 0, width: 0, instant: true, open: false },
    ]);
    expect(waterfallBars([step("a", { startedAtMs: 9_000, endedAtMs: null })], 1_000)).toEqual([
      { id: "a", left: 0, width: 0, instant: true, open: true },
    ]);
    expect(waterfallBars([], 0)).toEqual([]);
    expect(waterfallAxis([], 7)).toEqual({ start: 7, end: 7 });
  });
});

describe("RunStatusPill and RunHeader", () => {
  test("the pill shows the word, its glyph and tone", async () => {
    await render(<RunStatusPill state="failed" />);
    const pill = $("[data-slot='run-status']")!;
    expect(pill.textContent).toBe("✕Failed");
    expect(pill.dataset.word).toBe("Failed");
    expect(pill.className).toContain("sui-badge-destructive");
  });

  test("a word overrides the state's", async () => {
    await render(<RunStatusPill state="running" word="On another device" />);
    expect($("[data-slot='run-status']")!.dataset.word).toBe("On another device");
  });

  test("the header names the run, its state in a live region, its elapsed clock and host, then its acts", async () => {
    await render(
      <RunHeader
        title="release-notes"
        state="completed"
        startedAtMs={1_000}
        finishedAtMs={43_000}
        now={99_000}
        host="This device"
        actions={<button type="button">Retry</button>}
      />,
    );
    expect($("h1")!.textContent).toBe("release-notes");
    expect($("[role='status']")!.textContent).toBe("✓Done");
    expect($("[role='status']")!.getAttribute("aria-live")).toBe("polite");
    expect($("[aria-label='Elapsed']")!.textContent).toBe("0:42");
    expect($(".sui-run-header-host")!.textContent).toBe("This device");
    expect($(".sui-run-header-actions button")!.textContent).toBe("Retry");
  });

  test("a live run counts to now, reads Stopping once a stop is requested, and takes a heading level", async () => {
    await render(
      <RunHeader title="triage" state="running" cancelRequested startedAtMs={0} finishedAtMs={null} now={65_000} host="This device" headingLevel={2} />,
    );
    expect($("h2")!.textContent).toBe("triage");
    expect($("[role='status']")!.textContent).toBe("◌Stopping");
    expect($("[aria-label='Elapsed']")!.textContent).toBe("1:05");
    expect($(".sui-run-header-actions")).toBeNull();
  });

  test("a header with a word override", async () => {
    await render(<RunHeader title="x" state="running" word="No access" startedAtMs={0} finishedAtMs={null} now={0} host="Cloud" />);
    expect($("[role='status']")!.textContent).toBe("⊘No access");
  });
});

describe("RunList", () => {
  const runs = [
    { id: "r1", flow: "release-notes", state: "completed" as const, startedAtMs: 0, finishedAtMs: 42_000, href: "/app/runs/r1" },
    { id: "r2", flow: "triage", state: "running" as const, cancelRequested: true, startedAtMs: 50_000, finishedAtMs: null, href: "/app/runs/r2" },
  ];

  test("one row per run: its flow as a link, its state, when it started and how long it ran", async () => {
    await render(<RunList runs={runs} now={60_000} />);
    const rows = $$("tbody tr");
    expect(rows.map((row) => row.dataset.run)).toEqual(["r1", "r2"]);
    expect(rows[0]!.querySelector("a")!.getAttribute("href")).toBe("/app/runs/r1");
    expect(rows[0]!.querySelector("a")!.textContent).toBe("release-notes");
    expect(rows[0]!.textContent).toContain("Done");
    expect(rows[0]!.textContent).toContain("1m ago");
    expect(rows[0]!.textContent).toContain("0:42");
    expect(rows[1]!.textContent).toContain("Stopping");
    expect(rows[1]!.textContent).toContain("10s ago");
    expect(rows[1]!.textContent).toContain("0:10");
    expect($("table")!.getAttribute("aria-label")).toBe("Runs");
  });

  test("a plain link takes only a navigable href; anything else shows the name alone", async () => {
    await render(<RunList runs={[{ ...runs[0]!, href: "javascript:alert(1)" }]} now={60_000} />);
    expect($("a")).toBeNull();
    expect($(".sui-run-list-flow")!.textContent).toBe("release-notes");
  });

  test("the host renders the links", async () => {
    const renderLink = (href: string, children: ReactNode) => <span data-link={href}>{children}</span>;
    await render(<RunList runs={runs} now={60_000} renderLink={renderLink} />);
    expect($$("[data-link]").map((link) => link.dataset.link)).toEqual(["/app/runs/r1", "/app/runs/r2"]);
    expect($("a")).toBeNull();
  });

  test("no runs: the empty state, or the host's", async () => {
    await render(<RunList runs={[]} now={0} />);
    expect($("[data-slot='run-list']")!.dataset.empty).toBe("true");
    expect($("[data-slot='empty-state']")!.textContent).toBe("No runs");
    await render(<RunList runs={[]} now={0} empty={<p>Nothing yet</p>} />);
    expect($("[data-slot='run-list'] p")!.textContent).toBe("Nothing yet");
    expect($("[data-slot='empty-state']")).toBeNull();
  });
});

describe("RunList like a CI system's runs", () => {
  const runs = [
    {
      id: "c1", flow: "todo", state: "failed" as const, startedAtMs: 0, finishedAtMs: 30_000, href: "/app/runs/todo:1",
      trigger: "commit", branch: "todo/fix-the-thing", actor: "maya", where: "Cloud", toggleHref: "/app/runs?open=c1",
      expanded: true,
    },
    {
      id: "d1", flow: "app/theme/set", state: "completed" as const, startedAtMs: 40_000, finishedAtMs: 40_500,
      href: "/app/runs/d1", trigger: "button", branch: null, actor: "you", toggleHref: "/app/runs?open=d1",
    },
  ];

  test("trigger, branch and actor columns show once any row has them, with none as a dash", async () => {
    await render(<RunList runs={runs} now={60_000} />);
    expect($$("thead th").map((head) => head.textContent)).toEqual(
      ["Details", "Flow", "Status", "Trigger", "Branch", "Actor", "Started", "Duration"],
    );
    const [cloud, device] = $$("tbody tr[data-run]");
    expect(cloud!.querySelector("[data-slot='run-trigger']")!.textContent).toBe("commit");
    expect(cloud!.querySelector("[data-slot='run-branch']")!.textContent).toBe("todo/fix-the-thing");
    expect(cloud!.querySelector("[data-slot='run-actor']")!.textContent).toBe("maya");
    expect(cloud!.querySelector("[data-slot='run-where']")!.textContent).toBe("Cloud");
    expect(device!.querySelector("[data-slot='run-branch']")!.textContent).toBe("–");
    expect(device!.querySelector("[data-slot='run-where']")).toBeNull();
  });

  test("a toggle links to the row opened or closed; only an expanded row shows its details, full width", async () => {
    await render(<RunList runs={runs} now={60_000} renderDetails={(run) => <p data-details={run.id}>details</p>} />);
    const toggles = $$("[data-slot='run-details-toggle']");
    expect(toggles.map((toggle) => toggle.getAttribute("aria-label"))).toEqual(["Hide todo", "Show app/theme/set"]);
    expect(toggles.map((toggle) => toggle.closest("a")!.getAttribute("href"))).toEqual(["/app/runs?open=c1", "/app/runs?open=d1"]);
    expect($$("[data-details]").map((details) => details.dataset.details)).toEqual(["c1"]);
    expect($("tr[data-run-details='c1'] td")!.getAttribute("colspan")).toBe("8");
    expect($("tr[data-run='c1']")!.dataset.expanded).toBe("true");
    // Without a renderer, an expanded row shows nothing more.
    await render(<RunList runs={runs} now={60_000} />);
    expect($("tr[data-run-details]")).toBeNull();
  });

  test("a list without the CI fields keeps its four columns", async () => {
    await render(<RunList runs={[{ id: "r", flow: "f", state: "running", startedAtMs: 0, finishedAtMs: null, href: "/r", toggleHref: "javascript:x" }]} now={1_000} />);
    expect($$("thead th").map((head) => head.textContent)).toEqual(["Details", "Flow", "Status", "Started", "Duration"]);
    // A toggle whose href isn't navigable shows the chevron alone.
    expect($("[data-slot='run-details-toggle']")!.closest("a")).toBeNull();
  });
});

describe("RunDetails", () => {
  const jobs: ReadonlyArray<RunDetailsJob> = [
    {
      id: "root", label: "todo", state: "failed", href: null,
      steps: [
        { id: "s1", label: "todo/Plan", state: "completed", startedAtMs: 0, endedAtMs: 1_200, logs: 2 },
        { id: "s2", label: "todo/Publish", state: "failed", startedAtMs: 1_200, endedAtMs: 4_200, error: "GitHubRefused", logs: 0 },
        { id: "s3", label: "todo/Review", state: "pending", startedAtMs: 4_200, endedAtMs: null, logs: 0 },
      ],
    },
    { id: "child", label: "ci/job", state: "running", href: "/app/runs/child", steps: [{ id: "c1", label: "ci/step", state: "running", startedAtMs: 1_000, endedAtMs: null, logs: 1 }] },
    { id: "empty", label: "nothing", state: "pending", href: null, steps: [] },
  ];

  test("each job with its steps; a failed step opens with its error; logs render when a step has them", async () => {
    await render(
      <RunDetails jobs={jobs} now={6_000} renderLogs={(job, step) => <pre data-logs={`${job.id}/${step.id}`}>lines</pre>} />,
    );
    expect($$("[data-job]").map((job) => job.dataset.job)).toEqual(["root", "child"]);
    const steps = $$("details[data-step]");
    expect(steps.map((step) => [step.dataset.step, step.hasAttribute("open")])).toEqual(
      [["s1", false], ["s2", true], ["s3", false], ["c1", false]],
    );
    expect(steps[0]!.querySelector("summary")!.textContent).toContain("todo/Plan");
    expect(steps[0]!.querySelector(".sui-run-details-duration")!.textContent).toBe("1.2 s");
    expect(steps[1]!.querySelector("[data-slot='run-step-error']")!.textContent).toBe("GitHubRefused");
    expect(steps[1]!.textContent).toContain("No logs");
    expect(steps[2]!.querySelector(".sui-run-details-duration")).toBeNull();
    // A running step counts to now.
    expect(steps[3]!.querySelector(".sui-run-details-duration")!.textContent).toBe("5.0 s");
    expect($$("[data-logs]").map((logs) => logs.dataset.logs)).toEqual(["root/s1", "child/c1"]);
    expect($("[data-job='child'] a")!.getAttribute("href")).toBe("/app/runs/child");
    expect($("[data-job='root'] .sui-sr-only")!.textContent).toBe("Failed");
  });

  test("nothing to list shows the host's empty line; without a log renderer every step reads No logs", async () => {
    await render(<RunDetails jobs={[]} now={0} empty={<p data-empty>Loading</p>} />);
    expect($("[data-empty]")!.textContent).toBe("Loading");
    await render(<RunDetails jobs={jobs.slice(0, 1)} now={6_000} renderLink={(href, children) => <span data-link={href}>{children}</span>} />);
    expect($$(".sui-run-details-empty").length).toBe(3);
    await render(<RunDetails jobs={jobs.slice(1, 2)} now={6_000} renderLink={(href, children) => <span data-link={href}>{children}</span>} />);
    expect($("[data-link]")!.dataset.link).toBe("/app/runs/child");
    await render(<RunDetails jobs={[{ ...jobs[1]!, href: "javascript:x" }]} now={6_000} />);
    expect($("[data-job] a")).toBeNull();
  });
});

describe("SpanTree", () => {
  const steps = [
    step("load", { label: "Load", startedAtMs: 0, endedAtMs: 12 }),
    step("model", { label: "model · frame 1", startedAtMs: 12, endedAtMs: 1_212, attempts: 2, failedAttempts: 1 }),
    step("call", { label: "repo/read", depth: 1, state: "failed", startedAtMs: 100, endedAtMs: 184, attempts: 3 }),
    step("wait", { label: "waits for an answer", state: "waiting", startedAtMs: 1_300, endedAtMs: null }),
  ];

  test("one option per step, indented by depth, with its glyph, label, attempts and duration", async () => {
    await render(<SpanTree steps={steps} selected="model" onSelect={() => {}} now={2_300} />);
    const options = $$("[role='option']");
    expect($("[role='listbox']")!.getAttribute("aria-label")).toBe("Steps");
    expect(options.map((option) => option.dataset.step)).toEqual(["load", "model", "call", "wait"]);
    expect(options[0]!.querySelector(".sui-span-tree-glyph")!.textContent).toBe("✓");
    expect(options[0]!.querySelector(".sui-span-tree-duration")!.textContent).toBe("12 ms");
    expect(options[0]!.querySelector(".sui-span-tree-attempts")).toBeNull();
    expect(options[1]!.querySelector(".sui-span-tree-attempts")!.textContent).toBe("2 attempts");
    expect(options[1]!.querySelector(".sui-span-tree-attempts")!.getAttribute("data-failed")).toBe("true");
    expect(options[1]!.querySelector(".sui-span-tree-duration")!.textContent).toBe("1.2 s");
    expect(options[2]!.querySelector(".sui-span-tree-attempts")!.getAttribute("data-failed")).toBeNull();
    expect(options[2]!.style.getPropertyValue("--sui-span-depth")).toBe("1");
    expect(options[2]!.querySelector(".sui-sr-only")!.textContent).toBe("Failed");
    expect(options[3]!.querySelector(".sui-span-tree-duration")!.textContent).toBe("1.0 s");
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  test("with nothing selected, the first row takes Tab; an unknown selection does too", async () => {
    await render(<SpanTree steps={steps} selected={null} onSelect={() => {}} now={0} />);
    expect($$("[role='option']").map((option) => option.tabIndex)).toEqual([0, -1, -1, -1]);
    await render(<SpanTree steps={steps} selected="gone" onSelect={() => {}} now={0} />);
    expect($$("[role='option']").map((option) => option.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  test("arrows, Home and End move focus; Enter and Space select; a click selects", async () => {
    const selected: Array<string> = [];
    await render(<SpanTree steps={steps} selected="load" onSelect={(id) => selected.push(id)} now={0} />);
    const options = $$("[role='option']");
    options[0]!.focus();
    await key(options[0]!, "ArrowDown");
    expect(document.activeElement).toBe(options[1]!);
    await key(options[1]!, "ArrowDown");
    await key(options[2]!, "ArrowDown");
    await key(options[3]!, "ArrowDown");
    expect(document.activeElement).toBe(options[3]!);
    await key(options[3]!, "ArrowUp");
    expect(document.activeElement).toBe(options[2]!);
    await key(options[2]!, "Home");
    expect(document.activeElement).toBe(options[0]!);
    await key(options[0]!, "ArrowUp");
    expect(document.activeElement).toBe(options[0]!);
    await key(options[0]!, "End");
    expect(document.activeElement).toBe(options[3]!);
    await key(options[3]!, "Enter");
    await key(options[2]!, " ");
    await key(options[2]!, "a");
    await act(async () => options[1]!.click());
    expect(selected).toEqual(["wait", "call", "model"]);
  });

  test("no steps: an empty listbox, and keys go nowhere", async () => {
    await render(<SpanTree steps={[]} selected={null} onSelect={() => {}} now={0} />);
    expect($$("[role='option']")).toEqual([]);
  });
});

describe("SpanDetail", () => {
  test("its state, wait, attempts, input and output (open), and its acts", async () => {
    await render(
      <SpanDetail
        label="repo/read"
        state="failed"
        attempts={[
          { attempt: 1, state: "failed", startedAtMs: 0, finishedAtMs: 10, error: "unavailable" },
          { attempt: 2, state: "succeeded", startedAtMs: 20, finishedAtMs: 30, error: null },
        ]}
        input={{ text: '{"path":"README.md"}', bytes: 20, clipped: false }}
        output={{ text: '"## Changes"', bytes: 12, clipped: false }}
        wait={{ kind: "human", sinceMs: 0, wakeAtMs: null }}
        now={120_000}
        actions={<button type="button">Answer</button>}
      />,
    );
    const detail = $("[data-slot='span-detail']")!;
    expect(detail.getAttribute("aria-label")).toBe("repo/read");
    expect(detail.dataset.state).toBe("failed");
    expect($("h3")!.textContent).toBe("repo/read");
    expect($(".sui-span-detail-word")!.textContent).toBe("Failed");
    expect($(".sui-span-detail-wait")!.textContent).toBe("human · since 2m ago");
    expect($("[aria-label='Attempts']")!.textContent).toBe("1 ✕ unavailable · 2 ✓");
    const values = $$("[data-slot='json-value']") as Array<HTMLDetailsElement>;
    expect(values.map((value) => value.querySelector(".sui-json-value-label")!.textContent)).toEqual(["Input", "Output"]);
    expect(values.every((value) => value.open)).toBe(true);
    expect(values[1]!.querySelector("pre")!.textContent).toBe("## Changes");
    expect($(".sui-span-detail-actions button")!.textContent).toBe("Answer");
  });

  test("shows nothing it wasn't given", async () => {
    await render(<SpanDetail label="Load" state="completed" attempts={[]} input={null} output={null} now={0} />);
    expect($(".sui-span-detail-wait")).toBeNull();
    expect($("[aria-label='Attempts']")).toBeNull();
    expect($("[data-slot='json-value']")).toBeNull();
    expect($(".sui-span-detail-actions")).toBeNull();
    await render(<SpanDetail label="Load" state="completed" attempts={[]} input={null} output={null} wait={null} now={0} />);
    expect($(".sui-span-detail-wait")).toBeNull();
  });
});

describe("RunWaterfall", () => {
  const steps = [
    step("a", { label: "Load", startedAtMs: 0, endedAtMs: 1_000 }),
    step("b", { label: "mark", startedAtMs: 1_000, endedAtMs: 1_000 }),
    step("c", { label: "model", state: "running", startedAtMs: 1_000, endedAtMs: null }),
  ];

  test("one bar per step on the shared axis; an open bar and an instant marker", async () => {
    await render(<RunWaterfall steps={steps} now={4_000} selected="c" />);
    const rows = $$("[role='listitem']");
    expect($("[role='list']")!.getAttribute("aria-label")).toBe("Timeline");
    expect(rows.map((row) => row.dataset.step)).toEqual(["a", "b", "c"]);
    const bars = $$(".sui-waterfall-bar");
    expect([bars[0]!.style.left, bars[0]!.style.width]).toEqual(["0%", "25%"]);
    expect(bars[1]!.dataset.instant).toBe("true");
    expect(bars[1]!.style.left).toBe("25%");
    expect(bars[1]!.style.width).toBe("");
    expect(bars[2]!.dataset.open).toBe("true");
    expect(bars[2]!.style.width).toBe("75%");
    expect(rows[2]!.dataset.selected).toBe("true");
    expect($("[role='img']")!.getAttribute("aria-label")).toBe("Load, Done, 1.0 s");
    expect($("button")).toBeNull();
  });

  test("with onSelect each bar is a button that selects its step", async () => {
    const selected: Array<string> = [];
    await render(<RunWaterfall steps={steps} now={4_000} onSelect={(id) => selected.push(id)} />);
    const buttons = $$("button.sui-waterfall-track");
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
    await act(async () => buttons[2]!.click());
    expect(selected).toEqual(["c"]);
    expect(buttons[2]!.getAttribute("aria-label")).toBe("model, Working, 3.0 s");
  });
});

describe("RunJournal", () => {
  const events = [
    { seq: 0, eventType: "flows.engine.run-decision", emittedAtMs: 1_000, payload: { text: '{"decision":"created"}', bytes: 22, clipped: false } },
    { seq: 1, eventType: "flows.engine.node-scheduled", emittedAtMs: 2_234, payload: { text: "{}", bytes: 2, clipped: false } },
  ];

  test("sequence, type, time from the first record, and the payload collapsed", async () => {
    await render(<RunJournal events={events} />);
    const rows = $$("tbody tr");
    expect(rows.map((row) => row.dataset.seq)).toEqual(["0", "1"]);
    expect(rows[1]!.querySelector(".sui-run-journal-type")!.textContent).toBe("flows.engine.node-scheduled");
    expect(rows[1]!.querySelector("time")!.textContent).toBe("+1.2 s");
    expect(rows[1]!.querySelector("time")!.getAttribute("datetime")).toBe(new Date(2_234).toISOString());
    expect((rows[0]!.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    expect($("button")).toBeNull();
  });

  test("times count from the origin given; More reads the next page", async () => {
    let more = 0;
    await render(<RunJournal events={events} originMs={0} hasMore onMore={() => more++} />);
    expect($$("time")[0]!.textContent).toBe("+1.0 s");
    await act(async () => $("button")!.click());
    expect(more).toBe(1);
    await render(<RunJournal events={events} hasMore />);
    expect($("button")).toBeNull();
  });

  test("an unreadable time omits its instant; no records, an empty table", async () => {
    await render(<RunJournal events={[{ ...events[0]!, emittedAtMs: Number.NaN }]} />);
    expect($("time")!.getAttribute("datetime")).toBeNull();
    await render(<RunJournal events={[]} />);
    expect($$("tbody tr")).toEqual([]);
  });
});

test("the run page's sheet is part of smithersUiCss", () => {
  expect(smithersUiCss).toContain(".sui-span-tree-row[aria-selected='true']");
  expect(smithersUiCss).toContain(".sui-waterfall-bar[data-instant='true']");
});
