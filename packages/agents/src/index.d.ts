import { openai } from '@ai-sdk/openai';
import * as ai from 'ai';
import { ToolLoopAgent, ToolSet, ToolLoopAgentSettings } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { Effect } from 'effect';
import { SmithersError } from '@smithers/errors/SmithersError';
import * as zod from 'zod';
import * as zod_v4_core from 'zod/v4/core';

type PiExtensionUiResponse$1 = {
    type: "extension_ui_response";
    id: string;
    value?: string;
    cancelled?: boolean;
    [key: string]: unknown;
};

type PiExtensionUiRequest$1 = {
    type: "extension_ui_request";
    id: string;
    method: string;
    title?: string;
    placeholder?: string;
    [key: string]: unknown;
};

type BaseCliAgentOptions$1 = {
    id?: string;
    model?: string;
    systemPrompt?: string;
    instructions?: string;
    cwd?: string;
    env?: Record<string, string>;
    yolo?: boolean;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxOutputBytes?: number;
    extraArgs?: string[];
};

type PiAgentOptions$2 = BaseCliAgentOptions$1 & {
    provider?: string;
    model?: string;
    apiKey?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    mode?: "text" | "json" | "rpc";
    print?: boolean;
    continue?: boolean;
    resume?: boolean;
    session?: string;
    sessionDir?: string;
    noSession?: boolean;
    models?: string | string[];
    listModels?: boolean | string;
    tools?: string[];
    noTools?: boolean;
    extension?: string[];
    noExtensions?: boolean;
    skill?: string[];
    noSkills?: boolean;
    promptTemplate?: string[];
    noPromptTemplates?: boolean;
    theme?: string[];
    noThemes?: boolean;
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    export?: string;
    files?: string[];
    verbose?: boolean;
    onExtensionUiRequest?: (request: PiExtensionUiRequest$1) => Promise<PiExtensionUiResponse$1 | null> | PiExtensionUiResponse$1 | null;
};

type SdkAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}, MODEL = any> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS>, "model"> & {
    /**
     * Either a provider model id string or a preconstructed AI SDK language model.
     * Passing a model instance is mainly useful for tests and advanced provider setup.
     */
    model: string | MODEL;
};

type OpenAIAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof openai>>;

type AnthropicAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof anthropic>>;

type AgentToolDescriptor$1 = {
    description?: string;
    source?: "builtin" | "mcp" | "extension" | "skill" | "runtime";
};

type AgentCapabilityRegistry$3 = {
    version: 1;
    engine: "claude-code" | "codex" | "gemini" | "kimi" | "pi" | "amp" | "forge";
    runtimeTools: Record<string, AgentToolDescriptor$1>;
    mcp: {
        bootstrap: "inline-config" | "project-config" | "allow-list" | "unsupported";
        supportsProjectScope: boolean;
        supportsUserScope: boolean;
    };
    skills: {
        supportsSkills: boolean;
        installMode?: "files" | "dir" | "plugin";
        smithersSkillIds: string[];
    };
    humanInteraction: {
        supportsUiRequests: boolean;
        methods: string[];
    };
    builtIns: string[];
};

/**
 * @param {AgentCapabilityRegistry | null | undefined} registry
 * @returns {string}
 */
declare function hashCapabilityRegistry(registry: AgentCapabilityRegistry$2 | null | undefined): string;
type AgentCapabilityRegistry$2 = AgentCapabilityRegistry$3;

type AgentCapabilityRegistry$1 = AgentCapabilityRegistry$3;

/**
 * Represents an entity capable of generating responses or actions based on prompts.
 * This is typically an AI agent interface.
 */
