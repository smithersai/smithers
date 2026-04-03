import { BaseCliAgent, pushFlag } from "@/agents/BaseCliAgent"

export class PiAgent extends BaseCliAgent {
  protected async buildCommand(params: { prompt: string; cwd: string }) {
    const args = ["--print", "--no-session", "--tools", "read,bash,edit,write"]

    pushFlag(args, "--model", this.model)
    pushFlag(args, "--append-system-prompt", this.systemPrompt)

    if (this.extraArgs?.length) {
      args.push(...this.extraArgs)
    }

    args.push(params.prompt)

    return {
      command: "pi",
      args,
    }
  }
}
