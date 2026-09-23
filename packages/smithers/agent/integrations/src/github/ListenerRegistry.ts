/**
 * Declared GitHub webhooks, and the reconciliation that makes a repository
 * match the declaration.
 *
 * The safety property this module exists for is **ownership**. A hook is owned
 * only when its numeric GitHub id appears in the workspace's own state file. A
 * matching callback URL is not proof of ownership, because anyone can point a
 * hook at any URL, so an unowned hook on a declared URL is reported as a
 * `conflict` and never modified. Every `create` runs that check, not only the
 * one for a listener with no ownership entry, because a listener that moved
 * repositories or whose hook was deleted remotely lands in a repository that
 * may already have somebody else's hook on the same URL. Deletes additionally
 * require an explicit `allowDelete`.
 *
 * Ownership is written before and after every remote mutation. The `pending`
 * record written first is what makes a crash converge: the next run recognizes
 * the hook it was about to claim and adopts it, instead of reporting a
 * `conflict` against a hook it created itself one second earlier. A record is
 * retired as soon as GitHub says it refused the create, and it is dropped
 * outright once the declaration that produced it changes, so the adoption path
 * covers a lost answer and nothing wider.
 *
 * There is no `smithers listeners` verb at 1.0. This is library code an
 * application calls.
 *
 * @since 1.0.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import { Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { IntegrationError, isIntegrationError } from "../core/IntegrationError.ts"
import * as Environment from "../Environment.ts"
import { resolve as resolveConfig } from "./Config.ts"
import { type GitHubClient, make as makeClient } from "./GitHubClient.ts"
import { fullNamePath } from "./Repository.ts"

/**
 * Where the declaration lives, relative to the workspace root.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REGISTRY_PATH = ".smithers/listeners.json"

/**
 * Where the ownership state lives, relative to the workspace root.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_STATE_PATH = ".smithers/listeners.state.json"

/**
 * Where an applying reconciliation records its exclusive workspace lock.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_LOCK_PATH = ".smithers/listeners.lock"

/**
 * The GitHub events a listener may subscribe to.
 *
 * @category constants
 * @since 1.0.0
 */
export const LISTENER_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment"
] as const

/**
 * One event a listener may subscribe to.
 *
 * @category models
 * @since 1.0.0
 */
export type ListenerEvent = (typeof LISTENER_EVENTS)[number]

/**
 * One declared webhook.
 *
 * @category models
 * @since 1.0.0
 */
export interface Listener {
  readonly id: string
  readonly provider: "github"
  readonly repository: string
  readonly events: ReadonlyArray<ListenerEvent>
  readonly flowId: string
  readonly callbackUrl: string
  /** The environment variable holding this listener's signing secret. */
  readonly secretEnv: string
  readonly active: boolean
}

/**
 * A parsed declaration file.
 *
 * @category models
 * @since 1.0.0
 */
export interface Registry {
  readonly version: 1
  readonly listeners: ReadonlyArray<Listener>
}

/**
 * One owned hook, as recorded in the state file.
 *
 * @category models
 * @since 1.0.0
 */
export interface Ownership {
  readonly listenerId: string
  readonly repository: string
  readonly hookId: number
  readonly callbackUrl: string
  readonly secretDigest?: string | undefined
}

/**
 * A create this workspace had started but not yet confirmed.
 *
 * Written before the POST and cleared after the ownership write, so a process
 * that dies in between leaves a record the next run can recognize. Without it
 * the next run sees an unowned hook on a declared URL and refuses forever.
 *
 * @category models
 * @since 1.0.0
 */
export interface PendingCreate {
  readonly listenerId: string
  readonly repository: string
  readonly callbackUrl: string
  /** When the create was started, in Unix milliseconds. */
  readonly startedAtMs: number
}

/**
 * How long a pending create stays adoptable.
 *
 * An intent is evidence, not proof: it says this workspace was creating a hook
 * on that URL, not that the hook now sitting there is the one it created. The
 * window bounds how long that inference is allowed to stand, so a record left
 * by a run that died months ago cannot license adopting a stranger's hook
 * today.
 *
 * @category constants
 * @since 1.0.0
 */
export const PENDING_CREATE_MAX_AGE_MS = 86_400_000

/**
 * The key a pending create is matched on.
 *
 * Length-prefixed rather than delimiter-joined, so a listener id or a
 * repository containing the delimiter cannot forge another entry's key.
 */
const pendingKey = (listenerId: string, repository: string, callbackUrl: string): string =>
  `${listenerId.length}:${listenerId}|${repository.length}:${repository}|${callbackUrl}`

/**
 * The workspace's ownership state.
 *
 * @category models
 * @since 1.0.0
 */
export interface OwnershipState {
  readonly version: 1
  readonly github: ReadonlyArray<Ownership>
  /** Creates started but not confirmed. Empty in the steady state. */
  readonly pending?: ReadonlyArray<PendingCreate> | undefined
}

