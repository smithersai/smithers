import {
  BaseCliAgent,
  pushFlag,
  isRecord,
  asString,
  truncate,
  toolKindFromName,
  shouldSurfaceUnparsedStdout,
  createSyntheticIdGenerator,
} from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList } from "./capability-registry/index.js";

/** @typedef {import("./BaseCliAgent/index.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./capability-registry/index.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */

/**
 * @typedef {BaseCliAgentOptions & {
 *   model?: string;
 *   agentName?: string;
 *   attachFiles?: string[];
 *   continueSession?: boolean;
 *   sessionId?: string;
 *   variant?: "high" | "medium" | "low";
 * }} OpenCodeAgentOptions
 */

/** @typedef {import("./BaseCliAgent/index.ts").CliOutputInterpreter} CliOutputInterpreter */

/**
 * @param {OpenCodeAgentOptions} [opts]  Currently unused — kept for API
 *   consistency with other agents (e.g. ClaudeCodeAgent uses opts to resolve
 *   builtIns based on tool allow/deny lists).  OpenCode does not yet expose
 *   CLI flags for restricting built-in tools, so the set is static.
 * @returns {AgentCapabilityRegistry}
 */
export function createOpenCodeCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    engine: "opencode",
    runtimeTools: {},
    mcp: {
      bootstrap: "project-config",
      supportsProjectScope: true,
      supportsUserScope: true,
    },
    skills: {
      supportsSkills: true,
      installMode: "plugin",
      smithersSkillIds: [],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    builtIns: normalizeCapabilityStringList([
      "read",
      "write",
      "edit",
      "apply_patch",
      "bash",
      "glob",
      "grep",
      "list",
      "webfetch",
      "websearch",
      "codesearch",
      "question",
      "task",
      "todowrite",
      "skill",
    ]),
  };
}

/**
 * CLI agent wrapper for OpenCode (https://opencode.ai).
 *
 * Shells out to `opencode run` in non-interactive mode with `--format json`
 * for streaming nd-JSON output. Parses AgentCliEvents from the JSON stream.
 *
 * Usage:
 *   const agent = new OpenCodeAgent({
 *     model: "anthropic/claude-opus-4-20250514",
 *     yolo: true,
 *   });
 *   const result = await agent.generate({
 *     messages: [{ role: "user", content: "Fix the bug" }],
 *   });
 */
export class OpenCodeAgent extends BaseCliAgent {
  /** @type {OpenCodeAgentOptions} */
  opts;
  /** @type {AgentCapabilityRegistry} */
  capabilities;
  /** @type {"opencode"} */
  cliEngine = "opencode";

  /**
   * @param {OpenCodeAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.capabilities = createOpenCodeCapabilityRegistry(opts);
  }

  /**
   * Create an output interpreter that parses OpenCode's nd-JSON streaming format.
   *
   * OpenCode `--format json` emits one JSON object per line (verified from source:
   * packages/opencode/src/cli/cmd/run.ts). The envelope is:
   *
   *   { type, timestamp: number, sessionID: string, ...payload }
   *
   * Event types:
   *   step_start  → { part: { type:"step-start", id, sessionID, messageID } }
   *   text        → { part: { type:"text", text, time: { start, end } } }
   *   tool_use    → { part: { type:"tool", tool, callID, state: { status, ... } } }
   *   step_finish → { part: { type:"step-finish", reason, tokens, cost } }
   *   reasoning   → { part: { type:"reasoning", text } }
   *   error       → { error: { name, data: { message } } }
   *
   * We map these to Smithers' AgentCliEvent union (started | action | completed).
   *
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let fullText = "";
    let sessionId = "";
    let didEmitStarted = false;
    let didEmitCompleted = false;
    let terminalError = null;

    // Accumulate tokens across multiple step_finish events
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;

    const nextSyntheticId = createSyntheticIdGenerator();

    /**
     * @param {string} title
     * @param {string} message
     * @param {"warning" | "error"} [level]
     * @returns {import("./BaseCliAgent/index.ts").AgentCliEvent}
     */
    const warningAction = (title, message, level = "warning") => ({
      type: "action",
      engine: this.cliEngine,
      phase: "completed",
      entryType: "thought",
      action: {
        id: nextSyntheticId("opencode-warning"),
        kind: "warning",
        title,
        detail: {},
      },
      message,
      ok: level !== "error",
      level,
    });

