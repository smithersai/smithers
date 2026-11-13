/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Reasoning } from "../src/agentic/Reasoning";
import { TaskItem } from "../src/agentic/TaskItem";
import { ToolCall, ToolCallHeader, type ToolCallState, TOOL_CALL_STATE_LABELS } from "../src/agentic/ToolCall";
import { TestResults, TestResultsProgress, TestSuite, TestSuiteName, TestSuiteStats, TestRow, type TestCaseStatus } from "../src/artifacts/TestResults";
import { ChangeSummary } from "../src/artifacts/ChangeSummary";
import { Checkpoint } from "../src/approvals/Checkpoint";
import { StackTrace } from "../src/artifacts/StackTrace";
import { CompactGroup } from "../src/chat/CompactGroup";
import { Calendar } from "../src/calendar/Calendar";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../src/agentic/Sources";
import type { CalendarEvent } from "../src/calendar/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root | undefined;

async function render(element: ReactElement) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(element));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});

const NOW = new Date(2026, 6, 27, 12).getTime();
const at = (hour: number, minute = 0) => new Date(2026, 6, 27, hour, minute).getTime();
const event = (id: string, start: number, end?: number): CalendarEvent => ({ id, title: id, start, end });

describe("component duration boundaries", () => {
  test.each([
    [0, "0s"], [59.4, "59s"], [59.5, "1m 00s"], [59.6, "1m 00s"],
    [60, "1m 00s"], [119.4, "1m 59s"], [119.5, "2m 00s"], [119.6, "2m 00s"],
  ] as const)("reasoning and work rows round %s seconds before splitting", async (seconds, expected) => {
    await render(<><Reasoning duration={seconds} /><TaskItem label="Build" status="complete" elapsedSeconds={seconds} /></>);
    expect(container.querySelector('[data-slot="reasoning-duration"]')!.textContent).toBe(`Thought for ${expected}`);
    expect(container.querySelector(".sui-taskitem-elapsed")!.textContent).toBe(expected);
  });

  test.each([
    [0, "0ms"], [842, "842ms"], [999.4, "999ms"], [999.6, "1.0s"],
    [1000, "1.0s"], [1250, "1.3s"], [59_940, "59.9s"], [59_960, "1m 00s"],
    [60_000, "1m 00s"], [119_400, "1m 59s"], [119_600, "2m 00s"],
  ] as const)("tool duration %s uses normalized units", async (durationMs, expected) => {
    await render(<ToolCall name="Build" state="output-available" durationMs={durationMs}><ToolCallHeader /></ToolCall>);
    expect(container.querySelector('[data-slot="tool-call-duration"]')!.textContent).toBe(expected);
  });
});

describe("test result completion and composition", () => {
  test.each([
    [["passed", "passed", "passed", "todo"], "100"],
    [["todo"], "100"], [["passed", "failed", "skipped", "todo"], "100"],
    [["passed", "todo", "running", "running"], "50"],
  ] as const)("terminal test statuses %j contribute to progress", async (statuses, expected) => {
    await render(<TestResults suites={[{ id: "api", name: "api", tests: statuses.map((status, i) => ({ id: String(i), name: String(i), status: status as TestCaseStatus })) }]}><TestResultsProgress /></TestResults>);
    expect(container.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe(expected);
  });

  test("a composed suite keeps its name in the trigger while its rows are collapsed", async () => {
    await render(<TestSuite><TestSuiteName>api</TestSuiteName><TestSuiteStats /><TestRow test={{ id: "ok", name: "responds", status: "passed" }} /></TestSuite>);
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="test-suite-trigger"]')!;
    expect(trigger.textContent).toContain("api");
    expect(trigger.querySelector('[data-slot="test-suite-stats"]')).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="test-row"]')).toBeNull();
    await act(async () => trigger.click());
    const content = container.querySelector('[data-slot="test-suite-content"]')!;
    expect(content.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(content.querySelector('[data-slot="test-suite-name"]')).toBeNull();
    expect(content.textContent).toContain("responds");
  });

  test("a composed suite without header parts still has a named trigger", async () => {
    await render(<TestSuite><TestRow test={{ id: "ok", name: "responds", status: "passed" }} /></TestSuite>);
    expect(container.querySelector('[data-slot="test-suite-trigger"]')!.textContent).toBe("Test suite");
  });
});

