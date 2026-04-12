import React from "react";
import { SmithersContext } from "@smithers/react-reconciler/context";
import { Task } from "./Task.js";
import { Loop } from "./Ralph.js";
/** @typedef {import("./Poller.ts").PollerProps} PollerProps */

/**
 * Compute the timeout for a given attempt based on the backoff strategy.
 * This effectively controls the interval between polls by setting
 * the task's timeoutMs, giving the agent/compute time proportional
 * to the backoff delay.
 */
function computeTimeoutMs(attempt, baseMs, strategy) {
    switch (strategy) {
        case "linear":
            return baseMs * (attempt + 1);
        case "exponential":
            return baseMs * Math.pow(2, attempt);
        case "fixed":
        default:
            return baseMs;
    }
}
/**
 * @param {PollerProps} props
 */
export function Poller(props) {
    if (props.skipIf)
        return null;
    const ctx = React.useContext(SmithersContext);
    const prefix = props.id ?? "poll";
    const maxAttempts = props.maxAttempts ?? 30;
    const backoff = props.backoff ?? "fixed";
    const baseInterval = props.intervalMs ?? 5000;
    const onTimeout = props.onTimeout ?? "fail";
    const iteration = ctx?.iterations?.[`${prefix}-loop`] ?? ctx?.iteration ?? 0;
    const checkRow = ctx?.outputMaybe(props.checkOutput, {
        nodeId: `${prefix}-check`,
        iteration,
    });
    const until = checkRow?.satisfied === true;
    // Determine if check is an agent or a compute function
    const isAgent = typeof props.check === "object" &&
        props.check !== null &&
        "generate" in props.check;
    // Build the check task
    const prompt = props.children ??
        "Check whether the condition is satisfied. Return an object with a satisfied boolean.";
    const checkTask = isAgent
        ? React.createElement(Task, {
            id: `${prefix}-check`,
            output: props.checkOutput,
            timeoutMs: computeTimeoutMs(iteration, baseInterval, backoff),
            agent: props.check,
            children: prompt,
        })
        : React.createElement(Task, {
            id: `${prefix}-check`,
            output: props.checkOutput,
            timeoutMs: computeTimeoutMs(iteration, baseInterval, backoff),
            children: props.check,
        });
    return React.createElement(Loop, {
        id: `${prefix}-loop`,
        until,
        maxIterations: maxAttempts,
        onMaxReached: onTimeout === "fail" ? "fail" : "return-last",
    }, checkTask);
}
