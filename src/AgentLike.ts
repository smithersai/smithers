import type { AgentCapabilityRegistry } from "./agents/capability-registry";

/**
 * Represents an entity capable of generating responses or actions based on prompts.
 * This is typically an AI agent interface.
 */
export type AgentLike = {
  /** Optional unique identifier for the agent */
  id?: string;
  /** Available tools the agent can use */
  tools?: Record<string, any>;
  /** Optional structured capability registry for cache and diagnostics */
  capabilities?: AgentCapabilityRegistry;
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
