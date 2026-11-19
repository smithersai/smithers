/**
 * The durable copy of the deployment's Alchemy state, kept in R2.
 *
 * Alchemy maps each logical resource to the physical Worker, D1 database, and
 * R2 bucket it created only through its state. State that lives on one
 * operator's disk is lost with that disk, and the next deployment from any
 * other machine creates a second production instead of updating the first.
 *
 * The deploy wrapper therefore treats each stage's local state directory as a
 * working copy of that stage's own snapshot object in R2. It takes the stage's
 * remote lock, pulls the snapshot over the stage directory, runs Alchemy,
 * redacts, and publishes the snapshot back with a compare-and-swap on the
 * version it pulled. A deployment of one stage never reads, locks, or
 * publishes another's object. The remote copy only ever receives redacted
 * state.
 *
 * State used to be one object holding every stage. `pnpm run migrate-state`
 * (this module's process entry) splits it, and a deployment refuses while the
 * shared object still holds state. The shared `alchemy-state-store`
 * Worker is not used because reading its bearer needs Cloudflare Secrets Store
 * access, which the deploy token does not have; R2 needs only the R2 access the
 * deployment already requires.
 *
 * @since 0.1.0
 */

import { errorCode } from "@smthrs/targets/SafeFs"
import { AwsClient } from "aws4fetch"
import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { createHash, randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { stackName } from "../deployment.ts"
import { failureMessage } from "./failure-message.ts"
import { defaultStateDirectory } from "./redact-state.ts"
import { resolveStateRoot } from "./state-root.ts"

/** Default deadline for one remote state operation, including its response body.
 * @category constants
 * @since 0.1.0
 */
export const remoteStateTimeoutMs = 30_000

/** Cancellation and deadline for remote state initialization or one request.
 * @category models
 * @since 0.1.0
 */
export interface RemoteStateRequestOptions {
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * The Promise boundary for the operator's remote state adapter.
 *
 * Effect owns the deadline and interruption: even a faulty adapter that ignores
 * its signal cannot trap the wrapper. Failures keep their original identity.
 * Operation names identify the stage without logging signed URLs or credentials.
 * @category utilities
 * @since 0.1.0
 */
export const remoteStateRequest = async <A>(
  operation: string,
  start: (signal: AbortSignal) => Promise<A>,
  options: RemoteStateRequestOptions = {}
): Promise<A> => {
  const timeoutMs = options.timeoutMs ?? remoteStateTimeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("remote state deadline must be finite and positive")
  }
  options.signal?.throwIfAborted()
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({ try: start, catch: (error) => error }).pipe(Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new Error(operation + " timed out after " + timeoutMs + "ms"))
    })),
    { signal: options.signal }
  )
  if (Exit.isSuccess(exit)) return exit.value
  if (options.signal?.aborted === true) throw options.signal.reason
  throw Cause.squash(exit.cause)
}