    /**
     * @param {string} line
     * @returns {import("./BaseCliAgent/index.ts").AgentCliEvent[]}
     */
    const parseLine = (line) => {
      // Strip OSC terminal escape sequences (e.g. title-setting "\x1b]0;...\x07")
      // that OpenCode emits inline with JSON events on stdout.
      const cleaned = line.replace(/\x1b\]0;[^\x07]*\x07/g, "");
      const trimmed = cleaned.trim();
      if (!trimmed) return [];

      /** @type {Record<string, unknown>} */
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        if (!shouldSurfaceUnparsedStdout(trimmed)) return [];
        return [warningAction("stdout", truncate(trimmed, 220))];
      }

      if (!isRecord(payload)) return [];

      const eventType = asString(payload.type);
      if (!eventType) return [];

      // Capture sessionID from the envelope (present on every event)
      const envelopeSessionId = asString(payload.sessionID);
      if (envelopeSessionId) {
        sessionId = envelopeSessionId;
      }

      const part = isRecord(payload.part) ? payload.part : null;

      // --- step_start: session/step beginning ---
      if (eventType === "step_start") {
        if (!didEmitStarted) {
          didEmitStarted = true;
          return [
            {
              type: "started",
              engine: this.cliEngine,
              title: "OpenCode",
              resume: sessionId || undefined,
              detail: sessionId ? { sessionId } : undefined,
            },
          ];
        }
        return [];
      }

      // --- text: finalized text chunk from the model ---
      if (eventType === "text") {
        const text = part ? asString(part.text) : null;
        if (text) {
          fullText += text;
          return [
            {
              type: "action",
              engine: this.cliEngine,
              phase: "updated",
              entryType: "message",
              action: {
                id: nextSyntheticId("opencode-text"),
                kind: "note",
                title: "assistant",
                detail: {},
              },
              message: text,
              ok: true,
              level: "info",
            },
          ];
        }
        return [];
      }

      // --- tool_use: tool completed or errored ---
      if (eventType === "tool_use" && part) {
        const toolName = asString(part.tool) ?? "tool";
        const callID = asString(part.callID) ?? nextSyntheticId("opencode-tool");
        const state = isRecord(part.state) ? part.state : null;
        const status = state ? asString(state.status) : null;
        const isError = status === "error";

        const events = [];

        // Emit a "started" action for the tool
        events.push({
          type: "action",
          engine: this.cliEngine,
          phase: "started",
          entryType: "thought",
          action: {
            id: callID,
            kind: toolKindFromName(toolName),
            title: toolName,
            detail: state && isRecord(state.input)
              ? { input: state.input }
              : {},
          },
          message: `Running ${toolName}`,
          level: "info",
        });

        // Emit a "completed" action for the tool
        const output = state
          ? asString(state.output) ?? asString(state.error)
          : undefined;
        events.push({
          type: "action",
          engine: this.cliEngine,
          phase: "completed",
          entryType: "thought",
          action: {
            id: callID,
            kind: toolKindFromName(toolName),
            title: toolName,
            detail: {},
          },
          message: output ? truncate(output, 300) : undefined,
          ok: !isError,
          level: isError ? "warning" : "info",
        });

        return events;
      }

      // --- step_finish: step completed with token usage ---
      if (eventType === "step_finish" && part) {
        const tokens = isRecord(part.tokens) ? part.tokens : null;
        if (tokens) {
          const input = typeof tokens.input === "number" ? tokens.input : 0;
          const output = typeof tokens.output === "number" ? tokens.output : 0;
          const total = typeof tokens.total === "number" ? tokens.total : 0;
          totalInputTokens += input;
          totalOutputTokens += output;
          totalTokens += total;
        }

        const reason = asString(part.reason);
        // Only emit "completed" on the final step (reason: "stop")
        if (reason === "stop") {
          if (didEmitCompleted) return [];
          didEmitCompleted = true;

          return [
            {
              type: "completed",
              engine: this.cliEngine,
              ok: true,
              answer: fullText || undefined,
              resume: sessionId || undefined,
              usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                totalTokens: totalTokens,
              },
            },
          ];
        }

        return [];
      }

      // --- reasoning: model thinking (only with --thinking flag) ---
      if (eventType === "reasoning") {
        // Surface reasoning as a thought action, don't accumulate into fullText
        const text = part ? asString(part.text) : null;
        if (text) {
          return [
            {
              type: "action",
              engine: this.cliEngine,
              phase: "updated",
              entryType: "thought",
              action: {
                id: nextSyntheticId("opencode-reasoning"),
                kind: "note",
                title: "reasoning",
                detail: {},
              },
              message: truncate(text, 500),
              ok: true,
              level: "info",
            },
          ];
        }
        return [];
      }

      // --- error: session error ---
      if (eventType === "error") {
        const errorObj = isRecord(payload.error) ? payload.error : null;
        const errorData = errorObj && isRecord(errorObj.data) ? errorObj.data : null;
        const errorName = errorObj ? asString(errorObj.name) : null;
        const errorMessage = errorData
          ? asString(errorData.message)
          : errorName ?? "OpenCode reported an error";
        terminalError = errorMessage ?? "OpenCode reported an error";

        if (didEmitCompleted) {
          return [warningAction("error", errorMessage ?? "OpenCode reported an error", "error")];
        }

        didEmitCompleted = true;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: false,
            answer: fullText || undefined,
            error: errorMessage ?? "OpenCode reported an error",
          },
        ];
      }

      return [];
    };

    return {
      onStdoutLine: parseLine,

      onStderrLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return [];
        return [warningAction("stderr", truncate(trimmed, 220))];
      },

      onExit: (result) => {
        if (didEmitCompleted) return [];
        const isSuccess = (result.exitCode ?? 0) === 0 && !terminalError;
        didEmitCompleted = true;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: isSuccess,
            answer: isSuccess ? fullText || undefined : undefined,
            error: isSuccess
              ? undefined
              : terminalError ?? `OpenCode exited with code ${result.exitCode ?? -1}`,
          },
        ];
      },
    };
  }

  /**
   * Build the CLI command spec for `opencode run`.
   *
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
   */
  async buildCommand(params) {
    const resumeSession = typeof params.options?.resumeSession === "string"
      ? params.options.resumeSession
      : undefined;
    const args = ["run"];

    // Model selection
    pushFlag(args, "-m", this.opts.model ?? this.model);

    // Working directory
    pushFlag(args, "--dir", params.cwd);

    // Streaming nd-JSON output
    pushFlag(args, "--format", "json");

    // Named agent config
    pushFlag(args, "--agent", this.opts.agentName);

    // File attachments: -f file1 -f file2 (repeated flag)
    if (this.opts.attachFiles) {
      for (const file of this.opts.attachFiles) {
        args.push("-f", file);
      }
    }

    // Session continuation
    const explicitSession = resumeSession ?? this.opts.sessionId;
    if (this.opts.continueSession && !explicitSession) {
      args.push("--continue");
    }
    pushFlag(args, "--session", explicitSession);

    // Variant / reasoning effort
    pushFlag(args, "--variant", this.opts.variant);

    // Yolo mode: auto-approve all tool calls.
    // OpenCode parses OPENCODE_PERMISSION with JSON.parse() and expects a
    // permission object.  '{"*":"allow"}' grants blanket approval for every
    // tool category.  See: packages/opencode/src/config/config.ts
    const yoloEnabled = this.opts.yolo ?? this.yolo;
    const env = {};
    if (yoloEnabled) {
      env.OPENCODE_PERMISSION = '{"*":"allow"}';
    }

    // Extra args from constructor
    if (this.extraArgs?.length) {
      args.push(...this.extraArgs);
    }

    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;

    // When flags like -f (yargs [array] type) are present, subsequent
    // positional arguments can be consumed as flag values. Insert '--'
    // to tell yargs to stop parsing flags and treat the rest as positional.
    if (fullPrompt) {
      args.push("--", fullPrompt);
    }

    return {
      command: "opencode",
      args,
      outputFormat: "stream-json",
      env: Object.keys(env).length > 0 ? env : undefined,
      stdoutBannerPatterns: [
        // OpenCode may print a version banner
        /^opencode\s+v[\d.]+/gim,
        // Strip OSC terminal title-setting sequences (ESC ] 0 ; ... BEL)
        // OpenCode emits these even with --format json
        /\x1b\]0;[^\x07]*\x07/g,
      ],
      stdoutErrorPatterns: [
        /^error:/im,
        /^fatal:/im,
      ],
    };
  }
}
