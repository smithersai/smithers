import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sweepBudgetMs } from "../src/repoDelivery.ts";

/**
 * The stack's physical names, hostnames, shared state and `--stage prod`
 * scripts are asserted with every other stack in
 * `apps/site/scripts/deployment.test.mjs`.
 */
describe("delivery cron", () => {
  test("a delivery sweep ends before the next cron tick and the platform limit", () => {
    const cron = /crons: \["\*\/(\d+) \* \* \* \*"\]/.exec(readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8"));
    expect(cron).not.toBeNull();
    const cadenceMs = Number(cron![1]) * 60_000;
    // One send may still be in flight when the budget expires; it times out after ten seconds.
    expect(sweepBudgetMs + 10_000).toBeLessThan(cadenceMs);
    // Cloudflare stops a Cron Trigger invocation after fifteen minutes.
    expect(cadenceMs).toBeLessThanOrEqual(15 * 60_000);
  });
});
