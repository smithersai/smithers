/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { Progress } from "../progress";
import { StatusPill } from "../status-pill";
import { StackTrace, type StackFrameData } from "./StackTrace";

export type TestCaseStatus = "passed" | "failed" | "skipped" | "running" | "todo";

/** Map the test-case vocabulary onto the shared status vocabulary. */
export function testCaseStatusToStatus(status: TestCaseStatus): string {
  switch (status) {
    case "passed":
      return "ok";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "running":
      return "running";
    case "todo":
      return "todo";
  }
}

export type TestCaseModel = {
  id: string;
  name: string;
  status: TestCaseStatus;
  durationMs?: number;
  errorText?: string;
  stack?: readonly StackFrameData[];
};

export type TestSuiteModel = {
  id: string;
  name: string;
  tests: readonly TestCaseModel[];
  durationMs?: number;
};

type TestCounts = { passed: number; failed: number; skipped: number; running: number; todo: number; total: number };

function countSuite(suite: TestSuiteModel, counts: TestCounts): void {
  for (const test of suite.tests) {
    counts[test.status] += 1;
    counts.total += 1;
  }
}

function summarize(suites: readonly TestSuiteModel[]): TestCounts {
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, running: 0, todo: 0, total: 0 };
  for (const suite of suites) countSuite(suite, counts);
  return counts;
}

function summarizeSuite(suite: TestSuiteModel): TestCounts {
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, running: 0, todo: 0, total: 0 };
  countSuite(suite, counts);
  return counts;
}

/** "842ms" under a second, "1.2s" above. */
export function formatTestDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

type TestResultsContextValue = { running: boolean; counts: TestCounts };
const TestResultsContext = createContext<TestResultsContextValue | null>(null);

type TestSuiteContextValue = { suite: TestSuiteModel; counts: TestCounts };
const TestSuiteContext = createContext<TestSuiteContextValue | null>(null);

export type TestResultsProps = Omit<ComponentProps<"div">, "children"> & { running?: boolean } & (
  | { suites: readonly TestSuiteModel[]; children?: ReactNode }
  | { children: ReactNode; suites?: never }
);

/**
 * Test run rollup: model-driven (`suites`) or compound (`children`). Streams
 * via the `running` flag plus per-case `running` statuses; the root announces
 * only summary-count changes through one polite live region.
 */
export function TestResults(props: TestResultsProps) {
  useInjectUiCss();
  const p = props as { running?: boolean; className?: string; suites?: readonly TestSuiteModel[]; children?: ReactNode } & ComponentProps<"div">;
  const { running = false, className, suites, children, ...divProps } = p;
  const counts = useMemo(() => (suites ? summarize(suites) : null), [suites]);

  const countsKey = counts ? `${counts.passed}/${counts.failed}/${counts.skipped}/${counts.running}/${counts.todo}` : null;
  const [announcement, setAnnouncement] = useState("");
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (countsKey === null || counts === null) return;
    if (prevKeyRef.current !== null && prevKeyRef.current !== countsKey) {
      setAnnouncement(
        `Test results updated: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.running} running, ${counts.todo} todo`,
      );
    }
    prevKeyRef.current = countsKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countsKey]);

  const contextValue = useMemo<TestResultsContextValue>(
    () => ({ running, counts: counts ?? { passed: 0, failed: 0, skipped: 0, running: 0, todo: 0, total: 0 } }),
    [running, counts],
  );

  return (
    <TestResultsContext.Provider value={contextValue}>
      <div
        data-slot="test-results"
        data-running={running ? "true" : "false"}
        className={cn("sui-tests", className)}
        {...divProps}
      >
        <div className="sui-sr-only" aria-live="polite">{announcement}</div>
        {children !== undefined
          ? children
          : suites?.map((suite) => <TestSuite key={suite.id} suite={suite} />) ?? null}
      </div>
    </TestResultsContext.Provider>
  );
}