/**
 * A hook as GitHub reports it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RemoteHook {
  readonly id: number
  readonly active: boolean
  readonly events: ReadonlyArray<string>
  readonly config: {
    readonly url?: string | undefined
    readonly content_type?: string | undefined
    readonly insecure_ssl?: string | number | undefined
  }
}

/**
 * One entry of a reconciliation plan.
 *
 * @category models
 * @since 1.0.0
 */
export interface PlanAction {
  readonly action: "create" | "update" | "delete" | "noop" | "leave" | "conflict"
  readonly listenerId: string | null
  readonly repository: string
  readonly hookId: number | null
  readonly reason: string
  readonly destructive: boolean
}

/**
 * A reconciliation plan.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconcilePlan {
  readonly registryPath: string
  readonly statePath: string
  readonly actions: ReadonlyArray<PlanAction>
  readonly changes: number
  readonly destructiveChanges: number
}

const configError = (message: string, details?: Record<string, unknown>, cause?: unknown): IntegrationError =>
  new IntegrationError("invalid-config", message, details, cause === undefined ? undefined : { cause })

const ID = /^[a-z0-9][a-z0-9._-]*$/
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

const validateCallbackUrl = (value: unknown, flowId: string, issues: Array<string>, at: string): void => {
  if (typeof value !== "string") {
    issues.push(`${at}.callbackUrl must be a string`)
    return
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    issues.push(`${at}.callbackUrl must be an absolute URL`)
    return
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    issues.push(`${at}.callbackUrl must be an HTTPS URL without embedded credentials, query parameters, or a fragment`)
    return
  }
  // Compared exactly. A tolerated trailing slash would produce a hook whose
  // deliveries the receiving route can only answer with a 404.
  const expected = `/webhooks/${encodeURIComponent(flowId)}`
  if (url.pathname !== expected) {
    issues.push(`${at}.callbackUrl path must be ${expected} for flow "${flowId}"`)
  }
}

const validateListener = (value: unknown, index: number, issues: Array<string>): Listener | undefined => {
  const at = `listeners[${index}]`
  const before = issues.length
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`)
    return undefined
  }
  const known = new Set(["id", "provider", "repository", "events", "flowId", "callbackUrl", "secretEnv", "active"])
  for (const key of Object.keys(value)) if (!known.has(key)) issues.push(`${at}.${key} is not a listener field`)
  const id = value["id"]
  if (typeof id !== "string" || !ID.test(id)) {
    issues.push(`${at}.id must use lowercase letters, numbers, dots, underscores, or hyphens`)
  }
  if (value["provider"] !== "github") issues.push(`${at}.provider must be "github"`)
  const repository = value["repository"]
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    issues.push(`${at}.repository must be owner/repository`)
  }
  const events = value["events"]
  if (
    !Array.isArray(events) || events.length === 0 ||
    events.some((event) => !LISTENER_EVENTS.includes(event as ListenerEvent))
  ) {
    issues.push(`${at}.events must be a non-empty array of ${LISTENER_EVENTS.join(", ")}`)
  }
  const flowId = value["flowId"]
  if (typeof flowId !== "string" || flowId.length === 0) issues.push(`${at}.flowId must be a non-empty string`)
  validateCallbackUrl(value["callbackUrl"], typeof flowId === "string" ? flowId : "", issues, at)
  const secretEnv = value["secretEnv"]
  if (typeof secretEnv !== "string" || !ENV_NAME.test(secretEnv)) {
    issues.push(`${at}.secretEnv must be an environment variable name`)
  }
  const active = value["active"]
  if (active !== undefined && typeof active !== "boolean") issues.push(`${at}.active must be a boolean`)
  if (issues.length > before) return undefined
  return {
    id: id as string,
    provider: "github",
    repository: repository as string,
    events: events as Array<ListenerEvent>,
    flowId: flowId as string,
    callbackUrl: value["callbackUrl"] as string,
    secretEnv: secretEnv as string,
    active: active === undefined ? true : (active as boolean)
  }
}

/**
 * Parses and validates a declaration.
 *
 * Accepts JSON text or an already-parsed value, and reports every problem it
 * finds rather than the first, because editing a declaration one error at a
 * time is miserable.
 *
 * @category constructors
 * @since 1.0.0
 */
