/**
 * Context payloads supplied to agents across native and browser transports.
 *
 * @since 1.0.0
 */
import { z } from "zod"

// Metadata occupies one instruction line. Keep the wire contract bounded and
// defend direct renderer callers too, which may not have parsed the payload.
const runtimeLineLimit = 4096
const runtimeLineSchema = z.string().regex(/^[^\r\n]*$/).max(runtimeLineLimit)
const line = (text: string): string => text.replace(/\r\n|[\r\n]/g, " ").slice(0, runtimeLineLimit)

/*
 * The per-turn runtime context: a versioned, structured, freshly-derived view of
 * the host Smithers app the agent is actually running inside. The client builds
 * it anew from live collections on EVERY turn (never cached, never persisted into
 * the visible transcript), sends it alongside the turn, and the server boundary
 * renders it into the instructions the upstream model sees. It states only state
 * the client genuinely holds — surface, connectors, wiki note summaries — and
 * honest limitations, so the model answers "what app am I in" from fact instead
 * of pleading ignorance about the host environment.
 */

/**
 * Shared agent runtime context version used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const AGENT_RUNTIME_CONTEXT_VERSION = 1

/**
 * Validates agent runtime connector values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRuntimeConnectorSchema = z.object({
  kind: runtimeLineSchema,
  name: runtimeLineSchema,
  status: runtimeLineSchema,
  access: runtimeLineSchema,
  root: runtimeLineSchema,
  branch: runtimeLineSchema.nullable()
})
/**
 * The decoded value accepted by {@link AgentRuntimeConnectorSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRuntimeConnector = z.infer<typeof AgentRuntimeConnectorSchema>

/*
 * One open tab of the local app (docs/LOCAL-APP.md "Tabs"), as the model sees
 * it: Smithers is the first tab and knows every other one — a terminal, a
 * harness (a subagent), or a card — and can read a tab's output with
 * `tab.read <id>`. Optional on the context so a boundary built before tabs
 * existed still validates the payload.
 */