describe("calendar event access", () => {
  test("the month grid has a header row and six seven-day rows", async () => {
    await render(<Calendar events={[]} now={NOW} />);
    const grid = container.querySelector('[role="grid"]')!;
    expect(grid.children).toHaveLength(7);
    for (const row of grid.children) expect(row.getAttribute("role")).toBe("row");
    expect(grid.children[0]!.querySelectorAll('[role="columnheader"]')).toHaveLength(7);
    for (const row of [...grid.children].slice(1)) expect(row.querySelectorAll('[role="gridcell"]')).toHaveLength(7);
  });

  test("agenda event links and buttons retain their native roles inside lists", async () => {
    const clicks: string[] = [];
    await render(<Calendar events={[{ ...event("link", at(13)), href: "/event" }, event("button", at(14))]} view="agenda" now={NOW} />);
    const link = container.querySelector<HTMLAnchorElement>(".sui-cal-agenda-row[href]")!;
    const button = container.querySelector<HTMLButtonElement>("button.sui-cal-agenda-row")!;
    for (const control of [link, button]) {
      expect(control.hasAttribute("role")).toBe(false);
      expect(control.parentElement!.getAttribute("role")).toBe("listitem");
      expect(control.parentElement!.parentElement!.getAttribute("role")).toBe("list");
    }
    const agenda = container.querySelector('[aria-label="Agenda"]')!;
    for (const group of agenda.children) {
      expect(group.getAttribute("role")).toBe("listitem");
      expect(group.querySelector('[role="list"]')!.getAttribute("aria-label")).toBeTruthy();
    }
    await render(<Calendar events={[{ ...event("link", at(13)), href: "/event" }]} view="agenda" now={NOW} onEventClick={(e) => clicks.push(e.id)} />);
    const action = container.querySelector<HTMLButtonElement>("button.sui-cal-agenda-row")!;
    expect(action.hasAttribute("role")).toBe(false);
    await act(async () => action.click());
    expect(clicks).toEqual(["link"]);
  });

  test("same-time events occupy separate columns and both remain clickable", async () => {
    const clicks: string[] = [];
    await render(<Calendar events={[event("first", at(9), at(10)), event("second", at(9), at(10))]} now={NOW} view="week" onEventClick={(e) => clicks.push(e.id)} />);
    const controls = [...container.querySelectorAll<HTMLButtonElement>(".sui-cal-week-event")];
    expect(controls).toHaveLength(2);
    expect(controls[0]!.style.left).not.toBe(controls[1]!.style.left);
    for (const control of controls) {
      expect(control.style.width).toContain("50%");
      await act(async () => control.click());
    }
    expect(clicks).toEqual(["first", "second"]);
  });

  test("overflow label, padding, and chips never fire an empty-slot click", async () => {
    const slots: number[] = [];
    const clicks: string[] = [];
    await render(<Calendar events={[event("first", at(9)), event("second", at(10))]} now={NOW} maxChipsPerDay={1} onSlotClick={(ms) => slots.push(ms)} onEventClick={(e) => clicks.push(e.id)} />);
    await act(async () => container.querySelector<HTMLButtonElement>(".sui-cal-more")!.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.querySelector<HTMLElement>(".sui-cal-popover-label")!.click());
    await act(async () => dialog.click());
    await act(async () => dialog.querySelector<HTMLButtonElement>(".sui-cal-chip")!.click());
    expect(slots).toEqual([]);
    expect(clicks).toEqual(["first"]);
    await act(async () => container.querySelector<HTMLElement>('[role="gridcell"][data-date="2026-07-27"]')!.click());
    expect(slots).toEqual([new Date(2026, 6, 27).getTime()]);
  });
});

test("compound sources expose a labelled list of source rows", async () => {
  await render(<Sources defaultOpen><SourcesTrigger count={2} /><SourcesContent><Source title="Alpha" /><Source title="Beta" /></SourcesContent></Sources>);
  const list = container.querySelector("ul")!;
  expect(list.getAttribute("role") ?? "list").toBe("list");
  expect([...list.children].map((child) => child.tagName)).toEqual(["LI", "LI"]);
  expect(document.getElementById(list.getAttribute("aria-labelledby")!)!.textContent).toBe("Used 2 sources");
});

describe("accessible change summaries", () => {
  test.each([false, true])("singular counts are announced even with compact=%s", async (compact) => {
    await render(<ChangeSummary additions={1} deletions={1} filesChanged={1} compact={compact} />);
    const summary = container.querySelector('[data-slot="change-summary"]')!;
    expect(summary.getAttribute("role")).toBe("img");
    expect(summary.getAttribute("aria-label")).toBe("1 addition, 1 deletion, 1 file changed in this diff");
  });
  test("zero and plural counts keep the working-copy terminology", async () => {
    await render(<ChangeSummary additions={0} deletions={2} filesChanged={3} vcs="jj" />);
    expect(container.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("0 additions, 2 deletions, 3 files changed in this working-copy change");
  });
});

test.each([0, 1, 2])("message and frame counts pluralize %s", async (count) => {
  await render(<>
    <Checkpoint checkpoint={{ id: "saved", messageCount: count }} />
    <StackTrace frames={Array.from({ length: count }, () => ({ functionName: "run", file: "src/run.ts" }))} />
    <CompactGroup count={count}>Earlier content</CompactGroup>
  </>);
  const noun = count === 1 ? "message" : "messages";
  expect(container.querySelector('[data-slot="checkpoint-metadata"]')!.textContent).toBe(`${count} ${noun}`);
  expect(container.querySelector('[data-slot="compact-group-trigger"]')!.textContent).toContain(`${count} earlier ${noun}`);
  if (count > 0) expect(container.querySelector(".sui-stack-count")!.textContent).toBe(`${count} ${count === 1 ? "frame" : "frames"}`);
  else expect(container.querySelector(".sui-stack-count")).toBeNull();
});

test("tool lifecycle announcements follow every transition, including repeated completions", async () => {
  const states: ToolCallState[] = ["running", "output-available", "running", "output-error", "input-streaming", "input-available", "approval-requested", "approval-responded", "output-denied", "output-available"];
  await render(<ToolCall name="Build" state="input-streaming"><ToolCallHeader /></ToolCall>);
  const live = container.querySelector('[data-slot="tool-call-live"]')!;
  expect(live.textContent).toBe("");
  for (const state of states) {
    await render(<ToolCall name="Build" state={state}><ToolCallHeader /></ToolCall>);
    expect(live.textContent).toBe(TOOL_CALL_STATE_LABELS[state]);
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    await render(<ToolCall name="Build" state={state}><ToolCallHeader /></ToolCall>);
    expect(live.textContent).toBe(TOOL_CALL_STATE_LABELS[state]);
  }
});