export const parseRegistry = (input: unknown, source: string = DEFAULT_REGISTRY_PATH): Registry => {
  let value = input
  if (typeof input === "string") {
    try {
      value = JSON.parse(input)
    } catch (cause) {
      throw configError(`Listener registry ${source} is not valid JSON.`, { source }, cause)
    }
  }
  const issues: Array<string> = []
  if (!isRecord(value)) throw configError(`Listener registry ${source} must be an object.`, { source })
  if (value["version"] !== 1) issues.push("version must be 1")
  const rawListeners = value["listeners"]
  if (!Array.isArray(rawListeners)) issues.push("listeners must be an array")
  const listeners: Array<Listener> = []
  if (Array.isArray(rawListeners)) {
    for (const [index, raw] of rawListeners.entries()) {
      const listener = validateListener(raw, index, issues)
      if (listener !== undefined) listeners.push(listener)
    }
  }
  const seen = new Set<string>()
  const destinations = new Map<string, string>()
  // One repository plus one callback URL is one GitHub hook. The per-flow path
  // rule already keeps two flows off one URL, so the pair can only repeat
  // within a flow, where it asks for a second hook delivering to the same
  // endpoint and doubles every overlapping delivery. Reconciliation cannot
  // report that honestly either: the second listener's preflight finds a hook
  // this workspace created for the first and has to call it a `conflict` with
  // an unowned hook. The declaration is the place to say so, because it is the
  // thing that can be edited.
  const hookKeys = new Map<string, string>()
  for (const listener of listeners) {
    if (seen.has(listener.id)) issues.push(`duplicate listener id "${listener.id}"`)
    seen.add(listener.id)
    const hookKey = `${listener.repository} ${listener.callbackUrl}`
    const firstClaimant = hookKeys.get(hookKey)
    if (firstClaimant !== undefined && firstClaimant !== listener.id) {
      issues.push(
        `listeners "${firstClaimant}" and "${listener.id}" both declare ${listener.callbackUrl} on ${listener.repository}, which is one GitHub hook`
      )
    } else hookKeys.set(hookKey, listener.id)
    const destination = `${listener.callbackUrl} ${listener.secretEnv}`
    const existing = destinations.get(listener.flowId)
    if (existing !== undefined && existing !== destination) {
      issues.push(`listeners for flow "${listener.flowId}" must share callbackUrl and secretEnv`)
    }
    destinations.set(listener.flowId, destination)
  }
  if (issues.length > 0) {
    throw configError(
      `Listener registry ${source} failed validation: ${issues.join("; ")}`,
      { source, issues }
    )
  }
  return { version: 1, listeners }
}

/**
 * Reads and validates `.smithers/listeners.json` under `workspaceRoot`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const readRegistry = (workspaceRoot: string): Registry => {
  const path = resolvePath(workspaceRoot, DEFAULT_REGISTRY_PATH)
  if (!existsSync(path)) throw configError(`Listener registry not found at ${path}.`, { path })
  return parseRegistry(readFileSync(path, "utf8"), path)
}

const parseOwnership = (value: unknown, path: string): OwnershipState => {
  const bad = () =>
    configError(`Listener ownership state ${path} is invalid; refusing unsafe reconciliation.`, { path })
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["github"])) throw bad()
  const github: Array<Ownership> = []
  for (const entry of value["github"]) {
    if (
      !isRecord(entry) || typeof entry["listenerId"] !== "string" || typeof entry["repository"] !== "string" ||
      typeof entry["hookId"] !== "number" || !Number.isInteger(entry["hookId"]) || entry["hookId"] <= 0 ||
      typeof entry["callbackUrl"] !== "string" ||
      (entry["secretDigest"] !== undefined && typeof entry["secretDigest"] !== "string")
    ) {
      throw bad()
    }
    github.push({
      listenerId: entry["listenerId"],
      repository: entry["repository"],
      hookId: entry["hookId"],
      callbackUrl: entry["callbackUrl"],
      secretDigest: entry["secretDigest"]
    })
  }
  const rawPending = value["pending"]
  if (rawPending !== undefined && !Array.isArray(rawPending)) throw bad()
  const pending: Array<PendingCreate> = []
  for (const entry of rawPending ?? []) {
    if (
      !isRecord(entry) || typeof entry["listenerId"] !== "string" || typeof entry["repository"] !== "string" ||
      typeof entry["callbackUrl"] !== "string" || typeof entry["startedAtMs"] !== "number" ||
      !Number.isSafeInteger(entry["startedAtMs"]) || entry["startedAtMs"] < 0
    ) {
      throw bad()
    }
    pending.push({
      listenerId: entry["listenerId"],
      repository: entry["repository"],
      callbackUrl: entry["callbackUrl"],
      startedAtMs: entry["startedAtMs"]
    })
  }
  return { version: 1, github, pending }
}

/**
 * Decodes the hook list GitHub returned for one repository.
 *
 * `paginate` hands back `unknown`, and `plan` reads `hook.id`,
 * `hook.config.url`, `hook.events`, and `hook.active`. A malformed member
 * would produce a raw `TypeError` inside `Effect.gen`, which dies as a defect
 * rather than failing `decode-failed`, and a wrong-typed `id` would silently
 * misclassify ownership. So the array is decoded once, here, and the failure
 * names the member and the field rather than carrying the body.
 *
 * @category constructors
 * @since 1.0.0
 */
