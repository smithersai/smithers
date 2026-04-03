import { z } from "zod"

export const agentCliSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  binaryPath: z.string(),
  logoProvider: z.string(),
})

export const generateWorkflowInputSchema = z.object({
  name: z.string().min(1),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
})

export const editWorkflowInputSchema = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1),
})

export type AgentCli = z.infer<typeof agentCliSchema>
export type GenerateWorkflowInput = z.infer<typeof generateWorkflowInputSchema>
export type EditWorkflowInput = z.infer<typeof editWorkflowInputSchema>