const responseText = async (response: Response, signal: AbortSignal): Promise<string> => {
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()
  const decoder = new TextDecoder()
  let text = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

/**
 * The R2 bucket holding the deployment's Alchemy state.
 *
 * It is created once by hand, outside this stack, because the stack's own
 * state cannot record the bucket that holds it.
 *
 * @category constants
 * @since 0.1.0
 */
export const stateBucketName = "smithers-build-infra-state"

/**
 * The stage names the deploy tooling accepts: Alchemy's own `--stage` rule, a
 * letter or digit followed by letters, digits, `-` and `_`. A stage names a
 * local directory and an R2 key, so nothing else may reach either.
 *
 * @category constants
 * @since 0.1.0
 */
export const stagePattern = /^[A-Za-z0-9][-_A-Za-z0-9]*$/

/**
 * The object holding one stage's state snapshot. Its lock is the same key
 * with `.lock` appended.
 *
 * @throws A `TypeError` for a name {@link stagePattern} refuses.
 * @category constructors
 * @since 0.1.0
 */
export const stateObjectKey = (stage: string): string => {
  if (!stagePattern.test(stage)) throw new TypeError(`not a stage name: ${JSON.stringify(stage)}`)
  return `alchemy/${stackName}/${stage}.json`
}

/**
 * The object that held every stage's state before each stage had its own.
 * Once migrated it holds a marker that names the stage objects; a wrapper
 * from before the split refuses that marker rather than deploying from it.
 *
 * @category constants
 * @since 0.1.0
 */
export const legacyStateObjectKey = `alchemy/${stackName}.json`

/**
 * The byte-for-byte copy of the shared object the migration writes before it
 * replaces the shared object with its marker, and that {@link restoreSharedState}
 * restores it from.
 *
 * @category constants
 * @since 0.1.0
 */
export const sharedStateBackupKey = `alchemy/${stackName}.pre-split.json`

const snapshotFormat = "smithers-alchemy-state/1"
const migratedFormat = "smithers-alchemy-state-migrated/1"

/**
 * The precondition a state write must satisfy: the object is still at the
 * version that was read, or no object exists yet.
 *
 * @category models
 * @since 0.1.0
 */
export type PutCondition = { readonly ifMatch: string } | { readonly ifAbsent: true }

/**
 * One stored object and the version it was read at.
 *
 * @category models
 * @since 0.1.0
 */
export interface StateObject {
  readonly body: string
  readonly etag: string
}

/**
 * The object store the state snapshot and its lock live in.
 *
 * @category models
 * @since 0.1.0
 */
export interface StateBucket {
  /** Reads an object, or `undefined` when none exists. */
  readonly get: (key: string, signal?: AbortSignal) => Promise<StateObject | undefined>
  /** Writes an object when `condition` holds; `false` when it does not. */
  readonly put: (key: string, body: string, condition: PutCondition, signal?: AbortSignal) => Promise<boolean>
  /** Deletes an object; an absent object is already deleted. */
  readonly delete: (key: string, signal?: AbortSignal) => Promise<void>
}

/**
 * Where one stack's durable state lives.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteState {
  readonly bucket: StateBucket
  readonly key: string
}

/**
 * An in-process {@link StateBucket} with the same conditional-write rules as
 * R2. The suites use it in place of the real bucket.
 *
 * @category constructors
 * @since 0.1.0
 */
export const memoryStateBucket = (): StateBucket & { readonly objects: Map<string, StateObject> } => {
  const objects = new Map<string, StateObject>()
  let version = 0
  return {
    objects,
    get: async (key) => objects.get(key),
    put: async (key, body, condition) => {
      const current = objects.get(key)
      const holds = "ifAbsent" in condition ? current === undefined : current?.etag === condition.ifMatch
      if (!holds) return false
      version += 1
      objects.set(key, { body, etag: `"${version}"` })
      return true
    },
    delete: async (key) => {
      objects.delete(key)
    }
  }
}

/**
 * The R2 bucket and the S3 credentials that reach it.
 *
 * @category models
 * @since 0.1.0
 */
export interface R2StateBucketOptions {
  /** Deadline for signing, fetching, and consuming each response. */
  readonly timeoutMs?: number | undefined
  readonly accountId: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly fetch: typeof globalThis.fetch
}

/**
 * A refusal to condition a state write on a weak ETag.
 *
 * R2 serves a gzip-compressed object with a weak ETag (`W/"…"`) and answers
 * every `If-Match` on a weak ETag with 412, so a compare-and-swap on one can
 * never succeed and would read as a concurrent deployment.
 *
 * @category errors
 * @since 0.1.0
 */
export class WeakEtagError extends Data.TaggedError("@smthrs/build-infra/WeakEtagError")<{
  readonly key: string
  readonly etag: string
}> {
  override readonly name = "WeakEtagError"
  declare readonly message: string
  constructor(options: { readonly key: string; readonly etag: string }) {
    super(options)
    Object.defineProperty(this, "message", {
      value: `R2 state ${this.key} carries the weak ETag ${this.etag}, which R2 never matches on a conditional write`,
      writable: false,
      configurable: false
    })
  }
}

const isWeakEtag = (etag: string): boolean => etag.startsWith("W/")

const describeFailure = async (method: string, key: string, response: Response, signal: AbortSignal): Promise<Error> =>
  new Error(
    `R2 state ${method} ${key} answered ${response.status}: ${(await responseText(response, signal)).slice(0, 200)}`
  )

/**
 * A {@link StateBucket} over R2's S3 API, which honours `If-Match` and
 * `If-None-Match` on writes. Cloudflare's REST object API ignores both, so it
 * cannot hold a lock or a compare-and-swap.
 *
 * Reads ask for `accept-encoding: identity`. Otherwise R2 serves the object
 * gzip-compressed with a weak ETag that no `If-Match` accepts, and the state
 * could never be saved back. A weak ETag is refused with a
 * {@link WeakEtagError} on read and as a write condition.
 *
 * @category constructors
 * @since 0.1.0
 */
export const r2StateBucket = (options: R2StateBucketOptions): StateBucket => {
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: "auto"
  })
  const fetch = options.fetch
  const url = (key: string): string =>
    `https://${options.accountId}.r2.cloudflarestorage.com/${options.bucket}/${
      key.split("/").map(encodeURIComponent).join("/")
    }`
  const send = async (key: string, init: RequestInit): Promise<Response> => {
    const request = await client.sign(url(key), init)
    request.signal.throwIfAborted()
    return fetch(request)
  }
  return {
    get: (key, signal) =>
      remoteStateRequest("R2 state GET " + key, async (signal) => {
        const response = await send(key, { method: "GET", headers: { "accept-encoding": "identity" }, signal })
        if (response.status === 404) {
          await response.body?.cancel()
          return undefined
        }
        if (!response.ok) throw await describeFailure("GET", key, response, signal)
        const etag = response.headers.get("etag")
        const body = await responseText(response, signal)
        if (etag === null) throw new Error(`R2 state GET ${key} returned no ETag, so no write can be conditioned on it`)
        if (isWeakEtag(etag)) throw new WeakEtagError({ key, etag })
        return { body, etag }
      }, { signal, timeoutMs: options.timeoutMs }),
    put: (key, body, condition, signal) =>
      remoteStateRequest("R2 state PUT " + key, async (signal) => {
        if ("ifMatch" in condition && isWeakEtag(condition.ifMatch)) {
          throw new WeakEtagError({ key, etag: condition.ifMatch })
        }
        const headers = "ifAbsent" in condition ? { "if-none-match": "*" } : { "if-match": condition.ifMatch }
        const response = await send(key, {
          method: "PUT",
          body,
          signal,
          headers: { ...headers, "content-type": "application/json" }
        })
        if (response.status === 412) {
          await response.body?.cancel()
          return false
        }
        if (!response.ok) throw await describeFailure("PUT", key, response, signal)
        // A successful conditional write is already committed. Disposal of
        // its unused response must not hide that ownership from the caller.
        void response.body?.cancel().catch(() => undefined)
        return true
      }, { signal, timeoutMs: options.timeoutMs }),
    delete: (key, signal) =>
      remoteStateRequest("R2 state DELETE " + key, async (signal) => {
        const response = await send(key, { method: "DELETE", signal })
        if (!response.ok && response.status !== 404) throw await describeFailure("DELETE", key, response, signal)
        await response.body?.cancel()
      }, { signal, timeoutMs: options.timeoutMs })
  }
}