export const parseRemoteHooks = (value: ReadonlyArray<unknown>, repository: string): ReadonlyArray<RemoteHook> => {
  const bad = (index: number, field: string): never => {
    throw new IntegrationError(
      "decode-failed",
      `GitHub returned a hook this workspace cannot read for ${repository}: hooks[${index}].${field}.`,
      { repository, index, field }
    )
  }
  const hooks: Array<RemoteHook> = []
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) bad(index, "")
    const hook = entry as Record<string, unknown>
    const id = hook["id"]
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) bad(index, "id")
    const config = hook["config"]
    if (!isRecord(config)) bad(index, "config")
    // Required, not optional: `plan` decides drift and collisions by comparing
    // this URL, so a hook without one is a hook it cannot compare.
    const url = (config as Record<string, unknown>)["url"]
    if (typeof url !== "string") bad(index, "config.url")
    const contentType = (config as Record<string, unknown>)["content_type"]
    if (contentType !== undefined && typeof contentType !== "string") bad(index, "config.content_type")
    const insecure = (config as Record<string, unknown>)["insecure_ssl"]
    if (insecure !== undefined && typeof insecure !== "string" && typeof insecure !== "number") {
      bad(index, "config.insecure_ssl")
    }
    const events = hook["events"]
    if (!Array.isArray(events) || events.some((event) => typeof event !== "string")) bad(index, "events")
    const active = hook["active"]
    if (typeof active !== "boolean") bad(index, "active")
    hooks.push({
      id: id as number,
      active: active as boolean,
      events: events as ReadonlyArray<string>,
      config: {
        url: url as string,
        content_type: contentType as string | undefined,
        insecure_ssl: insecure as string | number | undefined
      }
    })
  }
  return hooks
}

/**
 * Reads the ownership state, or an empty one when the workspace has never
 * reconciled.
 *
 * A state file that exists but cannot be parsed is fatal: reconciling without
 * knowing what this workspace owns is how somebody else's hook gets deleted.
 *
 * @category constructors
 * @since 1.0.0
 */
