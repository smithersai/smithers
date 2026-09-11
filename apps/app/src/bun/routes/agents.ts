/*
 * Agents as data (docs/workbench-lanes/custom-agents.md): the agents store
 * (`<stateDir>/agents.json`, seeded from the built-ins in
 * @smthrs/rpc/AgentRoles.ts) and its routes. The store is the one source
 * of truth on the native host — the renderer mirrors it in `app-agents`, and
 * Pty.ts resolves a role id against the same store — so a custom agent
 * launches exactly like a built-in.
 *
 *   GET    /api/agents                 the list
 *   PUT    /api/agents/{id}            create or edit (the harness must be in
 *                                      the table with a verified model flag;
 *                                      the model id must match MODEL_ID)
 *   DELETE /api/agents/{id}            refuses a built-in
 *   GET    /api/harnesses/{id}/models  what the harness's list command
 *                                      printed (5 s cap), else the table's
 *                                      verified suggestions; empty + reason
 *                                      on failure
 */
import { randomUUID } from "node:crypto"
import { open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  AgentPutRequestSchema,
  AgentRoleIdSchema,
  AgentRoleSchema,
  isBuiltinAgentRoleId,
  orderedAgentRoles
} from "@smthrs/rpc/AgentRoles"
import type { AgentPutRequest, AgentRole, HarnessModelsResponse } from "@smthrs/rpc/AgentRoles"
import { HARNESS_IDS } from "@smthrs/rpc/LocalApp"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { z } from "zod"
import { atomicWriteJson } from "../atomicWriteJson"
import { DETECTORS, harnessModels, probeEnv, wrapProbe } from "../Harnesses"
import { json, jsonError, readJson, Router } from "../routes"
import type { SandboxHost } from "../Sandbox"
import type { HarnessDetector } from "./harnesses"

export const AGENTS_PATH = "/api/agents"
/** The store's file under the state dir. */
export const AGENTS_FILE = "agents.json"
/** How long a harness's model list command may run before the route answers empty with the reason. */
export const MODEL_LIST_TIMEOUT_MS = 5000
/** Lines past this are dropped: a list command is a list, not a stream. */
const MODEL_LIST_MAX_LINES = 2000

const StoredAgentsSchema = z.object({ agents: z.array(AgentRoleSchema) }).strict()

export type AgentPutResult =
  | { readonly status: "created" | "updated"; readonly agent: AgentRole }
  | { readonly status: "error"; readonly code: "invalid_id" | "invalid_request" | "unknown_harness" | "harness_no_model_flag" | "builtin_harness_fixed"; readonly message: string }

export type AgentRemoveResult =
  | { readonly status: "removed" }
  | { readonly status: "error"; readonly code: "not_found" | "builtin_agent"; readonly message: string }

export interface AgentStore {
  /** Every agent, built-ins first in table order, then custom agents oldest first. */
  readonly list: () => Promise<ReadonlyArray<AgentRole>>
  readonly get: (id: string) => Promise<AgentRole | undefined>
  readonly put: (id: string, input: AgentPutRequest) => Promise<AgentPutResult>
  readonly remove: (id: string) => Promise<AgentRemoveResult>
}

export interface AgentStoreOptions {
  /** Where the store persists; absent = memory only (tests, one-shot hosts). */
  readonly stateDir?: string
  readonly log?: (line: string) => void
  readonly now?: () => number
  /** Override persistence for fault-injection tests. */
  readonly writeJson?: typeof atomicWriteJson
}

/**
 * Validates one PUT body against the harness table: the harness must exist
 * and take a model flag the app verified; the model id passed the schema's
 * MODEL_ID guard already. Pure, so the route test and the store share it.
 */
export const validateAgentInput = (input: AgentPutRequest): { readonly ok: true } | { readonly ok: false; readonly code: "unknown_harness" | "harness_no_model_flag"; readonly message: string } => {
  const detector = DETECTORS.find((candidate) => candidate.id === input.harness)
  if (detector === undefined) {
    return { ok: false, code: "unknown_harness", message: `There is no harness with id ${input.harness}. Harnesses: ${HARNESS_IDS.join(", ")}.` }
  }
  if (detector.models === undefined) {
    return {
      ok: false,
      code: "harness_no_model_flag",
      message: `${detector.displayName} takes no model flag this app has verified, so an agent cannot be bound to a model on it.`
    }
  }
  return { ok: true }
}

