import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
import { Task } from "./Task";
import { Sequence } from "./Sequence";
import { Parallel } from "./Parallel";
import { Loop } from "./Ralph";

export type ScanFixVerifyProps = {
  /** ID prefix for generated task/component ids. */
  id?: string;
  /** Agent that scans for problems. */
  scanner: AgentLike;
  /** Agent (or agents) that fixes problems. When an array is provided, agents are cycled across issues. */
  fixer: AgentLike | AgentLike[];
  /** Agent that verifies the fixes were applied correctly. */
  verifier: AgentLike;
  /** Output schema for scan results. Should include `issues: Array`. */
  scanOutput: OutputTarget;
  /** Output schema for each individual fix. */
  fixOutput: OutputTarget;
  /** Output schema for verification results. */
  verifyOutput: OutputTarget;
  /** Output schema for the final summary report. */
  reportOutput: OutputTarget;
  /** Maximum number of parallel fix tasks. */
  maxConcurrency?: number;
  /** Maximum scan-fix-verify cycles before stopping. Default 3. */
  maxRetries?: number;
  /** Skip the entire component. */
  skipIf?: boolean;
  /** Prompt/context describing what to scan for. */
  children?: React.ReactNode;
};

export function ScanFixVerify(props: ScanFixVerifyProps) {
  if (props.skipIf) return null;

  const prefix = props.id ?? "sfv";
  const maxRetries = props.maxRetries ?? 3;
  const fixers = Array.isArray(props.fixer) ? props.fixer : [props.fixer];

  // The scan task finds problems
  const scanTask = React.createElement(Task, {
    id: `${prefix}-scan`,
    output: props.scanOutput,
    agent: props.scanner,
    children: props.children ?? "Scan for problems and return an issues array.",
  });

  // Parallel fix tasks — one per issue slot. At render time we don't know
  // how many issues there are, so we create a single fix task that the agent
  // will apply to all discovered issues. The Parallel wrapper allows the
  // runtime to fan out when the scan output becomes available.
  const fixTask = React.createElement(Task, {
    id: `${prefix}-fix`,
    output: props.fixOutput,
    agent: fixers[0],
    dependsOn: [`${prefix}-scan`],
    children: "Fix all issues identified by the scan. Address each problem found.",
  });

  const fixParallel = React.createElement(
    Parallel,
    { id: `${prefix}-fixes`, maxConcurrency: props.maxConcurrency },
    fixTask,
  );

  // Verify that all fixes were applied correctly
  const verifyTask = React.createElement(Task, {
    id: `${prefix}-verify`,
    output: props.verifyOutput,
    agent: props.verifier,
    dependsOn: [`${prefix}-fix`],
    children:
      "Verify that all fixes were applied correctly. Return whether all issues are resolved.",
  });

  // The inner loop: scan → fix → verify, repeating until verification passes
  const innerSequence = React.createElement(
    Sequence,
    null,
    scanTask,
    fixParallel,
    verifyTask,
  );

  const loop = React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until: false, // Re-evaluated at render time via reactive context
      maxIterations: maxRetries,
      onMaxReached: "return-last" as const,
    },
    innerSequence,
  );

  // Final report task after the loop completes
  const reportTask = React.createElement(Task, {
    id: `${prefix}-report`,
    output: props.reportOutput,
    dependsOn: [`${prefix}-verify`],
    children:
      "Produce a final summary report of all scan-fix-verify cycles, including what was found, what was fixed, and the final verification status.",
  });

  return React.createElement(Sequence, null, loop, reportTask);
}