export const readOwnershipState = (workspaceRoot: string): OwnershipState => {
  const path = resolvePath(workspaceRoot, DEFAULT_STATE_PATH)
  if (!existsSync(path)) return { version: 1, github: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (cause) {
    throw configError(`Listener ownership state ${path} is invalid; refusing unsafe reconciliation.`, { path }, cause)
  }
  return parseOwnership(parsed, path)
}

const writeOwnershipState = (workspaceRoot: string, state: OwnershipState): void => {
  const path = resolvePath(workspaceRoot, DEFAULT_STATE_PATH)
  const directory = dirname(path)
  for (const entry of [directory, path]) {
    if (lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw configError(`Listener ownership state refuses symbolic link ${entry}.`, { path: entry })
    }
  }
  mkdirSync(directory, { recursive: true })
  // Exclusive creation refuses an existing file or symlink; the random name
  // also keeps stale files from earlier runs out of the write path.
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`)
    fsyncSync(descriptor)
    renameSync(temporary, path)
  } finally {
    try {
      closeSync(descriptor)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

const normalizedEvents = (events: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(events)].sort()

const sameEvents = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  JSON.stringify(normalizedEvents(left)) === JSON.stringify(normalizedEvents(right))

const secretDigest = (secret: string): string => createHash("sha256").update(secret).digest("hex")

/**
 * What {@link plan} compares.
 *
 * @category models
 * @since 1.0.0
 */
export interface PlanInput {
  readonly registry: Registry
  readonly state: OwnershipState
  readonly hooksByRepository: ReadonlyMap<string, ReadonlyArray<RemoteHook>>
  /** Digests of the current secrets, so a rotated secret shows as drift. */
  readonly secretDigests?: ReadonlyMap<string, string> | undefined
  /** "Now", for aging out a pending create. Defaults to the wall clock. */
  readonly nowMs?: number | undefined
}

/**
 * Compares the declaration with what GitHub reports. Pure: it performs no
 * requests and writes nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const plan = (input: PlanInput): ReadonlyArray<PlanAction> => {
  const hooksFor = (repository: string): ReadonlyArray<RemoteHook> => input.hooksByRepository.get(repository) ?? []
  const desiredById = new Map(input.registry.listeners.map((listener) => [listener.id, listener]))
  const ownershipById = new Map(input.state.github.map((owned) => [owned.listenerId, owned]))
  const ownedHookKeys = new Set(input.state.github.map((owned) => `${owned.repository}:${owned.hookId}`))
  const nowMs = input.nowMs ?? Date.now()
  const pendingKeys = new Set(
    (input.state.pending ?? [])
      .filter((entry) => nowMs - entry.startedAtMs <= PENDING_CREATE_MAX_AGE_MS)
      .map((entry) => pendingKey(entry.listenerId, entry.repository, entry.callbackUrl))
  )
  const actions: Array<PlanAction> = []

  // Every `create` runs the same preflight. An unowned hook already holding
  // the declared callback URL means a second hook would double every delivery
  // to that endpoint, which is exactly what `conflict` exists to prevent, and
  // it is just as true for a listener that moved repositories or whose hook
  // was deleted remotely as for one this workspace has never seen.
  //
  // The one exception is a hook a recent run of this workspace was recorded as
  // creating. That inference is bounded on purpose: the record must still be
  // inside {@link PENDING_CREATE_MAX_AGE_MS}, and exactly one hook may hold
  // the URL. Two hooks on one URL means the workspace cannot tell its own from
  // the other, so it refuses rather than guessing, which is the whole point of
  // requiring ownership by hook id everywhere else.
  const createOrClaim = (listener: Listener, reason: string): PlanAction => {
    const collisions = hooksFor(listener.repository).filter((hook) => hook.config.url === listener.callbackUrl)
    const collision = collisions[0]
    if (collision === undefined) {
      return {
        action: "create",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: null,
        reason,
        destructive: false
      }
    }
    const key = pendingKey(listener.id, listener.repository, listener.callbackUrl)
    if (collisions.length === 1 && pendingKeys.has(key)) {
      return {
        action: "update",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: collision.id,
        reason: "adopting the GitHub hook an interrupted run of this workspace created",
        destructive: false
      }
    }
    return {
      action: "conflict",
      listenerId: listener.id,
      repository: listener.repository,
      hookId: collision.id,
      reason: "matching callback URL is not owned by this workspace",
      destructive: false
    }
  }

  for (const listener of input.registry.listeners) {
    const owned = ownershipById.get(listener.id)
    const hooks = hooksFor(listener.repository)
    const remote = owned === undefined ? undefined : hooks.find((hook) => hook.id === owned.hookId)
    if (owned === undefined) {
      actions.push(createOrClaim(listener, "declared listener is missing"))
      continue
    }
    if (owned.repository !== listener.repository) {
      // Only delete a hook that is still there. A run that deleted the old
      // hook and died before writing ownership used to leave a plan that
      // deleted it again forever: GitHub answered 404, apply aborted before
      // the create, and the move never completed. Skipping an absent delete
      // makes the move converge on the next run with no journal at all.
      if (hooksFor(owned.repository).some((hook) => hook.id === owned.hookId)) {
        actions.push({
          action: "delete",
          listenerId: listener.id,
          repository: owned.repository,
          hookId: owned.hookId,
          reason: "owned listener moved repositories",
          destructive: true
        })
      }
      actions.push(createOrClaim(listener, "declared listener moved repositories"))
      continue
    }
    if (remote === undefined) {
      actions.push(createOrClaim(listener, "owned GitHub hook was removed remotely"))
      continue
    }
    const digest = input.secretDigests?.get(listener.id)
    const drifted = remote.config.url !== listener.callbackUrl ||
      remote.config.content_type !== "json" ||
      String(remote.config.insecure_ssl ?? "0") !== "0" ||
      remote.active !== listener.active ||
      !sameEvents(remote.events, listener.events) ||
      (digest !== undefined && owned.secretDigest !== digest)
    actions.push({
      action: drifted ? "update" : "noop",
      listenerId: listener.id,
      repository: listener.repository,
      hookId: remote.id,
      reason: drifted
        ? "owned GitHub hook drifted from the declaration"
        : "owned GitHub hook matches the declaration",
      destructive: false
    })
  }

  for (const owned of input.state.github) {
    if (desiredById.has(owned.listenerId)) continue
    if (!hooksFor(owned.repository).some((hook) => hook.id === owned.hookId)) continue
    actions.push({
      action: "delete",
      listenerId: owned.listenerId,
      repository: owned.repository,
      hookId: owned.hookId,
      reason: "owned listener was removed from the registry",
      destructive: true
    })
  }

  // Report each unowned hook once per repository, not once per declared
  // listener in it, and never alongside an action that already names it: the
  // `conflict` that covers it, or the `update` that adopts it.
  const addressedKeys = new Set(
    actions
      .filter((action) => action.action !== "leave" && action.hookId !== null)
      .map((action) => `${action.repository}:${action.hookId}`)
  )
  for (const repository of new Set(input.registry.listeners.map((listener) => listener.repository))) {
    for (const hook of hooksFor(repository)) {
      const key = `${repository}:${hook.id}`
      if (ownedHookKeys.has(key) || addressedKeys.has(key)) continue
      actions.push({
        action: "leave",
        listenerId: null,
        repository,
        hookId: hook.id,
        reason: "GitHub hook is not owned by this workspace",
        destructive: false
      })
    }
  }
  return actions
}

/**
 * What {@link reconcile} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconcileOptions {
  /**
   * Where `.smithers/listeners.json` and its state file live. Defaults to the
   * host's working directory, through the named `Environment` accessor rather
   * than a bare `process.cwd()`, so the ambient read is a decision the module
   * states rather than one a missing argument makes.
   */
  readonly workspaceRoot?: string | undefined
  /** An in-memory declaration, instead of reading the workspace file. */
  readonly registry?: Registry | undefined
  /** Perform creates and updates. Without it, `reconcile` only plans. */
  readonly apply?: boolean | undefined
  /** Perform deletes. Required in addition to `apply`. */
  readonly allowDelete?: boolean | undefined
  readonly token?: string | undefined
  readonly apiBaseUrl?: string | undefined
  /**
   * Replaces the ambient environment outright, for both webhook secrets and
   * GitHub credentials. Reconciliation mutates a real repository, so an
   * explicit environment must never let an ambient `GITHUB_TOKEN` decide which
   * account the hooks are created under.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /**
   * An already-built client, for a caller that has one.
   *
   * A client carries its own credential, so supplying one skips the GitHub
   * token check entirely: a host that injects an authenticated client does not
   * also have to invent a `GITHUB_TOKEN` to get past a check about a request
   * this module will never make. Each listener's webhook-secret variable is
   * still required, because the secret goes into the hook body.
   */
  readonly client?: GitHubClient | undefined
}

/**
 * What {@link reconcile} did.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconcileResult extends ReconcilePlan {
  readonly applied: ReadonlyArray<PlanAction>
  readonly skipped: ReadonlyArray<PlanAction>
}

const permissionError = (repository: string, cause: IntegrationError): IntegrationError => {
  const status = cause.details?.["status"]
  if (status === 401 || status === 403 || status === 404) {
    return new IntegrationError(
      "permission-denied",
      `GitHub listener reconciliation cannot administer webhooks for ${repository}. The token needs fine-grained Webhooks read/write permission or classic admin:repo_hook access.`,
      { repository, status },
      { cause }
    )
  }
  return cause
}

/**
 * Runs a synchronous boundary inside the typed failure channel.
 *
 * `readRegistry`, `readOwnershipState`, and `writeOwnershipState` all throw:
 * a missing declaration, an unparseable state file, an EACCES on the write.
 * A throw inside `Effect.gen` is a defect, not a failure, so a caller's
 * `catchTag` on `IntegrationError` would miss the single most common operator
 * error. Every one of those calls goes through this instead.
 */
const attempt = <A>(run: () => A): Effect.Effect<A, IntegrationError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      isIntegrationError(cause)
        ? cause
        : configError(
          `GitHub listener reconciliation could not read or write its workspace files: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          undefined,
          cause
        )
  })