type AgentLike$1 = {
    /** Optional unique identifier for the agent */
    id?: string;
    /** Available tools the agent can use */
    tools?: Record<string, any>;
    /** Optional structured capability registry for cache and diagnostics */
    capabilities?: AgentCapabilityRegistry$1;
    /**
     * Generates a response or action based on the provided arguments.
     *
     * @param args - The arguments for generation
     * @param args.options - Optional provider-specific configuration
     * @param args.abortSignal - Signal to abort the generation request
     * @param args.prompt - The input text prompt to generate from
     * @param args.timeout - Optional timeout configuration in milliseconds
     * @param args.onStdout - Callback for streaming standard output text
     * @param args.onStderr - Callback for streaming standard error text
     * @param args.outputSchema - Optional Zod schema defining the expected structured output format
     * @returns A promise resolving to the generated output
     */
    generate: (args: any) => Promise<any>;
};

type RunCommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
};

type CodexConfigOverrides = Record<string, string | number | boolean | object | null> | string[];

type AgentCliActionKind = "turn" | "command" | "tool" | "file_change" | "web_search" | "todo_list" | "reasoning" | "warning" | "note";

type AgentCliActionPhase = "started" | "updated" | "completed";
type AgentCliEventLevel = "debug" | "info" | "warning" | "error";
type AgentCliStartedEvent = {
    type: "started";
    engine: string;
    title: string;
    resume?: string;
    detail?: Record<string, unknown>;
};
type AgentCliActionEvent = {
    type: "action";
    engine: string;
    phase: AgentCliActionPhase;
    entryType?: "thought" | "message";
    action: {
        id: string;
        kind: AgentCliActionKind;
        title: string;
        detail?: Record<string, unknown>;
    };
    message?: string;
    ok?: boolean;
    level?: AgentCliEventLevel;
};
type AgentCliCompletedEvent = {
    type: "completed";
    engine: string;
    ok: boolean;
    answer?: string;
    error?: string;
    resume?: string;
    usage?: Record<string, unknown>;
};
type AgentCliEvent = AgentCliStartedEvent | AgentCliActionEvent | AgentCliCompletedEvent;

type CliOutputInterpreter$8 = {
    onStdoutLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined;
    onStderrLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined;
    onExit?: (result: RunCommandResult) => AgentCliEvent[] | AgentCliEvent | null | undefined;
};

declare class BaseCliAgent {
    /**
   * @param {BaseCliAgentOptions} opts
   */
    constructor(opts: BaseCliAgentOptions);
    version: string;
    tools: {};
    capabilities: any;
    id: string;
    model: string | undefined;
    systemPrompt: string | undefined;
    cwd: string | undefined;
    env: Record<string, string> | undefined;
    yolo: boolean;
    timeoutMs: number | undefined;
    idleTimeoutMs: number | undefined;
    maxOutputBytes: number | undefined;
    extraArgs: string[] | undefined;
    /**
   * @param {any} options
   * @param {AgentInvocationOperation} operation
   * @returns {Effect.Effect<GenerateTextResult<any, any>, SmithersError>}
   */
    runGenerateEffect(options: any, operation: AgentInvocationOperation): Effect.Effect<GenerateTextResult$2<any, any>, SmithersError>;
    /**
   * @param {any} options
   * @returns {Promise<GenerateTextResult<any, any>>}
   */
    generate(options: any): Promise<GenerateTextResult$2<any, any>>;
    /**
   * @param {any} options
   * @returns {Promise<StreamTextResult<any, any>>}
   */
    stream(options: any): Promise<StreamTextResult<any, any>>;
    /**
   * @returns {CliOutputInterpreter | undefined}
   */
    createOutputInterpreter(): CliOutputInterpreter$7 | undefined;
}
type BaseCliAgentOptions = BaseCliAgentOptions$1;
type CliOutputInterpreter$7 = CliOutputInterpreter$8;
type GenerateTextResult$2 = ai.GenerateTextResult<any, any>;
type StreamTextResult = ai.StreamTextResult<any, any>;