/**
 * Validates agent runtime tab values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRuntimeTabSchema = z.object({
  id: runtimeLineSchema,
  kind: z.enum(["main", "terminal", "harness", "card"]),
  title: runtimeLineSchema,
  /** A harness tab's harness id and account, when known. */
  harnessId: runtimeLineSchema.optional(),
  account: runtimeLineSchema.optional(),
  /** A process tab's working directory. */
  cwd: runtimeLineSchema.optional(),
  /** "running" / "exited" for process tabs, "open" for the rest. */
  status: z.enum(["running", "exited", "open"]),
  exitCode: z.number().nullable().optional(),
  active: z.boolean()
})
/**
 * The decoded value accepted by {@link AgentRuntimeTabSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRuntimeTab = z.infer<typeof AgentRuntimeTabSchema>

/**
 * Validates agent runtime world document values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRuntimeWorldDocumentSchema = z.object({
  path: runtimeLineSchema,
  title: runtimeLineSchema,
  confidence: z.number(),
  /*
   * §10.8: the note's own words. Metadata alone made the World decorative —
   * a note recording a fact nowhere else was invisible to the model, which
   * answered "I can't retrieve that" about content the pane calls "what
   * Smithers currently understands". Optional, because the client budgets
   * how much body text rides a turn and a boundary built before this field
   * must still validate the payload.
   */
  body: z.string().optional(),
  /** True when `body` is the head of a longer note the budget cut. */
  bodyTruncated: z.boolean().optional()
})
/**
 * The decoded value accepted by {@link AgentRuntimeWorldDocumentSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRuntimeWorldDocument = z.infer<typeof AgentRuntimeWorldDocumentSchema>

/**
 * Validates agent runtime context values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRuntimeContextSchema = z.object({
  version: z.literal(AGENT_RUNTIME_CONTEXT_VERSION),
  product: z.literal("smithers"),
  // Epoch milliseconds, bounded by the ECMAScript time-value range: an
  // out-of-range number is not a timestamp, and rendering one would throw at
  // the server boundary rather than be rejected here.
  capturedAt: z.number().int().min(0).max(8_640_000_000_000_000),
  revision: z.number().int().nonnegative(),
  surface: z.enum(["chat", "world", "connectors", "flows", "plugins"]),
  theme: z.enum(["light", "dark"]),
  selectedWorldDocument: runtimeLineSchema.nullable(),
  connectors: z.array(AgentRuntimeConnectorSchema),
  /*
   * Repositories open in the LOCAL app (docs/LOCAL-APP.md), by name and
   * path: what files.list / files.read / target.list act on. Optional so a
   * boundary built before this field, and the cloud client, still validate.
   */
  repositories: z
    .array(
      z.object({
        id: runtimeLineSchema,
        name: runtimeLineSchema,
        path: runtimeLineSchema,
        branch: runtimeLineSchema.nullable(),
        /** A Smithers workspace was detected (target.list has something to list). */
        smithers: z.boolean()
      })
    )
    .optional(),
  /*
   * The selected repository, as `owner/name`: the one `repo.select` or the
   * landing page's `?repo=owner/name` link chose. A bare repo-scoped command
   * acts on it, and "this repo" in a first message means it. Null when
   * nothing is selected; optional so a boundary built before this field
   * still validates the payload.
   */
  activeRepository: runtimeLineSchema.nullable().optional(),
  /** The public catalog's description of the selected repository, when loaded. */
  activeRepositorySummary: z.string().optional(),
  /*
   * Sign-in IS the GitHub connector — one act, one truth (Wave 10, §2a′):
   * a valid GitHub session means the GitHub connector IS connected, so the
   * model never routes a signed-in user toward "connecting GitHub" again.
   * repositories is the count of the loaded repository inventory (lane
   * piper), and null when signed out.
   */
  github: z.object({
    connected: z.boolean(),
    login: runtimeLineSchema.nullable(),
    repositories: z.number().int().nonnegative().nullable(),
    /*
     * The loaded repositories BY NAME. A count alone left the model
     * declining to answer "what repos do I have?" while the names were
     * served plainly by the seam it was already reading (§22.7). Optional so
     * a boundary built before this field still validates the payload.
     */
    repositoryNames: z.array(runtimeLineSchema).optional()
  }),
  /*
   * The Smithers Cloud session (agent-parity.md): the GitHub line above says
   * nothing about it, so the model reached for the GitHub prompt when the
   * cloud session was what was missing. `degraded` is a signed-in legacy
   * token that reads but cannot act; `unavailable` is a host with no cloud
   * door answering. Optional so a boundary built before this field still
   * validates the payload.
   */
  cloud: z
    .object({
      state: z.enum(["signed-in", "signed-out", "degraded", "unavailable"]),
      username: runtimeLineSchema.nullable()
    })
    .optional(),
  /*
   * The account's own money, as the client already holds it. Asked "what is my
   * balance right now?", the model answered "$0.00" one line above a card its
   * own tool call had just rendered reading "$519 left" — it had no figure in
   * context and confabulated one (§22.7). Optional for the same reason.
   */
  billing: z
    .object({
      state: runtimeLineSchema,
      totalUsd: runtimeLineSchema.nullable(),
      lifetimeChargedUsd: runtimeLineSchema.nullable(),
      chargeCount: z.number().int().nonnegative()
    })
    .nullable()
    .optional(),
  worldState: z.object({
    documentCount: z.number().int().nonnegative(),
    documents: z.array(AgentRuntimeWorldDocumentSchema)
  }),
  /*
   * The guided introduction while it runs (apps/ui docs/ONBOARDING.md): the
   * lesson the user is on and the lesson transcript they have seen. The
   * tutorial is the app's whole screen then, so the model answers a mid-
   * tutorial message against it — deferring to the lesson for chatter,
   * skipping it (onboarding.act finish) for real work. Absent once the
   * tutorial is done; optional so a boundary built before this field still
   * validates the payload.
   */
  onboarding: z
    .object({
      /** The lesson the user is on, 0-based. */
      step: z.number().int().nonnegative(),
      /** The total lesson count. */
      stepCount: z.number().int().positive(),
      /** The lesson messages shown so far — the tutorial's own transcript. */
      transcript: z.array(z.string())
    })
    .optional(),
  /** The open tabs; absent on a client without a tab strip. */
  tabs: z.array(AgentRuntimeTabSchema).optional(),
  capabilities: z.array(runtimeLineSchema),
  limitations: z.array(runtimeLineSchema)
})
/**
 * The decoded value accepted by {@link AgentRuntimeContextSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRuntimeContext = z.infer<typeof AgentRuntimeContextSchema>

/*
 * Rendering runs on the server boundary against a body that arrived over the
 * wire, so it never throws on a timestamp: a value the schema would have
 * rejected still renders as an honest "unknown" instead of turning the turn
 * into a misleading "Smithers Cloud is unreachable".
 */
const capturedAtLabel = (capturedAt: number): string =>
  Number.isFinite(capturedAt) && Math.abs(capturedAt) <= 8_640_000_000_000_000
    ? new Date(capturedAt).toISOString()
    : "unknown"

