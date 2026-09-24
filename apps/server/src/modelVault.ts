import type { Redacted } from "effect"
import { MODEL_CREDENTIALS } from "@smthrs/rpc/ConfiguredModel"
import type { ModelCredentialListing } from "@smthrs/rpc/ConfiguredModel"
import type { ServerConfigShape } from "./Config"

/*
 * The deployment's two model keys, by NAME. Smithers picks the models and
 * charges the account's credit (modelPayer.ts); there is no account
 * credential enrollment (no BYOK).
 */

const DEPLOYMENT_NAMES = ["CEREBRAS_API_KEY", "AI_GATEWAY_API_KEY"] as const
export const isDeploymentCredential = (name: string): boolean => (DEPLOYMENT_NAMES as readonly string[]).includes(name)
export const deploymentModelSecret = (config: ServerConfigShape, name: string): Redacted.Redacted<string> | undefined =>
  name === "CEREBRAS_API_KEY" ? config.cerebrasApiKey : name === "AI_GATEWAY_API_KEY" ? config.aiGatewayApiKey : undefined
export const workerModelCredentials = (config: ServerConfigShape): ReadonlyArray<ModelCredentialListing> => DEPLOYMENT_NAMES.map(name => ({
  name, present: deploymentModelSecret(config, name) !== undefined, origins: [...MODEL_CREDENTIALS.find(row => row.name === name)!.origins]
}))

/**
 * The retired account credential vault. The class stays exported because a
 * Durable Object class and its binding are deployment identity
 * (workerIdentity.ts); removing it is a migration of its own. Nothing routes
 * to it, and it answers nothing.
 */
export class AccountModelVault {
  constructor(_ctx: unknown) {}
  fetch(_request: Request): Promise<Response> { return Promise.resolve(new Response(null, { status: 410 })) } // effect-policy: boundary
}