/** @typedef {import("ai").AgentCallParameters} AgentCallParameters */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/**
 * @template CALL_OPTIONS, TOOLS
 * @typedef {AgentCallParameters<CALL_OPTIONS, TOOLS> & { onStdout?: (text: string) => void; onStderr?: (text: string) => void; onEvent?: (event: unknown) => Promise<void> | void; outputSchema?: import("zod").ZodTypeAny; resumeSession?: string; }} ExtendedGenerateArgs
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
declare class AnthropicAgent extends ToolLoopAgent<never, any, never> {
    /**
   * @param {AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} opts
   */
    constructor(opts: AnthropicAgentOptions$1<CALL_OPTIONS, TOOLS>);
    hijackEngine: string;
    /**
   * @param {ExtendedGenerateArgs<CALL_OPTIONS, TOOLS>} args
   * @returns {Promise<GenerateTextResult<TOOLS, never>>}
   */
    generate(args: ExtendedGenerateArgs$1<CALL_OPTIONS, TOOLS>): Promise<GenerateTextResult$1<TOOLS, never>>;
}
type AgentCallParameters$1 = any;
type AnthropicAgentOptions$1<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = AnthropicAgentOptions$2<CALL_OPTIONS, TOOLS>;
type ExtendedGenerateArgs$1<CALL_OPTIONS, TOOLS> = AgentCallParameters$1<CALL_OPTIONS, TOOLS> & {
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    onEvent?: (event: unknown) => Promise<void> | void;
    outputSchema?: zod.ZodTypeAny;
    resumeSession?: string;
};
type GenerateTextResult$1 = ai.GenerateTextResult<any, any>;

/** @typedef {import("ai").AgentCallParameters} AgentCallParameters */
/**
 * @template CALL_OPTIONS, TOOLS
 * @typedef {AgentCallParameters<CALL_OPTIONS, TOOLS> & { onStdout?: (text: string) => void; onStderr?: (text: string) => void; onEvent?: (event: unknown) => Promise<void> | void; outputSchema?: import("zod").ZodTypeAny; resumeSession?: string; }} ExtendedGenerateArgs
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
declare class OpenAIAgent extends ToolLoopAgent<never, any, never> {
    /**
   * @param {OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} opts
   */
    constructor(opts: OpenAIAgentOptions$1<CALL_OPTIONS, TOOLS>);
    hijackEngine: string;
    /**
   * @param {ExtendedGenerateArgs<CALL_OPTIONS, TOOLS>} args
   * @returns {Promise<GenerateTextResult<TOOLS, never>>}
   */
    generate(args: ExtendedGenerateArgs<CALL_OPTIONS, TOOLS>): Promise<GenerateTextResult<TOOLS, never>>;
}
type AgentCallParameters = any;
type ExtendedGenerateArgs<CALL_OPTIONS, TOOLS> = AgentCallParameters<CALL_OPTIONS, TOOLS> & {
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    onEvent?: (event: unknown) => Promise<void> | void;
    outputSchema?: zod.ZodTypeAny;
    resumeSession?: string;
};
type GenerateTextResult = ai.GenerateTextResult<any, any>;
type OpenAIAgentOptions$1<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = OpenAIAgentOptions$2<CALL_OPTIONS, TOOLS>;

/**
 * Configuration options for the AmpAgent.
 */
type AmpAgentOptions$1 = BaseCliAgentOptions$1 & {
    /** Visibility setting for the new thread (e.g., private, public) */
    visibility?: "private" | "public" | "workspace" | "group";
    /** Path to a specific MCP configuration file */
    mcpConfig?: string;
    /** Path to a specific settings file */
    settingsFile?: string;
    /** Logging severity level */
    logLevel?: "error" | "warn" | "info" | "debug" | "audit";
    /** File path to write logs to */
    logFile?: string;
    /**
     * If true, dangerously allows all commands without asking for permission.
     * Equivalent to yolo mode but explicit.
     */
    dangerouslyAllowAll?: boolean;
    /** Whether to enable IDE integrations (disabled by default in AmpAgent) */
    ide?: boolean;
    /** Whether to enable JetBrains IDE integration */
    jetbrains?: boolean;
};

/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/**
 * Agent implementation that wraps the 'amp' CLI executable.
 * It translates generation requests into CLI arguments and executes the process.
 */
