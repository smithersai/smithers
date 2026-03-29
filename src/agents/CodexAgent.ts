import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BaseCliAgent,
  normalizeCodexConfig,
  pushFlag,
  pushList,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions, CodexConfigOverrides } from "./BaseCliAgent";

type CodexAgentOptions = BaseCliAgentOptions & {
  config?: CodexConfigOverrides;
  enable?: string[];
  disable?: string[];
  image?: string[];
  model?: string;
  outputFormat?: "text" | "json" | "stream-json";
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

export class CodexAgent extends BaseCliAgent {
  private readonly opts: CodexAgentOptions;

  constructor(opts: CodexAgentOptions = {}) {
    opts = {
      ...opts,
      json: opts.json ?? true,
      outputFormat: opts.outputFormat ?? "stream-json",
    };
    super(opts);
    this.opts = opts;
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = ["exec"];
    const yoloEnabled = this.opts.yolo ?? this.yolo;

    const configOverrides = normalizeCodexConfig(this.opts.config);
    for (const entry of configOverrides) {
      args.push("-c", entry);
    }

    pushList(args, "--enable", this.opts.enable);
    pushList(args, "--disable", this.opts.disable);
    pushList(args, "--image", this.opts.image);
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (this.opts.oss) args.push("--oss");
    pushFlag(args, "--local-provider", this.opts.localProvider);
    pushFlag(args, "--sandbox", this.opts.sandbox);
    pushFlag(args, "--profile", this.opts.profile);
    if (this.opts.fullAuto) {
      args.push("--full-auto");
    } else if (yoloEnabled || this.opts.dangerouslyBypassApprovalsAndSandbox) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    pushFlag(args, "--cd", this.opts.cd);
    if (this.opts.skipGitRepoCheck) args.push("--skip-git-repo-check");
    pushList(args, "--add-dir", this.opts.addDir);
    pushFlag(args, "--output-schema", this.opts.outputSchema);
    pushFlag(args, "--color", this.opts.color);
    // Always enable JSON output to capture JSONL events including
    // turn.completed with token usage for metrics. extractUsageFromOutput
    // in BaseCliAgent will parse these automatically.
    args.push("--json");

    // Auto-wire output schema from task context if not explicitly set
    let schemaCleanupFile: string | null = null;
    if (!this.opts.outputSchema && params.options?.outputSchema) {
      const { z } = await import("zod");
      const jsonSchema = z.toJSONSchema(params.options.outputSchema);
      const schemaFile = join(
        tmpdir(),
        `smithers-schema-${randomUUID()}.json`,
      );
      await fs.writeFile(schemaFile, JSON.stringify(jsonSchema), "utf8");
      pushFlag(args, "--output-schema", schemaFile);
      schemaCleanupFile = schemaFile;
    }

    const outputFile =
      this.opts.outputLastMessage ??
      join(tmpdir(), `smithers-codex-${randomUUID()}.txt`);
    pushFlag(args, "--output-last-message", outputFile);

    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;

    args.push("-");

    return {
      command: "codex",
      args,
      stdin: fullPrompt,
      outputFile,
      outputFormat: "stream-json" as const,
      stdoutBannerPatterns: [
        // Codex CLI prints a startup banner like:
        // "OpenAI Codex v0.99.0-alpha.13 (research preview)"
        /^OpenAI Codex v[^\n]*$/gm,
      ],
      cleanup: async () => {
        if (!this.opts.outputLastMessage) {
          await fs.rm(outputFile, { force: true }).catch(() => undefined);
        }
        if (schemaCleanupFile) {
          await fs
            .rm(schemaCleanupFile, { force: true })
            .catch(() => undefined);
        }
      },
    };
  }
}