const verifiedTokenId = async (
  fetch: typeof globalThis.fetch,
  url: string,
  apiToken: string,
  options: RemoteStateRequestOptions
): Promise<string | undefined> =>
  remoteStateRequest("Cloudflare token verification", async (signal) => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` }, signal })
    const text = await responseText(response, signal)
    // A rate limit or server error says nothing about the token, so it must not
    // read as a refusal or send the caller on to the user-token endpoint.
    const outage = new Error(`Cloudflare token verification ${url} answered ${response.status}: ${text.slice(0, 200)}`)
    if (response.status === 429 || response.status >= 500) throw outage
    let payload: { success?: boolean; result?: { id?: unknown } }
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      throw outage
    }
    return payload.success === true && typeof payload.result?.id === "string" ? payload.result.id : undefined
  }, options)

/**
 * Derives R2 S3 credentials from a Cloudflare API token.
 *
 * R2 accepts an API token as S3 credentials: the token's id is the access key
 * id and the SHA-256 of its value is the secret. The id comes from
 * Cloudflare's own verification, first as an account token, then as a user
 * token, so the deployment needs no second secret.
 *
 * @throws An `Error` naming the status when verification answers a rate limit,
 * a server error, or a body that is not JSON; an `Error` naming
 * `CLOUDFLARE_API_TOKEN` when neither endpoint verifies the token.
 * @category constructors
 * @since 0.1.0
 */
export const r2CredentialsFromApiToken = async (
  options: RemoteStateRequestOptions & {
    readonly apiToken: string
    readonly accountId: string
    readonly fetch: typeof globalThis.fetch
  }
): Promise<{ readonly accessKeyId: string; readonly secretAccessKey: string }> => {
  const api = "https://api.cloudflare.com/client/v4"
  const accessKeyId = (await verifiedTokenId(
    options.fetch,
    `${api}/accounts/${options.accountId}/tokens/verify`,
    options.apiToken,
    options
  )) ??
    (await verifiedTokenId(options.fetch, `${api}/user/tokens/verify`, options.apiToken, options))
  if (accessKeyId === undefined) {
    throw new Error("Cloudflare did not verify CLOUDFLARE_API_TOKEN, so it cannot reach the R2 state bucket")
  }
  return { accessKeyId, secretAccessKey: createHash("sha256").update(options.apiToken, "utf8").digest("hex") }
}

/**
 * The production state bucket, reached with the deploying shell's Cloudflare
 * credentials. The caller names the object: {@link stateObjectKey} for a stage.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stateBucketFromEnvironment = async (
  env: NodeJS.ProcessEnv = process.env,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  options: RemoteStateRequestOptions = {}
): Promise<StateBucket> => {
  const apiToken = env["CLOUDFLARE_API_TOKEN"]
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"]
  if (apiToken === undefined || apiToken === "") {
    throw new Error("CLOUDFLARE_API_TOKEN is required to reach the R2 state bucket")
  }
  if (accountId === undefined || accountId === "") {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required to reach the R2 state bucket")
  }
  const credentials = await r2CredentialsFromApiToken({ apiToken, accountId, fetch, ...options })
  return r2StateBucket({ accountId, bucket: stateBucketName, ...credentials, fetch, timeoutMs: options.timeoutMs })
}

interface StateTree {
  readonly files: Array<string>
  readonly directories: Array<string>
  readonly kept: Array<string>
}

const walkStateTree = async (directory: string, prefix: string): Promise<StateTree> => {
  const tree: StateTree = { files: [], directories: [], kept: [] }
  const entries: Array<Dirent> = await Fs.readdir(NodePath.join(directory, prefix), { withFileTypes: true })
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new TypeError(`Alchemy state contains a symbolic link, which a snapshot will not follow: ${relative}`)
    }
    if (entry.isDirectory()) {
      const child = await walkStateTree(directory, relative)
      tree.directories.push(relative, ...child.directories)
      tree.files.push(...child.files)
      tree.kept.push(...child.kept)
    } else if (entry.isFile() && entry.name.endsWith(".json")) tree.files.push(relative)
    else tree.kept.push(relative)
  }
  return tree
}

/**
 * Inventory the entire tree before deciding which state entries can be replaced.
 *
 * The root is resolved first: a directory reached through a symbolic link is
 * refused before anything under its target is read. A stack that has never
 * been deployed has no state directory yet and inventories as empty.
 */
const stateTree = async (directory: string): Promise<StateTree> =>
  (await resolveStateRoot(directory)) === null ? { files: [], directories: [], kept: [] } : walkStateTree(directory, "")

const renderSnapshot = (files: Record<string, string>): string => {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file]!]))
  return JSON.stringify({ format: snapshotFormat, files: sorted }, null, 2)
}

/**
 * Serializes every Alchemy state file under a stack's state directory.
 *
 * The rendering is deterministic, so a run that changed nothing renders the
 * bytes it pulled and publishes nothing. Lock files and Alchemy's temporary
 * siblings are not state and are left out.
 *
 * @throws A `TypeError` for a relative directory or one reached through a
 * symbolic link; see {@link resolveStateRoot}.
 * @category utilities
 * @since 0.1.0
 */
export const readStateSnapshot = async (directory: string): Promise<string> => {
  const files: Record<string, string> = {}
  for (const file of (await stateTree(directory)).files) {
    files[file] = await Fs.readFile(NodePath.join(directory, ...file.split("/")), "utf8")
  }
  return renderSnapshot(files)
}

const safeSegment = (segment: string): boolean =>
  segment !== "" && segment !== "." && segment !== ".." && segment.isWellFormed() && !/[\\\u0000-\u001f]/.test(segment)

// A conservative portable identity, independent of the host's case sensitivity.
// Lowercase first joins ẞ/ß, then uppercase joins expansions such as ß/SS and ſ/S.
const pathIdentity = (path: string): string =>
  path.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFD")

const pathPrefixes = (path: string): Array<string> => {
  const prefixes: Array<string> = []
  for (let separator = path.indexOf("/"); separator !== -1; separator = path.indexOf("/", separator + 1)) {
    prefixes.push(path.slice(0, separator))
  }
  return [...prefixes, path]
}

interface SnapshotPath {
  readonly path: string
  readonly kind: "file" | "directory"
}

const parseSnapshot = (body: string): {
  readonly files: Record<string, string>
  readonly paths: Map<string, SnapshotPath>
} => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new TypeError("remote Alchemy state is not JSON")
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { format?: unknown }).format !== snapshotFormat) {
    throw new TypeError(`remote Alchemy state is not a ${snapshotFormat} snapshot`)
  }
  const files = (parsed as { files?: unknown }).files
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new TypeError("remote Alchemy state has no file map")
  }
  const paths = new Map<string, SnapshotPath>()
  for (const [file, contents] of Object.entries(files)) {
    if (typeof contents !== "string") throw new TypeError(`remote Alchemy state file ${file} is not text`)
    if (!file.endsWith(".json") || !file.split("/").every(safeSegment)) {
      throw new TypeError(`remote Alchemy state names a path outside the stack: ${JSON.stringify(file)}`)
    }
    for (const path of pathPrefixes(file)) {
      const identity = pathIdentity(path)
      const kind = path === file ? "file" : "directory"
      const existing = paths.get(identity)
      if (existing !== undefined && (existing.path !== path || existing.kind !== kind)) {
        throw new TypeError(
          `remote Alchemy state paths collide: ${JSON.stringify(existing.path)} and ${JSON.stringify(path)}`
        )
      }
      paths.set(identity, { path, kind })
    }
  }
  return { files: files as Record<string, string>, paths }
}

/**
 * Replaces every Alchemy state file under `directory` with a snapshot's.
 *
 * Snapshot topology and retained local entries are validated before any local
 * changes. Files that are not state, such as the ownership lock, are kept.
 * Empty directories and directories containing only state can become files.
 * Requires exclusive access to a local POSIX tree; see README.md for the
 * supported filesystem policy. I/O failures during replacement are not atomic.
 *
 * @throws A `TypeError` for a relative directory or one reached through a
 * symbolic link, invalid snapshots, ambiguous case/Unicode names,
 * file/directory collisions, or topology that would replace a kept local entry.
 * @category utilities
 * @since 0.1.0
 */
export const writeStateSnapshot = async (directory: string, body: string): Promise<void> => {
  const { files, paths } = parseSnapshot(body)
  const local = await stateTree(directory)
  for (const path of local.directories) {
    const remote = paths.get(pathIdentity(path))
    if (remote?.kind === "directory" && remote.path !== path) {
      throw new TypeError(
        `remote Alchemy state directory ${JSON.stringify(remote.path)} aliases local directory ${JSON.stringify(path)}`
      )
    }
  }
  for (const kept of local.kept) {
    for (const prefix of pathPrefixes(kept)) {
      const remote = paths.get(pathIdentity(prefix))
      if (remote !== undefined && (prefix === kept || remote.kind === "file")) {
        throw new TypeError(
          `remote Alchemy state path ${JSON.stringify(remote.path)} conflicts with kept local entry ${
            JSON.stringify(kept)
          }`
        )
      }
    }
  }
  const directories = local.directories.filter((path) =>
    pathPrefixes(path).some((prefix) => paths.get(pathIdentity(prefix))?.kind === "file")
  )
  for (const file of local.files) {
    await Fs.rm(NodePath.join(directory, ...file.split("/")))
  }
  // Remove only directories displaced by incoming files, children first.
  // rmdir refuses unexpected retained content rather than recursively deleting it.
  for (const path of directories.sort((a, b) => b.length - a.length)) {
    await Fs.rmdir(NodePath.join(directory, ...path.split("/")))
  }
  for (const [file, contents] of Object.entries(files)) {
    const target = NodePath.join(directory, ...file.split("/"))
    await Fs.mkdir(NodePath.dirname(target), { recursive: true })
    await Fs.writeFile(target, contents, { encoding: "utf8", mode: 0o600 })
  }
}

/**
 * Who holds the remote lock, recorded in the lock object.
 *
 * @category models
 * @since 0.1.0
 */
export interface LockHolder {
  readonly host: string
  readonly pid: number
  readonly startedAt: string
}

/**
 * One deployment's hold on the remote state.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteStateSession {
  /** Publishes local state when it differs from what was pulled. */
  readonly push: () => Promise<"published" | "unchanged">
  /** Deletes the remote lock. */
  readonly release: () => Promise<void>
}

const describeHolder = (body: string): string => {
  try {
    const holder = JSON.parse(body) as LockHolder
    if (typeof holder.host === "string" && typeof holder.pid === "number") {
      return `${holder.host} pid ${holder.pid} since ${String(holder.startedAt)}`
    }
  } catch {
    // Reported below as unreadable.
  }
  return "an unreadable holder"
}

const unpublishedMarker = ".smithers-unpublished-state"
const markerFormat = "smithers-unpublished-state/1"

/** The remote version local state was pulled from, and the digest of what was pulled. */
interface UnpublishedMarker {
  readonly etag: string | null
  readonly baseline: string
}

const digest = (snapshot: string): string => createHash("sha256").update(snapshot, "utf8").digest("hex")

const readMarker = async (path: string): Promise<UnpublishedMarker | undefined> => {
  let body: string
  try {
    body = await Fs.readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
  try {
    const parsed = JSON.parse(body) as { format?: unknown; etag?: unknown; baseline?: unknown }
    if (
      parsed.format === markerFormat && (parsed.etag === null || typeof parsed.etag === "string") &&
      typeof parsed.baseline === "string"
    ) return { etag: parsed.etag, baseline: parsed.baseline }
  } catch {
    // Reported below as unreadable.
  }
  throw new TypeError(
    `the unpublished-state marker ${path} is unreadable; compare local state with ${stateBucketName} by hand, ` +
      `then delete the marker`
  )
}

const cleanupFailure = (error: unknown, releaseError: unknown): AggregateError =>
  new AggregateError(
    [error, releaseError],
    failureMessage(error) + "; Remote Alchemy state lock was not released: " + failureMessage(releaseError)
  )

/**
 * Takes the lock object beside `remote.key` with a conditional write and
 * returns its release. A held lock refuses the caller with its holder. A
 * write whose outcome is unknown is reconciled under a fresh deadline: the
 * lock is deleted only when it holds this attempt's own body.
 */
const lockRemoteState = async (
  remote: RemoteState,
  holder: LockHolder,
  options: RemoteStateRequestOptions
): Promise<() => Promise<void>> => {
  const lockKey = `${remote.key}.lock`
  const lockBody = JSON.stringify({ ...holder, attempt: randomUUID() })
  // Cleanup has a fresh deadline and no initialization signal: cancellation
  // of acquisition or the pull must still allow our lock to be deleted.
  const cleanup = { timeoutMs: options.timeoutMs }
  const release = (): Promise<void> =>
    remoteStateRequest("remote state lock DELETE", (signal) => remote.bucket.delete(lockKey, signal), cleanup)
  let attempted = false
  let acquired: boolean
  try {
    acquired = await remoteStateRequest("remote state lock PUT", (signal) => {
      attempted = true
      return remote.bucket.put(lockKey, lockBody, { ifAbsent: true }, signal)
    }, options)
  } catch (error) {
    // A refused or interrupted response does not prove the conditional PUT
    // failed. Reconcile under a fresh deadline, deleting only this holder.
    if (attempted) {
      try {
        const current = await remoteStateRequest(
          "remote state lock ownership GET",
          (signal) => remote.bucket.get(lockKey, signal),
          cleanup
        )
        if (current?.body === lockBody) await release()
      } catch (releaseError) {
        throw cleanupFailure(error, releaseError)
      }
    }
    throw error
  }
  if (!acquired) {
    const current = await remoteStateRequest(
      "remote state lock GET",
      (signal) => remote.bucket.get(lockKey, signal),
      options
    )
    if (current === undefined) {
      throw new Error(`remote Alchemy state lock ${lockKey} was released while it was read; retry the deployment`)
    }
    throw new Error(
      `remote Alchemy state is locked by ${describeHolder(current.body)}; delete ${stateBucketName}/${lockKey} ` +
        `only once that deployment is gone`
    )
  }
  return release
}

/**
 * Locks the remote state and pulls it over the local state directory.
 *
 * A held lock refuses the caller with its holder. When no snapshot exists yet,
 * local state is left as it is and becomes the first snapshot on push, which
 * is how a stack's existing local state moves to R2. The lock is released if
 * initialization fails after taking the lock.
 *
 * Until a push succeeds, a marker in the state directory records the remote
 * version local state was pulled from. A later session that finds local state
 * changed since that pull keeps it instead of pulling, so resources a failed or
 * killed run created stay recorded and are published by the next push. When
 * the remote moved on since that pull as well, the session refuses rather
 * than discard either side.
 *
 * The state directory is resolved before the lock is taken: one reached
 * through a symbolic link, in the root or an ancestor, is refused before
 * anything in the link's target is read or replaced.
 *
 * @throws An `Error` when the lock is held or local state holds unpublished
 * changes the remote has since diverged from; a `TypeError` for a relative or
 * linked state directory, an invalid snapshot or an unreadable
 * unpublished-state marker.
 *
 * @category constructors
 * @since 0.1.0
 */
export const openRemoteState = async (
  remote: RemoteState,
  directory: string,
  holder: LockHolder,
  options: RemoteStateRequestOptions = {}
): Promise<RemoteStateSession> => {
  await resolveStateRoot(directory)
  const release = await lockRemoteState(remote, holder, options)
  const cleanup = { timeoutMs: options.timeoutMs }
  const markerPath = NodePath.join(directory, unpublishedMarker)
  let pulled: StateObject | undefined
  let baseline: string
  try {
    const marker = await readMarker(markerPath)
    pulled = await remoteStateRequest(
      "remote state snapshot GET",
      (signal) => remote.bucket.get(remote.key, signal),
      options
    )
    const unpublished = marker !== undefined && digest(await readStateSnapshot(directory)) !== marker.baseline
    if (unpublished) {
      if ((pulled?.etag ?? null) !== marker.etag) {
        throw new Error(
          `local Alchemy state in ${directory} holds changes a run never published, and remote state ${remote.key} ` +
            `changed since it was pulled; reconcile them by hand, then delete ${markerPath}`
        )
      }
      baseline = marker.baseline
    } else {
      if (pulled !== undefined) await writeStateSnapshot(directory, pulled.body)
      baseline = digest(pulled === undefined ? renderSnapshot({}) : await readStateSnapshot(directory))
      await Fs.mkdir(directory, { recursive: true })
      await Fs.writeFile(
        markerPath,
        JSON.stringify({ format: markerFormat, etag: pulled?.etag ?? null, baseline }),
        { encoding: "utf8", mode: 0o600 }
      )
    }
    options.signal?.throwIfAborted()
  } catch (error) {
    try {
      await release()
    } catch (releaseError) {
      throw cleanupFailure(error, releaseError)
    }
    throw error
  }
  return {
    push: async () => {
      const snapshot = await readStateSnapshot(directory)
      if (digest(snapshot) === baseline) {
        await Fs.rm(markerPath, { force: true })
        return "unchanged"
      }
      const condition: PutCondition = pulled === undefined ? { ifAbsent: true } : { ifMatch: pulled.etag }
      if (
        !(await remoteStateRequest(
          "remote state snapshot PUT",
          (signal) => remote.bucket.put(remote.key, snapshot, condition, signal),
          cleanup
        ))
      ) {
        throw new Error(
          `remote Alchemy state ${remote.key} changed during this deployment; local state was kept in ${directory}`
        )
      }
      await Fs.rm(markerPath, { force: true })
      return "published"
    },
    release
  }
}

const isMigrationMarker = (body: string): boolean => {
  try {
    return (JSON.parse(body) as { format?: unknown } | null)?.format === migratedFormat
  } catch {
    return false
  }
}

/**
 * Refuses a deployment while state still has the shared layout from before
 * each stage had its own object.
 *
 * Two copies can hold such state. An unpublished-state marker in the stack's
 * own state directory, rather than a stage directory, records local changes
 * a wrapper of that layout never published; pulling the stage's object over
 * them would lose the resources they record. The shared R2 object, until
 * {@link migrateSharedState} replaces it with its marker, is the only copy of
 * every stage's state, and a stage object written beside it would fork it.
 * A deployment reads that object only to refuse.
 *
 * @throws An `Error` naming the marker to reconcile, or the migration command.
 * @category utilities
 * @since 0.1.0
 */
export const refuseSharedState = async (
  bucket: StateBucket,
  directory: string,
  stage: string,
  options: RemoteStateRequestOptions = {}
): Promise<void> => {
  const marker = NodePath.join(directory, unpublishedMarker)
  if ((await readMarker(marker)) !== undefined) {
    throw new Error(
      `${marker} records state a deployment from before per-stage state never published; compare ${directory} ` +
        `with each stage's object in ${stateBucketName} by hand, then delete the marker`
    )
  }
  const shared = await remoteStateRequest(
    "shared remote state GET",
    (signal) => bucket.get(legacyStateObjectKey, signal),
    options
  )
  if (shared !== undefined && !isMigrationMarker(shared.body)) {
    throw new Error(
      `remote Alchemy state is still the shared object ${stateBucketName}/${legacyStateObjectKey}, which holds ` +
        `every stage; preview splitting it with "pnpm run migrate-state -- --dry-run", run ` +
        `"pnpm run migrate-state", then deploy ${stage} again`
    )
  }
}