declare class AmpAgent extends BaseCliAgent {
    /**
     * Initializes a new AmpAgent with the given options.
     *
     * @param {AmpAgentOptions} [opts] - Configuration options for the agent
     */
    constructor(opts?: AmpAgentOptions);
    opts: AmpAgentOptions$1;
    capabilities: {
        version: number;
        engine: string;
        runtimeTools: {};
        mcp: {
            bootstrap: string;
            supportsProjectScope: boolean;
            supportsUserScope: boolean;
        };
        skills: {
            supportsSkills: boolean;
            smithersSkillIds: never[];
        };
        humanInteraction: {
            supportsUiRequests: boolean;
            methods: never[];
        };
        builtIns: string[];
    };
    cliEngine: string;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$6;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
    }>;
}
type AmpAgentOptions = AmpAgentOptions$1;
type CliOutputInterpreter$6 = CliOutputInterpreter$8;

type ClaudeCodeAgentOptions$1 = BaseCliAgentOptions$1 & {
    addDir?: string[];
    agent?: string;
    agents?: Record<string, {
        description?: string;
        prompt?: string;
    }> | string;
    allowDangerouslySkipPermissions?: boolean;
    allowedTools?: string[];
    appendSystemPrompt?: string;
    betas?: string[];
    chrome?: boolean;
    continue?: boolean;
    dangerouslySkipPermissions?: boolean;
    debug?: boolean | string;
    debugFile?: string;
    disableSlashCommands?: boolean;
    disallowedTools?: string[];
    fallbackModel?: string;
    file?: string[];
    forkSession?: boolean;
    fromPr?: string;
    ide?: boolean;
    includePartialMessages?: boolean;
    inputFormat?: "text" | "stream-json";
    jsonSchema?: string;
    maxBudgetUsd?: number;
    mcpConfig?: string[];
    mcpDebug?: boolean;
    model?: string;
    noChrome?: boolean;
    noSessionPersistence?: boolean;
    outputFormat?: "text" | "json" | "stream-json";
    permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "delegate" | "dontAsk" | "plan";
    pluginDir?: string[];
    replayUserMessages?: boolean;
    resume?: string;
    sessionId?: string;
    settingSources?: string;
    settings?: string;
    strictMcpConfig?: boolean;
    systemPrompt?: string;
    tools?: string[] | "default" | "";
    verbose?: boolean;
};

declare class ClaudeCodeAgent extends BaseCliAgent {
    /**
   * @param {ClaudeCodeAgentOptions} [opts]
   */
    constructor(opts?: ClaudeCodeAgentOptions);
    opts: ClaudeCodeAgentOptions$1;
    capabilities: AgentCapabilityRegistry$3;
    cliEngine: string;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$5;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "stream-json" | "text" | "json";
    }>;
}
type ClaudeCodeAgentOptions = ClaudeCodeAgentOptions$1;
type CliOutputInterpreter$5 = CliOutputInterpreter$8;

type CodexAgentOptions$1 = BaseCliAgentOptions$1 & {
    config?: CodexConfigOverrides;
    enable?: string[];
    disable?: string[];
    image?: string[];
    model?: string;
    oss?: boolean;
    localProvider?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    profile?: string;
    fullAuto?: boolean;
    dangerouslyBypassApprovalsAndSandbox?: boolean;
    cd?: string;
    skipGitRepoCheck?: boolean;
    addDir?: string[];
    outputSchema?: string;
    color?: "always" | "never" | "auto";
    json?: boolean;
    outputLastMessage?: string;
};

declare class CodexAgent extends BaseCliAgent {
    /**
   * @param {CodexAgentOptions} [opts]
   */
    constructor(opts?: CodexAgentOptions);
    opts: CodexAgentOptions$1;
    capabilities: AgentCapabilityRegistry$3;
    cliEngine: string;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$4;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: any[];
        stdin: string;
        outputFile: string;
        outputFormat: string;
        stdoutBannerPatterns: RegExp[];
        cleanup: () => Promise<void>;
    }>;
}
type CliOutputInterpreter$4 = CliOutputInterpreter$8;
type CodexAgentOptions = CodexAgentOptions$1;

