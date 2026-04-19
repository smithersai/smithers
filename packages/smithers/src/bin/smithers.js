#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * When a workflow directory (`.smithers/`) exists in the user's cwd and it's
 * installed a local `smithers` bin, re-exec against that instead of this
 * globally-resolved copy. This is the same pattern `tsc` uses for local
 * TypeScript installs: every module the workflow runtime touches — engine,
 * react-reconciler, components, React itself — comes from a single tree,
 * which avoids the "two React copies → null useContext dispatcher" trap that
 * bunx and `.smithers/` would otherwise produce (bunx temp dir + local
 * `.smithers/node_modules/` each install their own React).
 */
function delegateToLocalCliIfPresent() {
    const cwd = process.cwd();
    const localBin = resolve(cwd, ".smithers/node_modules/.bin/smithers");
    if (!existsSync(localBin)) return false;
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    const localTarget = realpathSync(localBin);
    if (localTarget === selfPath) return false;
    const proc = spawn(process.execPath, [localTarget, ...process.argv.slice(2)], {
        stdio: "inherit",
        cwd,
    });
    proc.on("exit", (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 0);
    });
    return true;
}

if (!delegateToLocalCliIfPresent()) {
    await import("@smithers-orchestrator/cli");
}
