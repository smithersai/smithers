import { findAndOpenDb } from "./find-db";
import { CronExpressionParser } from "cron-parser";
import { spawn } from "node:child_process";
import pc from "picocolors";

export async function runScheduler(pollIntervalMs = 15000) {
  console.log(pc.green("[smithers-cron] Starting background scheduler loop..."));
  console.log(pc.dim(`Polling every ${pollIntervalMs / 1000}s for due jobs.`));

  const { adapter, cleanup } = await findAndOpenDb();

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(pc.yellow("\n[smithers-cron] Shutting down scheduler gracefully..."));
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  async function tick() {
    try {
      const crons = await adapter.listCrons(true);
      const now = Date.now();

      for (const job of (crons as any[])) {
        try {
          // If no next run time is set or if we've passed the next run time
          if (!job.nextRunAtMs || now >= job.nextRunAtMs) {
            
            // Execute the background workflow
            console.log(pc.cyan(`[smithers-cron] Triggering due workflow: ${job.workflowPath} (Schedule: ${job.pattern})`));
            
            // Spawn the orchestrator in the background to handle the job
            const childOpts = process.env.MCP_MODE ? {} : { stdio: "ignore" }; // Keep terminal clean
            const proc = spawn("bun", ["run", "src/cli/index.ts", "up", job.workflowPath, "-d"], {
               cwd: process.cwd(),
               detached: true,
               stdio: "ignore",
            });
            proc.unref();

            // Calculate the NEXT run time using cron-parser
            const interval = CronExpressionParser.parse(job.pattern);
            const nextDate = interval.next();
            const nextRunAtMs = nextDate.getTime();

            // Update in SQLite so it isn't triggered repeatedly
            await adapter.updateCronRunTime(job.cronId, now, nextRunAtMs);
          }
        } catch (jobErr: any) {
          console.error(pc.red(`[smithers-cron] Error processing job ${job.cronId}: ${jobErr.message}`));
          await adapter.updateCronRunTime(job.cronId, Date.now(), job.nextRunAtMs ?? (Date.now() + 60000), jobErr.message);
        }
      }
    } catch (err: any) {
      console.error(pc.red(`[smithers-cron] Tick failed: ${err.message}`));
    }

    // Schedule next tick
    setTimeout(tick, pollIntervalMs);
  }

  // Initial fast tick to immediately handle any missed jobs
  tick();
}