/**
 * What {@link migrateSharedState} did to one stage's object, or would do on a
 * dry run.
 *
 * @category models
 * @since 0.1.0
 */
export interface StageMigration {
  readonly stage: string
  readonly key: string
  readonly files: number
  /** `create` writes the object; `exists` found it already holding exactly these files. */
  readonly action: "create" | "exists"
}

/**
 * The outcome of one migration: `absent` when no shared object exists,
 * `migrated` when it already holds the migration marker, `split` when its
 * snapshot was split into the listed stage objects.
 *
 * @category models
 * @since 0.1.0
 */
export interface StateMigration {
  readonly shared: "absent" | "migrated" | "split"
  /** On a split: `create` copies the shared object to its backup; `exists` found the same bytes there. */
  readonly backup?: "create" | "exists"
  readonly stages: ReadonlyArray<StageMigration>
}

/** The stages of a shared snapshot, each with its own snapshot, in stage order. */
const stageSnapshots = (
  shared: string
): ReadonlyArray<{ readonly stage: string; readonly files: number; readonly body: string }> => {
  const byStage = new Map<string, Record<string, string>>()
  for (const [file, contents] of Object.entries(parseSnapshot(shared).files)) {
    const separator = file.indexOf("/")
    const stage = file.slice(0, Math.max(separator, 0))
    if (!stagePattern.test(stage)) {
      throw new TypeError(`shared Alchemy state file ${JSON.stringify(file)} is not inside a stage directory`)
    }
    byStage.set(stage, { ...byStage.get(stage), [file.slice(separator + 1)]: contents })
  }
  return [...byStage.keys()].sort().map((stage) => {
    const files = byStage.get(stage)!
    return { stage, files: Object.keys(files).length, body: renderSnapshot(files) }
  })
}

