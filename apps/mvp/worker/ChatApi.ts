import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"
import { workerBuild } from "../infra/WorkerBuild.ts"
import type { ProgramOptions } from "./ChatApiProgram.ts"

// ChatApi's Worker: its settings and its program. The program, and every module it reaches, lives in
// worker/ChatApiProgram.ts and is imported when the Worker first builds it: Cloudflare refuses a deploy whose Worker
// takes longer than its startup limit to evaluate its modules, and with the whole program at the top level ChatApi took
// 400 to 750 ms of it (docs/infrastructure.md#limits). worker/ChatApi.startup.test.ts checks the lazy module graph; bench/startup.ts holds the timing budget.

/**
 * Where Cloudflare runs ChatApi's requests (docs/infrastructure.md#placement): `CHATAPI_PLACEMENT_REGION`, a cloud
 * region such as `aws:us-east-1` beside the database, read when the stack is declared. Unset, each request runs near
 * whoever sent it, the public stack's default. A deployment value, like `FLOW_EXECUTION_LOCATION`.
 */
export const placementOf = (region: string | undefined): { readonly placement?: { readonly region: string } } => {
  if (region === undefined || region === "") return {}
  if (!/^(aws|gcp|azure):[a-z0-9-]+$/.test(region)) {
    throw new Error(`CHATAPI_PLACEMENT_REGION is "${region}": use <provider>:<region>, such as aws:us-east-1`)
  }
  return { placement: { region } }
}

/** ChatApi's Worker settings; `worker/DevChatApi.ts` uses them with its own `main`. */
export const props = {
  ...placementOf(globalThis.process?.env?.CHATAPI_PLACEMENT_REGION),
  main: "worker/ChatApi.ts",
  // @effect/sql-pg opens its sockets with node:net, which workerd provides under nodejs_compat.
  // global_fetch_strictly_public: the global fetch always goes out to the public internet, never straight to a Worker
  // of this account; Electric's gateway, which has no public URL, is reached by service binding (infra/Electric.ts).
  compatibility: {
    date: "2026-10-01",
    flags: ["nodejs_compat", "enable_request_signal", "global_fetch_strictly_public"]
  },
  // Workers Logs keeps every JSON log line; Cloudflare.Telemetry() below turns on Workers Traces.
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true, persist: true } },
  // Five minutes of CPU per request or alarm, the most Cloudflare allows, rather than the default 30 seconds: the
  // `FlowExecution` objects this Worker hosts run the `todo` run's agent, whose QuickJS cells and replayed frames are CPU
  // (docs/infrastructure.md#limits). Waiting on a model or a machine costs none.
  limits: { cpuMs: 300_000 },
  // Browsers reach it only through the site, so locally it takes any free port and the site keeps 1337.
  dev: { port: 0 },
  // The workspace packages it bundles from source can hold `.vibe` modules.
  build: workerBuild
}

/**
 * ChatApi's program (worker/ChatApiProgram.ts `program`), imported when the Worker first builds it. `options` are
 * `alchemy dev`'s (worker/DevChatApi.ts).
 */
export const program = (options: ProgramOptions = {}) =>
  Effect.flatMap(Effect.promise(() => import("./ChatApiProgram.ts")), (loaded) => loaded.program(options))

// ChatApi answers /api/* for the site Worker (worker/index.ts), including chat, the Electric shape proxy, agent
// attachment, sign-in, repositories and the browser's telemetry. It hosts the remote flows' Durable Object.
// Alchemy runs its handlers. Until the GitHub App is configured, production has no signed-in sessions.
export default class ChatApi extends Cloudflare.Worker<ChatApi>()("ChatApi", props, program()) {}