type GeminiAgentOptions$1 = BaseCliAgentOptions$1 & {
    debug?: boolean;
    model?: string;
    sandbox?: boolean;
    yolo?: boolean;
    approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
    experimentalAcp?: boolean;
    allowedMcpServerNames?: string[];
    allowedTools?: string[];
    extensions?: string[];
    listExtensions?: boolean;
    resume?: string;
    listSessions?: boolean;
    deleteSession?: string;
    includeDirectories?: string[];
    screenReader?: boolean;
    outputFormat?: "text" | "json" | "stream-json";
};

declare class GeminiAgent extends BaseCliAgent {
    /**
   * @param {GeminiAgentOptions} [opts]
   */
    constructor(opts?: GeminiAgentOptions);
    opts: GeminiAgentOptions$1;
    capabilities: AgentCapabilityRegistry$3;
    cliEngine: string;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$3;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "stream-json" | "text" | "json";
    }>;
}
type CliOutputInterpreter$3 = CliOutputInterpreter$8;
type GeminiAgentOptions = GeminiAgentOptions$1;

declare class PiAgent extends BaseCliAgent {
    /**
   * @param {PiAgentOptions} [opts]
   */
    constructor(opts?: PiAgentOptions$1);
    opts: PiAgentOptions$2;
    capabilities: AgentCapabilityRegistry$3;
    cliEngine: string;
    issuedSessionRef: any;
    /**
   * @param {any} options
   * @returns {PiMode}
   */
    resolveMode(options: any): PiMode;
    /**
   * @param {{ prompt: string; cwd: string; options: any; mode: PiMode; }} params
   * @returns {string[]}
   */
    buildArgs(params: {
        prompt: string;
        cwd: string;
        options: any;
        mode: PiMode;
    }): string[];
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$2;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   * @returns {Promise<{ command: string; args: string[]; stdin?: string; outputFormat?: string; outputFile?: string; cleanup?: () => Promise<void>; }>}
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        stdin?: string;
        outputFormat?: string;
        outputFile?: string;
        cleanup?: () => Promise<void>;
    }>;
}
type CliOutputInterpreter$2 = CliOutputInterpreter$8;
type PiAgentOptions$1 = PiAgentOptions$2;

type KimiAgentOptions$1 = BaseCliAgentOptions$1 & {
    workDir?: string;
    session?: string;
    continue?: boolean;
    thinking?: boolean;
    outputFormat?: "text" | "stream-json";
    finalMessageOnly?: boolean;
    quiet?: boolean;
    agent?: "default" | "okabe";
    agentFile?: string;
    mcpConfigFile?: string[];
    mcpConfig?: string[];
    skillsDir?: string;
    maxStepsPerTurn?: number;
    maxRetriesPerStep?: number;
    maxRalphIterations?: number;
    verbose?: boolean;
    debug?: boolean;
};

declare class KimiAgent extends BaseCliAgent {
    /**
   * @param {KimiAgentOptions} [opts]
   */
    constructor(opts?: KimiAgentOptions);
    opts: KimiAgentOptions$1;
    capabilities: AgentCapabilityRegistry$3;
    cliEngine: string;
    issuedSessionId: any;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$1;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "stream-json" | "text";
        env: {
            KIMI_SHARE_DIR: string;
        } | undefined;
        cleanup: (() => Promise<void>) | undefined;
        stdoutBannerPatterns: RegExp[];
        stdoutErrorPatterns: RegExp[];
        errorOnBannerOnly: boolean;
    }>;
}
type CliOutputInterpreter$1 = CliOutputInterpreter$8;
type KimiAgentOptions = KimiAgentOptions$1;

type ForgeAgentOptions$1 = BaseCliAgentOptions$1 & {
    directory?: string;
    provider?: string;
    agent?: string;
    conversationId?: string;
    sandbox?: string;
    restricted?: boolean;
    verbose?: boolean;
    workflow?: string;
    event?: string;
    conversation?: string;
};

