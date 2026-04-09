import { Cli, z } from "incur";
import { runPromise } from "../effect/runtime";
import {
  createSmithersIdeService,
  type SmithersIdeServiceConfig,
} from "./SmithersIdeService";

export const SMITHERS_IDE_TOOL_NAMES = [
  "smithers_ide_open_file",
  "smithers_ide_open_diff",
  "smithers_ide_show_overlay",
  "smithers_ide_run_terminal",
  "smithers_ide_ask_user",
  "smithers_ide_open_webview",
] as const;

export function createSmithersIdeCli(
  config: SmithersIdeServiceConfig = {},
) {
  const service = createSmithersIdeService(config);

  return Cli.create({
    name: "smithers-ide",
    description: "Smithers IDE MCP namespace backed by smithers-ctl.",
  })
    .command("smithers_ide_open_file", {
      description: "Open a file in Smithers IDE, optionally jumping to line and column.",
      args: z.object({
        path: z.string().min(1).describe("Path to open in the IDE"),
        line: z.number().int().positive().optional().describe("1-based line number"),
        col: z.number().int().positive().optional().describe("1-based column number"),
      }),
      async run(c) {
        return runPromise(
          service.openFile(c.args.path, c.args.line, c.args.col),
        );
      },
    })
    .command("smithers_ide_open_diff", {
      description: "Open a diff preview in Smithers IDE.",
      args: z.object({
        content: z.string().min(1).describe("Unified diff content"),
      }),
      async run(c) {
        return runPromise(service.openDiff(c.args.content));
      },
    })
    .command("smithers_ide_show_overlay", {
      description: "Show a Smithers IDE overlay.",
      args: z.object({
        type: z.enum(["chat", "progress", "panel"]).describe("Overlay type"),
        message: z.string().min(1).describe("Overlay message"),
        title: z.string().optional().describe("Optional overlay title"),
        position: z
          .enum(["top", "center", "bottom"])
          .optional()
          .describe("Overlay position"),
        duration: z.number().int().positive().optional().describe("Overlay duration in seconds"),
        percent: z.number().min(0).max(100).optional().describe("Overlay progress percent"),
      }),
      async run(c) {
        return runPromise(
          service.showOverlay(c.args.type, {
            message: c.args.message,
            title: c.args.title,
            position: c.args.position,
            duration: c.args.duration,
            percent: c.args.percent,
          }),
        );
      },
    })
    .command("smithers_ide_run_terminal", {
      description: "Run a command in a new Smithers IDE terminal tab.",
      args: z.object({
        cmd: z.string().min(1).describe("Command to run in the terminal"),
        cwd: z.string().optional().describe("Optional working directory"),
      }),
      async run(c) {
        return runPromise(service.runTerminal(c.args.cmd, c.args.cwd));
      },
    })
    .command("smithers_ide_ask_user", {
      description: "Prompt the user through a thin Smithers IDE overlay shim.",
      args: z.object({
        prompt: z.string().min(1).describe("Prompt to show to the user"),
      }),
      async run(c) {
        return runPromise(service.askUser(c.args.prompt));
      },
    })
    .command("smithers_ide_open_webview", {
      description: "Open a URL in a Smithers IDE webview tab.",
      args: z.object({
        url: z.string().url().describe("URL to open"),
      }),
      async run(c) {
        return runPromise(service.openWebview(c.args.url));
      },
    });
}