const objectName = (key: string): string => `${stateBucketName}/${key}`

/** Reads, conditional writes and deletes for one migration or restore, each under the request deadline. */
const stateObjects = (bucket: StateBucket, options: RemoteStateRequestOptions, operation: string) => ({
  read: (key: string): Promise<StateObject | undefined> =>
    remoteStateRequest("remote state GET " + key, (signal) => bucket.get(key, signal), options),
  write: async (key: string, body: string, condition: PutCondition): Promise<void> => {
    if (
      !(await remoteStateRequest(
        "remote state PUT " + key,
        (signal) => bucket.put(key, body, condition, signal),
        options
      ))
    ) {
      throw new Error(`${objectName(key)} changed during the ${operation}; run it again`)
    }
  },
  remove: (key: string): Promise<void> =>
    remoteStateRequest("remote state DELETE " + key, (signal) => bucket.delete(key, signal), options)
})

/** Runs `work` under the shared object's lock, or without any lock on a dry run. */
const underSharedLock = async <A>(
  bucket: StateBucket,
  holder: LockHolder,
  options: RemoteStateRequestOptions & { readonly dryRun?: boolean | undefined },
  work: (dryRun: boolean) => Promise<A>
): Promise<A> => {
  const dryRun = options.dryRun === true
  const release = dryRun
    ? async () => {}
    : await lockRemoteState({ bucket, key: legacyStateObjectKey }, holder, options)
  let result: A
  try {
    result = await work(dryRun)
  } catch (error) {
    try {
      await release()
    } catch (releaseError) {
      throw cleanupFailure(error, releaseError)
    }
    throw error
  }
  await release()
  return result
}

