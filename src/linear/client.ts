import { LinearClient } from "@linear/sdk";

let cachedClient: LinearClient | null = null;

/**
 * Returns a cached LinearClient instance using LINEAR_API_KEY env var.
 */
export function getLinearClient(): LinearClient {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY environment variable is required for Linear integration",
    );
  }
  cachedClient = new LinearClient({ apiKey });
  return cachedClient;
}

/**
 * Reset the cached client (useful for testing).
 */
export function resetLinearClient(): void {
  cachedClient = null;
}
