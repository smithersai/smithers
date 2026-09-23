/**
 * Approvals: a consequential flow call waits for the person at the keyboard.
 *
 * The kernel's attended `GrantStore` is the whole model. `authorize` asks it
 * for each consequential capability a call declares, `Agent.Options.authorize`
 * runs that before the call's clock starts, and a denial reaches the cell as
 * `capability_refused` carrying the `Denied: ` message this module writes. The
 * UI polls `list` and answers with `reply`.
 *
 * Consequential means the declared capability can change something the
 * workspace's VCS will not show, or reach outside the process: every
 * `fs:write` (this host restores no snapshot, so "compensable" is never
 * compensated), `proc:spawn`, and all `net:` actions (a GET still sends data
 * out). Reads and the TUI's own runtime flows declare none of these.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import type * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Layer, Option } from "effect"
import { resolve } from "node:path"
import * as Changes from "./changes.ts"
import * as Transcript from "./transcript.ts"

/** `ask` waits for y/n, `all` asks nothing, `deny` refuses every consequential call. */
export type Mode = "ask" | "all" | "deny"
/** The answers `GrantStore.reply` takes that the TUI offers. */
export type Choice = "once" | "deny" | "run"

export interface Meta {
  readonly flow: string
  readonly subject: string
  /** `chat`, or the worker tab id. */
  readonly source: string
}

export interface Request {
  readonly capability: Capability.Capability
  readonly meta: Meta
}

export interface Pending extends Meta {
  readonly requestId: string
  readonly action: Capability.Action
  readonly tier: Capability.EffectTier
  /** Whether the store can grant this for the rest of the session. */
  readonly always: boolean
}

export const environmentKey = "SMITHERS_TUI_APPROVE"

export const mode = (
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly print: boolean }
): Mode | { readonly error: string } => {
  const value = env[environmentKey]
  if (value === undefined || value === "") return options.print ? "deny" : "ask"
  if (value !== "ask" && value !== "all" && value !== "deny") {
    return { error: `${environmentKey} must be ask, all or deny` }
  }
  if (value === "ask" && options.print) return { error: `${environmentKey}=ask needs the interactive TUI` }
  return value
}

export const consequential = (capability: Capability.Capability, cwd: string): boolean =>
  capability.action.startsWith("net:") || Capability.tierOf(capability, { workspaceRoot: cwd }) !== "sealed"

/** One request per consequential capability, narrowed to what this call touches. */
export const requests = (call: Cell.Call, cwd: string, source: string): ReadonlyArray<Request> => {
  const found = new Map<string, Request>()
  const subject = Transcript.subject(call.input).slice(0, 160)
  const add = (capability: Capability.Capability, shown: string) =>
    found.set(Capability.format(capability), { capability, meta: { flow: call.flowName, subject: shown, source } })
  for (const declared of call.capabilities) {
    const parsed = Capability.parse(declared)
    if (Option.isNone(parsed) || !consequential(parsed.value, cwd)) continue
    const capability = parsed.value
    if (capability.action === "fs:write") {
      // `undefined` or nothing named: ask for everything the flow declares.
      const paths = Changes.touched(call.flowName, call.input) ?? []
      if (paths.length === 0) add(capability, subject)
      for (const path of paths) add(Capability.make("fs:write", resolve(cwd, path)), path.slice(0, 160))
    } else if (capability.action === "proc:spawn") {
      // The flow, not the command: `a` then means this flow for the session.
      add(Capability.make("proc:spawn", call.flowName), subject)
    } else {
      add(capability, subject)
    }
  }
  return [...found.values()]
}

const denyAll = new Permission.Rule({
  effect: "deny",
  pattern: new Capability.CapabilityPattern({ action: "*", resource: "**" })
})

export const layer = (cwd: string, approvals: Mode): Layer.Layer<GrantStore.GrantStore> =>
  GrantStore.layer({ attended: true, planDigest: "smithers-tui", rules: approvals === "deny" ? [denyAll] : [] }).pipe(
    Layer.provide(Workspace.layer(cwd)),
    Layer.orDie
  )

/** Starts every denial message this host writes; the cell reads it as `capability_refused`. */
export const deniedPrefix = "Denied: "

/** Whether a settled call is a denial this host wrote, not some other refusal. */
export const denied = (result: Cell.CallResult): boolean =>
  result.outcome === "failure" && result.code === "capability_refused" &&
  (result.message ?? "").startsWith(deniedPrefix)

/** Print mode's notice for a denied flow: one line per flow, the first time only. */
export const notices = () => {
  const seen = new Set<string>()
  return (flow: string): string | undefined => {
    if (seen.has(flow)) return undefined
    seen.add(flow)
    return `denied ${flow}; ${environmentKey}=all allows`
  }
}

