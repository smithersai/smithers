/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StepInspector } from "../src/flow-graph/StepInspector";
import { StepLogs } from "../src/flow-graph/StepLogs";
import { stepLogLines, stepLogTime } from "../src/flow-graph/stepLogLines";
import * as barrel from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; container?.remove(); });
const render = async (element: React.ReactNode) => {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(() => root!.render(element));
};
const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];

const value = (payload: unknown) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { text, bytes: text.length, clipped: false };
};
const at = Date.UTC(2026, 9, 25, 14, 3, 7);
const engine = { runId: "r", stepKeyDigest: "d".repeat(64), stepKey: "k", tier: "sealed" };
const log = (fields: Record<string, unknown>) => value({
  version: 1,
  level: "Info",
  message: ["working"],
  annotations: { ...engine, attempt: 1 },
  cause: { version: 1, reasons: [] },
  fiberId: 1,
  timestamp: new Date(at).toISOString(),
  ...fields,
});

test("a record reads as time, level, message and key=value fields, without the engine's attribution", () => {
  const [line] = stepLogLines([log({
    level: "Warn",
    message: ["fetching", { repo: "octo/hello", note: "two words", empty: "", eq: "a=b", count: 2, ok: true, none: null }, 3],
    annotations: { ...engine, attempt: 1, code: "slow_fetch", nested: { a: [1, 2] }, long: { text: "y".repeat(300) } },
  })]);
  expect(line).toEqual({
    kind: "record",
    at,
    level: "WARN",
    message: "fetching 3",
    fields: [
      ["repo", "octo/hello"],
      ["note", '"two words"'],
      ["empty", '""'],
      ["eq", '"a=b"'],
      ["count", "2"],
      ["ok", "true"],
      ["none", "null"],
      ["code", "slow_fetch"],
      ["nested", '{"a":[1,2]}'],
      ["long", `${JSON.stringify({ text: "y".repeat(300) }).slice(0, 199)}…`],
    ],
    error: null,
    attempt: 1,
  });
});

test("a record's failure reads as one phrase per reason", () => {
  const [line] = stepLogLines([log({
    level: "Error",
    message: "refused",
    cause: {
      version: 1,
      reasons: [
        { _tag: "Fail", error: { _tag: "QuotaExhausted", message: "", code: "quota" } },
        { _tag: "Fail", error: { name: "Error", message: "request failed" } },
        { _tag: "Fail", error: { message: "bare" } },
        { _tag: "Fail", error: "unavailable" },
        { _tag: "Fail", error: { code: "x" } },
        { _tag: "Fail", error: 42 },
        { _tag: "Die", defect: { name: "TypeError", message: "boom" } },
        { _tag: "Interrupt", fiberId: null },
      ],
    },
  })]);
  expect(line).toMatchObject({
    message: "refused",
    error: 'QuotaExhausted; Error: request failed; bare; unavailable; {"code":"x"}; 42; TypeError: boom; Interrupted',
  });
});

test("what isn't a log record reads as its text, and an unreadable time is left out", () => {
  const lines = stepLogLines([
    value("printed\noutput"),
    value("42"),
    value({ version: 2, level: "Info", annotations: {} }),
    value({ version: 1, level: "Loud", annotations: {} }),
    value({ version: 1, level: "Info", annotations: [] }),
    { text: '{"version":1,"lev', bytes: 900, clipped: true },
    log({ timestamp: "not a time", annotations: { runId: "r" }, cause: null }),
    log({ message: undefined }),
  ]);
  expect(lines.slice(0, 6)).toEqual([
    { kind: "text", text: "printed\noutput" },
    { kind: "text", text: "42" },
    { kind: "text", text: '{"version":2,"level":"Info","annotations":{}}' },
    { kind: "text", text: '{"version":1,"level":"Loud","annotations":{}}' },
    { kind: "text", text: '{"version":1,"level":"Info","annotations":[]}' },
    { kind: "text", text: '{"version":1,"lev…' },
  ]);
  expect(lines[6]).toEqual({ kind: "record", at: null, level: "INFO", message: "working", fields: [], error: null, attempt: null });
  expect(lines[7]).toMatchObject({ kind: "record", message: "" });
});

test("records from more than one attempt start each attempt with its number", () => {
  const second = log({ annotations: { ...engine, attempt: 2 }, message: ["retrying"] });
  expect(stepLogLines([log({}), value("printed"), second, second]).map((line) => line.kind === "attempt" ? `#${line.attempt}` : line.kind)).toEqual([
    "#1", "record", "text", "#2", "record", "record",
  ]);
  expect(stepLogLines([log({}), log({})]).map((line) => line.kind)).toEqual(["record", "record"]);
});

test("a time shows the day only when it isn't today's", () => {
  const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(at);
  expect(stepLogTime(at, at + 1000)).toBe(clock);
  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at);
  expect(stepLogTime(at, at + 3 * 86_400_000)).toBe(`${day} ${clock}`);
});

test("StepLogs renders each line like a CI log, and nothing for an empty log", async () => {
  expect(barrel.StepLogs).toBe(StepLogs);
  await render(<StepLogs lines={[]} now={at} />);
  expect(container.innerHTML).toBe("");
  await render(<StepLogs className="mine" now={at} lines={[
    log({ message: ["cloning", { repo: "octo/hello" }] }),
    log({ annotations: { ...engine, attempt: 2 }, level: "Error", message: [], cause: { version: 1, reasons: [{ _tag: "Fail", error: "unavailable" }] } }),
    log({ annotations: { ...engine, attempt: 2 }, timestamp: "unknown" }),
    value("printed"),
  ]} />);
  const list = container.querySelector<HTMLElement>('[data-slot="step-logs"]')!;
  expect(list.getAttribute("aria-label")).toBe("Logs");
  expect(list.className).toContain("mine");
  const rows = all("[data-slot=step-logs] > li");
  expect(rows.map((row) => row.dataset.kind)).toEqual(["attempt", "record", "attempt", "record", "record", "text"]);
  expect(rows[0]!.textContent).toBe("Attempt 1");
  expect(rows[1]!.querySelector("time")!.getAttribute("dateTime")).toBe(new Date(at).toISOString());
  expect(rows[1]!.textContent).toBe(`${stepLogTime(at, at)}INFOcloningrepo=octo/hello`);
  expect(rows[3]!.dataset.level).toBe("ERROR");
  expect(rows[3]!.querySelector(".sui-step-log-message")).toBeNull();
  expect(rows[3]!.querySelector(".sui-step-log-error")!.textContent).toBe("unavailable");
  expect(rows[4]!.querySelector("time")).toBeNull();
  expect(rows[5]!.textContent).toBe("printed");
  expect(list.textContent).not.toContain("stepKeyDigest");
});

test("the inspector's Logs tab shows the step's log lines", async () => {
  const step = { id: "a", label: "Load", kind: "action", state: "failed" as const, startedAtMs: at, endedAtMs: at + 1, depth: 0, attempts: 1, failedAttempts: 1 };
  await render(<StepInspector step={step} input={null} output={null} logs={[log({ message: ["fetching"] })]} attempts={[]} now={at} />);
  const tab = all('[role="tab"]').find((t) => t.textContent!.startsWith("Logs"))!;
  expect(tab.textContent).toContain("1");
  await act(() => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  expect(container.querySelector('[data-slot="step-logs"]')!.textContent).toContain("INFOfetching");
});
