// @smithers-type-exports-begin
/** @typedef {import("./CheckSuiteProps.ts").CheckSuiteProps} CheckSuiteProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";
/** @typedef {import("./CheckConfig.ts").CheckConfig} CheckConfig */

/**
 * @param {CheckConfig[] | Record<string, Omit<CheckConfig, "id">>} checks
 * @returns {CheckConfig[]}
 */
function normalizeChecks(checks) {
    if (Array.isArray(checks))
        return checks;
    return Object.entries(checks).map(([key, cfg]) => ({
        id: key,
        ...cfg,
    }));
}
/**
 * <CheckSuite> — Parallel checks with auto-aggregated pass/fail verdict.
 *
 * Composes: Sequence > Parallel[Task per check] > Task(verdict aggregator)
 * @param {CheckSuiteProps} props
 */
export function CheckSuite(props) {
    if (props.skipIf)
        return null;
    const { id, checks, verdictOutput, strategy = "all-pass", maxConcurrency, continueOnFail = true, } = props;
    const prefix = id ?? "checksuite";
    const normalized = normalizeChecks(checks);
    // Build parallel check tasks
    const checkTasks = normalized.map((check) => {
        const taskId = `${prefix}-${check.id}`;
        const childContent = check.command
            ? `Run check: ${check.command}`
            : `Run check: ${check.label ?? check.id}`;
        const taskProps = {
            key: taskId,
            id: taskId,
            output: verdictOutput,
            continueOnFail,
            label: check.label ?? check.id,
        };
        if (check.agent) {
            taskProps.agent = check.agent;
        }
        return React.createElement(Task, taskProps, childContent);
    });
    const parallelEl = React.createElement(Parallel, { maxConcurrency }, ...checkTasks);
    // Build needs map so the verdict task depends on all checks
    const needs = {};
    normalized.forEach((check) => {
        const taskId = `${prefix}-${check.id}`;
        needs[taskId] = taskId;
    });
    const strategyDesc = strategy === "all-pass"
        ? "ALL checks must pass for an overall pass verdict."
        : strategy === "majority"
            ? "A MAJORITY of checks must pass for an overall pass verdict."
            : "ANY single check passing is sufficient for an overall pass verdict.";
    const verdictTask = React.createElement(Task, {
        id: `${prefix}-verdict`,
        output: verdictOutput,
        needs,
    }, `Aggregate check results into a pass/fail verdict.\n\nStrategy: ${strategyDesc}`);
    return React.createElement(Sequence, null, parallelEl, verdictTask);
}