const splitSharedState = async (
  bucket: StateBucket,
  dryRun: boolean,
  options: RemoteStateRequestOptions
): Promise<StateMigration> => {
  const { read, write } = stateObjects(bucket, options, "migration")
  const current = await read(legacyStateObjectKey)
  if (current === undefined) return { shared: "absent", stages: [] }
  if (isMigrationMarker(current.body)) return { shared: "migrated", stages: [] }
  const backup = await read(sharedStateBackupKey)
  if (backup !== undefined && backup.body !== current.body) {
    throw new Error(
      `${objectName(sharedStateBackupKey)} already holds a different copy of the shared state; reconcile it with ` +
        `${objectName(legacyStateObjectKey)} by hand`
    )
  }
  const planned: Array<StageMigration & { readonly body: string }> = []
  for (const { body, files, stage } of stageSnapshots(current.body)) {
    const key = stateObjectKey(stage)
    const existing = await read(key)
    if (existing !== undefined && existing.body !== body) {
      throw new Error(
        `${objectName(key)} already holds state that differs from the shared object's ${stage} files; ` +
          `reconcile the two by hand`
      )
    }
    planned.push({ stage, key, files, action: existing === undefined ? "create" : "exists", body })
  }
  if (!dryRun) {
    // Until the marker replaces it, the shared object is the only copy of
    // every stage's state: it is copied first, and replaced only once the
    // copy and every stage object read back exactly as written.
    if (backup === undefined) await write(sharedStateBackupKey, current.body, { ifAbsent: true })
    for (const entry of planned) {
      if (entry.action === "create") await write(entry.key, entry.body, { ifAbsent: true })
    }
    for (const { body, key } of [{ key: sharedStateBackupKey, body: current.body }, ...planned]) {
      if ((await read(key))?.body !== body) {
        throw new Error(
          `${objectName(key)} does not read back as it was written; ${objectName(legacyStateObjectKey)} was left ` +
            `as it was`
        )
      }
    }
    const marker = JSON.stringify({ format: migratedFormat, stages: planned.map((entry) => entry.key) }, null, 2)
    await write(legacyStateObjectKey, marker, { ifMatch: current.etag })
  }
  return {
    shared: "split",
    backup: backup === undefined ? "create" : "exists",
    stages: planned.map((entry) => ({ stage: entry.stage, key: entry.key, files: entry.files, action: entry.action }))
  }
}