/** The hidden-context block the server boundary folds into the turn's instructions.
 * @since 1.0.0
 * @category conversions
 */
export const renderAgentRuntimeContext = (context: AgentRuntimeContext): string => {
  const lines = [
    "# Runtime context — the Smithers app you are running inside (context version 1)",
    "This block was freshly derived from the host app's live state at the start of THIS turn. It is hidden context: it is not part of the visible transcript and the user cannot see it. Treat it as the complete and current truth about the environment you are operating in — never guess beyond it.",
    "- Product: Smithers. You are running INSIDE the Smithers product's own chat client, so when the user asks what app they are in, the truthful answer is Smithers.",
    `- Captured: ${capturedAtLabel(context.capturedAt)} (app-state revision ${context.revision})`,
    `- Current surface: ${line(context.surface)}${
      context.selectedWorldDocument === null
        ? ""
        : ` (wiki note open: "${line(context.selectedWorldDocument)}")`
    }${
      // Chat-first: world and connectors are panes embedded in the chat shell,
      // not pages that replaced it. Saying only "Current surface: world" would
      // read as "the conversation is gone", which is not what the user sees.
      context.surface === "chat"
        ? ""
        : " — an embedded pane inside the chat shell; the conversation transcript and composer stay visible and usable beside it"}`,
    `- Theme: ${line(context.theme)}`
  ]
  if (context.onboarding !== undefined) {
    const { step, stepCount, transcript } = context.onboarding
    lines.push(
      `- Onboarding tutorial: IN PROGRESS — the user is on lesson ${
        step + 1
      } of ${stepCount}. The tutorial IS the screen right now: it has its own messages and buttons, and this chat is the summoned "Talk to Smithers" dock over it.`,
      `  A conversational message (a greeting, a question about what is happening) gets ONE short answer that hands the lesson back — name the current lesson's action and stop. Do not start work, run flows, or tour capabilities for it.`,
      `  A request to DO something — a real task, or the user asking to skip — is different: the tutorial is then in their way, so execute onboarding.act finish to end it, then answer the request in the same turn. Never make the user wait out the tutorial for work you can do now.`,
      `  The lesson transcript the user has seen so far:`
    )
    // Quoted like Wiki notes: lesson copy is evidence, never an instruction line.
    for (const lesson of transcript) {
      for (const text of lesson.split(/\r\n|[\r\n]/)) lines.push(`    | ${line(text)}`)
    }
  }
  if (context.connectors.length === 0) {
    lines.push("- Connectors: none connected — no workspace, repository, or branch is known.")
  } else {
    lines.push("- Connectors:")
    for (const connector of context.connectors) {
      lines.push(
        `  - ${line(connector.kind)} "${line(connector.name)}" (${line(connector.status)}, ${
          line(connector.access)
        } access) at ${line(connector.root)}${connector.branch === null ? "" : `, branch ${line(connector.branch)}`}`
      )
    }
  }
  const repositories = context.repositories ?? []
  if (repositories.length > 0) {
    lines.push(
      "- Open repositories (local checkouts in this app; files.list / files.read / target.list act on them, a bare call on the active one):"
    )
    for (const repo of repositories) {
      lines.push(
        `  - "${line(repo.name)}" (id ${line(repo.id)}) at ${line(repo.path)}${
          repo.branch === null ? "" : `, branch ${line(repo.branch)}`
        }${repo.smithers ? ", Smithers workspace detected" : ""}`
      )
    }
  }
  if (context.activeRepository !== undefined) {
    lines.push(
      context.activeRepository === null
        ? "- Active repository: none selected."
        : `- Active repository: ${
          line(context.activeRepository)
        }. This is the selected repository: a bare repo-scoped command acts on it, and "this repo" in the user's message means it.`
    )
    if (context.activeRepository !== null && context.activeRepositorySummary !== undefined) {
      lines.push("- Selected repository description (public catalog):")
      for (const text of context.activeRepositorySummary.split(/\r\n|[\r\n]/)) {
        lines.push(`    | ${line(text)}`)
      }
    }
  }
  if (context.github.connected) {
    const loaded = typeof context.github.repositories === "number"
      ? `${context.github.repositories} ${context.github.repositories === 1 ? "repository" : "repositories"} loaded`
      : "repository inventory unknown"
    lines.push(
      `- GitHub: CONNECTED as ${
        line(context.github.login ?? "a GitHub user")
      } (sign-in and the GitHub connector are one act) — ${loaded}.`
    )
    const names = context.github.repositoryNames ?? []
    if (names.length > 0) {
      lines.push(`  Loaded repositories, by name: ${names.map(line).join(", ")}.`)
    }
  } else {
    lines.push("- GitHub: not connected (no signed-in session).")
  }
  if (context.cloud !== undefined) {
    const who = line(context.cloud.username ?? "you")
    switch (context.cloud.state) {
      case "signed-in":
        lines.push(`- Smithers Cloud: signed in as ${who}.`)
        break
      case "signed-out":
        lines.push(
          "- Smithers Cloud: signed out (workspaces, changes and sync need it; cloud.prompt renders the sign-in button)."
        )
        break
      case "degraded":
        lines.push(
          `- Smithers Cloud: signed in as ${who} with a degraded session — it reads but cannot act on workspaces; cloud.prompt renders the sign-in button for a fresh session.`
        )
        break
      case "unavailable":
        lines.push("- Smithers Cloud: unavailable on this host.")
        break
    }
  }
  const billing = context.billing
  if (billing !== undefined && billing !== null) {
    lines.push(
      billing.state === "unavailable" || billing.state === "unknown"
        ? `- Balance: the billing service did not answer (${line(billing.state)}) — say so rather than naming a figure.`
        : `- Balance: $${line(billing.totalUsd ?? "0")} left; $${
          line(billing.lifetimeChargedUsd ?? "0")
        } spent across ${billing.chargeCount} turn(s). This IS the number — never state a different one.`
    )
  }
  if (context.worldState.documentCount === 0) {
    lines.push("- Wiki: no notes yet.")
  } else {
    lines.push(
      `- Wiki: ${context.worldState.documentCount} note(s). These are workspace notes, not the selected repository's identity or description. Answer from their substantive content when relevant; a blank note or a title alone supplies no repository facts:`
    )
    for (const document of context.worldState.documents) {
      lines.push(`  - ${line(document.path)} — "${line(document.title)}" (confidence ${document.confidence})`)
      if (document.body === undefined) continue
      const body = document.body.trim()
      if (body === "") {
        lines.push(
          document.bodyTruncated === true
            ? "    | (this note's text did not fit this turn's context budget — read it in the Wiki pane)"
            : "    (empty note)"
        )
        continue
      }
      // Indented under its own heading so a note's words cannot be read as
      // an instruction line of this block.
      for (const text of body.split(/\r\n|[\r\n]/)) lines.push(`    | ${line(text)}`)
      if (document.bodyTruncated === true) {
        lines.push("    | … (note truncated here — read the rest in the Wiki pane)")
      }
    }
  }
  if (context.tabs !== undefined) {
    if (context.tabs.length <= 1) {
      lines.push("- Tabs: only this conversation is open — no terminal, agent, or card tab.")
    } else {
      lines.push(
        "- Tabs (you are the first tab and can see every other one; read a tab's recent output with tab.read <id>):"
      )
      for (const tab of context.tabs) {
        const detail = [
          tab.harnessId === undefined ? undefined : `harness ${line(tab.harnessId)}`,
          tab.account === undefined ? undefined : line(tab.account),
          tab.cwd === undefined ? undefined : `in ${line(tab.cwd)}`,
          tab.status === "exited"
            ? `exited${tab.exitCode == null ? "" : ` with code ${tab.exitCode}`}`
            : line(tab.status)
        ].filter((part): part is string => part !== undefined)
        lines.push(
          `  - ${line(tab.id)} — ${line(tab.kind)} "${line(tab.title)}"${tab.active ? " (active)" : ""}: ${
            detail.join(", ")
          }`
        )
      }
    }
  }
  lines.push("- Capabilities (what you can honestly do in this client):")
  for (const capability of context.capabilities) lines.push(`  - ${line(capability)}`)
  lines.push("- Limitations (never claim otherwise):")
  for (const limitation of context.limitations) lines.push(`  - ${line(limitation)}`)
  return lines.join("\n")
}

/**
 * The composition both server boundaries (the dev-server AgentApi via CloudAgent
 * and the deployed product Worker) apply before calling the upstream chat
 * service: instructions plus the rendered context block. Upstream sees one
 * instructions string; the structured context itself never crosses to it.
 * @since 1.0.0
 * @category conversions
 */
export const composeAgentInstructions = (
  instructions: string,
  context?: AgentRuntimeContext
): string => context === undefined ? instructions : `${instructions}\n\n${renderAgentRuntimeContext(context)}`