/** The seed merged over what the file holds: built-ins the file lacks are added; edited built-ins keep their edits. */
const withSeed = (stored: ReadonlyArray<AgentRole>): ReadonlyArray<AgentRole> => {
  const present = new Set(stored.map((agent) => agent.id))
  return [...stored, ...AGENT_ROLES.filter((builtin) => !present.has(builtin.id))]
}

export const createAgentStore = (options: AgentStoreOptions = {}): AgentStore => {
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const path = options.stateDir === undefined ? undefined : join(options.stateDir, AGENTS_FILE)
  let loaded: Promise<Array<AgentRole>> | undefined
  let mutations: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutations.then(operation)
    mutations = result.catch(() => {})
    return result
  }

  const read = async (): Promise<Array<AgentRole>> => {
    if (path === undefined) return [...AGENT_ROLES]
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...AGENT_ROLES]
      throw error
    }
    try {
      return [...withSeed(StoredAgentsSchema.parse(JSON.parse(text)).agents)]
    } catch (cause) {
      const preserved = `${path}.corrupt-${now()}-${randomUUID()}`
      // Do not recover in this store instance: every caller must see the error.
      // If preservation fails, leave the original in place and reject the read.
      await rename(path, preserved)
      const directory = await open(dirname(path), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      const message = `agents store at ${path} is invalid; preserved at ${preserved}: ${cause instanceof Error ? cause.message : String(cause)}`
      log(message)
      throw new Error(message, { cause })
    }
  }

  const agents = (): Promise<Array<AgentRole>> => {
    loaded ??= read()
    return loaded
  }

  /** Publish the whole list atomically; persistence errors reject the mutation. */
  const write = async (rows: ReadonlyArray<AgentRole>): Promise<void> => {
    if (path === undefined) return
    await (options.writeJson ?? atomicWriteJson)(path, { agents: rows })
  }

  const list: AgentStore["list"] = async () => orderedAgentRoles(await agents())

  const get: AgentStore["get"] = async (id) => (await agents()).find((agent) => agent.id === id)

  const put: AgentStore["put"] = async (id, input) => {
    if (!AgentRoleIdSchema.safeParse(id).success) {
      return { status: "error", code: "invalid_id", message: `${JSON.stringify(id)} is not an agent id: lowercase letters, digits and dashes, starting with a letter (2–41 characters).` }
    }
    const body = AgentPutRequestSchema.safeParse(input)
    if (!body.success) {
      return { status: "error", code: "invalid_request", message: body.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }
    }
    const valid = validateAgentInput(body.data)
    if (!valid.ok) return { status: "error", code: valid.code, message: valid.message }
    const rows = await agents()
    const index = rows.findIndex((agent) => agent.id === id)
    const existing = index === -1 ? undefined : rows[index]
    if (existing !== undefined && existing.builtin && existing.harness !== body.data.harness) {
      return {
        status: "error",
        code: "builtin_harness_fixed",
        message: `${existing.label} is a built-in agent: its model and purpose can change, its harness (${existing.harness}) cannot.`
      }
    }
    const stamp = now()
    const agent: AgentRole = {
      id,
      label: body.data.label,
      purpose: body.data.purpose,
      harness: body.data.harness,
      model: body.data.model,
      delegates: body.data.delegates ?? existing?.delegates ?? false,
      builtin: existing?.builtin ?? isBuiltinAgentRoleId(id),
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp
    }
    const next = existing === undefined ? [...rows, agent] : rows.map((row, position) => (position === index ? agent : row))
    await write(next)
    loaded = Promise.resolve(next)
    return { status: existing === undefined ? "created" : "updated", agent }
  }

  const remove: AgentStore["remove"] = async (id) => {
    const rows = await agents()
    const existing = rows.find((agent) => agent.id === id)
    if (existing === undefined) return { status: "error", code: "not_found", message: `There is no agent with id ${id}.` }
    if (existing.builtin) {
      return { status: "error", code: "builtin_agent", message: `${existing.label} is a built-in agent and cannot be removed; its model and purpose can be edited.` }
    }
    const next = rows.filter((agent) => agent.id !== id)
    await write(next)
    loaded = Promise.resolve(next)
    return { status: "removed" }
  }

  return { list, get, put: (id, input) => serial(() => put(id, input)), remove: (id) => serial(() => remove(id)) }
}

/** One model id per printed line; blank lines and anything that is not a model id are dropped. */
export const parseModelLines = (output: string): Array<string> =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/.test(line))
    .slice(0, MODEL_LIST_MAX_LINES)

