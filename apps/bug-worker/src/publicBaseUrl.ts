import type { BugWorkerEnv } from "./env.ts";

/**
 * Public origin of this Worker, without a trailing slash; returned URLs start
 * here. The deployment sets `PUBLIC_BASE_URL`; without it the request's own
 * origin answers, so a self-hosted install needs no hosted default.
 */
export function publicBaseUrl(env: BugWorkerEnv, request: Request): string {
  return (env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, "");
}
