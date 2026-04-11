import type { AgentCliEvent } from "./AgentCliEvent";
import type { RunCommandResult } from "./RunCommandResult";

export type CliOutputInterpreter = {
  onStdoutLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined;
  onStderrLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined;
  onExit?: (result: RunCommandResult) => AgentCliEvent[] | AgentCliEvent | null | undefined;
};
