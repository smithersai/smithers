// @smithers-type-exports-begin
/** @typedef {import("./RunRewindCommandInput.ts").RunRewindCommandInput} RunRewindCommandInput */
/** @typedef {import("./RunRewindCommandResult.ts").RunRewindCommandResult} RunRewindCommandResult */
// @smithers-type-exports-end

import readline from "node:readline";
import { jumpToFrameRoute } from "@smithers/server/gatewayRoutes/jumpToFrame";
import { JumpToFrameError } from "@smithers/time-travel/jumpToFrame";
import {
    EXIT_OK,
    EXIT_USER_ERROR,
    EXIT_DECLINED,
} from "./util/exitCodes.js";
import { formatCliErrorForStderr, getCliErrorMapping } from "./util/errorMessage.js";

/**
 * @param {RunRewindCommandInput} input
 * @returns {Promise<boolean>}
 */
async function defaultConfirm(input) {
    if (!input.stdin.isTTY) {
        return false;
    }
    const rl = readline.createInterface({ input: input.stdin, output: input.stderr });
    try {
        /** @type {string} */
        const answer = await new Promise((resolve) => {
            rl.question(
                `Rewind run ${input.runId} to frame ${input.frameNo}? This is destructive. [y/N] `,
                (raw) => resolve(raw ?? ""),
            );
        });
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}

/**
 * @param {RunRewindCommandInput} input
 * @returns {Promise<RunRewindCommandResult>}
 */
export async function runRewindOnce(input) {
    if (!input.yes) {
        if (!input.stdin.isTTY && !input.confirm) {
            input.stderr.write(`${formatCliErrorForStderr("ConfirmationRequired", "stdin is not a TTY and --yes was not passed")}\n`);
            return { exitCode: EXIT_DECLINED };
        }
        const confirmFn = input.confirm ?? (() => defaultConfirm(input));
        const confirmed = await confirmFn();
        if (!confirmed) {
            input.stderr.write("rewind declined by user\n");
            return { exitCode: EXIT_DECLINED };
        }
    }
    try {
        const result = await jumpToFrameRoute({
            adapter: input.adapter,
            runId: input.runId,
            frameNo: input.frameNo,
            confirm: true,
            caller: "cli",
        });
        input.onResult?.(result);
        if (input.json) {
            input.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
            input.stdout.write(
                `rewound run ${input.runId} to frame ${result.newFrameNo} ` +
                `(reverted ${result.revertedSandboxes} sandbox${result.revertedSandboxes === 1 ? "" : "es"}, ` +
                `deleted ${result.deletedFrames} frame${result.deletedFrames === 1 ? "" : "s"}, ` +
                `${result.deletedAttempts} attempt${result.deletedAttempts === 1 ? "" : "s"}, ` +
                `invalidated ${result.invalidatedDiffs} diff${result.invalidatedDiffs === 1 ? "" : "s"}, ` +
                `took ${result.durationMs}ms)\n`,
            );
        }
        return { exitCode: EXIT_OK };
    } catch (err) {
        const code = err instanceof JumpToFrameError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        input.stderr.write(`${formatCliErrorForStderr(code, message)}\n`);
        if (code === "ConfirmationRequired") {
            return { exitCode: EXIT_USER_ERROR };
        }
        const mapping = getCliErrorMapping(code, message);
        return { exitCode: mapping.exitCode };
    }
}
