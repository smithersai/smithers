import React from "react";
import type { AgentLike } from "../AgentLike";
import type { OutputTarget } from "./Task";
import { Sequence } from "./Sequence";
import { Parallel } from "./Parallel";
import { Task } from "./Task";

export type CheckConfig = {
  id: string;
  agent?: AgentLike;
  command?: string;
  label?: string;
};

export type CheckSuiteProps = {
  id?: string;
  checks: CheckConfig[] | Record<string, Omit<CheckConfig, "id">>;
  verdictOutput: OutputTarget;
  strategy?: "all-pass" | "majority" | "any-pass";
  maxConcurrency?: number;
  continueOnFail?: boolean;
  skipIf?: boolean;
};

function normalizeChecks(
  checks: CheckConfig[] | Record<string, Omit<CheckConfig, "id">>,
): CheckConfig[] {
  if (Array.isArray(checks)) return checks;
  return Object.entries(checks).map(([key, cfg]) => ({
    id: key,
    ...cfg,
  }));
}

/**
 * <CheckSuite> — Parallel checks with auto-aggregated pass/fail verdict.
 *
 * Composes: Sequence > Parallel[Task per check] > Task(verdict aggregator)
 */
export function CheckSuite(props: CheckSuiteProps) {
  if (props.skipIf) return null;

  const {
    id,
    checks,
    verdictOutput,
    strategy = "all-pass",
    maxConcurrency,
    continueOnFail = true,
  } = props;

  const prefix = id ?? "checksuite";
  const normalized = normalizeChecks(checks);

  // Build parallel check tasks
  const checkTasks = normalized.map((check) => {
    const taskId = `${prefix}-${check.id}`;
    const childContent = check.command
      ? `Run check: ${check.command}`
      : `Run check: ${check.label ?? check.id}`;

    const taskProps: Record<string, unknown> = {
      key: taskId,
      id: taskId,
      output: verdictOutput,
      continueOnFail,
      label: check.label ?? check.id,
    };

    if (check.agent) {
      taskProps.agent = check.agent;
    }

    return React.createElement(Task, taskProps as any, childContent);
  });

  const parallelEl = React.createElement(
    Parallel,
    { maxConcurrency },
    ...checkTasks,
  );

  // Build needs map so the verdict task depends on all checks
  const needs: Record<string, string> = {};
  normalized.forEach((check) => {
    const taskId = `${prefix}-${check.id}`;
    needs[taskId] = taskId;
  });

  const strategyDesc =
    strategy === "all-pass"
      ? "ALL checks must pass for an overall pass verdict."
      : strategy === "majority"
        ? "A MAJORITY of checks must pass for an overall pass verdict."
        : "ANY single check passing is sufficient for an overall pass verdict.";

  const verdictTask = React.createElement(
    Task,
    {
      id: `${prefix}-verdict`,
      output: verdictOutput,
      needs,
    } as any,
    `Aggregate check results into a pass/fail verdict.\n\nStrategy: ${strategyDesc}`,
  );

  return React.createElement(Sequence, null, parallelEl, verdictTask);
}