/**
 * Splits the shared state object into one object per stage.
 *
 * It refuses while the local stack state directory holds an unpublished-state
 * marker from the shared layout: that machine has state the shared object
 * lacks, and the split would leave it out. Under the shared object's own
 * lock, so no wrapper of the old layout runs meanwhile, it copies the shared
 * object byte for byte to {@link sharedStateBackupKey}, writes each stage
 * directory of the shared snapshot to that stage's object with the same file
 * bytes, and reads every one of them back. Only then is the shared object
 * replaced, on the version that was read, with a marker naming the stage
 * objects: a wrapper of the old layout refuses a body that is not a snapshot,
 * and a current one deploys. {@link restoreSharedState} reverses it.
 *
 * It is idempotent. A backup or stage object that already holds exactly its
 * bytes is kept, so a run that stopped part way finishes; one that holds
 * different bytes refuses before anything is written. A dry run takes no
 * lock and writes nothing; it reports the same plan.
 *
 * @throws An `Error` for an unpublished-state marker in `directory`, a held
 * shared lock, a backup or stage object that differs, an object that changed
 * during the run or does not read back; a `TypeError` for a shared snapshot
 * that is invalid or holds a file outside a stage directory.
 * @category commands
 * @since 0.1.0
 */
export const migrateSharedState = async (
  bucket: StateBucket,
  directory: string,
  holder: LockHolder,
  options: RemoteStateRequestOptions & { readonly dryRun?: boolean | undefined } = {}
): Promise<StateMigration> => {
  const marker = NodePath.join(directory, unpublishedMarker)
  if ((await readMarker(marker)) !== undefined) {
    throw new Error(
      `${marker} records state a deployment from this machine never published; before migrating, deploy once ` +
        `more from this machine with a revision from before per-stage state, which publishes it, or compare ` +
        `${directory} with ${objectName(legacyStateObjectKey)} by hand and delete the marker`
    )
  }
  return underSharedLock(bucket, holder, options, (dryRun) => splitSharedState(bucket, dryRun, options))
}

/**
 * What {@link restoreSharedState} did, or would do on a dry run: whether the
 * shared object was restored from the backup or already held it, and each
 * stage object it deleted.
 *
 * @category models
 * @since 0.1.0
 */
export interface StateRestoration {
  readonly shared: "restored" | "kept"
  readonly deleted: ReadonlyArray<{ readonly stage: string; readonly key: string }>
}

