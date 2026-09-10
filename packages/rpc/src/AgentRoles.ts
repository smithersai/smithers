/**
 * Role and event contracts for coordinated agents.
 *
 * @since 1.0.0
 */
import { z } from "zod"
import { HARNESS_IDS } from "./LocalApp.ts"

/*
 * The agent roles (apps/ui/docs/LOCAL-APP.md "Tabs" → "Agents";
 * apps/ui/docs/workbench-lanes/custom-agents.md): every role is a job
 * description bound to one model and to the local harness that runs that
 * model. Roles are DATA — the `+` menus, the PTY route, the subagent card, the
 * Agents card, and the orchestrator's instructions all read one list — so a
 * role can never be launched with a different model than it names, and the
 * server (not the renderer) turns a role id into a launch argv.
 *
 * Agents are rows, not an enum. The built-ins below seed `<stateDir>/
 * agents.json` on the Bun host (`builtin: true`: editable model and purpose,
 * never removable); the user adds any number of custom agents, each a
 * harness the machine has plus a model id that harness accepts. Nothing
 * stores a launch argv: `roleLaunchArgv` COMPOSES it from the harness's
 * verified model flag and the guarded model id.
 *
 * Model ids and CLI flags are verified against the installed binaries:
 *  - `claude --model <model>` accepts a full model name ("claude-fable-5").
 *  - `codex -m <MODEL>` ("gpt-5.6-sol", "gpt-5.6-luna"; the same ids
 *    packages/smithers/agent/model/src/DeferredTools.ts lists for the GPT-5.6 family).
 *  - `opencode --model provider/model`: `opencode models kimi-for-coding`
 *    lists `k3`; `opencode models cerebras` lists `gpt-oss-120b` and
 *    `gemma-4-31b` (opencode 1.18.22, this machine). The model id an
 *    opencode role stores is the `provider/model` the binary accepts.
 */

/** A role id: lowercase, starts with a letter, 2–41 characters, no spaces.
 * @since 1.0.0
 * @category constants
 */
export const AGENT_ROLE_ID = /^[a-z][a-z0-9-]{1,40}$/
/**
 * Validates agent role id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRoleIdSchema = z.string().regex(
  AGENT_ROLE_ID,
  "an agent id is lowercase letters, digits and dashes, starting with a letter"
)
/**
 * The decoded value accepted by {@link AgentRoleIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRoleId = z.infer<typeof AgentRoleIdSchema>

/**
 * A model id as a harness accepts it on its command line: no spaces and no
 * leading dash, so it can never be read as a second flag (flag injection).
 * @since 1.0.0
 * @category constants
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/
/**
 * Validates model id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelIdSchema = z.string().regex(MODEL_ID, "a model id has no spaces and does not start with a dash")

/** The built-in role ids: the seed rows, in menu order.
 * @since 1.0.0
 * @category constants
 */
export const AGENT_ROLE_IDS = [
  "orchestrator",
  "explainer",
  "implementation",
  "trivial-implementation",
  "ui",
  "fast-ui"
] as const
/**
 * The builtin agent role id contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type BuiltinAgentRoleId = (typeof AGENT_ROLE_IDS)[number]

/**
 * Validates agent role model values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRoleModelSchema = z.object({
  /** The provider the model belongs to, for the human ("anthropic", "openai", "kimi-for-coding"). */
  provider: z.string(),
  /** The id the harness's model flag takes, verbatim. */
  id: ModelIdSchema,
  /** The label the menus show ("Fable 5"). */
  label: z.string()
})
/**
 * The decoded value accepted by {@link AgentRoleModelSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRoleModel = z.infer<typeof AgentRoleModelSchema>

/**
 * Validates agent role values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRoleSchema = z.object({
  id: AgentRoleIdSchema,
  label: z.string().min(1).max(60),
  /** One sentence the model and the UI both read. */
  purpose: z.string().max(400),
  model: AgentRoleModelSchema,
  /** The local harness that runs this model; its availability is the role's. */
  harness: z.enum(HARNESS_IDS),
  /** Whether this role's job is to delegate to the others. */
  delegates: z.boolean(),
  /** A seeded row: editable model and purpose, never removable. */
  builtin: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})
