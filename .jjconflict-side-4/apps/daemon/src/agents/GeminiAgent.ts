import { BaseCliAgent, pushFlag } from "@/agents/BaseCliAgent"

export class GeminiAgent extends BaseCliAgent {
  protected async buildCommand(params: { prompt: string; cwd: string }) {
    const args: string[] = []

    pushFlag(args, "--model", this.model)
    if (this.yolo) {
      args.push("--yolo")
    }

    if (this.extraArgs?.length) {
      args.push(...this.extraArgs)
    }

    const fullPrompt = this.systemPrompt
      ? `${this.systemPrompt}\n\n${params.prompt}`
      : params.prompt

    args.push("--prompt", fullPrompt)

    return {
      command: "gemini",
      args,
    }
  }
}
