/**
 * Regression test: `stop()` must remove the hook handlers it installed
 * even when no previous handler was present. Otherwise later React commits
 * continue to flow through the stopped instance's core, leaking.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { SmithersDevTools } from "../src/devtools/SmithersDevTools.js";

const HOOK_KEY = "__REACT_DEVTOOLS_GLOBAL_HOOK__";

/** @type {unknown} */
let priorHook;

describe("SmithersDevTools stop() cleanup", () => {
    beforeEach(() => {
        // Save any pre-existing hook so we can restore after each test.
        priorHook = /** @type {Record<string, unknown>} */ (globalThis)[HOOK_KEY];
        // Ensure a clean slate: no hook installed.
        delete (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY];
    });

    afterEach(() => {
        if (priorHook === undefined) {
            delete (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY];
        } else {
            (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY] = priorHook;
        }
    });

    test("stop() removes handlers when no previous handler existed", () => {
        // Simulate a hook that exists but has NO onCommit handlers yet. This is
        // the scenario where devtools is the first to install them.
        (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY] = {
            renderers: new Map(),
            supportsFiber: true,
            inject() { return 1; },
            on() {},
            off() {},
            emit() {},
        };

        const devtools = new SmithersDevTools();
        devtools.start();
        const hook = /** @type {any} */ (globalThis[HOOK_KEY]);
        expect(hook).toBeDefined();
        // The devtools instance installed these fresh.
        expect(typeof hook.onCommitFiberRoot).toBe("function");
        expect(typeof hook.onCommitFiberUnmount).toBe("function");

        devtools.stop();

        // With no previous handler to restore, stop() must fully remove the
        // handlers it installed so later commits don't flow through the
        // stopped instance.
        expect(hook.onCommitFiberRoot).toBeUndefined();
        expect(hook.onCommitFiberUnmount).toBeUndefined();
    });

    test("stop() restores previous handlers when they existed", () => {
        const previousRoot = () => {};
        const previousUnmount = () => {};
        // Simulate a pre-existing hook with handlers already installed.
        (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY] = {
            renderers: new Map(),
            supportsFiber: true,
            inject() { return 1; },
            onCommitFiberRoot: previousRoot,
            onCommitFiberUnmount: previousUnmount,
            on() {},
            off() {},
            emit() {},
        };

        const devtools = new SmithersDevTools();
        devtools.start();
        const hook = /** @type {any} */ (globalThis[HOOK_KEY]);
        // After start, devtools replaced the handlers.
        expect(hook.onCommitFiberRoot).not.toBe(previousRoot);
        expect(hook.onCommitFiberUnmount).not.toBe(previousUnmount);

        devtools.stop();

        // Previous handlers must be restored.
        expect(hook.onCommitFiberRoot).toBe(previousRoot);
        expect(hook.onCommitFiberUnmount).toBe(previousUnmount);
    });
});