/**
 * The decoded value accepted by {@link AgentRoleSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRole = z.infer<typeof AgentRoleSchema>

const seeded = (
  role: Omit<AgentRole, "builtin" | "createdAt" | "updatedAt">
): AgentRole => ({ ...role, builtin: true, createdAt: 0, updatedAt: 0 })

/** The built-in roles: the seed of every agents store, in menu order.
 * @since 1.0.0
 * @category constants
 */
export const AGENT_ROLES: ReadonlyArray<AgentRole> = [
  seeded({
    id: "orchestrator",
    label: "Orchestrator",
    purpose: "The smartest agent: plans, writes workflows frame by frame, and delegates most work to the other roles.",
    model: { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" },
    harness: "claude",
    delegates: true
  }),
  seeded({
    id: "explainer",
    label: "Explainer",
    purpose: "Explains things very well: errors, code, runs, and decisions, in plain language.",
    model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" },
    harness: "opencode-kimi",
    delegates: false
  }),
  /*
   * Implement runs on the smart seat, first try included (factory-spec review
   * RULINGS 42, Will, 2026-09-08). `implementation` is the smart seat of this
   * table and is the only row an implement-shaped delegation may take. The
   * fast rows below it (`trivial-implementation` and `fast-ui`) exist for a
   * person who explicitly picks one for a mechanical edit; nothing may route
   * an implement-shaped run to them, and no code here or downstream may
   * "start cheap and escalate". Cost control is parallelism, caching and the
   * prototype-first decision, never a cheaper model for the implementation
   * itself. The pin is
   * apps/ui/src/mainview/state/controller/implementSeat.test.ts.
   */
  seeded({
    id: "implementation",
    label: "Implementation",
    purpose: "Implements non-trivial changes end to end, with tests.",
    model: { provider: "openai", id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    harness: "codex",
    delegates: false
  }),
  seeded({
    id: "trivial-implementation",
    label: "Trivial implementation",
    purpose: "Makes small, low-risk, mechanical changes quickly.",
    model: { provider: "openai", id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    harness: "codex",
    delegates: false
  }),
  seeded({
    id: "ui",
    label: "UI",
    purpose: "Builds and reviews UI and visual work.",
    model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" },
    harness: "opencode-kimi",
    delegates: false
  }),
  seeded({
    id: "fast-ui",
    label: "Fast UI",
    purpose: "Fast, cheap UI iterations.",
    model: { provider: "cerebras", id: "cerebras/gpt-oss-120b", label: "Cerebras gpt-oss-120b" },
    harness: "opencode-cerebras",
    delegates: false
  })
]

/** Whether a string is a well-formed agent id (built-in or custom); not whether one exists.
 * @since 1.0.0
 * @category conversions
 */
export const isAgentRoleId = (value: string): value is AgentRoleId => AGENT_ROLE_ID.test(value)

/** Whether an id names one of the seeded rows.
 * @since 1.0.0
 * @category conversions
 */
export const isBuiltinAgentRoleId = (value: string): value is BuiltinAgentRoleId =>
  (AGENT_ROLE_IDS as ReadonlyArray<string>).includes(value)

/** The role with this id in a list (the built-ins by default), or undefined.
 * @since 1.0.0
 * @category conversions
 */
export const findAgentRole = (id: string, roles: ReadonlyArray<AgentRole> = AGENT_ROLES): AgentRole | undefined =>
  roles.find((candidate) => candidate.id === id)

/** A built-in role by id; throws for anything else (the built-ins are the compile-time table).
 * @since 1.0.0
 * @category conversions
 */
export const agentRole = (id: BuiltinAgentRoleId): AgentRole => {
  const role = findAgentRole(id)
  if (role === undefined) throw new Error(`Unknown agent role ${id}`)
  return role
}

/**
 * The agents as every menu lists them: the built-ins in table order, then
 * the custom agents oldest first. An empty list (nothing loaded yet) is the
 * built-ins, because they are never removable — a loaded list is never empty.
 * @since 1.0.0
 * @category conversions
 */
export const orderedAgentRoles = (roles: ReadonlyArray<AgentRole>): ReadonlyArray<AgentRole> => {
  if (roles.length === 0) return AGENT_ROLES
  const rank = (role: AgentRole): number => {
    const index = (AGENT_ROLE_IDS as ReadonlyArray<string>).indexOf(role.id)
    return role.builtin && index !== -1 ? index : AGENT_ROLE_IDS.length
  }
  return [...roles].sort((left, right) =>
    rank(left) - rank(right) || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
}

/*
 * Cloud roles (docs: the concierge's side turns). A cloud role is a
 * sub-agent the app Worker answers ITSELF, on the deployment's own Cerebras
 * key, instead of forwarding the turn to the chat upstream: the Librarian
 * answers wiki and repository questions from the runtime context, the Flows
 * agent picks which registered flows achieve a goal. Neither runs a local
 * harness, so a cloud role is not an `AgentRole` (AgentRoleSchema requires a
 * harness) and never appears in the agents store or the `+` menus: it is a
 * separate compile-time table with a `seat: "cloud"` marker. A cloud role is
 * tool-free by contract; the Worker refuses a tool-bearing body on it.
 *
 * The model row is the default; a deployment overrides it with the named
 * environment variable, so the served model is always readable from the
 * Worker's configuration and never claimed by the client.
 */

/** The cloud role ids: the sub-agents the Worker serves on Cerebras.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AGENT_ROLE_IDS = ["librarian", "flows"] as const
/**
 * The cloud role id contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudRoleId = (typeof CLOUD_AGENT_ROLE_IDS)[number]
/**
 * Validates cloud role id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CloudRoleIdSchema = z.enum(CLOUD_AGENT_ROLE_IDS)

/**
 * Validates cloud role values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CloudRoleSchema = z.object({
  id: CloudRoleIdSchema,
  label: z.string().min(1).max(60),
  /** One sentence the model and the UI both read. */
  purpose: z.string().max(400),
  /** Served by the app Worker, never by a local harness. */
  seat: z.literal("cloud"),
  /** The default model; `provider` is always "cerebras". */
  model: AgentRoleModelSchema,
  /** The Worker environment variable whose value, when set, replaces `model.id`. */
  modelEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/)
})
/**
 * The decoded value accepted by {@link CloudRoleSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudRole = z.infer<typeof CloudRoleSchema>

/** The cloud roles, in the order the concierge names them.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AGENT_ROLES: ReadonlyArray<CloudRole> = [
  {
    id: "librarian",
    label: "Librarian",
    purpose:
      "Answers questions about the Wiki and the repository facts in the runtime context, citing paths and pages, never inventing one.",
    seat: "cloud",
    model: { provider: "cerebras", id: "gpt-oss-120b", label: "Cerebras gpt-oss-120b" },
    modelEnv: "CEREBRAS_MODEL_LIBRARIAN"
  },
  {
    id: "flows",
    label: "Flows",
    purpose:
      "Picks which registered flows achieve a goal and says how to run them, using only flows the catalog offers.",
    seat: "cloud",
    model: { provider: "cerebras", id: "qwen-3.8-27b", label: "Cerebras Qwen 3.8 27B" },
    modelEnv: "CEREBRAS_MODEL_FLOWS"
  }
]

/** Whether an id names a cloud role.
 * @since 1.0.0
 * @category conversions
 */
export const isCloudRoleId = (value: string): value is CloudRoleId =>
  (CLOUD_AGENT_ROLE_IDS as ReadonlyArray<string>).includes(value)

/** A cloud role by id; throws for anything else (the table is compile-time).
 * @since 1.0.0
 * @category conversions
 */
export const cloudRole = (id: CloudRoleId): CloudRole => {
  const role = CLOUD_AGENT_ROLES.find((candidate) => candidate.id === id)
  if (role === undefined) throw new Error(`Unknown cloud role ${id}`)
  return role
}

/**
 * The model id a deployment serves a cloud role on: the role's `modelEnv`
 * variable when it is set to a well-formed model id, else the table default.
 * A malformed override is ignored, not launched: the id is re-checked here
 * exactly as `roleLaunchArgv` re-checks a local role's.
 * @since 1.0.0
 * @category conversions
 */
export const cloudRoleModelId = (role: CloudRole, env: Readonly<Record<string, string | undefined>>): string => {
  const override = env[role.modelEnv]?.trim()
  return override !== undefined && override !== "" && MODEL_ID.test(override) ? override : role.model.id
}

/** "Explainer · Kimi K3": the menu label.
 * @since 1.0.0
 * @category conversions
 */
export const agentRoleTitle = (role: AgentRole): string => `${role.label} · ${role.model.label}`

/**
 * What a harness needs to launch a role: its binary name and the flag that
 * takes a model id (`claude --model`, `codex -m`, `opencode --model`). The
 * Bun host's harness table (apps/ui/src/bun/Harnesses.ts) states these,
 * verified against each installed binary's `--help`; this module only
 * composes with them.
 * @since 1.0.0
 * @category models
 */
export interface HarnessModelSpec {
  /** argv[0]: the binary name, resolved to a path server-side. */
  readonly binary: string
  /** The flag(s) placed before the model id. */
  readonly flag: ReadonlyArray<string>
}

/**
 * The launch argv for a role: the harness binary, its model flag, and the
 * role's model id — COMPOSED, never stored, and never containing renderer
 * text except the delegated task as the CLI's first prompt. The model id is
 * re-checked here so a row that slipped past validation still cannot inject
 * a flag. A trimmed task starting with a dash is refused; every nonempty
 * task follows the `--` option terminator as one positional prompt.
 * `claude [prompt]` and `codex [PROMPT]` take the task positionally;
 * the OpenCode TUI takes none, so a task runs through
 * `opencode run -m provider/model -- <message>` (opencode 1.18.22 `run --help`).
 * @since 1.0.0
 * @category conversions
 */
export const roleLaunchArgv = (
  role: Pick<AgentRole, "model">,
  harness: HarnessModelSpec,
  task?: string
): ReadonlyArray<string> => {
  const model = role.model.id
  if (!MODEL_ID.test(model)) throw new Error(`Refusing to launch: ${JSON.stringify(model)} is not a model id.`)
  const prompt = task?.trim() ?? ""
  if (prompt.startsWith("-")) throw new Error("Refusing to launch: a task must not start with a dash.")
  if (prompt !== "" && harness.binary === "opencode") return ["opencode", "run", "-m", model, "--", prompt]
  const base = [harness.binary, ...harness.flag, model]
  return prompt === "" ? base : [...base, "--", prompt]
}

/*
 * The wire (apps/ui/docs/LOCAL-APP.md "HTTP and WebSocket surface"):
 * `GET /api/agents` answers the list; `PUT /api/agents/{id}` creates or
 * edits one row from this body; `GET /api/harnesses/{id}/models` answers
 * what the harness's own list command printed, or the table's verified
 * suggestions when it has no list command.
 */
/**
 * Validates agents response values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentsResponseSchema = z.object({ agents: z.array(AgentRoleSchema) })
/**
 * The decoded value accepted by {@link AgentsResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentsResponse = z.infer<typeof AgentsResponseSchema>

/**
 * Validates agent put request values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentPutRequestSchema = z.object({
  label: z.string().min(1).max(60),
  purpose: z.string().max(400),
  harness: z.enum(HARNESS_IDS),
  model: AgentRoleModelSchema,
  delegates: z.boolean().optional()
}).strict()
/**
 * The decoded value accepted by {@link AgentPutRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentPutRequest = z.infer<typeof AgentPutRequestSchema>

/**
 * Validates agent response values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentResponseSchema = z.object({ agent: AgentRoleSchema })

/**
 * Validates harness models response values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const HarnessModelsResponseSchema = z.object({
  harnessId: z.enum(HARNESS_IDS),
  /** One model id per line the list command printed, or the verified suggestions. */
  models: z.array(z.string()),
  source: z.enum(["list", "suggestions"]),
  /** Why the list is empty or fell back, in the host's words; absent when it answered. */
  reason: z.string().optional()
})
/**
 * The decoded value accepted by {@link HarnessModelsResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type HarnessModelsResponse = z.infer<typeof HarnessModelsResponseSchema>

/**
 * The id a new agent gets from its name when none was typed: "Docs writer"
 * → "docs-writer". Undefined when nothing id-shaped survives.
 * @since 1.0.0
 * @category conversions
 */
export const agentIdFromLabel = (label: string): AgentRoleId | undefined => {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 41)
  return AGENT_ROLE_ID.test(slug) ? slug : undefined
}