/** `Agent.Options.authorize`: waits for every consequential request, in order. */
export const authorize = (grants: GrantStore.Service, options: { readonly cwd: string; readonly source: string }) =>
(call: Cell.Call): Effect.Effect<void, HarnessError> =>
  Effect.forEach(
    requests(call, options.cwd, options.source),
    (request) =>
      grants.check(request.capability, { ...request.meta }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Permission.PermissionDenied
            ? new HarnessError({
              code: "engine_failed",
              message: `${deniedPrefix}${request.meta.flow} ${request.meta.subject}`,
              cause
            })
            : new HarnessError({ code: "engine_failed", message: "Approval store failed", cause })
        )
      ),
    { discard: true }
  )

const order = (requestId: string): number => Number(requestId.slice(requestId.lastIndexOf("-") + 1))

/** The store's waiting requests, oldest first. */
export const pending = (list: ReadonlyArray<GrantStore.PendingRequest>): ReadonlyArray<Pending> =>
  [...list].sort((a, b) => order(a.requestId) - order(b.requestId)).map((request) => ({
    requestId: request.requestId,
    flow: String(request.meta.flow ?? ""),
    subject: String(request.meta.subject ?? ""),
    source: String(request.meta.source ?? "chat"),
    action: request.capability.action,
    tier: request.tier,
    always: request.capability.action === "fs:write"
      ? request.tier === "compensable"
      : Option.isSome(Capability.patternFromCapability(request.capability))
  }))

export const reply = (
  grants: GrantStore.Service,
  request: Pending,
  choice: Choice,
  cwd: string
): Effect.Effect<void, Permission.GrantStoreError> =>
  grants.reply(
    request.requestId,
    choice,
    choice === "run" && request.action === "fs:write"
      ? new Capability.CapabilityPattern({ action: "fs:write", resource: `${cwd.replace(/\/+$/, "")}/**` })
      : undefined
  )

/** `reply`, settled: the store's error code when it refused the answer, else `undefined`. */
export const answer = (
  grants: GrantStore.Service,
  request: Pending,
  choice: Choice,
  cwd: string
): Effect.Effect<Permission.GrantStoreError["code"] | undefined> =>
  reply(grants, request, choice, cwd).pipe(
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => undefined })
  )

/** What `a` grants for the rest of the session. */
export const scope = (request: Pending): string => request.action === "fs:write" ? "all edits" : `all ${request.flow}`

/**
 * How long a row is on screen before y, n or a answers it. Rows arrive on a
 * poll, so without this a person typing "add tests" as one appeared would
 * grant the session with the `a`.
 */
export const armMs = 400

/**
 * Whether the front row takes keys yet.
 *
 * `requestId` is the row whose delay runs since `since`. `waiting` is the
 * request last answered while the store still lists it: nothing arms until a
 * poll shows it gone, so a double-tapped `y` never answers the next row.
 */
export interface Arming {
  readonly requestId: string | undefined
  readonly since: number
  readonly waiting: string | undefined
}

export const idle: Arming = { requestId: undefined, since: 0, waiting: undefined }

/**
 * After each poll. `listed` is everything the store holds; `skip` is what the
 * UI already answered and so does not show. The front row's delay starts the
 * first poll it is shown on.
 */
export const shown = (
  arming: Arming,
  listed: ReadonlyArray<Pending>,
  now: number,
  skip: ReadonlySet<string> = new Set()
): Arming => {
  if (arming.waiting !== undefined && listed.some((request) => request.requestId === arming.waiting)) return arming
  const front = listed.find((request) => !skip.has(request.requestId))?.requestId
  if (front === undefined) return idle
  if (front === arming.requestId && arming.waiting === undefined) return arming
  return { requestId: front, since: now, waiting: undefined }
}

/** A key answered `requestId`; the next row waits for a poll without it. */
export const answered = (requestId: string): Arming => ({ requestId: undefined, since: 0, waiting: requestId })

/** The store refused the answer to `requestId`; its row shows and arms again. */
export const failed = (arming: Arming, requestId: string): Arming =>
  arming.waiting === requestId ? idle : arming

export const armed = (arming: Arming, front: string | undefined, now: number): boolean =>
  front !== undefined && arming.waiting === undefined && arming.requestId === front && now - arming.since >= armMs

/** The answer a key gives, or `undefined` so the key reaches the editor. */
export const key = (
  name: string,
  state: {
    readonly draft: string
    readonly shift: boolean
    readonly ctrl: boolean
    readonly meta: boolean
    /** See `armed`. */
    readonly armed: boolean
    readonly pending: ReadonlyArray<Pending>
  }
): Choice | undefined => {
  const first = state.pending[0]
  if (first === undefined || !state.armed || state.draft !== "" || state.shift || state.ctrl || state.meta) {
    return undefined
  }
  if (name === "y") return "once"
  if (name === "n") return "deny"
  if (name === "a" && first.always) return "run"
  return undefined
}
