import { openai } from '@ai-sdk/openai';
import * as ai from 'ai';
import { ToolLoopAgent, ToolSet, ToolLoopAgentSettings } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { Effect } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import * as zod from 'zod';
import * as zod_v4_core from 'zod/v4/core';

type SmithersToolSurface$2 = "raw" | "semantic";

type SmithersListedTool$2 = {
    name: string;
    description?: string | null;
};

type SmithersAgentToolCategory$1 = "runs" | "approvals" | "workflows" | "debug" | "admin";

type SmithersAgentContractTool$1 = {
    name: string;
    description: string;
    destructive: boolean;
    category: SmithersAgentToolCategory$1;
};

type SmithersAgentContract$3 = {
    toolSurface: SmithersToolSurface$2;
    serverName: string;
    tools: SmithersAgentContractTool$1[];
    promptGuidance: string;
    docsGuidance: string;
};

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
    tools?: Record<string, unknown>;
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
    generate: (args: unknown) => Promise<unknown>;
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
type AgentCliEvent$2 = AgentCliStartedEvent | AgentCliActionEvent | AgentCliCompletedEvent;

type CliOutputInterpreter$8 = {
    onStdoutLine?: (line: string) => AgentCliEvent$2[] | AgentCliEvent$2 | null | undefined;
    onStderrLine?: (line: string) => AgentCliEvent$2[] | AgentCliEvent$2 | null | undefined;
    onExit?: (result: RunCommandResult) => AgentCliEvent$2[] | AgentCliEvent$2 | null | undefined;
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
   * @param {AgentGenerateOptions} [options]
   * @param {AgentInvocationOperation} operation
   * @returns {Effect.Effect<GenerateTextResult<Record<string, never>, unknown>, SmithersError>}
   */
    runGenerateEffect(options?: AgentGenerateOptions, operation: AgentInvocationOperation): Effect.Effect<GenerateTextResult$3<Record<string, never>, unknown>, SmithersError>;
    /**
   * @param {AgentGenerateOptions} [options]
   * @returns {Promise<GenerateTextResult<Record<string, never>, unknown>>}
   */
    generate(options?: AgentGenerateOptions): Promise<GenerateTextResult$3<Record<string, never>, unknown>>;
    /**
   * @param {AgentGenerateOptions} [options]
   * @returns {Promise<StreamTextResult<Record<string, never>, unknown>>}
   */
    stream(options?: AgentGenerateOptions): Promise<StreamTextResult<Record<string, never>, unknown>>;
    /**
   * @returns {CliOutputInterpreter | undefined}
   */
    createOutputInterpreter(): CliOutputInterpreter$7 | undefined;
}
type AgentCliEvent$1 = AgentCliEvent$2;
type BaseCliAgentOptions = BaseCliAgentOptions$1;
type CliOutputInterpreter$7 = CliOutputInterpreter$8;
type GenerateTextResult$3 = ai.GenerateTextResult<any, any>;
type StreamTextResult = ai.StreamTextResult<any, any>;
type AgentInvocationOperation = "generate" | "stream";
/**
 * Loosely-typed generation options. The AI SDK passes a dynamic shape here
 * (GenerateTextOptions / StreamTextOptions and provider-specific extensions)
 * so we keep this permissive but avoid raw `any`.
 */
