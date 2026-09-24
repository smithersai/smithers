import type { BugWorkerEnv } from "./env.ts";

/** Public origin of this Worker, without a trailing slash; returned URLs and emailed links start here. */
export function publicBaseUrl(env: BugWorkerEnv): string {
  return (env.PUBLIC_BASE_URL ?? "https://bug.smithers.sh").replace(/\/$/, "");
}
