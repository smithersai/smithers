import {
  BaseCliAgent,
  pushFlag,
  pushList,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";

type GeminiAgentOptions = BaseCliAgentOptions & {
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

export class GeminiAgent extends BaseCliAgent {
  private readonly opts: GeminiAgentOptions;

  constructor(opts: GeminiAgentOptions = {}) {
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
    // Default to "json" output format to separate model responses from tool
    // output text. With "text" format, tool call results (file contents etc.)
    // are concatenated into the response, making JSON extraction unreliable.
    const outputFormat = this.opts.outputFormat ?? "json";

    if (this.opts.debug) args.push("--debug");
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (this.opts.sandbox) args.push("--sandbox");
    if (this.opts.approvalMode) {
      pushFlag(args, "--approval-mode", this.opts.approvalMode);
    } else if (yoloEnabled) {
      args.push("--yolo");
    }
    if (this.opts.experimentalAcp) args.push("--experimental-acp");
    pushList(
      args,
      "--allowed-mcp-server-names",
      this.opts.allowedMcpServerNames,
    );
    pushList(args, "--allowed-tools", this.opts.allowedTools);
    pushList(args, "--extensions", this.opts.extensions);
    if (this.opts.listExtensions) args.push("--list-extensions");
    pushFlag(args, "--resume", this.opts.resume);
    if (this.opts.listSessions) args.push("--list-sessions");
    pushFlag(args, "--delete-session", this.opts.deleteSession);
    pushList(args, "--include-directories", this.opts.includeDirectories);
    if (this.opts.screenReader) args.push("--screen-reader");
    pushFlag(args, "--output-format", outputFormat);
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    // Reinforce JSON output requirement in the prompt for Gemini models which
    // tend to forget structured output instructions on long responses.
    const jsonReminder = params.prompt?.includes("REQUIRED OUTPUT")
      ? "\n\nREMINDER: Your response MUST end with a ```json code fence containing the required JSON object. Do NOT skip this step — the pipeline will reject your response without it.\n"
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}${jsonReminder}`;
    args.push("--prompt", fullPrompt);

    return {
      command: "gemini",
      args,
      outputFormat,
    };
  }
}