const restoreFromBackup = async (
  bucket: StateBucket,
  dryRun: boolean,
  options: RemoteStateRequestOptions
): Promise<StateRestoration> => {
  const { read, remove, write } = stateObjects(bucket, options, "restore")
  const backup = await read(sharedStateBackupKey)
  if (backup === undefined) {
    throw new Error(`${objectName(sharedStateBackupKey)} does not exist, so there is nothing to restore from`)
  }
  const current = await read(legacyStateObjectKey)
  const kept = current?.body === backup.body
  if (current !== undefined && !kept && !isMigrationMarker(current.body)) {
    throw new Error(
      `${objectName(legacyStateObjectKey)} holds neither the migration marker nor its backup; reconcile it by hand`
    )
  }
  const copies: Array<{ readonly stage: string; readonly key: string; readonly etag: string }> = []
  for (const { body, stage } of stageSnapshots(backup.body)) {
    const key = stateObjectKey(stage)
    const existing = await read(key)
    if (existing === undefined) continue
    if (existing.body !== body) {
      throw new Error(
        `${objectName(key)} changed since the migration: stage ${stage} was deployed with per-stage state, and ` +
          `restoring the shared object would lose that deployment`
      )
    }
    copies.push({ stage, key, etag: existing.etag })
  }
  if (!dryRun) {
    if (!kept) {
      await write(
        legacyStateObjectKey,
        backup.body,
        current === undefined ? { ifAbsent: true } : { ifMatch: current.etag }
      )
    }
    for (const copy of copies) {
      if ((await read(copy.key))?.etag !== copy.etag) {
        throw new Error(`${objectName(copy.key)} changed during the restore; run it again`)
      }
      await remove(copy.key)
    }
  }
  return { shared: kept ? "kept" : "restored", deleted: copies.map(({ key, stage }) => ({ stage, key })) }
}

/**
 * Reverses {@link migrateSharedState}: puts the backup back as the shared
 * object, so wrappers from before per-stage state deploy again, and deletes
 * each stage object that still holds exactly what the migration wrote.
 *
 * It runs under the shared object's lock and refuses before it writes
 * anything when the backup is missing, when the shared object holds neither
 * the marker nor the backup, or when a stage was deployed after the
 * migration, since restoring would lose that deployment. It is idempotent,
 * keeps the backup, and a dry run takes no lock and writes nothing.
 *
 * @throws An `Error` naming the object that blocks the restore.
 * @category commands
 * @since 0.1.0
 */
export const restoreSharedState = async (
  bucket: StateBucket,
  holder: LockHolder,
  options: RemoteStateRequestOptions & { readonly dryRun?: boolean | undefined } = {}
): Promise<StateRestoration> =>
  underSharedLock(bucket, holder, options, (dryRun) => restoreFromBackup(bucket, dryRun, options))

/**
 * Substitutions for {@link remoteStateCommand}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteStateCommandOptions {
  /** Where state lives; defaults to the production R2 bucket. */
  readonly stateBucket?: (() => Promise<StateBucket>) | undefined
  /** The local stack state directory; defaults to this checkout's. */
  readonly stateDirectory?: string | undefined
}

const usage = "usage: node scripts/remote-state.ts migrate|restore [--dry-run]\n"

/**
 * The `node scripts/remote-state.ts migrate|restore [--dry-run]` command
 * (`pnpm run migrate-state`, `pnpm run restore-shared-state`): runs
 * {@link migrateSharedState} or {@link restoreSharedState} against the
 * production bucket and prints one line per object it writes or would write.
 *
 * @returns The process exit code.
 * @category commands
 * @since 0.1.0
 */
export const remoteStateCommand = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
  options: RemoteStateCommandOptions = {}
): Promise<number> => {
  const forwarded = args.filter((arg) => arg !== "--")
  const command = forwarded[0]
  const dryRun = forwarded.includes("--dry-run")
  if ((command !== "migrate" && command !== "restore") || forwarded.slice(1).some((arg) => arg !== "--dry-run")) {
    process.stderr.write(usage)
    return 1
  }
  const holder = { host: NodeOs.hostname(), pid: process.pid, startedAt: new Date().toISOString() }
  const directory = options.stateDirectory ?? defaultStateDirectory
  const say = (line: string): void => void process.stdout.write(line + "\n")
  try {
    const bucket = await (options.stateBucket ?? (() => stateBucketFromEnvironment()))()
    if (command === "restore") {
      const result = await restoreSharedState(bucket, holder, { dryRun })
      say(
        result.shared === "kept"
          ? `${objectName(legacyStateObjectKey)} already holds the backup.`
          : `${dryRun ? "Would restore" : "Restored"} ${objectName(legacyStateObjectKey)} from ` +
            `${objectName(sharedStateBackupKey)}.`
      )
      for (const entry of result.deleted) {
        say(`${dryRun ? "Would delete" : "Deleted"} ${objectName(entry.key)} for stage ${entry.stage}.`)
      }
      return 0
    }
    const result = await migrateSharedState(bucket, directory, holder, { dryRun })
    if (result.shared !== "split") {
      const state = result.shared === "absent" ? "does not exist" : "is already a migration marker"
      say(`${objectName(legacyStateObjectKey)} ${state}; nothing to migrate.`)
      return 0
    }
    say(
      result.backup === "create"
        ? `${dryRun ? "Would copy" : "Copied"} ${objectName(legacyStateObjectKey)} to ` +
          `${objectName(sharedStateBackupKey)}.`
        : `${objectName(sharedStateBackupKey)} already holds a copy of ${objectName(legacyStateObjectKey)}.`
    )
    for (const entry of result.stages) {
      const verb = entry.action === "create" ? (dryRun ? "Would create" : "Created") : (dryRun ? "Would keep" : "Kept")
      say(`${verb} ${objectName(entry.key)} for stage ${entry.stage} (${entry.files} files).`)
    }
    say(`${dryRun ? "Would replace" : "Replaced"} ${objectName(legacyStateObjectKey)} with a migration marker.`)
    return 0
  } catch (error) {
    process.stderr.write(`State ${command === "restore" ? "restore" : "migration"} failed: ${failureMessage(error)}\n`)
    return 1
  }
}

const invokedPath = process.argv[1]
/* v8 ignore next 3 -- the process entry reaches the production R2 bucket; the suite drives remoteStateCommand against an in-memory bucket */
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await remoteStateCommand()
}