type AgentGenerateOptions = {
    prompt?: unknown;
    messages?: unknown;
    timeout?: unknown;
    abortSignal?: AbortSignal;
    rootDir?: string;
    resumeSession?: string;
    maxOutputBytes?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    onEvent?: (event: AgentCliEvent$1) => unknown;
    retry?: unknown;
    isRetry?: unknown;
    retryAttempt?: unknown;
    schemaRetry?: unknown;
    [key: string]: unknown;
};

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
    generate(args: ExtendedGenerateArgs$1<CALL_OPTIONS, TOOLS>): Promise<GenerateTextResult$2<TOOLS, never>>;
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
type GenerateTextResult$2 = ai.GenerateTextResult<any, any>;

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
    generate(args: ExtendedGenerateArgs<CALL_OPTIONS, TOOLS>): Promise<GenerateTextResult$1<TOOLS, never>>;
}
type AgentCallParameters = any;
type ExtendedGenerateArgs<CALL_OPTIONS, TOOLS> = AgentCallParameters<CALL_OPTIONS, TOOLS> & {
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    onEvent?: (event: unknown) => Promise<void> | void;
    outputSchema?: zod.ZodTypeAny;
    resumeSession?: string;
};
type GenerateTextResult$1 = ai.GenerateTextResult<any, any>;
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
   * @param {PiGenerateOptions} [options]
   * @returns {PiMode}
   */
    resolveMode(options?: PiGenerateOptions): PiMode;
    /**
   * @param {{ prompt: string; cwd: string; options?: PiGenerateOptions; mode: PiMode; }} params
   * @returns {string[]}
   */
    buildArgs(params: {
        prompt: string;
        cwd: string;
        options?: PiGenerateOptions;
        mode: PiMode;
    }): string[];
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$2;
    /**
   * @param {PiGenerateOptions} [options]
   * @returns {Promise<GenerateTextResult>}
   */
    generate(options?: PiGenerateOptions): Promise<GenerateTextResult>;
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options?: PiGenerateOptions; }} params
   * @returns {Promise<{ command: string; args: string[]; stdin?: string; outputFormat?: string; outputFile?: string; cleanup?: () => Promise<void>; }>}
   */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options?: PiGenerateOptions;
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
type AgentCliEvent = AgentCliEvent$2;
type GenerateTextResult = ai.GenerateTextResult<Record<string, never>, unknown>;
type PiAgentOptions$1 = PiAgentOptions$2;
type PiMode = "text" | "json" | "stream-json" | "rpc";
type PiGenerateOptions = {
    prompt?: unknown;
    messages?: unknown;
    onEvent?: (event: AgentCliEvent) => unknown;
    resumeSession?: unknown;
    rootDir?: string;
    timeout?: unknown;
    abortSignal?: AbortSignal;
    maxOutputBytes?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    [key: string]: unknown;
};

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
 * @param {CreateSmithersAgentContractOptions} options
 * @returns {SmithersAgentContract}
 */
declare function createSmithersAgentContract(options: CreateSmithersAgentContractOptions): SmithersAgentContract$2;
type SmithersListedTool$1 = SmithersListedTool$2;
type SmithersToolSurface$1 = SmithersToolSurface$2;
type CreateSmithersAgentContractOptions = {
    toolSurface?: SmithersToolSurface$1;
    serverName?: string;
    tools: SmithersListedTool$1[];
};
type SmithersAgentContract$2 = SmithersAgentContract$3;

/**
 * @param {SmithersAgentContract} contract
 * @param {RenderGuidanceOptions} [options]
 */
declare function renderSmithersAgentPromptGuidance(contract: SmithersAgentContract$1, options?: RenderGuidanceOptions): string;
type RenderGuidanceOptions = {
    available?: boolean;
    toolNamePrefix?: string;
};
type SmithersAgentContract$1 = SmithersAgentContract$3;

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

type AgentCapabilityRegistry = AgentCapabilityRegistry$3;
type AgentLike = AgentLike$1;
type AgentToolDescriptor = AgentToolDescriptor$1;
type AnthropicAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = AnthropicAgentOptions$2<CALL_OPTIONS, TOOLS>;
type OpenAIAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = OpenAIAgentOptions$2<CALL_OPTIONS, TOOLS>;
type PiAgentOptions = PiAgentOptions$2;
type PiExtensionUiRequest = PiExtensionUiRequest$1;
type PiExtensionUiResponse = PiExtensionUiResponse$1;
type SmithersAgentContract = SmithersAgentContract$3;
type SmithersAgentContractTool = SmithersAgentContractTool$1;
type SmithersAgentToolCategory = SmithersAgentToolCategory$1;
type SmithersListedTool = SmithersListedTool$2;
type SmithersToolSurface = SmithersToolSurface$2;

export { type AgentCapabilityRegistry, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, BaseCliAgent, ClaudeCodeAgent, CodexAgent, ForgeAgent, GeminiAgent, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, createSmithersAgentContract, hashCapabilityRegistry, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