/**
 * The models a harness can run, as the HARNESS says: its list command's
 * output when it has one and the binary is installed, else the table's
 * verified suggestions. A failed or slow list answers empty with the reason.
 */
export const listHarnessModels = async (
  harness: Harness,
  spawn: (argv: ReadonlyArray<string>) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>
): Promise<HarnessModelsResponse> => {
  const table = harnessModels(harness.id)
  if (table === undefined) {
    return { harnessId: harness.id, models: [], source: "suggestions", reason: `${harness.displayName} takes no model flag this app has verified.` }
  }
  if (table.list === undefined) return { harnessId: harness.id, models: [...table.suggestions], source: "suggestions" }
  if (harness.binary === null) {
    return { harnessId: harness.id, models: [...table.suggestions], source: "suggestions", reason: `${harness.displayName} is not installed here.` }
  }
  try {
    const result = await spawn([harness.binary, ...table.list.slice(1)])
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n")[0] ?? ""
      return { harnessId: harness.id, models: [], source: "list", reason: `${table.list.join(" ")} exited ${String(result.code)}${detail === "" ? "" : `: ${detail}`}` }
    }
    return { harnessId: harness.id, models: parseModelLines(result.stdout), source: "list" }
  } catch (error) {
    return { harnessId: harness.id, models: [], source: "list", reason: `${table.list.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * The list command as spawned: the probe sandbox (or its documented
 * exception) around the argv, and the probe environment, the same as the
 * version probe for the same binary.
 */
export const modelListCommand = (
  argv: ReadonlyArray<string>,
  source: Readonly<Record<string, string | undefined>>,
  host?: SandboxHost
): { readonly argv: ReadonlyArray<string>; readonly env: Record<string, string> } => ({
  argv: wrapProbe(argv, host),
  env: probeEnv(source)
})

/** Runs a list argv under the timeout; the caller owns the argv (the table's, with the resolved binary). */
const spawnList = async (argv: ReadonlyArray<string>): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> => {
  const command = modelListCommand(argv, process.env)
  const child = Bun.spawn([...command.argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: MODEL_LIST_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: command.env
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (child.signalCode === "SIGKILL") return { code: null, stdout, stderr: `timed out after ${MODEL_LIST_TIMEOUT_MS} ms` }
  return { code, stdout, stderr }
}

export interface AgentRoutesOptions {
  readonly stateDir?: string
  readonly harnesses: HarnessDetector
  readonly log?: (line: string) => void
  /** Test override for the list-command runner. */
  readonly spawn?: typeof spawnList
}

export const registerAgentRoutes = (router: Router, options: AgentRoutesOptions): { readonly store: AgentStore } => {
  const store = createAgentStore({ ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }), ...(options.log === undefined ? {} : { log: options.log }) })
  const spawn = options.spawn ?? spawnList

  router.add("GET", AGENTS_PATH, async () => json({ agents: await store.list() }))

  router.add("PUT", `${AGENTS_PATH}/:id`, async ({ request, params }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = AgentPutRequestSchema.safeParse(parsed.body)
    if (!body.success) {
      return jsonError(400, "invalid_request", `Body must be { label, purpose, harness, model: { provider, id, label } }: ${body.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
    }
    const result = await store.put(params.id ?? "", body.data)
    if (result.status === "error") {
      const status = result.code === "unknown_harness" ? 404 : result.code === "builtin_harness_fixed" ? 409 : 400
      return jsonError(status, result.code, result.message)
    }
    return json({ agent: result.agent }, result.status === "created" ? 201 : 200)
  })

  router.add("DELETE", `${AGENTS_PATH}/:id`, async ({ params }) => {
    const result = await store.remove(params.id ?? "")
    if (result.status === "error") return jsonError(result.code === "not_found" ? 404 : 409, result.code, result.message)
    return json({ ok: true })
  })

  router.add("GET", "/api/harnesses/:id/models", async ({ params }) => {
    const id = params.id ?? ""
    const harness = (await options.harnesses()).find((candidate) => candidate.id === id)
    if (harness === undefined) return jsonError(404, "unknown_harness", `There is no harness with id ${id}. Harnesses: ${HARNESS_IDS.join(", ")}.`)
    return json(await listHarnessModels(harness, spawn))
  })

  return { store }
}

/** The built-in ids, for messages that list what cannot be removed. */
export const BUILTIN_AGENT_IDS: ReadonlyArray<string> = AGENT_ROLE_IDS
