import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Resume an existing run by launching `smithers up ... --resume` as a detached process.
 * Returns the spawned PID when available.
 */
export function resumeRunDetached(workflowPath, runId, claim) {
    const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
    const args = [cliPath, "up", workflowPath, "--resume", "--run-id", runId, "-d", "--force"];
    if (claim) {
        args.push("--resume-claim-owner", claim.claimOwnerId);
        args.push("--resume-claim-heartbeat", String(claim.claimHeartbeatAtMs));
        if (claim.restoreRuntimeOwnerId !== undefined && claim.restoreRuntimeOwnerId !== null) {
            args.push("--resume-restore-owner", claim.restoreRuntimeOwnerId);
        }
        if (claim.restoreHeartbeatAtMs !== undefined && claim.restoreHeartbeatAtMs !== null) {
            args.push("--resume-restore-heartbeat", String(claim.restoreHeartbeatAtMs));
        }
    }
    const child = spawn("bun", args, {
        cwd: dirname(resolve(workflowPath)),
        stdio: "ignore",
        env: process.env,
        detached: true,
    });
    child.unref();
    return child.pid ?? null;
}