interface WorkspaceLockHolder {
  readonly pid: number
  readonly startedAtMs: number
}

interface WorkspaceLock extends WorkspaceLockHolder {
  readonly path: string
  readonly contents: string
}

const readWorkspaceLockHolder = (contents: string): WorkspaceLockHolder | null => {
  try {
    const parsed: unknown = JSON.parse(contents)
    if (!isRecord(parsed)) return null
    const pid = parsed["pid"]
    const startedAtMs = parsed["startedAtMs"]
    if (
      typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
      typeof startedAtMs !== "number" || !Number.isSafeInteger(startedAtMs) || startedAtMs < 0
    ) return null
    return { pid, startedAtMs }
  } catch {
    // Legacy writers may still be initializing an empty record. The acquirer
    // uses its file age before considering an unreadable holder reclaimable.
    return null
  }
}

const readWorkspaceLock = (path: string) => {
  try {
    const stat = lstatSync(path)
    const contents = readFileSync(path, "utf8")
    return { stat, contents, holder: readWorkspaceLockHolder(contents) }
  } catch (cause) {
    // A holder can release the lock between publication and inspection.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
}

const acquireWorkspaceLock = (workspaceRoot: string): WorkspaceLock => {
  const path = resolvePath(workspaceRoot, DEFAULT_LOCK_PATH)
  mkdirSync(dirname(path), { recursive: true })
  const holder = { pid: process.pid, startedAtMs: Date.now(), nonce: randomUUID() }
  const contents = `${JSON.stringify(holder, null, 2)}\n`
  const temporary = `${path}.${holder.nonce}.tmp`
  try {
    // Publish only complete records. A hard link is exclusive, unlike rename,
    // and cannot expose the empty-file window of open("wx") followed by write.
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 })
    for (;;) {
      try {
        linkSync(temporary, path)
        return { ...holder, path, contents }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
      }
      const existing = readWorkspaceLock(path)
      if (existing === undefined) continue
      let dead = false
      if (existing.holder !== null) {
        try {
          process.kill(existing.holder.pid, 0)
        } catch (cause) {
          // EPERM and other failures do not establish that the holder died.
          dead = (cause as NodeJS.ErrnoException).code === "ESRCH"
        }
      }
      const held = existing.holder === null
        ? Date.now() - existing.stat.mtimeMs <= 5_000
        : !dead && Date.now() - existing.holder.startedAtMs <= PENDING_CREATE_MAX_AGE_MS
      if (held) {
        throw new IntegrationError(
          "listener-conflict",
          `GitHub listener apply refused because workspace lock ${path} is held${
            existing.holder === null ? " or initializing" : ` by pid ${existing.holder.pid}`
          }.`,
          {
            lockPath: path,
            holderPid: existing.holder?.pid,
            startedAtMs: existing.holder?.startedAtMs,
            retryable: false
          }
        )
      }
      // A competing reclaimer may have published a different holder while we
      // checked liveness. Re-read both record and inode before removing it.
      const current = readWorkspaceLock(path)
      if (
        current === undefined || current.contents !== existing.contents ||
        current.stat.dev !== existing.stat.dev || current.stat.ino !== existing.stat.ino
      ) continue
      rmSync(path, { force: true })
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

const releaseWorkspaceLock = (lock: WorkspaceLock): void => {
  if (!existsSync(lock.path)) return
  // A lock older than the bound may have been replaced. Only its creator may
  // remove the current path, or one late finalizer could unlock another run.
  if (readFileSync(lock.path, "utf8") !== lock.contents) return
  rmSync(lock.path, { force: true })
}

/**
 * Plans, and optionally applies, the declaration against GitHub.
 *
 * A create is recorded as pending before the POST and confirmed as ownership
 * after it, so a process that dies in between leaves a state file the next run
 * converges from: it recognizes the hook it was creating and adopts it, rather
 * than reporting a permanent `conflict` against its own work.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reconcile = (options: ReconcileOptions = {}): Effect.Effect<ReconcileResult, IntegrationError> => {
  const workspaceRoot = resolvePath(options.workspaceRoot ?? Environment.ambientWorkingDirectory())
  const run = Effect.gen(function*() {
    const registryPath = resolvePath(workspaceRoot, DEFAULT_REGISTRY_PATH)
    const statePath = resolvePath(workspaceRoot, DEFAULT_STATE_PATH)
    const registry = options.registry ?? (yield* attempt(() => readRegistry(workspaceRoot)))
    const state = yield* attempt(() => readOwnershipState(workspaceRoot))
    const env = options.env ?? Environment.ambientEnvironment()
    const resolved = resolveConfig({ token: options.token, apiBaseUrl: options.apiBaseUrl }, env)
    // An injected client carries its own credential, so the ambient token is
    // neither read nor required: requiring one would be a check about a
    // request this module is not going to make.
    if (options.client === undefined && resolved.token === undefined) {
      return yield* Effect.fail(
        new IntegrationError(
          "credentials-missing",
          "GitHub listener reconciliation requires SMITHERS_GITHUB_TOKEN (or GITHUB_TOKEN) with fine-grained Webhooks read/write permission or classic admin:repo_hook access."
        )
      )
    }
    const secrets = new Map<string, string>()
    const digests = new Map<string, string>()
    for (const listener of registry.listeners) {
      const secret = env[listener.secretEnv]
      if (secret === undefined || secret.length === 0) {
        return yield* Effect.fail(
          new IntegrationError(
            "credentials-missing",
            `GitHub listener "${listener.id}" requires webhook secret environment variable ${listener.secretEnv}.`,
            { listenerId: listener.id, secretEnv: listener.secretEnv }
          )
        )
      }
      secrets.set(listener.id, secret)
      digests.set(listener.id, secretDigest(secret))
    }
    const client = options.client ??
      (yield* attempt(() => makeClient({ token: resolved.token, apiBaseUrl: resolved.apiBaseUrl })))
    const repositories = new Set([
      ...registry.listeners.map((listener) => listener.repository),
      ...state.github.map((owned) => owned.repository)
    ])
    const hooksByRepository = new Map<string, ReadonlyArray<RemoteHook>>()
    for (const repository of repositories) {
      const path = yield* attempt(() => fullNamePath(repository))
      const page = yield* client.paginate(`/repos/${path}/hooks`, { maxPages: 10 }).pipe(
        Effect.mapError((cause) => permissionError(repository, cause))
      )
      // A truncated list is not a short list. Planning against it would emit a
      // `create` for an owned hook that is simply past the page budget, so the
      // repository would end up with a second hook on the same URL.
      if (page.truncated) {
        return yield* Effect.fail(
          new IntegrationError(
            "delivery-failed",
            `GitHub returned more webhooks for ${repository} than one reconciliation can read, so the plan would be built from an incomplete list.`,
            { repository, retryable: false }
          )
        )
      }
      hooksByRepository.set(repository, yield* attempt(() => parseRemoteHooks(page.items, repository)))
    }
    const actions = plan({ registry, state, hooksByRepository, secretDigests: digests })
    const summary: ReconcilePlan = {
      registryPath,
      statePath,
      actions,
      changes: actions.filter((action) => ["create", "update", "delete"].includes(action.action)).length,
      destructiveChanges: actions.filter((action) => action.action === "delete").length
    }
    if (options.apply !== true) {
      return {
        ...summary,
        applied: [],
        skipped: actions.filter((action) => action.action !== "noop" && action.action !== "leave")
      }
    }
    if (actions.some((action) => action.action === "conflict")) {
      return yield* Effect.fail(
        new IntegrationError(
          "listener-conflict",
          "GitHub listener apply refused because an unowned hook uses a declared callback URL. Adopt it manually or choose a different callback URL; Smithers will not modify it.",
          { conflicts: actions.filter((action) => action.action === "conflict") }
        )
      )
    }
    const desiredById = new Map(registry.listeners.map((listener) => [listener.id, listener]))
    // A move is a delete plus a create. Without `allowDelete` the delete is
    // skipped, so the create must be skipped too: applying it alone would
    // leave the repository with two live hooks for one listener.
    const blockedMoves = new Set(
      options.allowDelete === true ? [] : actions
        .filter((action) =>
          action.action === "delete" && action.listenerId !== null && desiredById.has(action.listenerId)
        )
        .map((action) => action.listenerId as string)
    )
    let github: Array<Ownership> = state.github.map((owned) => ({ ...owned }))
    // The pending set carries over so two interrupted runs in a row still
    // converge, but only for a create this declaration still asks for. A
    // record kept past the declaration that produced it would be a standing
    // licence to adopt whatever hook later appeared on that URL.
    let pending: Array<PendingCreate> = (state.pending ?? []).filter((entry) => {
      const listener = desiredById.get(entry.listenerId)
      return listener !== undefined && listener.repository === entry.repository &&
        listener.callbackUrl === entry.callbackUrl
    }).map((entry) => ({ ...entry }))
    const commit = () => attempt(() => writeOwnershipState(workspaceRoot, { version: 1, github, pending }))
    const applied: Array<PlanAction> = []
    const skipped: Array<PlanAction> = []
    for (const action of actions) {
      if (action.action === "delete" && options.allowDelete !== true) {
        skipped.push(action)
        continue
      }
      if (!["create", "update", "delete"].includes(action.action)) continue
      if (action.action === "create" && action.listenerId !== null && blockedMoves.has(action.listenerId)) {
        skipped.push(action)
        continue
      }
      const path = yield* attempt(() => fullNamePath(action.repository))
      if (action.action === "delete") {
        yield* client.request("DELETE", `/repos/${path}/hooks/${action.hookId}`)
        github = github.filter((owned) => !(owned.repository === action.repository && owned.hookId === action.hookId))
      } else {
        const listener = action.listenerId === null ? undefined : desiredById.get(action.listenerId)
        if (listener === undefined) {
          return yield* Effect.fail(
            configError(`Listener "${action.listenerId}" disappeared while applying the plan.`)
          )
        }
        const body = {
          name: "web",
          active: listener.active,
          events: normalizedEvents(listener.events),
          config: {
            url: listener.callbackUrl,
            content_type: "json",
            insecure_ssl: "0",
            secret: secrets.get(listener.id)
          }
        }
        if (action.action === "create") {
          // Recorded before the POST, so a crash between GitHub accepting the
          // hook and this workspace claiming it leaves evidence the next run
          // reads as "this is mine" instead of "somebody else owns this URL".
          pending = [
            ...pending.filter((entry) => entry.listenerId !== listener.id),
            {
              listenerId: listener.id,
              repository: listener.repository,
              callbackUrl: listener.callbackUrl,
              startedAtMs: Date.now()
            }
          ]
          yield* commit()
        }
        const hook = action.action === "create"
          ? yield* client.request("POST", `/repos/${path}/hooks`, body).pipe(
            // A refusal is not an unknown outcome: GitHub says it did not
            // create the hook, so the pending record is retired before the
            // failure escapes. Only a lost answer, which the client marks
            // `outcomeUnknown`, leaves a claim behind for the next run.
            Effect.tapError((cause) =>
              cause.details?.["outcomeUnknown"] === true ? Effect.void : Effect.suspend(() => {
                pending = pending.filter((entry) => entry.listenerId !== listener.id)
                return commit()
              })
            )
          )
          : yield* client.request("PATCH", `/repos/${path}/hooks/${action.hookId}`, body)
        const hookId = isRecord(hook)
          ? Object.hasOwn(hook, "id") ? hook["id"] : action.hookId
          : undefined
        if (typeof hookId !== "number" || !Number.isSafeInteger(hookId) || hookId <= 0) {
          return yield* Effect.fail(
            new IntegrationError(
              "decode-failed",
              `GitHub did not return a valid hook id for listener "${listener.id}".`,
              { listenerId: listener.id }
            )
          )
        }
        github = github.filter((owned) => owned.listenerId !== listener.id)
        github.push({
          listenerId: listener.id,
          repository: listener.repository,
          hookId,
          callbackUrl: listener.callbackUrl,
          secretDigest: digests.get(listener.id)
        })
        pending = pending.filter((entry) => entry.listenerId !== listener.id)
      }
      yield* commit()
      applied.push(action)
    }
    yield* commit()
    return { ...summary, applied, skipped }
  })
  const traced = run.pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        "listeners.applied": result.applied.length,
        "listeners.skipped": result.skipped.length
      })
    ),
    Effect.withSpan("ListenerRegistry.reconcile", { attributes: { "listeners.apply": options.apply === true } })
  )
  if (options.apply !== true) return traced
  return Effect.acquireUseRelease(
    attempt(() => acquireWorkspaceLock(workspaceRoot)),
    () => traced,
    (lock) => attempt(() => releaseWorkspaceLock(lock))
  )
}