export function TestResultsHeader({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="test-results-header" className={cn("sui-tests-header", className)} {...props} />;
}

/** Passed/failed/skipped/todo counts derived from the root model. */
export function TestResultsSummary({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const context = useContext(TestResultsContext);
  const counts = context?.counts;
  return (
    <div data-slot="test-results-summary" className={cn("sui-tests-summary", className)} {...props}>
      <span className="sui-tests-summary-count" data-tone="ok">{counts?.passed ?? 0} passed</span>
      <span className="sui-tests-summary-count" data-tone="bad">{counts?.failed ?? 0} failed</span>
      <span className="sui-tests-summary-count" data-tone="muted">{counts?.skipped ?? 0} skipped</span>
      {(counts?.running ?? 0) > 0 ? (
        <span className="sui-tests-summary-count" data-tone="run">{counts?.running} running</span>
      ) : null}
      {(counts?.todo ?? 0) > 0 ? (
        <span className="sui-tests-summary-count" data-tone="muted">{counts?.todo} todo</span>
      ) : null}
    </div>
  );
}

export type TestResultsDurationProps = Omit<ComponentProps<"span">, "children"> & { durationMs: number };

export function TestResultsDuration({ durationMs, className, ...props }: TestResultsDurationProps) {
  useInjectUiCss();
  return (
    <span data-slot="test-results-duration" className={cn("sui-tests-duration", className)} {...props}>
      {formatTestDuration(durationMs)}
    </span>
  );
}

/** ui Progress over the run; indeterminate while the root is `running`. */
export function TestResultsProgress({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const context = useContext(TestResultsContext);
  const running = context?.running ?? false;
  const counts = context?.counts;
  const finished = (counts?.passed ?? 0) + (counts?.failed ?? 0) + (counts?.skipped ?? 0);
  const total = counts?.total ?? 0;
  const value = running || total === 0 ? undefined : Math.round((finished / total) * 100);
  return (
    <Progress
      data-slot="test-results-progress"
      data-running={running ? "true" : "false"}
      aria-label="Test progress"
      value={value}
      className={cn("sui-tests-progress", className)}
      {...props}
    />
  );
}

export function TestResultsContent({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="test-results-content" className={cn("sui-tests-content", className)} {...props} />;
}

export type TestSuiteProps = Omit<ComponentProps<"div">, "children"> & {
  suite?: TestSuiteModel;
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Collapsible suite; failed suites default open, the rest default closed. */
export function TestSuite({
  suite,
  children,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: TestSuiteProps) {
  useInjectUiCss();
  const triggerId = useId();
  const contentId = useId();
  const suiteCounts = useMemo(() => (suite ? summarizeSuite(suite) : null), [suite]);
  const failed = suiteCounts !== null && suiteCounts.failed > 0;
  const resolvedDefaultOpen = defaultOpen ?? failed;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(resolvedDefaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const previousFailed = useRef(failed);
  const userToggled = useRef(false);

  useEffect(() => {
    const becameFailed = !previousFailed.current && failed;
    previousFailed.current = failed;
    if (!becameFailed || isControlled || userToggled.current) return;
    setUncontrolledOpen(true);
    onOpenChange?.(true);
  }, [failed, isControlled, onOpenChange]);

  function toggle() {
    const next = !open;
    userToggled.current = true;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const suiteContext = useMemo<TestSuiteContextValue | null>(
    () =>
      suite && suiteCounts
        ? { suite, counts: suiteCounts }
        : null,
    [suite, suiteCounts],
  );

  const body = (
    <>
      <button
        type="button"
        id={triggerId}
        data-slot="test-suite-trigger"
        className="sui-tests-suite-trigger"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
      >
        {suite ? (
          <>
            <TestSuiteName>{suite.name}</TestSuiteName>
            <TestSuiteStats />
          </>
        ) : null}
      </button>
      {open ? (
        <div
          data-slot="test-suite-content"
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          className="sui-tests-suite-content"
        >
          {suite ? suite.tests.map((test) => <TestRow key={test.id} test={test} />) : children}
        </div>
      ) : null}
    </>
  );

  const root = (
    <div
      data-slot="test-suite"
      data-state={open ? "open" : "closed"}
      className={cn("sui-tests-suite", className)}
      {...props}
    >
      {body}
    </div>
  );

  return suiteContext ? (
    <TestSuiteContext.Provider value={suiteContext}>{root}</TestSuiteContext.Provider>
  ) : (
    root
  );
}

export function TestSuiteName({ className, ...props }: ComponentProps<"span">) {
  useInjectUiCss();
  return <span data-slot="test-suite-name" className={cn("sui-tests-suite-name", className)} {...props} />;
}

/** "3/4 passed" plus failure/skip badges, derived from the suite context. */
export function TestSuiteStats({ className, ...props }: ComponentProps<"span">) {
  useInjectUiCss();
  const context = useContext(TestSuiteContext);
  const counts = context?.counts;
  const parts: string[] = [`${counts?.passed ?? 0}/${counts?.total ?? 0} passed`];
  if ((counts?.failed ?? 0) > 0) parts.push(`${counts?.failed} failed`);
  if ((counts?.skipped ?? 0) > 0) parts.push(`${counts?.skipped} skipped`);
  if ((counts?.running ?? 0) > 0) parts.push(`${counts?.running} running`);
  if ((counts?.todo ?? 0) > 0) parts.push(`${counts?.todo} todo`);
  return (
    <span data-slot="test-suite-stats" className={cn("sui-tests-suite-stats", className)} {...props}>
      {parts.join(" · ")}
    </span>
  );
}

export function TestSuiteContent({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="test-suite-content" role="region" className={cn("sui-tests-suite-content", className)} {...props} />;
}

export type TestRowProps = Omit<ComponentProps<"div">, "children"> & {
  test: TestCaseModel;
  children?: ReactNode;
};

/** One test case: status pill, name, duration; failures nest error + stack. */
export function TestRow({ test, children, className, ...props }: TestRowProps) {
  useInjectUiCss();
  return (
    <div
      data-slot="test-row"
      data-status={test.status}
      className={cn("sui-tests-row", className)}
      {...props}
    >
      <TestStatus status={test.status} />
      <TestName>{test.name}</TestName>
      {test.durationMs !== undefined ? (
        <span className="sui-tests-row-duration">{formatTestDuration(test.durationMs)}</span>
      ) : null}
      {test.status === "failed" && (test.errorText !== undefined || test.stack !== undefined) ? (
        <div className="sui-tests-row-detail">
          {test.errorText !== undefined ? <pre className="sui-tests-row-error">{test.errorText}</pre> : null}
          {test.stack !== undefined && test.stack.length > 0 ? (
            <StackTrace frames={test.stack} title="Failure stack" />
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export type TestStatusProps = Omit<ComponentProps<"span">, "children"> & { status: TestCaseStatus };

export function TestStatus({ status, className, ...props }: TestStatusProps) {
  useInjectUiCss();
  return (
    <StatusPill
      data-slot="test-status"
      status={testCaseStatusToStatus(status)}
      label={status}
      className={cn("sui-tests-status", className)}
      {...props}
    />
  );
}

export function TestName({ className, ...props }: ComponentProps<"span">) {
  useInjectUiCss();
  return <span data-slot="test-name" className={cn("sui-tests-name", className)} {...props} />;
}
