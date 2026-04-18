import { describe, expect, test } from "bun:test";
import {
    DEVTOOLS_ERROR_CODES,
    NODE_DIFF_ERROR_CODES,
    NODE_OUTPUT_ERROR_CODES,
    JUMP_TO_FRAME_ERROR_CODES,
} from "@smithers-orchestrator/protocol/errors/index.js";
import { CLI_ERROR_MESSAGES } from "../src/util/errorMessage.js";
import { EXIT_USER_ERROR, EXIT_SERVER_ERROR } from "../src/util/exitCodes.js";

/**
 * Finding #10 regression guard.
 *
 * Every typed error code returned by the four devtools RPCs must have
 * a CLI-side mapping to a user-friendly message, a hint, and an exit
 * code. Importing the protocol's frozen code arrays and asserting each
 * one maps here means any code added to `@smithers-orchestrator/protocol/errors`
 * that the CLI forgets to handle will fail this test immediately.
 */
describe("CLI_ERROR_MESSAGES covers every protocol error code", () => {
    const allCodes = Array.from(
        new Set([
            ...DEVTOOLS_ERROR_CODES,
            ...NODE_DIFF_ERROR_CODES,
            ...NODE_OUTPUT_ERROR_CODES,
            ...JUMP_TO_FRAME_ERROR_CODES,
        ]),
    );

    test("every code is present with a non-empty message and hint", () => {
        for (const code of allCodes) {
            const mapping = CLI_ERROR_MESSAGES[code];
            expect(mapping).toBeDefined();
            expect(typeof mapping.message).toBe("string");
            expect(mapping.message.length).toBeGreaterThan(0);
            expect(typeof mapping.hint).toBe("string");
            expect(mapping.hint.length).toBeGreaterThan(0);
        }
    });

    test("exit code is either user-error (1) or server-error (2)", () => {
        for (const code of allCodes) {
            const mapping = CLI_ERROR_MESSAGES[code];
            expect([EXIT_USER_ERROR, EXIT_SERVER_ERROR]).toContain(mapping.exitCode);
        }
    });

    test("user-supplied Invalid* inputs map to exit 1", () => {
        // InvalidDelta is a server-side protocol error (delta the client
        // cannot apply); it maps to server-error. Every other Invalid*
        // code represents a user-supplied bad value and must exit 1.
        const USER_INPUT_INVALID = [
            "InvalidRunId",
            "InvalidNodeId",
            "InvalidIteration",
            "InvalidFrameNo",
        ];
        for (const code of USER_INPUT_INVALID) {
            const mapping = CLI_ERROR_MESSAGES[code];
            expect(mapping).toBeDefined();
            expect(mapping.exitCode).toBe(EXIT_USER_ERROR);
        }
    });
});