/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./ForgeAgentOptions.ts").ForgeAgentOptions} ForgeAgentOptions */
declare class ForgeAgent extends BaseCliAgent {
    /**
   * @param {ForgeAgentOptions} [opts]
   */
    constructor(opts?: ForgeAgentOptions);
    opts: ForgeAgentOptions$1;
    capabilities: {
        version: number;
        engine: string;
        runtimeTools: {};
        mcp: {
            bootstrap: string;
            supportsProjectScope: boolean;
            supportsUserScope: boolean;
        };
        skills: {
            supportsSkills: boolean;
            smithersSkillIds: never[];
        };
        humanInteraction: {
            supportsUiRequests: boolean;
            methods: never[];
        };
        builtIns: string[];
    };
    cliEngine: string;
    issuedConversationId: any;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
    }>;
}
type CliOutputInterpreter = CliOutputInterpreter$8;
type ForgeAgentOptions = ForgeAgentOptions$1;

/**
 * Convert a Zod schema to an OpenAI-safe JSON Schema object.
 *
 * Usage:
 * ```ts
 * import { zodToOpenAISchema } from "./zodToOpenAISchema";
 * const jsonSchema = zodToOpenAISchema(myZodSchema);
 * ```
 */
declare function zodToOpenAISchema(zodSchema: any): Promise<zod_v4_core.ZodStandardJSONSchemaPayload<any>>;

/**
 * Sanitize a JSON Schema for OpenAI's structured-output API.
 *
 * OpenAI's `response_format` imposes constraints beyond standard JSON Schema:
 *
 * 1. Every object node **must** include `"type": "object"`.
 * 2. `additionalProperties` must be a boolean or a valid sub-schema with a
 *    `type` key -- bare `{}` is rejected.
 * 3. `additionalProperties: true` is accepted but tells the model it can
 *    return extra keys -- set to `false` if you want strict conformance.
 *
 * Zod v4's `toJSONSchema()` can violate (1) when `z.looseObject()` is used:
 * it emits `{ additionalProperties: true }` without `"type": "object"`.
 *
 * This function fixes these issues in-place so any agent (Codex, future
 * OpenAI-backed agents, etc.) can safely use a JSON Schema for OpenAI.
 */
declare function sanitizeForOpenAI(node: any): void;

type SmithersToolSurface = "raw" | "semantic";
type SmithersAgentToolCategory = "runs" | "approvals" | "workflows" | "debug" | "admin";
type SmithersAgentContractTool = {
    name: string;
    description: string;
    destructive: boolean;
    category: SmithersAgentToolCategory;
};
type SmithersListedTool = {
    name: string;
    description?: string | null;
};
type SmithersAgentContract = {
    toolSurface: SmithersToolSurface;
    serverName: string;
    tools: SmithersAgentContractTool[];
    promptGuidance: string;
    docsGuidance: string;
};
type CreateSmithersAgentContractOptions = {
    toolSurface?: SmithersToolSurface;
    serverName?: string;
    tools: SmithersListedTool[];
};
type RenderSmithersAgentPromptGuidanceOptions = {
    available?: boolean;
    toolNamePrefix?: string;
};

declare function createSmithersAgentContract(options: CreateSmithersAgentContractOptions): SmithersAgentContract;
declare function renderSmithersAgentPromptGuidance(contract: SmithersAgentContract, options?: RenderSmithersAgentPromptGuidanceOptions): string;

type AgentCapabilityRegistry = AgentCapabilityRegistry$3;
type AgentLike = AgentLike$1;
type AgentToolDescriptor = AgentToolDescriptor$1;
type AnthropicAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = AnthropicAgentOptions$2<CALL_OPTIONS, TOOLS>;
type OpenAIAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = OpenAIAgentOptions$2<CALL_OPTIONS, TOOLS>;
type PiAgentOptions = PiAgentOptions$2;
type PiExtensionUiRequest = PiExtensionUiRequest$1;
type PiExtensionUiResponse = PiExtensionUiResponse$1;

export { type AgentCapabilityRegistry, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, BaseCliAgent, ClaudeCodeAgent, CodexAgent, type CreateSmithersAgentContractOptions, ForgeAgent, GeminiAgent, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type RenderSmithersAgentPromptGuidanceOptions, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, createSmithersAgentContract, hashCapabilityRegistry, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
