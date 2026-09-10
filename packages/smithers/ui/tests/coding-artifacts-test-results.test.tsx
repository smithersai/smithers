/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  TestResults,
  TestResultsContent,
  TestResultsDuration,
  TestResultsHeader,
  TestResultsProgress,
  TestResultsSummary,
  TestSuite,
  TestRow,
  testCaseStatusToStatus,
  formatTestDuration,
  type TestSuiteModel,
} from "../src/artifacts/TestResults";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

const suites: readonly TestSuiteModel[] = [
  {
    id: "unit",
    name: "unit",
    tests: [
      { id: "a", name: "adds numbers", status: "passed", durationMs: 12 },
      { id: "b", name: "handles overflow", status: "failed", durationMs: 840, errorText: "expected 3 got 4" },
      { id: "c", name: "todo later", status: "todo" },
    ],
  },
  {
    id: "e2e",
    name: "e2e",
    tests: [
      { id: "d", name: "logs in", status: "passed", durationMs: 1500 },
      { id: "e", name: "logs out", status: "skipped" },
    ],
  },
];

describe("testCaseStatusToStatus / formatTestDuration", () => {
  test("frozen mapping", () => {
    expect(testCaseStatusToStatus("passed")).toBe("ok");
    expect(testCaseStatusToStatus("failed")).toBe("failed");
    expect(testCaseStatusToStatus("skipped")).toBe("skipped");
    expect(testCaseStatusToStatus("running")).toBe("running");
    expect(testCaseStatusToStatus("todo")).toBe("todo");
  });

  test("duration formatting", () => {
    expect(formatTestDuration(842)).toBe("842ms");
    expect(formatTestDuration(1500)).toBe("1.5s");
  });
});

describe("TestResults (model mode)", () => {
  test("failed suites default open, clean suites default closed", async () => {
    await render(<TestResults suites={suites} />);
    const suiteEls = container!.querySelectorAll('[data-slot="test-suite"]');
    expect(suiteEls[0]!.getAttribute("data-state")).toBe("open");
    expect(suiteEls[1]!.getAttribute("data-state")).toBe("closed");
    expect(container!.querySelectorAll('[data-slot="test-row"]').length).toBe(3);
  });

  test("opens a streaming suite when its first failure arrives unless the user already toggled it", async () => {
    const running: TestSuiteModel = {
      id: "streaming",
      name: "streaming",
      tests: [{ id: "case", name: "streams", status: "running" }],
    };
    const failed: TestSuiteModel = {
      ...running,
      tests: [{ id: "case", name: "streams", status: "failed", errorText: "late failure" }],
    };

    await render(<TestResults suites={[running]} running />);
    const suite = container!.querySelector('[data-slot="test-suite"]')!;
    expect(suite.getAttribute("data-state")).toBe("closed");
    await act(async () => root!.render(<TestResults suites={[failed]} />));
    expect(suite.getAttribute("data-state")).toBe("open");
    expect(container!.textContent).toContain("late failure");

    await act(async () => root!.render(<TestResults suites={[running]} running />));
    const trigger = container!.querySelector('[data-slot="test-suite-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    await act(async () => root!.render(<TestResults suites={[failed]} />));
    expect(suite.getAttribute("data-state")).toBe("closed");
  });

  test("failed rows nest error text and a stack trace", async () => {
    const withStack: readonly TestSuiteModel[] = [
      {
        id: "s",
        name: "s",
        tests: [
          {
            id: "t",
            name: "explodes",
            status: "failed",
            errorText: "kaboom",
            stack: [{ functionName: "explodes", file: "/t.test.ts", line: 4, column: 2 }],
          },
        ],
      },
    ];
    await render(<TestResults suites={withStack} />);
    expect(container!.querySelector(".sui-tests-row-error")!.textContent).toBe("kaboom");
    const trigger = container!.querySelector('[data-slot="stack-trace-trigger"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain("Failure stack");
    await act(async () => trigger.click());
    expect(container!.textContent).toContain("/t.test.ts:4:2");
  });

  test("compound header derives summary counts and duration from context", async () => {
    await render(
      <TestResults suites={suites}>
        <TestResultsHeader>
          <TestResultsSummary />
          <TestResultsDuration durationMs={2352} />
          <TestResultsProgress />
        </TestResultsHeader>
        <TestResultsContent>
          {suites.map((suite) => (
            <TestSuite key={suite.id} suite={suite} />
          ))}
        </TestResultsContent>
      </TestResults>,
    );
    const summary = container!.querySelector('[data-slot="test-results-summary"]')!;
    expect(summary.textContent).toContain("2 passed");
    expect(summary.textContent).toContain("1 failed");
    expect(summary.textContent).toContain("1 skipped");
    expect(summary.textContent).toContain("1 todo");
    expect(container!.querySelector('[data-slot="test-results-duration"]')!.textContent).toBe("2.4s");
    expect(container!.querySelectorAll('[data-slot="test-suite"]')).toHaveLength(suites.length);
  });

  test("progress is indeterminate while running", async () => {
    await render(
      <TestResults suites={suites} running>
        <TestResultsProgress />
      </TestResults>,
    );
    const progress = container!.querySelector('[data-slot="test-results-progress"]')!;
    expect(progress.getAttribute("data-running")).toBe("true");
    expect(progress.getAttribute("aria-valuenow")).toBeNull();
  });

  test("summary-count changes announce once via the polite live region", async () => {
    await render(<TestResults suites={suites} />);
    const live = container!.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");
    const updated: readonly TestSuiteModel[] = [
      { ...suites[0]!, tests: suites[0]!.tests.map((t) => (t.id === "b" ? { ...t, status: "passed" as const } : t)) },
      suites[1]!,
    ];
    await act(async () => root!.render(<TestResults suites={updated} />));
    expect(live.textContent).toContain("3 passed");
    expect(live.textContent).toContain("0 failed");
  });

  test("running per-case status renders through the shared pill vocabulary", async () => {
    const streaming: readonly TestSuiteModel[] = [
      { id: "s", name: "s", tests: [{ id: "t", name: "in flight", status: "running" }] },
    ];
    await render(<TestResults suites={streaming} running />);
    const trigger = container!.querySelector('[data-slot="test-suite-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const row = container!.querySelector('[data-slot="test-row"]')!;
    expect(row.getAttribute("data-status")).toBe("running");
    expect(row.querySelector('[data-slot="test-status"]')!.getAttribute("data-status")).toBe("running");
  });

  test("TestRow accepts custom children", async () => {
    await render(
      <TestRow test={{ id: "x", name: "custom", status: "passed" }}>
        <span data-extra>extra</span>
      </TestRow>,
    );
    expect(container!.querySelector("[data-extra]")!.textContent).toBe("extra");
  });

  test("renders under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<TestResults suites={suites} />);
    expect(container!.querySelector('[data-slot="test-results"]')).not.toBeNull();
  });
});
