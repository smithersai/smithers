import {
  BaseCliAgent,
  pushFlag,
  pushList,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";

type KimiAgentOptions = BaseCliAgentOptions & {
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

export class KimiAgent extends BaseCliAgent {
  private readonly opts: KimiAgentOptions;

  constructor(opts: KimiAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = [];
    const yoloEnabled = this.opts.yolo ?? this.yolo;

    // Print mode is required for non-interactive execution
    // Note: --print implicitly adds --yolo
    args.push("--print");

    // Output format — use text with --final-message-only to get only the
    // model's final response without tool call outputs mixed in.
    const outputFormat = this.opts.outputFormat ?? "text";
    pushFlag(args, "--output-format", outputFormat);
    // When using text format, --final-message-only ensures we only get
    // the model's final response, not intermediate tool output.
    const finalMessageOnly = this.opts.finalMessageOnly ?? (outputFormat === "text");
    if (finalMessageOnly) args.push("--final-message-only");

    // Other flags
    pushFlag(args, "--work-dir", this.opts.workDir ?? params.cwd);
    pushFlag(args, "--session", this.opts.session);
    if (this.opts.continue) args.push("--continue");
    pushFlag(args, "--model", this.opts.model ?? this.model);
    const thinking = this.opts.thinking ?? true;
    args.push(thinking ? "--thinking" : "--no-thinking");
    if (this.opts.finalMessageOnly) args.push("--final-message-only");
    if (this.opts.quiet) args.push("--quiet");
    pushFlag(args, "--agent", this.opts.agent);
    pushFlag(args, "--agent-file", this.opts.agentFile);
    pushList(args, "--mcp-config-file", this.opts.mcpConfigFile);
    pushList(args, "--mcp-config", this.opts.mcpConfig);
    pushFlag(args, "--skills-dir", this.opts.skillsDir);
    pushFlag(args, "--max-steps-per-turn", this.opts.maxStepsPerTurn);
    pushFlag(args, "--max-retries-per-step", this.opts.maxRetriesPerStep);
    pushFlag(args, "--max-ralph-iterations", this.opts.maxRalphIterations);
    if (this.opts.verbose) args.push("--verbose");
    if (this.opts.debug) args.push("--debug");

    if (this.extraArgs?.length) args.push(...this.extraArgs);

    // Build prompt with system prompt prepended
    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    const jsonReminder = params.prompt?.includes("REQUIRED OUTPUT")
      ? "\n\nREMINDER: Your response MUST end with a ```json code fence containing the required JSON object. Do NOT skip this step — the pipeline will reject your response without it.\n"
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}${jsonReminder}`;

    // Pass prompt via --prompt flag
    pushFlag(args, "--prompt", fullPrompt);

    return {
      command: "kimi",
      args,
      outputFormat,
    };
  }
}
