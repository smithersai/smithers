import { preparedView, type ViewAction } from "../PreparedView"
/*
 * The secrets seam: the secrets a repository's sessions may use, read off the
 * agent-environment document (GET /api/repos/{owner}/{repo}/agent-environment,
 * EnvironmentSeam.ts). plue serves secret METADATA only: name, the egress
 * binding (hosts, match_headers) and the updated time. No value exists on the
 * wire, so none can reach a card, the journal or the model. Adding and
 * removing secrets land in later Secrets lanes.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readEnvironment } from "./EnvironmentSeam"
import type { SeamContext } from "./SeamContext"
import { captureCloudOwner, readResult } from "./SeamContext"
import type { CommandGesture } from "../../flows/CommandGesture"
import type { FailureController } from "../controller/failures"
import { TOAST_SUPERSEDED } from "../controller/failures"

const CONNECTIONS = "/api/user/provider-connections"
const CONNECTION_ITEM = "/api/user/provider-connections/"
const connectionId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value)
type Connection = { id: string; provider: string; state: string; label: string }
const connections = (raw: unknown): Connection[] | undefined => Array.isArray(raw) && raw.every(row =>
  row && typeof row === "object" && connectionId(row.id) && typeof row.provider === "string" && typeof row.state === "string" && typeof row.label === "string")
  ? raw.map(row => ({ id: row.id, provider: row.provider, state: row.state, label: row.label })) : undefined

export interface SecretsSeam {
  readonly listSecrets: ViewAction<[repo?: string]>
  readonly connectCodingProvider: (gesture?: CommandGesture) => Promise<{ readonly value: string } | string>
  readonly listCodingProviders: () => Promise<{ readonly value: string } | string>
  readonly revokeCodingProvider: (id: string) => Promise<{ readonly value: string } | string>
  readonly resumeCodingProviders: () => void
}

export const createSecretsSeam = (ctx: SeamContext, withToast: FailureController["withToast"]): SecretsSeam => {
  type Flight = { readonly current: () => boolean; readonly admitted: Promise<boolean> }
  const inFlight = new Map<string, Flight>()
  const flightAt = (key: string): Flight | undefined => {
    const flight = inFlight.get(key)
    return flight?.current() ? flight : undefined
  }
  const release = (key: string, flight: Flight): void => {
    if (inFlight.get(key) === flight) inFlight.delete(key)
  }
  const owner = () => ctx.store.collections.identitySessions.get("identity")?.login ?? null
  type Pending = NonNullable<ReturnType<typeof ctx.store.session>["codingProviderRequests"]>[number]
  const requests = (): Pending[] => ctx.store.session().codingProviderRequests ?? []
  const save = async (row: Pending, current: () => boolean): Promise<boolean> => {
    if (!current()) return false
    await ctx.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests: [...requests().filter(item => item.id !== row.id), row].slice(-64) }).isPersisted.promise
    return current()
  }
  const active = (row: Connection): boolean => row.provider === "claude" && row.state === "active" && connectionId(row.id)
  const admit = (row: Pending, current: () => boolean): Flight => {
    const flight = { current, admitted: save(row, current).catch(() => false) }
    inFlight.set(row.id, flight)
    return flight
  }
  const acknowledgment = async (flight: Flight): Promise<{ readonly value: string } | string> =>
    await flight.admitted && flight.current() ? { value: "Requested" } : "Connection request could not be saved."
  const fail = async (row: Pending, current: () => boolean, message: string) =>
    await save({ ...row, state: "failed" }, current) ? message : TOAST_SUPERSEDED
  const report = (outcome: unknown, current: () => boolean): void => {
    if (current() && typeof outcome === "string") ctx.dispatch({ type: "message.appended", actor: "system", text: outcome })
  }
  const resumeCodingProviders: SecretsSeam["resumeCodingProviders"] = () => {
    const login = owner()
    if (!login) return
    for (const row of requests().filter(item => item.owner === login && item.state === "requested" && !flightAt(item.id))) {
      const current = captureCloudOwner(ctx, false)
      const flight = admit(row, current)
      void withToast(`coding-provider-${row.action === "revoke" ? "revoke" : "connect"}:${row.id}`, "Checking connection…", "Connection updated", async () => {
        try {
          if (!await flight.admitted || !current()) return TOAST_SUPERSEDED
          const response = await ctx.http(`${ctx.baseUrl}${CONNECTIONS}`)
          if (!current()) return TOAST_SUPERSEDED
          const rows = response.ok ? connections(await response.json().catch(() => undefined)) : undefined
          if (!current()) return TOAST_SUPERSEDED
          if (!rows) return "Connection check failed. Retry the check."
          if (row.action === "revoke") {
            if (!row.connectionId || !connectionId(row.connectionId)) return "Invalid connection."
            const match = rows.find(item => item.id === row.connectionId)
            if (!match || match.state === "revoked") return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
            if (match.state !== "active") return "Connection revocation needs a retry."
            const deleted = await ctx.http(`${ctx.baseUrl}${CONNECTION_ITEM}${row.connectionId}`, { method: "DELETE" })
            if (!current()) return TOAST_SUPERSEDED
            if (deleted.status !== 204) return `Connection revocation failed (HTTP ${deleted.status}).`
            return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
          }
          const match = rows.find(item => item.label === `web-${row.id}`)
          if (match && active(match)) return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
          if (match) { await save({ ...row, state: "failed" }, current); return "Claude connection is inactive. Retry with a fresh token." }
          await save({ ...row, state: "failed" }, current)
          return "Claude connection interrupted. Retry with a fresh token."
        } catch { return current() ? "Connection check failed. Retry the check." : TOAST_SUPERSEDED }
        finally { release(row.id, flight) }
      }, false, current).then(outcome => report(outcome, current))
    }
  }
  const connectCodingProvider: SecretsSeam["connectCodingProvider"] = async gesture => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    const value = gesture?.takeWriteOnly?.("value")
    gesture?.release()
    if (!login) return "Sign in to connect Claude."
    const flightKey = `connect:${login}`
    const previous = flightAt(flightKey)
    if (previous) return acknowledgment(previous)
    const pending = requests().find(row => row.owner === login && row.action !== "revoke" && row.state === "requested")
    if (pending) {
      resumeCodingProviders()
      const flight = flightAt(pending.id)
      return flight ? acknowledgment(flight) : "Connection check failed."
    }
    if (!value?.startsWith("sk-ant-oat01-") || /\s/.test(value)) return "Enter a Claude setup token."
    const row: Pending = { id: crypto.randomUUID(), owner: login, action: "connect", state: "requested" }
    const flight = admit(row, current)
    inFlight.set(flightKey, flight)
    let body: string | undefined = JSON.stringify({ provider: "claude", kind: "setup_token", label: `web-${row.id}`, access_token: value })
    const receipt = await acknowledgment(flight)
    if (typeof receipt === "string") {
      body = undefined
      release(flightKey, flight)
      release(row.id, flight)
      return receipt
    }
    void withToast(`coding-provider-connect:${login}`, "Connecting Claude…", "Claude connected", async () => {
      try {
        const sending = body
        body = undefined
        if (!current()) return TOAST_SUPERSEDED
        const response = await ctx.http(`${ctx.baseUrl}${CONNECTIONS}`, { method: "POST", headers: { "content-type": "application/json" }, body: sending })
        if (!current()) return TOAST_SUPERSEDED
        if (!response.ok) return await fail(row, current, `Claude connection failed (HTTP ${response.status}).`)
        // User-owned repositories resolve their owner's connection without a grant.
        // Organization repositories require an explicit grant through their own scope door.
        const result = await response.json().catch(() => undefined) as Connection | undefined
        if (!current()) return TOAST_SUPERSEDED
        if (!result || !active(result) || result.label !== `web-${row.id}`) return await fail(row, current, "Claude connection failed.")
        return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
      } catch { return current() ? "Claude connection failed." : TOAST_SUPERSEDED }
      finally { release(flightKey, flight); release(row.id, flight); body = undefined }
    }, false, current).then(outcome => report(outcome, current))
    return receipt
  }
  const listCodingProviders: SecretsSeam["listCodingProviders"] = async () => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    if (!login) return "Sign in to list coding connections."
    try {
      const response = await ctx.http(`${ctx.baseUrl}${CONNECTIONS}`)
      if (!current()) return "Account changed."
      if (!response.ok) return `Coding connections unavailable (HTTP ${response.status}).`
      const rows = connections(await response.json().catch(() => undefined))
      if (!current()) return "Account changed."
      if (!rows) return "Coding connections unavailable."
      return readResult(rows.length ? rows.map(row => `${row.id} · ${row.provider} · ${row.state}`).join("\n") : "No coding connections.")
    } catch { return "Coding connections unavailable." }
  }
  const revokeCodingProvider: SecretsSeam["revokeCodingProvider"] = async id => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    if (!login) return "Sign in to revoke a coding connection."
    if (!connectionId(id)) return "Invalid connection."
    const flightKey = `revoke:${login}:${id}`
    const previous = flightAt(flightKey)
    if (previous) return acknowledgment(previous)
    const pending = requests().find(row => row.owner === login && row.action === "revoke" && row.connectionId === id && row.state === "requested")
    if (pending) {
      resumeCodingProviders()
      const flight = flightAt(pending.id)
      return flight ? acknowledgment(flight) : "Connection check failed."
    }
    const row: Pending = { id: crypto.randomUUID(), owner: login, action: "revoke", connectionId: id, state: "requested" }
    const flight = admit(row, current)
    inFlight.set(flightKey, flight)
    const receipt = await acknowledgment(flight)
    if (typeof receipt === "string") {
      release(flightKey, flight)
      release(row.id, flight)
      return receipt
    }
    void withToast(`coding-provider-revoke:${id}`, "Revoking connection…", "Connection revoked", async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        const response = await ctx.http(`${ctx.baseUrl}${CONNECTION_ITEM}${id}`, { method: "DELETE" })
        if (!current()) return TOAST_SUPERSEDED
        if (response.status !== 204) return await fail(row, current, `Connection revocation failed (HTTP ${response.status}).`)
        return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
      } catch { return current() ? "Connection revocation failed." : TOAST_SUPERSEDED }
      finally { release(flightKey, flight); release(row.id, flight) }
    }, false, current).then(outcome => report(outcome, current))
    return receipt
  }
  /*
   * One secrets card per repository, re-surfaced at the end of the transcript
   * on every list. Leaving it at its old ordinal would answer the command with
   * a silent no-op.
   */
  const listSecrets = preparedView(ctx, (repo?: string) => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    return { id: `secrets-${target.repo}`, title: `Secrets · ${target.repo}`, read: async () => {
    const config = await readEnvironment(ctx, target.repo)
    if (typeof config === "string") return config
    const card: Card = {
      id: `secrets-${target.repo}`,
      kind: "secrets",
      title: `Secrets · ${target.repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: {
        repo: target.repo,
        scope: "repository",
        secrets: config.secrets.map((secret) => ({
          name: secret.name,
          hosts: [...secret.hosts],
          matchHeaders: [...secret.matchHeaders],
          updatedAt: secret.updatedAt
        }))
      }
    }
    return { card, ...readResult(card.payload.secrets.length === 0
      ? `No secrets in ${card.payload.repo}.`
      : [
        `Secrets · ${card.payload.repo}`,
        ...card.payload.secrets.map((secret) =>
          `${secret.name} · hosts: ${secret.hosts.join(", ") || "none"} · headers: ${secret.matchHeaders.join(", ") || "none"} · updated: ${secret.updatedAt ?? "unknown"}`)
      ].join("\n")) }
    } }
  })

  return { listSecrets, connectCodingProvider, listCodingProviders, revokeCodingProvider, resumeCodingProviders }
}
