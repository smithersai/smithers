/*
 * `GET /api/harnesses` (LOCAL-APP.md, "HTTP and WebSocket API"): the harness
 * table, detected afresh on every call so a sign-in that happened since the
 * last menu open shows up. Version probes are cached per binary in
 * Harnesses.ts, so a repeat call costs file reads, not process spawns.
 */
import type { Harness } from "@smthrs/rpc/LocalApp"
import { json, Router } from "../routes"

export const HARNESSES_PATH = "/api/harnesses"

export type HarnessDetector = () => Promise<ReadonlyArray<Harness>>

export const registerHarnessRoutes = (router: Router, detect: HarnessDetector): void => {
  router.add("GET", HARNESSES_PATH, async () => json({ harnesses: await detect() }))
}
